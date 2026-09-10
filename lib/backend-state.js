'use strict';

const snippetRichText = require('../public/snippets-richtext');

const EMPTY_SNIPPETS = () => ({ folders: {}, snippets: {}, structure: [] });
const SNIPPET_LOCK = 1936289392;
const SUPER_ADMIN = '02ashes';

class ApiError extends Error {
    constructor(statusCode, code, extra = {}) {
        super(code);
        this.statusCode = statusCode;
        this.code = code;
        this.extra = extra;
    }
}

async function transaction(pool, work) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) { /* retain original failure */ }
        throw error;
    } finally {
        client.release();
    }
}

function isRecord(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function safeId(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) &&
        !['__proto__', 'prototype', 'constructor'].includes(value);
}
function validateSnippets(input) {
    const fail = () => { throw new ApiError(400, 'invalid_snippets'); };
    if (!isRecord(input) || !isRecord(input.folders) || !isRecord(input.snippets) || !Array.isArray(input.structure)) fail();
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 8 * 1024 * 1024) fail();
    const output = EMPTY_SNIPPETS();
    const seen = new Set();
    for (const kind of ['folders', 'snippets']) {
        if (Object.keys(input[kind]).length > 10000) fail();
        for (const [id, item] of Object.entries(input[kind])) {
            if (!safeId(id) || seen.has(id) || !isRecord(item) || item.id !== id ||
                typeof item.name !== 'string' || !item.name.trim() || item.name.length > 500 ||
                !(item.parentId === null || item.parentId === undefined || safeId(item.parentId))) fail();
            seen.add(id);
            output[kind][id] = { id, name: item.name, parentId: item.parentId || null };
            if (kind === 'folders' && Object.hasOwn(item, 'order')) {
                if (!Array.isArray(item.order) || item.order.length > 20000) fail();
                output[kind][id].order = item.order.slice();
            }
            if (kind === 'snippets') {
                if (typeof item.content !== 'string' || item.content.length > 1000000) fail();
                output[kind][id].content = item.content;
                try {
                    const richText = snippetRichText.normalize(item.richText, item.content);
                    if (richText) output[kind][id].richText = richText;
                } catch (_) { fail(); }
            }
        }
    }
    for (const kind of ['folders', 'snippets']) {
        for (const item of Object.values(output[kind])) {
            const ancestors = new Set([item.id]);
            let parent = item.parentId;
            while (parent) {
                if (!Object.hasOwn(output.folders, parent) || ancestors.has(parent)) fail();
                ancestors.add(parent);
                parent = output.folders[parent].parentId;
            }
        }
    }
    for (const folder of Object.values(output.folders)) {
        if (!Object.hasOwn(folder, 'order')) continue;
        const ordered = new Set();
        for (const id of folder.order) {
            const child = Object.hasOwn(output.folders, id) ? output.folders[id] :
                Object.hasOwn(output.snippets, id) ? output.snippets[id] : null;
            if (!safeId(id) || ordered.has(id) || !child || child.parentId !== folder.id) fail();
            ordered.add(id);
        }
    }
    const roots = new Set([...Object.values(output.folders), ...Object.values(output.snippets)]
        .filter(item => !item.parentId).map(item => item.id));
    for (const id of input.structure) {
        if (!safeId(id) || !roots.delete(id)) fail();
        output.structure.push(id);
    }
    if (roots.size) fail();
    return output;
}

async function readSnippets(db) {
    const result = await db.query('SELECT id, data FROM snippets_data ORDER BY id DESC LIMIT 1');
    return result.rows.length
        ? { snippets: result.rows[0].data, revision: Number(result.rows[0].id) }
        : { snippets: EMPTY_SNIPPETS(), revision: 0 };
}

async function requireStoredSnippetsAccess(client, nickname, edit = false) {
    // Share-lock the account until the read/write commits. A concurrent revoke
    // or base-role change must serialize with this operation, not its old HTTP
    // authentication snapshot.
    const result = await client.query(
        'SELECT nickname, role, snippets_access FROM user_registrations WHERE nickname=$1 FOR SHARE',
        [nickname]
    );
    if (!result.rows.length) throw new ApiError(401, 'login_required');
    const user = userAccess(result.rows[0]);
    if (!canAccessSnippets(user)) throw new ApiError(403, 'snippets_access_required');
    if (edit && !canEditSnippets(user)) throw new ApiError(403, 'readers_cannot_edit');
    return user;
}

async function readSnippetsForUser(pool, nickname) {
    return transaction(pool, async client => {
        await requireStoredSnippetsAccess(client, nickname);
        return readSnippets(client);
    });
}

async function saveSnippets(pool, nickname, body, itemOnly = false) {
    if (!itemOnly && !Number.isSafeInteger(body.baseRevision)) {
        throw new ApiError(428, 'snippets_revision_required');
    }
    if (itemOnly && (!safeId(body.id) || typeof body.content !== 'string' ||
        typeof body.baseContent !== 'string' || body.content.length > 1000000)) {
        throw new ApiError(400, 'invalid_snippet');
    }
    let richText;
    let baseRichText;
    if (itemOnly) {
        try {
            richText = snippetRichText.normalize(body.richText, body.content);
            baseRichText = snippetRichText.normalize(body.baseRichText, body.baseContent);
        } catch (_) { throw new ApiError(400, 'invalid_snippet'); }
    }
    const snapshot = itemOnly ? null : validateSnippets(body.snippets);
    return transaction(pool, async client => {
        await requireStoredSnippetsAccess(client, nickname, true);
        // Lock also protects the first insert (there may be no row to lock yet).
        await client.query('SELECT pg_advisory_xact_lock($1)', [SNIPPET_LOCK]);
        const current = await readSnippets(client);
        let next = snapshot;
        if (itemOnly) {
            const existing = current.snippets.snippets?.[body.id];
            // Text equality alone cannot detect simultaneous format changes.
            // Legacy clients may still update plain items, but cannot silently
            // strip formatting they never loaded or understood.
            if (!existing || existing.content !== body.baseContent ||
                JSON.stringify(snippetRichText.normalize(existing.richText, existing.content)) !== JSON.stringify(baseRichText)) {
                throw new ApiError(409, 'snippets_conflict', current);
            }
            next = JSON.parse(JSON.stringify(current.snippets));
            next.snippets[body.id].content = body.content;
            if (richText) next.snippets[body.id].richText = richText;
            else delete next.snippets[body.id].richText;
            next = validateSnippets(next);
        } else if (body.baseRevision !== current.revision) {
            throw new ApiError(409, 'snippets_conflict', current);
        }
        const saved = await client.query(
            'INSERT INTO snippets_data (data, updated_at, updated_by) VALUES ($1, $2, $3) RETURNING id',
            [JSON.stringify(next), new Date(), nickname]
        );
        return { snippets: next, revision: Number(saved.rows[0].id), previous: current.snippets };
    });
}

async function deleteSessions(db, ids) {
    if (!ids.length) return { session: 0, messages: 0, logs: 0 };
    // Callers lock parent rows first, preventing concurrent FK inserts before deletion.
    const logs = await db.query('DELETE FROM session_logs WHERE session_id = ANY($1::text[])', [ids]);
    const messages = await db.query('DELETE FROM messages WHERE session_id = ANY($1::text[])', [ids]);
    const sessions = await db.query('DELETE FROM sessions WHERE id = ANY($1::text[])', [ids]);
    return { session: sessions.rowCount, messages: messages.rowCount, logs: logs.rowCount };
}
async function cleanupSessions(pool, { before = null, sessionId = null } = {}) {
    return transaction(pool, async client => {
        const result = sessionId
            ? await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [sessionId])
            : await client.query(`SELECT id FROM sessions WHERE deleted_at IS NOT NULL
                AND ($1::timestamp IS NULL OR deleted_at < $1) FOR UPDATE`, [before]);
        const ids = result.rows.map(row => row.id);
        return { ids, deleted: await deleteSessions(client, ids) };
    });
}

function weightedPick(items, random = Math.random) {
    const valid = items.filter(item => Number.isFinite(Number(item.weight)) && Number(item.weight) > 0);
    const total = valid.reduce((sum, item) => sum + Number(item.weight), 0);
    if (!valid.length || !Number.isFinite(total)) return null;
    let remaining = random() * total;
    return valid.find(item => (remaining -= Number(item.weight)) < 0) || valid[valid.length - 1];
}
async function openCase(pool, nickname, grantId, choose = weightedPick) {
    if (!Number.isSafeInteger(Number(grantId)) || Number(grantId) < 1) throw new ApiError(400, 'invalid_grant_id');
    return transaction(pool, async client => {
        const user = await client.query('SELECT nickname FROM user_registrations WHERE nickname=$1 FOR UPDATE', [nickname]);
        if (!user.rows.length) throw new ApiError(401, 'login_required');
        const grant = await client.query(
            'SELECT id, tier, opened FROM case_grants WHERE id=$1 AND worker_nickname=$2 FOR UPDATE',
            [grantId, nickname]
        );
        if (!grant.rows.length) throw new ApiError(409, 'case_unavailable');
        if (grant.rows[0].opened) {
            const previous = await client.query(
                'SELECT result_json FROM case_openings WHERE grant_id=$1 AND worker_nickname=$2 ORDER BY id LIMIT 1',
                [grantId, nickname]
            );
            if (previous.rows[0]?.result_json) return { ...previous.rows[0].result_json, reused: true };
            throw new ApiError(409, 'case_unavailable');
        }
        const tier = grant.rows[0].tier;
        const poolResult = await client.query(
            `SELECT p.id, p.name, p.kind, p.case_tier, p.icon, p.rarity, ctp.weight
             FROM case_tier_prizes ctp JOIN case_prizes p ON p.id=ctp.prize_id
             WHERE ctp.tier=$1 AND p.is_active=true`, [tier]
        );
        const prize = choose(poolResult.rows);
        if (!prize) throw new ApiError(409, 'empty_pool');
        const isCase = prize.kind === 'case';
        if (isCase && ![1, 2, 3].includes(prize.case_tier)) throw new ApiError(409, 'invalid_case_prize');
        await client.query('UPDATE case_grants SET opened=true, opened_at=NOW() WHERE id=$1', [grantId]);
        let newCase = null;
        if (isCase) {
            const next = await client.query(
                `INSERT INTO case_grants (worker_nickname, tier, granted_by, source, granted_at)
                 VALUES ($1,$2,'system','case',NOW()) RETURNING id, tier`, [nickname, prize.case_tier]
            );
            newCase = next.rows[0];
        }
        const result = {
            ok: true,
            prize: { id: prize.id, name: prize.name, kind: prize.kind, icon: prize.icon, rarity: prize.rarity, caseTier: prize.case_tier },
            pool: poolResult.rows.map(p => ({ id: p.id, name: p.name, kind: p.kind, icon: p.icon, rarity: p.rarity })),
            newCase
        };
        await client.query(
            `INSERT INTO case_openings
             (grant_id, worker_nickname, tier, prize_id, prize_name, prize_kind, prize_icon, prize_rarity,
              opened_at, delivered, delivered_by, delivered_at, result_json)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9,$10,$11,$12)`,
            [grantId, nickname, tier, prize.id, prize.name, prize.kind, prize.icon, prize.rarity,
                isCase, isCase ? 'system' : null, isCase ? new Date() : null, JSON.stringify(result)]
        );
        return result;
    });
}

function validNickname(nickname) {
    return typeof nickname === 'string' && nickname === nickname.trim() &&
        nickname.length >= 1 && nickname.length <= 64 &&
        /^[\p{L}\p{N}_. -]+$/u.test(nickname) && !/[\u0000-\u001f\u007f]/.test(nickname);
}
function isStaff(user) { return Boolean(user && ['admin', 'user', 'reader'].includes(user.role)); }
function userAccess(row) {
    const isOwner = row.nickname === SUPER_ADMIN;
    const role = isOwner ? 'admin' : (row.role || 'reader');
    return {
        nickname: row.nickname,
        role,
        snippetsAccessGranted: isOwner || row.snippets_access === true,
        snippetsAccess: isOwner || (isStaff({ role }) && row.snippets_access === true),
        canManageSnippetsAccess: isOwner
    };
}
function canAccessSnippets(user) { return isStaff(user) && user.snippetsAccess === true; }
function canEditSnippets(user) { return canAccessSnippets(user) && ['admin', 'user'].includes(user.role); }
function expiryDelay(expiresAt, now = Date.now()) {
    return Math.min(Math.max(0, new Date(expiresAt).getTime() - now), 24 * 60 * 60 * 1000);
}
function normalizeWheelCode(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value) ? value : '';
}

module.exports = {
    ApiError, transaction, validateSnippets, readSnippets, readSnippetsForUser, requireStoredSnippetsAccess, saveSnippets, cleanupSessions,
    deleteSessions, weightedPick, openCase, validNickname, isStaff, userAccess, canAccessSnippets, canEditSnippets, expiryDelay,
    normalizeWheelCode
};
