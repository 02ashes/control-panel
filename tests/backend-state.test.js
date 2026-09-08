'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const state = require('../lib/backend-state');

function makePool(db, fail = () => false) {
    // PGlite has one connection; emulate a pool checkout with an exclusive lease.
    let queue = Promise.resolve();
    const query = async (sql, values) => {
        if (fail(sql)) throw new Error('injected_write_failure');
        const result = await db.query(sql, values);
        return { ...result, rowCount: result.affectedRows || result.rows.length };
    };
    return { query, async connect() {
        let release;
        const previous = queue;
        queue = new Promise(resolve => { release = resolve; });
        await previous;
        return { query, release };
    } };
}
const library = () => ({ folders: {}, snippets: {
    a: { id: 'a', name: 'Alpha', parentId: null, content: 'first' },
    b: { id: 'b', name: 'Beta', parentId: null, content: 'second' }
}, structure: ['a', 'b'] });

const schema = `
CREATE TABLE user_registrations (nickname TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'reader',
 snippets_access BOOLEAN NOT NULL DEFAULT FALSE);
INSERT INTO user_registrations(nickname) VALUES ('worker'),('outsider');
INSERT INTO user_registrations VALUES ('editor','user',true),('colleague','user',true);
CREATE TABLE snippets_data (id SERIAL PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMP, updated_by TEXT);
CREATE TABLE sessions (id TEXT PRIMARY KEY, deleted_at TIMESTAMP);
CREATE TABLE messages (id SERIAL PRIMARY KEY, session_id TEXT REFERENCES sessions(id));
CREATE TABLE session_logs (id SERIAL PRIMARY KEY, session_id TEXT REFERENCES sessions(id));
CREATE TABLE case_grants (id SERIAL PRIMARY KEY, worker_nickname TEXT NOT NULL, tier INT NOT NULL,
 granted_by TEXT, source TEXT, granted_at TIMESTAMP DEFAULT NOW(), opened BOOLEAN DEFAULT false, opened_at TIMESTAMP);
CREATE TABLE case_prizes (id SERIAL PRIMARY KEY, name TEXT,kind TEXT,case_tier INT,icon TEXT,rarity TEXT,is_active BOOLEAN DEFAULT true);
CREATE TABLE case_tier_prizes (tier INT,prize_id INT REFERENCES case_prizes(id),weight INT);
CREATE TABLE case_openings (id SERIAL PRIMARY KEY,grant_id INT,worker_nickname TEXT,tier INT,prize_id INT,
 prize_name TEXT,prize_kind TEXT,prize_icon TEXT,prize_rarity TEXT,opened_at TIMESTAMP,delivered BOOLEAN,
 delivered_by TEXT,delivered_at TIMESTAMP,result_json JSONB);
`;

test('backend PostgreSQL transactions and optimistic concurrency', async t => {
    const db = new PGlite();
    await db.exec(schema);
    const pool = makePool(db);
    t.after(() => db.close());

    await t.test('snippets: durable revisions and concurrent stale save cannot erase a colleague', async () => {
        const initial = await state.saveSnippets(pool, 'editor', { snippets: library(), baseRevision: 0 });
        const first = library(); first.snippets.a.content = 'updated A';
        const second = library(); second.snippets.b.content = 'updated B';
        const results = await Promise.allSettled([
            state.saveSnippets(pool, 'editor', { snippets: first, baseRevision: initial.revision }),
            state.saveSnippets(pool, 'colleague', { snippets: second, baseRevision: initial.revision })
        ]);
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
        const conflict = results.find(r => r.status === 'rejected').reason;
        assert.equal(conflict.statusCode, 409);
        assert.equal(conflict.extra.snippets.snippets.a.content, 'updated A');
        assert.equal((await state.readSnippets(pool)).snippets.snippets.a.content, 'updated A');
    });
    await t.test('snippets: per-item comparison preserves unrelated content; duplicate stale item fails', async () => {
        const updated = await state.saveSnippets(pool, 'editor', { id: 'b', baseContent: 'second', content: 'new B' }, true);
        assert.equal(updated.snippets.snippets.a.content, 'updated A');
        await assert.rejects(state.saveSnippets(pool, 'editor', { id: 'b', baseContent: 'second', content: 'old B' }, true),
            { code: 'snippets_conflict' });
    });
    await t.test('snippets: failed insert rolls back and leaves durable snapshot unchanged', async () => {
        const before = await state.readSnippets(pool);
        const broken = makePool(db, sql => sql.startsWith('INSERT INTO snippets_data'));
        await assert.rejects(state.saveSnippets(broken, 'editor', { snippets: library(), baseRevision: before.revision }),
            /injected_write_failure/);
        assert.deepEqual(await state.readSnippets(pool), before);
    });
    await t.test('snippets: stored permission is required for reads, writes and conflict details', async () => {
        await assert.rejects(state.readSnippetsForUser(pool, 'outsider'), { code: 'snippets_access_required' });
        await assert.rejects(state.saveSnippets(pool, 'outsider', { snippets: library(), baseRevision: 0 }),
            { code: 'snippets_access_required' });
        await db.query("UPDATE user_registrations SET snippets_access=false WHERE nickname='editor'");
        await assert.rejects(state.saveSnippets(pool, 'editor', { id: 'b', baseContent: 'wrong', content: 'private' }, true),
            { code: 'snippets_access_required' });
        await db.query("UPDATE user_registrations SET snippets_access=true WHERE nickname='editor'");
    });
    await t.test('snippets: formatting is persisted and legacy item writes cannot erase it', async () => {
        const before = await state.readSnippets(pool);
        const next = structuredClone(before.snippets);
        next.snippets.b.richText = { ops: [{ insert: 'new B\n', attributes: { bold: true, color: '#ABCDEF' } }] };
        const saved = await state.saveSnippets(pool, 'editor', { snippets: next, baseRevision: before.revision });
        assert.deepEqual(saved.snippets.snippets.b.richText, { ops: [
            { insert: 'new B', attributes: { bold: true, color: '#abcdef' } }, { insert: '\n' }
        ] });
        await assert.rejects(state.saveSnippets(pool, 'editor', { id: 'b', baseContent: 'new B', content: 'legacy overwrite' }, true),
            { statusCode: 409, code: 'snippets_conflict' });
        assert.deepEqual(await state.readSnippets(pool), { snippets: saved.snippets, revision: saved.revision });
    });
    await t.test('snippets: formatting-only concurrent changes conflict even when the text matches', async () => {
        const initial = await state.readSnippets(pool);
        const baseRichText = initial.snippets.snippets.b.richText;
        const italic = { ops: [{ insert: 'new B', attributes: { italic: true } }, { insert: '\n' }] };
        const saved = await state.saveSnippets(pool, 'editor', {
            id: 'b', baseContent: 'new B', baseRichText, content: 'new B', richText: italic
        }, true);
        assert.deepEqual(saved.snippets.snippets.b.richText, italic);
        await assert.rejects(state.saveSnippets(pool, 'colleague', {
            id: 'b', baseContent: 'new B', baseRichText, content: 'new B', richText: baseRichText
        }, true), { code: 'snippets_conflict' });
        assert.equal(saved.snippets.snippets.a.content, 'updated A');
    });
    await t.test('snippets: canonical base formats match and explicit unformatted updates clear richText', async () => {
        const saved = await state.saveSnippets(pool, 'editor', {
            id: 'b', baseContent: 'new B',
            baseRichText: { ops: [{ insert: 'new ', attributes: { italic: true } }, { insert: 'B\n', attributes: { italic: true } }] },
            content: 'plain again'
        }, true);
        assert.equal(saved.snippets.snippets.b.content, 'plain again');
        assert.equal(Object.hasOwn(saved.snippets.snippets.b, 'richText'), false);
        const legacy = await state.saveSnippets(pool, 'editor', { id: 'b', baseContent: 'plain again', content: 'legacy still works' }, true);
        assert.equal(legacy.snippets.snippets.b.content, 'legacy still works');
    });
    await t.test('snippets: malformed rich item or base cannot persist a revision', async () => {
        const before = await state.readSnippets(pool);
        const body = { id: 'b', baseContent: 'legacy still works', content: 'unsafe' };
        for (const extra of [
            { richText: { ops: [{ insert: 'different\n', attributes: { bold: true } }] } },
            { richText: { ops: [{ insert: 'unsafe\n', attributes: { link: 'javascript:alert(1)' } }] } },
            { baseRichText: null }
        ]) {
            await assert.rejects(state.saveSnippets(pool, 'editor', { ...body, ...extra }, true),
                { statusCode: 400, code: 'invalid_snippet' });
        }
        assert.deepEqual(await state.readSnippets(pool), before);
    });
    await t.test('cleanup: parent and foreign-key children are removed together; active sessions retained', async () => {
        await db.exec(`INSERT INTO sessions VALUES ('deleted',NOW()),('active',NULL);
            INSERT INTO messages(session_id) VALUES ('deleted'),('active');
            INSERT INTO session_logs(session_id) VALUES ('deleted'),('active');`);
        const result = await state.cleanupSessions(pool);
        assert.deepEqual(result.deleted, { session: 1, messages: 1, logs: 1 });
        assert.deepEqual((await db.query('SELECT id FROM sessions')).rows, [{ id: 'active' }]);
    });
    await t.test('cleanup: failure during parent deletion rolls back deletion of children', async () => {
        const broken = makePool(db, sql => sql.startsWith('DELETE FROM sessions'));
        await assert.rejects(state.cleanupSessions(broken, { sessionId: 'active' }), /injected_write_failure/);
        assert.equal((await db.query('SELECT * FROM messages')).rows.length, 1);
        assert.equal((await db.query('SELECT * FROM session_logs')).rows.length, 1);
    });
    await t.test('case: losing connection during prize insert does not spend the grant', async () => {
        await db.exec(`INSERT INTO case_prizes(name,kind,icon,rarity) VALUES ('Reward','reward','gift','common');
            INSERT INTO case_tier_prizes VALUES (1,1,1);
            INSERT INTO case_grants(worker_nickname,tier) VALUES ('worker',1);`);
        const broken = makePool(db, sql => sql.includes('INSERT INTO case_openings'));
        await assert.rejects(state.openCase(broken, 'worker', 1), /injected_write_failure/);
        assert.equal((await db.query('SELECT opened FROM case_grants WHERE id=1')).rows[0].opened, false);
        assert.equal((await db.query('SELECT * FROM case_openings')).rows.length, 0);
    });
    await t.test('case: concurrent requests reuse one saved result, not two rewards', async () => {
        const [a, b] = await Promise.all([state.openCase(pool, 'worker', 1), state.openCase(pool, 'worker', 1)]);
        assert.deepEqual(a.prize, b.prize);
        assert.equal(b.reused, true);
        assert.equal((await db.query('SELECT * FROM case_openings')).rows.length, 1);
        await assert.rejects(state.openCase(pool, 'outsider', 1), { code: 'case_unavailable' });
    });
    await t.test('case: zero weight pool cannot consume a grant', async () => {
        await db.exec(`INSERT INTO case_grants(worker_nickname,tier) VALUES ('worker',2);
            INSERT INTO case_tier_prizes VALUES (2,1,0);`);
        await assert.rejects(state.openCase(pool, 'worker', 2), { code: 'empty_pool' });
        assert.equal((await db.query('SELECT opened FROM case_grants WHERE id=2')).rows[0].opened, false);
    });
});

test('snippets reject malformed objects, unsafe ids, cycles, missing roots and absent revision', async () => {
    const bad = [];
    bad.push(null, [], { folders: {}, snippets: {}, structure: [123] });
    const unsafe = library(); unsafe.snippets.a.id = "a');alert(1)//"; bad.push(unsafe);
    const parent = library(); parent.snippets.a.parentId = 'missing'; bad.push(parent);
    const cycle = library(); cycle.folders.f = { id:'f', name:'F', parentId:'f' }; bad.push(cycle);
    const roots = library(); roots.structure.pop(); bad.push(roots);
    bad.push(JSON.parse('{"folders":{"__proto__":{"id":"__proto__","name":"X","parentId":null}},"snippets":{},"structure":["__proto__"]}'));
    for (const input of bad) assert.throws(() => state.validateSnippets(input), { code: 'invalid_snippets' });
    await assert.rejects(state.saveSnippets({}, 'editor', { snippets: library() }), { statusCode: 428 });
    assert.deepEqual(state.validateSnippets(library()), library());
});
test('snippets snapshots retain only canonical safe rich text matching their copyable plain content', () => {
    const input = library();
    input.snippets.a.richText = { ops: [{ insert: 'first\n', attributes: { bold: true } }] };
    input.snippets.b.richText = { ops: [{ insert: 'second\n', attributes: {} }] };
    const saved = state.validateSnippets(input);
    assert.deepEqual(saved.snippets.a.richText, { ops: [{ insert: 'first', attributes: { bold: true } }, { insert: '\n' }] });
    assert.equal(Object.hasOwn(saved.snippets.b, 'richText'), false);
    for (const richText of [
        null,
        { ops: [{ insert: 'first' }] },
        { ops: [{ insert: 'second\n', attributes: { bold: true } }] },
        { ops: [{ insert: 'first\n', attributes: { color: 'url(https://tracking.invalid)' } }] },
        { ops: [{ insert: { image: 'https://tracking.invalid' } }, { insert: '\n' }] }
    ]) {
        input.snippets.a.richText = richText;
        assert.throws(() => state.validateSnippets(input), { statusCode: 400, code: 'invalid_snippets' });
    }
});
test('role policy is explicit allowlist and unknown roles fail closed', () => {
    for (const role of ['new', '', 'administrator', 'ADMIN']) {
        assert.equal(state.isStaff({ role }), false);
        assert.equal(state.canEditSnippets({ role }), false);
    }
    assert.equal(state.isStaff({ role: 'reader' }), true);
    assert.equal(state.canEditSnippets({ role: 'reader' }), false);
    assert.equal(state.canEditSnippets({ role: 'user' }), false);
    assert.equal(state.canEditSnippets({ role: 'user', snippetsAccess: true }), true);
    assert.equal(state.canAccessSnippets({ role: 'reader', snippetsAccess: true }), true);
    assert.equal(state.canEditSnippets({ role: 'reader', snippetsAccess: true }), false);
    assert.equal(state.canAccessSnippets({ role: 'new', snippetsAccess: true }), false);
});
test('snippets owner permission is exact, additive and closed by default', () => {
    for (const nickname of ['administrator', '02Ashes', '02ashes ']) {
        const user = state.userAccess({ nickname, role: 'admin' });
        assert.equal(user.snippetsAccess, false);
        assert.equal(user.canManageSnippetsAccess, false);
    }
    const owner = state.userAccess({ nickname: '02ashes', role: 'new', snippets_access: false });
    assert.equal(owner.role, 'admin');
    assert.equal(owner.snippetsAccess, true);
    assert.equal(owner.canManageSnippetsAccess, true);
    const trainee = state.userAccess({ nickname: 'trainee', role: 'new', snippets_access: true });
    assert.equal(trainee.snippetsAccess, false);
    assert.equal(trainee.snippetsAccessGranted, true);
});
test('nickname validation rejects HTML/control chars while preserving Unicode names', () => {
    assert.equal(state.validNickname('Имя_123'), true);
    for (const name of ['<img src=x onerror=alert(1)>', ' bad ', '\nname', {}, 'a'.repeat(65)]) {
        assert.equal(state.validNickname(name), false);
    }
});
test('expiry timer is capped below Node overflow and already elapsed timer fires immediately', () => {
    const now = Date.now();
    assert.equal(state.expiryDelay(now + 365 * 86400000, now), 86400000);
    assert.equal(state.expiryDelay(now - 1000, now), 0);
    assert.equal(state.expiryDelay(now + 250, now), 250);
});
