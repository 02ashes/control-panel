'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const rich = require('../public/snippets-richtext');
const sync = require('../public/snippets-sync');

const library = () => ({ folders: {}, snippets: {
    a: { id: 'a', name: 'A', content: 'first', parentId: null },
    b: { id: 'b', name: 'B', content: 'second', parentId: null }
}, structure: ['a', 'b'] });
const format = (content, attributes) => rich.normalize({ ops: [{ insert: content, attributes }, { insert: '\n' }] }, content);

test('rich snippets preserve every legacy character and exactly one editor sentinel', () => {
    for (const content of ['', 'Hello', '\n', 'line one\n\nline two\n', '  spaces\t\r\n', 'Привет 🙂 <b>literal</b>']) {
        assert.equal(rich.plainText(rich.fromText(content)), content);
        assert.equal(rich.normalize(undefined, content), undefined);
        assert.equal(rich.normalize(rich.fromText(content), content), undefined);
    }
    assert.throws(() => rich.fromText(null), /invalid_snippet_rich_text/);
    assert.throws(() => rich.normalize(undefined, null), /invalid_snippet_rich_text/);
});

test('rich snippets canonicalize attribute order, colors and equivalent adjacent runs without mutating input', () => {
    const delta = { ops: [
        { insert: 'Hel', attributes: { color: '#AABBCC', bold: true, underline: true } },
        { insert: 'lo', attributes: { underline: true, bold: true, color: '#aabbcc' } },
        { insert: ' ', attributes: {} },
        { insert: 'world', attributes: { strike: true, italic: true, background: '#DDEEFF' } },
        { insert: '\n' }
    ] };
    const original = structuredClone(delta);
    const result = rich.normalize(delta, 'Hello world');
    assert.deepEqual(result, { ops: [
        { insert: 'Hello', attributes: { bold: true, underline: true, color: '#aabbcc' } },
        { insert: ' ' },
        { insert: 'world', attributes: { italic: true, strike: true, background: '#ddeeff' } },
        { insert: '\n' }
    ] });
    assert.deepEqual(delta, original);
    assert.deepEqual(rich.normalize(result, 'Hello world'), result);
    assert.equal(rich.plainText(result), 'Hello world');
});

test('rich snippets ignore style on the sentinel only while preserving styled user newlines', () => {
    assert.equal(rich.normalize({ ops: [{ insert: '\n', attributes: { bold: true } }] }, ''), undefined);
    assert.equal(rich.normalize({ ops: [{ insert: 'plain' }, { insert: '\n', attributes: { color: '#abcdef' } }] }, 'plain'), undefined);
    assert.deepEqual(rich.normalize({ ops: [{ insert: 'bold\n\n', attributes: { bold: true } }] }, 'bold\n'),
        { ops: [{ insert: 'bold\n', attributes: { bold: true } }, { insert: '\n' }] });
});

test('rich snippets reject malformed documents, missing sentinel and content mismatch', () => {
    const invalid = [
        null, 'text', [], {}, { ops: [] }, { ops: [{ insert: '' }] },
        { ops: [{ insert: 'plain' }] }, { ops: [{ insert: 3 }] },
        { ops: [{ insert: 'different\n' }] }, { ops: [{ insert: 'plain\n\n' }] },
        { ops: [null] }, { ops: [{ insert: 'plain\n' }], html: '<p>plain</p>' },
        { ops: [{ insert: 'plain\n', attributes: null }] },
        { ops: [{ insert: 'plain\n', attributes: [] }] },
        { ops: [{ insert: 'plain\n', attributes: 'bold' }] }
    ];
    for (const delta of invalid) assert.throws(() => rich.normalize(delta, 'plain'), /invalid_snippet_rich_text/);
    assert.throws(() => rich.plainText({ ops: [{ insert: 'no marker' }] }), /invalid_snippet_rich_text/);
});

test('rich snippets reject executable HTML, links, embeds, non-inline formats and edit deltas', () => {
    const badOps = [
        { insert: { image: 'https://tracking.invalid/pixel' } },
        { insert: { video: 'javascript:alert(1)' } },
        { insert: { html: '<script>alert(1)</script>' } },
        { insert: 'plain\n', attributes: { link: 'javascript:alert(1)' } },
        { insert: 'plain\n', attributes: { style: 'background:url(https://tracking.invalid)' } },
        { insert: 'plain\n', attributes: { onclick: 'alert(1)' } },
        { insert: 'plain\n', attributes: { header: 1 } },
        { insert: 'plain\n', attributes: { list: 'ordered' } },
        { insert: 'plain\n', attributes: { font: 'serif' } },
        { insert: 'plain\n', html: '<b>unsafe extension</b>' },
        { retain: 3 }, { delete: 3 }, { insert: 'plain\n', retain: 3 },
        JSON.parse('{"insert":"plain\\n","attributes":{"__proto__":{"polluted":true}}}')
    ];
    for (const op of badOps) assert.throws(() => rich.normalize({ ops: [op] }, 'plain'), /invalid_snippet_rich_text/);
    assert.equal({}.polluted, undefined);
    const literal = '<img src=x onerror="alert(1)">';
    const safe = { ops: [{ insert: literal, attributes: { bold: true } }, { insert: '\n' }] };
    assert.equal(rich.plainText(rich.normalize(safe, literal)), literal);
});

test('rich snippets accept only explicit boolean flags and six-digit hex colors', () => {
    for (const name of ['bold', 'italic', 'underline', 'strike']) {
        for (const value of [false, null, 'true', 1, {}, []]) {
            assert.throws(() => rich.normalize({ ops: [{ insert: 'x\n', attributes: { [name]: value } }] }, 'x'), /invalid_snippet_rich_text/);
        }
    }
    for (const name of ['color', 'background']) {
        for (const value of ['red', '#fff', '#12345678', 'rgb(1,2,3)', '#123456;display:none', 'url(javascript:alert(1))', 'expression(alert(1))', null, 123456]) {
            assert.throws(() => rich.normalize({ ops: [{ insert: 'x\n', attributes: { [name]: value } }] }, 'x'), /invalid_snippet_rich_text/);
        }
    }
});

test('rich snippets enforce text and operation bounds before accepting large data', () => {
    const max = 'x'.repeat(rich.MAX_CONTENT_LENGTH);
    assert.equal(rich.plainText(rich.fromText(max)).length, rich.MAX_CONTENT_LENGTH);
    assert.throws(() => rich.fromText(max + 'x'), /invalid_snippet_rich_text/);
    assert.throws(() => rich.plainText({ ops: [{ insert: max + 'x\n' }] }), /invalid_snippet_rich_text/);
    const ops = Array.from({ length: rich.MAX_OPS }, () => ({ insert: 'x' }));
    ops.push({ insert: '\n' });
    assert.throws(() => rich.normalize({ ops }, 'x'.repeat(rich.MAX_OPS)), /invalid_snippet_rich_text/);
    const alternating = Array.from({ length: rich.MAX_OPS }, (_, index) => ({
        insert: index === rich.MAX_OPS - 1 ? 'x\n' : 'x',
        attributes: index % 2 ? { bold: true } : { italic: true }
    }));
    // Splitting an attributed sentinel must not produce an invalid canonical
    // document that passes once but fails on its next save.
    assert.throws(() => rich.normalize({ ops: alternating }, 'x'.repeat(rich.MAX_OPS)), /invalid_snippet_rich_text/);
});

test('rich snippets publish an independent browser model with the same canonical storage shape', () => {
    const context = vm.createContext({});
    vm.runInContext(fs.readFileSync(require.resolve('../public/snippets-richtext'), 'utf8'), context);
    assert.equal(typeof context.SnippetsRichText.normalize, 'function');
    assert.equal(context.SnippetsRichText.plainText(context.SnippetsRichText.fromText('browser\n')), 'browser\n');
    const input = { ops: [{ insert: 'same\n', attributes: { color: '#ABCDEF', bold: true } }] };
    assert.equal(JSON.stringify(context.SnippetsRichText.normalize(input, 'same')), JSON.stringify(rich.normalize(input, 'same')));
});

test('rich snippet merge keeps text and formatting atomic when local marks conflict with remote text', () => {
    const base = library(), local = library(), remote = library();
    local.snippets.a.richText = format('first', { bold: true });
    remote.snippets.a.content = 'remote text';
    remote.snippets.a.richText = format('remote text', { color: '#abcdef' });
    const before = structuredClone({ base, local, remote });
    const merged = sync.merge(base, local, remote);
    assert.deepEqual(merged.conflicts, ['snippets.a.content']);
    assert.deepEqual(merged.data.snippets.a, local.snippets.a);
    assert.equal(sync.valid(merged.data), true);
    assert.equal(rich.plainText(merged.data.snippets.a.richText), merged.data.snippets.a.content);
    assert.deepEqual({ base, local, remote }, before);
});

test('rich snippet merge combines edits to separate documents without losing formatting', () => {
    const base = library(), local = library(), remote = library();
    local.snippets.a.richText = format('first', { bold: true });
    remote.snippets.b.content = 'changed second';
    remote.snippets.b.richText = format('changed second', { background: '#ddffcc' });
    const merged = sync.merge(base, local, remote);
    assert.deepEqual(merged.conflicts, []);
    assert.deepEqual(merged.data.snippets.a, local.snippets.a);
    assert.deepEqual(merged.data.snippets.b, remote.snippets.b);
    assert.equal(sync.valid(merged.data), true);
});

test('rich snippet merge combines a title-only edit with remote text formatting', () => {
    const base = library(), local = library(), remote = library();
    local.snippets.a.name = 'Better title';
    remote.snippets.a.richText = format('first', { underline: true });
    const merged = sync.merge(base, local, remote);
    assert.deepEqual(merged.conflicts, []);
    assert.equal(merged.data.snippets.a.name, 'Better title');
    assert.deepEqual(merged.data.snippets.a.richText, remote.snippets.a.richText);
    assert.equal(sync.valid(merged.data), true);
});

test('rich snippet deletion versus formatting retains the local draft and reachable root', () => {
    const base = library(), local = library(), remote = library();
    local.snippets.a.richText = format('first', { italic: true });
    delete remote.snippets.a;
    remote.structure = ['b'];
    const merged = sync.merge(base, local, remote);
    assert.deepEqual(merged.conflicts, ['snippets.a']);
    assert.deepEqual(merged.data.snippets.a, local.snippets.a);
    assert.equal(merged.data.structure.filter(id => id === 'a').length, 1);
    assert.equal(sync.valid(merged.data), true);
});

test('rich snippet canonical acknowledgement does not conflict with typing after an in-flight save', () => {
    const pending = library();
    pending.snippets.a.richText = { ops: [
        { insert: 'fir', attributes: { color: '#ABCDEF', bold: true } },
        { insert: 'st\n', attributes: { bold: true, color: '#abcdef' } }
    ] };
    const local = structuredClone(pending);
    local.snippets.a.content = 'first!';
    local.snippets.a.richText = { ops: [{ insert: 'first!\n', attributes: { color: '#ABCDEF', bold: true } }] };
    const acknowledgement = sync.canonical(pending);
    assert.equal(sync.equal(sync.canonical(pending), acknowledgement), true);
    const merged = sync.merge(pending, local, acknowledgement);
    assert.deepEqual(merged.conflicts, []);
    assert.deepEqual(merged.data, sync.canonical(local));
    assert.equal(sync.valid(merged.data), true);
});

test('rich snippet canonicalization leaves plain legacy snapshots unchanged and rejects malformed rich content', () => {
    const legacy = library();
    assert.deepEqual(sync.canonical(legacy), legacy);
    assert.deepEqual(sync.merge(legacy, structuredClone(legacy), structuredClone(legacy)), { data: legacy, conflicts: [] });
    legacy.snippets.a.richText = rich.fromText('first');
    assert.equal(Object.hasOwn(sync.canonical(legacy).snippets.a, 'richText'), false);
    for (const richText of [null, { ops: [{ insert: 'wrong\n' }] }, { ops: [{ insert: { image: '/external' } }, { insert: '\n' }] }]) {
        legacy.snippets.a.richText = richText;
        assert.equal(sync.valid(legacy), false);
        assert.throws(() => sync.canonical(legacy), /invalid_snippet_rich_text/);
    }
});
