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
        return data.structure.every(id => typeof id === 'string' && (Object.hasOwn(data.snippets, id) || Object.hasOwn(data.folders, id)));
    }
    function canonical(data) {
        const result = { folders: {}, snippets: {}, structure: data.structure.slice() };
        for (const kind of ['folders', 'snippets']) {
            for (const [id, item] of Object.entries(data[kind])) {
                if (['__proto__', 'prototype', 'constructor'].includes(id)) continue;
                result[kind][id] = { id: item.id, name: item.name, parentId: item.parentId || null };
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
        // Preserve both independent additions to the root list. Ordering-only edits
        // are conflicts, since guessing an order would hide a user's change.
        if (conflicts.includes('structure')) {
            const old = base.structure || [];
            const mine = local.structure || [];
            const theirs = remote.structure || [];
            const oldMine = mine.filter(id => old.includes(id));
            const oldTheirs = theirs.filter(id => old.includes(id));
            if (equal(oldMine, old.filter(id => mine.includes(id))) && equal(oldTheirs, old.filter(id => theirs.includes(id)))) {
                data.structure = [...new Set([...theirs, ...mine])].filter(id => Object.hasOwn(data.folders, id) || Object.hasOwn(data.snippets, id));
                conflicts.splice(conflicts.indexOf('structure'), 1);
            }
        }
        // A delete-versus-edit conflict may retain a local record which the remote
        // root list removed; keep the draft reachable until explicitly resolved.
        data.structure = data.structure.filter(id => Object.hasOwn(data.folders, id) || Object.hasOwn(data.snippets, id));
        for (const group of ['folders', 'snippets']) {
            for (const [id, item] of Object.entries(data[group])) {
                if (item.parentId && !Object.hasOwn(data.folders, item.parentId)) {
                    item.parentId = null;
                    conflicts.push(`${group}.${id}.parentId`);
                }
                if (!item.parentId && !data.structure.includes(id)) data.structure.push(id);
            }
        }
        return { data, conflicts };
    }
    return { clone, equal, valid, canonical, merge };
});
