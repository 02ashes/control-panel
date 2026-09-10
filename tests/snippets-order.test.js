'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const state = require('../lib/backend-state');
const sync = require('../public/snippets-sync');

function library() {
    return {
        folders: {
            f: { id: 'f', name: 'First folder', parentId: null },
            g: { id: 'g', name: 'Second folder', parentId: null },
            nested: { id: 'nested', name: 'Nested folder', parentId: 'f' }
        },
        snippets: {
            a: { id: 'a', name: 'Alpha', parentId: 'f', content: 'first' },
            b: { id: 'b', name: 'Beta', parentId: 'f', content: 'second' },
            c: { id: 'c', name: 'Gamma', parentId: 'f', content: 'third' },
            d: { id: 'd', name: 'Delta', parentId: 'g', content: 'fourth' },
            e: { id: 'e', name: 'Epsilon', parentId: 'g', content: 'fifth' },
            root: { id: 'root', name: 'Root snippet', parentId: null, content: 'root' }
        },
        structure: ['g', 'root', 'f']
    };
}
function add(data, id, parentId = 'f') {
    data.snippets[id] = { id, name: id, content: id, parentId };
    if (parentId === null) data.structure.push(id);
}
function orderedLibrary() {
    const data = library();
    sync.setOrder(data, 'f', ['nested', 'a', 'b', 'c']);
    sync.setOrder(data, 'g', ['d', 'e']);
    return data;
}
function validateMerge(result) {
    assert.equal(sync.valid(result.data), true);
    assert.deepEqual(state.validateSnippets(result.data), result.data);
}

test('snippet children keep root structure and legacy folder-then-snippet enumeration', () => {
    const data = library();
    assert.deepEqual(sync.children(data, null), ['g', 'root', 'f']);
    assert.deepEqual(sync.children(data), ['g', 'root', 'f']);
    assert.deepEqual(sync.children(data, 'f'), ['nested', 'a', 'b', 'c']);
    assert.deepEqual(sync.children(data, 'nested'), []);
    assert.deepEqual(sync.children(data, 'missing'), []);
    assert.deepEqual(sync.children(null, null), []);
    assert.deepEqual(sync.canonical(data), data);
    assert.deepEqual(state.validateSnippets(data), data);
});

test('partial folder order prefers listed direct siblings and appends newly created children', () => {
    const data = library();
    data.folders.f.order = ['c', 'nested'];
    add(data, 'newChild');
    assert.deepEqual(sync.children(data, 'f'), ['c', 'nested', 'a', 'b', 'newChild']);
    assert.deepEqual(sync.canonical(data).folders.f.order, ['c', 'nested']);
    assert.deepEqual(state.validateSnippets(data).folders.f.order, ['c', 'nested']);
    data.folders.g.order = [];
    assert.deepEqual(sync.children(data, 'g'), ['d', 'e']);
    assert.deepEqual(state.validateSnippets(data).folders.g.order, []);
});

test('setOrder writes copied exact permutations at root or inside a folder', () => {
    const data = library();
    const ids = ['c', 'a', 'nested', 'b'];
    assert.equal(sync.setOrder(data, 'f', ids), true);
    ids.reverse();
    assert.deepEqual(data.folders.f.order, ['c', 'a', 'nested', 'b']);
    assert.equal(sync.setOrder(data, null, ['f', 'g', 'root']), true);
    assert.deepEqual(data.structure, ['f', 'g', 'root']);
    assert.equal(sync.setOrder(data, 'nested', []), true);
    assert.deepEqual(data.folders.nested.order, []);
    validateMerge({ data });
});

test('setOrder rejects partial, duplicate, unsafe, non-sibling and malformed lists without mutation', () => {
    const data = library();
    const before = structuredClone(data);
    for (const ids of [null, {}, 'a', ['a'], ['a', 'b', 'c', 'a'], ['a', 'b', 'c', 'd'],
        ['a', 'b', 'c', '__proto__'], ['a', 'b', 'c', 'missing'], new Array(4)]) {
        assert.equal(sync.setOrder(data, 'f', ids), false);
        assert.deepEqual(data, before);
    }
    assert.equal(sync.setOrder(data, 'missing', []), false);
    assert.equal(sync.setOrder(data, '', []), false);
    assert.equal(sync.setOrder(null, null, []), false);
    assert.equal(sync.setOrder(data, null, ['a', 'g', 'f']), false);
    assert.deepEqual(data, before);
});

test('folder ordering schema rejects dangling, duplicate, unsafe and wrong-parent entries', () => {
    for (const order of [null, {}, 'a', ['a', 'a'], ['missing'], ['d'], ['f'], ['root'],
        ['__proto__'], ['constructor'], ['a;alert(1)'], [123], new Array(2)]) {
        const data = library(); data.folders.f.order = order;
        assert.equal(sync.valid(data), false);
        assert.throws(() => sync.canonical(data), /invalid_snippet_order/);
        assert.throws(() => state.validateSnippets(data), { statusCode: 400, code: 'invalid_snippets' });
    }
});

test('reorders in different folders merge independently alongside a text edit', () => {
    const base = orderedLibrary(), local = orderedLibrary(), remote = orderedLibrary();
    sync.setOrder(local, 'f', ['c', 'b', 'a', 'nested']);
    sync.setOrder(remote, 'g', ['e', 'd']);
    remote.snippets.root.content = 'remote root text';
    const snapshots = structuredClone({ base, local, remote });
    const merged = sync.merge(base, local, remote);
    assert.deepEqual(merged.conflicts, []);
    assert.deepEqual(sync.children(merged.data, 'f'), ['c', 'b', 'a', 'nested']);
    assert.deepEqual(sync.children(merged.data, 'g'), ['e', 'd']);
    assert.equal(merged.data.snippets.root.content, 'remote root text');
    assert.deepEqual({ base, local, remote }, snapshots);
    validateMerge(merged);
});

test('the same concurrent folder reorder is compatible and keeps a separate folder rename', () => {
    const base = orderedLibrary(), local = orderedLibrary(), remote = orderedLibrary();
    sync.setOrder(local, 'f', ['b', 'a', 'nested', 'c']);
    sync.setOrder(remote, 'f', ['b', 'a', 'nested', 'c']);
    local.folders.f.name = 'Renamed';
    const merged = sync.merge(base, local, remote);
    assert.deepEqual(merged.conflicts, []);
    assert.equal(merged.data.folders.f.name, 'Renamed');
    assert.deepEqual(sync.children(merged.data, 'f'), ['b', 'a', 'nested', 'c']);
    validateMerge(merged);
});

test('independently appended and deleted siblings merge without an order conflict', () => {
    const base = orderedLibrary(), local = orderedLibrary(), remote = orderedLibrary();
    add(local, 'localNew'); add(remote, 'remoteNew');
    sync.setOrder(local, 'f', ['nested', 'a', 'b', 'c', 'localNew']);
    sync.setOrder(remote, 'f', ['nested', 'a', 'b', 'c', 'remoteNew']);
    let merged = sync.merge(base, local, remote);
    assert.deepEqual(merged.conflicts, []);
    assert.deepEqual(sync.children(merged.data, 'f'), ['nested', 'a', 'b', 'c', 'remoteNew', 'localNew']);
    validateMerge(merged);

    const mine = orderedLibrary(), theirs = orderedLibrary();
    delete mine.snippets.a; mine.folders.f.order = ['nested', 'b', 'c'];
    delete theirs.snippets.b; theirs.folders.f.order = ['nested', 'a', 'c'];
    merged = sync.merge(base, mine, theirs);
    assert.deepEqual(merged.conflicts, []);
    assert.deepEqual(sync.children(merged.data, 'f'), ['nested', 'c']);
    validateMerge(merged);
});

test('a one-sided reorder survives concurrent creation and deletion of other siblings', () => {
    const base = orderedLibrary(), local = orderedLibrary(), remote = orderedLibrary();
    sync.setOrder(local, 'f', ['c', 'b', 'a', 'nested']);
    delete remote.snippets.b; remote.folders.f.order = ['nested', 'a', 'c'];
    add(remote, 'newChild');
    const merged = sync.merge(base, local, remote);
    assert.deepEqual(merged.conflicts, []);
    assert.deepEqual(sync.children(merged.data, 'f'), ['c', 'a', 'nested', 'newChild']);
    validateMerge(merged);
});

test('incompatible two-sided reorders conflict at that folder only and preserve the local order', () => {
    const base = orderedLibrary(), local = orderedLibrary(), remote = orderedLibrary();
    sync.setOrder(local, 'f', ['c', 'b', 'a', 'nested']);
    sync.setOrder(remote, 'f', ['a', 'nested', 'b', 'c']);
    const merged = sync.merge(base, local, remote);
    assert.deepEqual(merged.conflicts, ['folders.f.order']);
    assert.deepEqual(sync.children(merged.data, 'f'), ['c', 'b', 'a', 'nested']);
    validateMerge(merged);
});

test('root structure follows the same independent-add and incompatible-reorder rules', () => {
    const base = library(), local = library(), remote = library();
    sync.setOrder(local, null, ['f', 'root', 'g']);
    add(remote, 'newRoot', null);
    let merged = sync.merge(base, local, remote);
    assert.deepEqual(merged.conflicts, []);
    assert.deepEqual(merged.data.structure, ['f', 'root', 'g', 'newRoot']);
    validateMerge(merged);
    sync.setOrder(remote, null, ['root', 'g', 'f', 'newRoot']);
    merged = sync.merge(base, local, remote);
    assert.deepEqual(merged.conflicts, ['structure']);
    assert.deepEqual(merged.data.structure, ['f', 'root', 'g', 'newRoot']);
    validateMerge(merged);
});

test('merged orders prune moved child references and preserved drafts remain reachable after a folder deletion', () => {
    const base = orderedLibrary(), local = orderedLibrary(), remote = orderedLibrary();
    sync.setOrder(local, 'f', ['c', 'b', 'a', 'nested']);
    remote.snippets.b.parentId = 'g'; remote.folders.f.order = ['nested', 'a', 'c'];
    let merged = sync.merge(base, local, remote);
    assert.deepEqual(merged.conflicts, []);
    assert.deepEqual(sync.children(merged.data, 'f'), ['c', 'a', 'nested']);
    assert.deepEqual(sync.children(merged.data, 'g'), ['d', 'e', 'b']);
    validateMerge(merged);

    const mine = orderedLibrary(), theirs = orderedLibrary();
    mine.snippets.a.content = 'keep this draft';
    delete theirs.folders.f; delete theirs.folders.nested;
    for (const id of ['a', 'b', 'c']) delete theirs.snippets[id];
    theirs.structure = ['g', 'root'];
    merged = sync.merge(base, mine, theirs);
    assert.ok(merged.conflicts.includes('snippets.a'));
    assert.ok(merged.conflicts.includes('snippets.a.parentId'));
    assert.equal(merged.data.snippets.a.parentId, null);
    assert.ok(merged.data.structure.includes('a'));
    validateMerge(merged);
});

test('unchanged partial and missing folder preferences remain unchanged through canonical acknowledgement', () => {
    const base = library(); base.folders.f.order = ['c'];
    const pending = structuredClone(base); pending.snippets.a.content = 'saved';
    const local = structuredClone(pending); local.snippets.a.content = 'newer typing';
    const merged = sync.merge(pending, local, sync.canonical(pending));
    assert.deepEqual(merged.conflicts, []);
    assert.deepEqual(merged.data.folders.f.order, ['c']);
    assert.equal(Object.hasOwn(merged.data.folders.g, 'order'), false);
    assert.deepEqual(merged.data, local);
    validateMerge(merged);
});

test('legacy concurrent children remain legacy without manufacturing folder preferences', () => {
    const base = library(), local = library(), remote = library();
    add(local, 'localNew'); add(remote, 'remoteNew');
    const merged = sync.merge(base, local, remote);
    assert.deepEqual(merged.conflicts, []);
    for (const folder of Object.values(merged.data.folders)) assert.equal(Object.hasOwn(folder, 'order'), false);
    assert.deepEqual(new Set(sync.children(merged.data, 'f')), new Set(['nested', 'a', 'b', 'c', 'localNew', 'remoteNew']));
    validateMerge(merged);
});

test('folder order is durable and protected by snippet revision checks; item saves do not reset it', async t => {
    const db = new PGlite(); t.after(() => db.close());
    await db.exec(`CREATE TABLE user_registrations (nickname TEXT PRIMARY KEY, role TEXT, snippets_access BOOLEAN);
        INSERT INTO user_registrations VALUES ('editor','user',true);
        CREATE TABLE snippets_data (id SERIAL PRIMARY KEY,data JSONB,updated_at TIMESTAMP,updated_by TEXT);`);
    const pool = { query: (sql, values) => db.query(sql, values),
        async connect() { return { query: (sql, values) => db.query(sql, values), release() {} }; } };
    const initial = await state.saveSnippets(pool, 'editor', { snippets: library(), baseRevision: 0 });
    const data = library(); data.folders.f.order = ['c', 'a'];
    const saved = await state.saveSnippets(pool, 'editor', { snippets: data, baseRevision: initial.revision });
    assert.deepEqual((await state.readSnippets(pool)).snippets.folders.f.order, ['c', 'a']);
    await assert.rejects(state.saveSnippets(pool, 'editor', { snippets: library(), baseRevision: initial.revision }),
        { statusCode: 409, code: 'snippets_conflict' });
    const edited = await state.saveSnippets(pool, 'editor', { id: 'a', baseContent: 'first', content: 'edited' }, true);
    assert.deepEqual(edited.snippets.folders.f.order, ['c', 'a']);
    add(edited.snippets, 'newChild');
    const created = await state.saveSnippets(pool, 'editor', { snippets: edited.snippets, baseRevision: edited.revision });
    assert.deepEqual(created.snippets.folders.f.order, ['c', 'a']);
    assert.ok(sync.children(created.snippets, 'f').includes('newChild'));
    const invalid = structuredClone(created.snippets); invalid.folders.f.order.push('root');
    await assert.rejects(state.saveSnippets(pool, 'editor', { snippets: invalid, baseRevision: created.revision }),
        { statusCode: 400, code: 'invalid_snippets' });
    assert.ok(saved.revision < created.revision);
    assert.equal((await state.readSnippets(pool)).revision, created.revision);
});
