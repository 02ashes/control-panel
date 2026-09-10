/* Shared, side-effect-free three-way merge for the collaborative snippet editor. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./snippets-richtext'));
    else root.SnippetsSync = factory(root.SnippetsRichText);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (richText) {
    const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    const equal = (a, b) => {
        if (a === b) return true;
        if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
        const keys = Object.keys(a);
        return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
    };
    const safeId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id) &&
        !['__proto__', 'prototype', 'constructor'].includes(id);
    function childIds(data, parentId) {
        if (!data || !data.folders || !data.snippets) return [];
        const parent = parentId == null ? null : parentId;
        if (parent !== null && !Object.hasOwn(data.folders, parent)) return [];
        const result = [];
        const seen = new Set();
        // This is the pre-ordering UI's enumeration, kept for old libraries and
        // newly created children omitted from a folder's stored preference.
        for (const group of ['folders', 'snippets']) {
            for (const [id, item] of Object.entries(data[group])) {
                if (item && (item.parentId || null) === parent && !seen.has(id)) {
                    result.push(id); seen.add(id);
                }
            }
        }
        return result;
    }
    function children(data, parentId = null) {
        const available = childIds(data, parentId);
        const remaining = new Set(available);
        const stored = parentId == null ? data?.structure : data?.folders?.[parentId]?.order;
        const result = [];
        if (Array.isArray(stored)) {
            for (const id of stored) if (remaining.delete(id)) result.push(id);
        }
        return result.concat(available.filter(id => remaining.has(id)));
    }
    function setOrder(data, parentId, ids) {
        if (!data || !data.folders || !data.snippets || !Array.isArray(data.structure) || !Array.isArray(ids)) return false;
        if (parentId != null && (!safeId(parentId) || !Object.hasOwn(data.folders, parentId))) return false;
        const expected = new Set(childIds(data, parentId));
        if (ids.length !== expected.size || ids.some(id => !safeId(id) || !expected.delete(id)) || expected.size) return false;
        if (parentId == null) data.structure = ids.slice();
        else data.folders[parentId].order = ids.slice();
        return true;
    }
    function validOrder(data, parentId, order) {
        if (!Array.isArray(order) || order.length > 20000) return false;
        const available = new Set(childIds(data, parentId));
        for (const id of order) if (!safeId(id) || !available.delete(id)) return false;
        return true;
    }
    function valid(data) {
        if (!data || typeof data !== 'object' || !Array.isArray(data.structure)) return false;
        for (const group of ['folders', 'snippets']) {
            const items = data[group];
            if (!items || typeof items !== 'object' || Array.isArray(items)) return false;
            for (const [id, item] of Object.entries(items)) {
                if (!item || typeof item !== 'object' || item.id !== id || typeof item.name !== 'string') return false;
                if (['__proto__', 'prototype', 'constructor'].includes(id)) return false;
                if (group === 'snippets') {
                    if (typeof item.content !== 'string') return false;
                    try { richText.normalize(item.richText, item.content); } catch (_) { return false; }
                }
                if (item.parentId != null && typeof item.parentId !== 'string') return false;
            }
        }
        for (const [id, folder] of Object.entries(data.folders)) {
            if (Object.hasOwn(folder, 'order') && !validOrder(data, id, folder.order)) return false;
        }
        return data.structure.every(id => typeof id === 'string' && (Object.hasOwn(data.snippets, id) || Object.hasOwn(data.folders, id)));
    }
    function canonical(data) {
        const result = { folders: {}, snippets: {}, structure: data.structure.slice() };
        for (const kind of ['folders', 'snippets']) {
            for (const [id, item] of Object.entries(data[kind])) {
                if (['__proto__', 'prototype', 'constructor'].includes(id)) continue;
                result[kind][id] = { id: item.id, name: item.name, parentId: item.parentId || null };
                if (kind === 'folders' && Object.hasOwn(item, 'order')) {
                    if (!validOrder(data, id, item.order)) throw new TypeError('invalid_snippet_order');
                    result[kind][id].order = item.order.slice();
                }
                if (kind === 'snippets') {
                    result[kind][id].content = item.content;
                    const formatted = richText.normalize(item.richText, item.content);
                    if (formatted) result[kind][id].richText = formatted;
                }
            }
        }
        return result;
    }
    function merge(base, local, remote) {
        // Compare the same canonical documents that the server persists.
        base = canonical(base); local = canonical(local); remote = canonical(remote);
        const conflicts = [];
        function visit(before, mine, theirs, path) {
            if (equal(mine, before)) return clone(theirs);
            if (equal(theirs, before) || equal(mine, theirs)) return clone(mine);
            if (before && mine && theirs && !Array.isArray(before) && typeof before === 'object' && typeof mine === 'object' && typeof theirs === 'object') {
                const result = {};
                // Text and its formatting describe one document, not independent fields.
                // Never combine remote text with marks/offsets from a local draft.
                const documentBody = path.length === 2 && path[0] === 'snippets';
                if (documentBody) {
                    const body = item => [item.content, item.richText || null];
                    const chosen = visit(body(before), body(mine), body(theirs), path.concat('content'));
                    result.content = chosen[0];
                    if (chosen[1]) result.richText = chosen[1];
                }
                for (const key of new Set([...Object.keys(before), ...Object.keys(mine), ...Object.keys(theirs)])) {
                    if (documentBody && ['content', 'richText'].includes(key)) continue;
                    if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
                    const value = visit(before[key], mine[key], theirs[key], path.concat(key));
                    if (value !== undefined) result[key] = value;
                }
                return result;
            }
            // A conflict never discards the local draft or silently overwrites the server.
            conflicts.push(path.join('.'));
            return clone(mine);
        }
        const data = visit(base, local, remote, []);
        // A delete-versus-edit conflict may retain a local record which the remote
        // root list removed; keep the draft reachable until explicitly resolved.
        for (const group of ['folders', 'snippets']) {
            for (const [id, item] of Object.entries(data[group])) {
                if (item.parentId && !Object.hasOwn(data.folders, item.parentId)) {
                    item.parentId = null;
                    conflicts.push(`${group}.${id}.parentId`);
                }
            }
        }
        function mergeOrder(parentId) {
            if (parentId !== null && ![base, local, remote, data].some(snapshot =>
                snapshot.folders[parentId] && Object.hasOwn(snapshot.folders[parentId], 'order'))) return;
            const path = parentId === null ? 'structure' : `folders.${parentId}.order`;
            const staleConflict = conflicts.indexOf(path);
            if (staleConflict >= 0) conflicts.splice(staleConflict, 1);
            const available = childIds(data, parentId);
            const live = new Set(available);
            const before = children(base, parentId).filter(id => live.has(id));
            const mine = children(local, parentId).filter(id => live.has(id));
            const theirs = children(remote, parentId).filter(id => live.has(id));
            let primary;
            let secondary;
            if (equal(mine, before)) { primary = theirs; secondary = mine; }
            else if (equal(theirs, before) || equal(mine, theirs)) { primary = mine; secondary = theirs; }
            else {
                const old = new Set(before), mineSet = new Set(mine), theirsSet = new Set(theirs);
                const mineReordered = !equal(mine.filter(id => old.has(id)), before.filter(id => mineSet.has(id)));
                const theirsReordered = !equal(theirs.filter(id => old.has(id)), before.filter(id => theirsSet.has(id)));
                const shared = new Set(mine.filter(id => theirsSet.has(id)));
                if (mineReordered && theirsReordered &&
                    !equal(mine.filter(id => shared.has(id)), theirs.filter(id => shared.has(id)))) conflicts.push(path);
                primary = mineReordered ? mine : theirs;
                secondary = mineReordered ? theirs : mine;
            }
            const merged = [...new Set([...primary, ...secondary, ...available])];
            if (parentId === null) { data.structure = merged; return; }
            const folder = data.folders[parentId];
            if (Object.hasOwn(folder, 'order')) {
                folder.order = folder.order.filter(id => live.has(id));
            }
            // Preserve absent/partial preferences when they already express the
            // merged order. This avoids modifying every old folder on any save.
            if (!equal(children(data, parentId), merged)) folder.order = merged;
        }
        mergeOrder(null);
        for (const id of Object.keys(data.folders)) mergeOrder(id);
        return { data, conflicts };
    }
    return { clone, equal, valid, canonical, merge, children, setOrder };
});
