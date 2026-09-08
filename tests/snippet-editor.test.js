'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const ROOT = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function setup(t, options = {}) {
    const dom = new JSDOM('<!doctype html><body class="work-ui"><div id="host"></div></body>', {
        runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://editor.test'
    });
    const w = dom.window;
    w.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
    w.Range.prototype.getClientRects = () => [];
    w.eval(source('node_modules/quill/dist/quill.js'));
    w.eval(source('public/snippets-richtext.js'));
    w.eval(source('public/snippet-editor.js'));
    const host = w.document.getElementById('host');
    const changes = [];
    const editor = w.SnippetEditor.create(host, { content: 'Hello world', ...options, onChange: value => changes.push(plain(value)) });
    const quill = w.Quill.find(host.querySelector('.ql-container'));
    t.after(() => { editor.destroy(); dom.window.close(); });
    const click = name => {
        const button = host.querySelector(`[data-editor-action="${name}"]`);
        button.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        button.click();
    };
    function clipboard(type, data = {}, files = []) {
        const event = new w.Event(type, { bubbles: true, cancelable: true });
        const written = {};
        Object.defineProperty(event, 'clipboardData', { value: {
            files, getData: name => data[name] || '', setData: (name, value) => { written[name] = value; }
        } });
        editor.root.dispatchEvent(event);
        return { event, written };
    }
    return { w, host, editor, quill, changes, click, clipboard };
}

test('actual Quill renders canonical inline formatting while keeping exact plain content and literal HTML', t => {
    const content = 'Bold <img src=x>\nsecond\tline\n';
    const richText = { ops: [{ insert: 'Bold', attributes: { bold: true } }, { insert: ' <img src=x>\nsecond\tline\n\n' }] };
    const p = setup(t, { content, richText });
    assert.deepEqual(plain(p.editor.getValue()), { content, richText });
    assert.equal(p.editor.root.querySelector('strong').textContent, 'Bold');
    assert.equal(p.editor.root.querySelector('img'), null);
    assert.equal(p.quill.getText(), content + '\n');
    assert.deepEqual(p.changes, []);
    assert.equal(p.editor.root.getAttribute('role'), 'textbox');
    assert.equal(p.editor.root.getAttribute('aria-multiline'), 'true');
});

test('toolbar formatting preserves selected text for pointer and keyboard use and emits plain/rich parity', t => {
    const p = setup(t);
    p.quill.setSelection(0, 5, 'user');
    p.click('bold');
    assert.equal(p.editor.getValue().content, 'Hello world');
    assert.deepEqual(plain(p.editor.getValue().richText.ops[0]), { insert: 'Hello', attributes: { bold: true } });
    assert.deepEqual(plain(p.quill.getSelection()), { index: 0, length: 5 });
    assert.equal(p.host.querySelector('[data-editor-action="bold"]').getAttribute('aria-pressed'), 'true');
    const italic = p.host.querySelector('[data-editor-action="italic"]');
    italic.focus();
    italic.click();
    assert.equal(p.editor.getValue().richText.ops[0].attributes.italic, true);
    const color = p.host.querySelector('[data-editor-action="color"]');
    color.focus();
    color.value = '#93c5fd';
    color.dispatchEvent(new p.w.Event('change', { bubbles: true }));
    assert.equal(p.editor.getValue().richText.ops[0].attributes.color, '#93c5fd');
    assert.equal(p.changes.at(-1).content, 'Hello world');
    p.click('clean');
    assert.deepEqual(plain(p.editor.getValue()), { content: 'Hello world' });
});

test('bold/italic/underline native shortcuts and added strike shortcut edit the real Quill document', t => {
    const p = setup(t);
    p.quill.setSelection(0, 5, 'user');
    for (const [key, code, shiftKey] of [['b', 'KeyB', false], ['i', 'KeyI', false], ['u', 'KeyU', false], ['x', 'KeyX', true]]) {
        p.editor.root.dispatchEvent(new p.w.KeyboardEvent('keydown', { key, code, ctrlKey: true, shiftKey, bubbles: true, cancelable: true }));
    }
    assert.deepEqual(plain(p.editor.getValue().richText.ops[0].attributes), { bold: true, italic: true, underline: true, strike: true });
});

test('equal data and own acknowledgements preserve selection, scroll and undo; distinct remote data resets undo', t => {
    const p = setup(t);
    p.quill.setSelection(0, 5, 'user');
    p.click('bold');
    const historyCount = p.quill.history.stack.undo.length;
    assert.ok(historyCount > 0);
    p.editor.root.scrollTop = 80;
    p.editor.setValue(p.editor.getValue());
    assert.equal(p.quill.history.stack.undo.length, historyCount);
    assert.equal(p.editor.root.scrollTop, 80);
    assert.deepEqual(plain(p.quill.getSelection()), { index: 0, length: 5 });
    p.click('undo');
    assert.deepEqual(plain(p.editor.getValue()), { content: 'Hello world' });
    p.click('redo');
    assert.equal(p.editor.getValue().richText.ops[0].attributes.bold, true);
    p.editor.setValue({ content: 'Remote' });
    assert.equal(p.quill.history.stack.undo.length, 0);
    assert.deepEqual(plain(p.editor.getValue()), { content: 'Remote' });
});

test('readonly viewers display styles without an active toolbar or user writes and can be enabled later', t => {
    const p = setup(t, { content: 'Read', readOnly: true, richText: { ops: [{ insert: 'Read', attributes: { underline: true } }, { insert: '\n' }] } });
    assert.equal(p.host.querySelector('[role="toolbar"]').hidden, true);
    assert.equal(p.editor.root.getAttribute('aria-readonly'), 'true');
    assert.equal(p.editor.root.getAttribute('contenteditable'), 'false');
    assert.equal(p.editor.root.querySelector('u').textContent, 'Read');
    p.quill.insertText(0, 'blocked ', 'user');
    assert.equal(p.editor.getValue().content, 'Read');
    assert.deepEqual(p.changes, []);
    p.editor.setReadOnly(false);
    assert.equal(p.host.querySelector('[role="toolbar"]').hidden, false);
    p.quill.insertText(4, ' now', 'user');
    assert.equal(p.editor.getValue().content, 'Read now');
});

test('paste keeps supported text styles while stripping links, blocks, scripts, images, video and formula embeds', t => {
    const p = setup(t, { content: '' });
    p.quill.setSelection(0, 0, 'user');
    p.clipboard('paste', { 'text/html': '<h1><b>Safe</b> <a href="javascript:alert(1)">link</a></h1><img src=x onerror="window.attack=true"><video src=x>video</video><iframe src=x></iframe><span class="ql-formula" data-value="bad">formula</span><script>window.attack=true</script><p><span style="color:rgb(147,197,253); font-size:100px">Blue</span></p>' });
    const value = plain(p.editor.getValue());
    assert.match(value.content, /Safe link/);
    assert.match(value.content, /Blue/);
    assert.ok(!/formula|video|window.attack/.test(value.content));
    assert.equal(p.editor.root.querySelector('img,video,iframe,a,h1,script,.ql-formula'), null);
    assert.equal(p.w.attack, undefined);
    assert.ok(value.richText.ops.some(op => op.attributes?.bold === true));
    assert.ok(value.richText.ops.some(op => op.attributes?.color === '#93c5fd'));
    for (const op of value.richText.ops) {
        assert.equal(typeof op.insert, 'string');
        assert.ok(Object.keys(op.attributes || {}).every(key => ['bold', 'italic', 'underline', 'strike', 'color', 'background'].includes(key)));
    }
});

test('native copy and cut are plain only and never invoke the vulnerable semantic HTML exporter', t => {
    const p = setup(t);
    p.quill.setSelection(0, 5, 'user');
    p.click('bold');
    p.quill.getSemanticHTML = () => { throw new Error('HTML export must never execute'); };
    const copied = p.clipboard('copy');
    assert.deepEqual(copied.written, { 'text/plain': 'Hello', 'text/html': '' });
    const cut = p.clipboard('cut');
    assert.deepEqual(cut.written, { 'text/plain': 'Hello', 'text/html': '' });
    assert.equal(p.editor.getValue().content, ' world');
});

test('select-all native copying omits only the mandatory sentinel and retains real trailing newlines', t => {
    for (const content of ['Hello', 'Hello\n', 'Hello\n\n', '']) {
        const p = setup(t, { content });
        const all = p.quill.clipboard.onCopy({ index: 0, length: p.quill.getLength() });
        assert.deepEqual(plain(all), { text: content, html: '' });
        p.quill.setSelection(0, p.quill.getLength(), 'user');
        assert.equal(p.clipboard('copy').written['text/plain'], content);
    }
});

test('legacy CRLF and bare CR render as LF without losing trailing breaks or rewriting an untouched record', t => {
    const content = 'first\r\nsecond\rthird\r\n\nlast\r';
    const displayed = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const p = setup(t, { content });
    assert.deepEqual(plain(p.editor.getValue()), { content });
    assert.equal(p.quill.getText().slice(0, -1), displayed);
    assert.deepEqual(p.changes, []);
    p.editor.setValue({ content });
    assert.deepEqual(plain(p.editor.getValue()), { content });
    p.quill.insertText(0, 'Edited ', 'user');
    assert.equal(p.editor.getValue().content, 'Edited ' + displayed);
    assert.equal(p.quill.getText().slice(0, -1), p.editor.getValue().content);
});

test('CRLF split across formatted operations produces one visible newline, not two', t => {
    const content = 'first\r\nlast\r';
    const p = setup(t, { content, richText: { ops: [
        { insert: 'first\r', attributes: { bold: true } },
        { insert: '\nlast\r\n' }
    ] } });
    assert.equal(p.quill.getText(), 'first\nlast\n\n');
    assert.equal(p.editor.getValue().content, content);
    assert.equal(p.editor.root.querySelector('strong').textContent, 'first');
});

test('image-only paste and all drops are ignored; destroying an editor empties state and undo history', t => {
    const p = setup(t);
    p.quill.setSelection(0, 5, 'user');
    p.click('bold');
    const before = plain(p.editor.getValue());
    const paste = p.clipboard('paste', {}, [new p.w.File(['not a real image'], 'example.png', { type: 'image/png' })]);
    assert.equal(paste.event.defaultPrevented, true);
    const drop = new p.w.Event('drop', { bubbles: true, cancelable: true });
    p.editor.root.dispatchEvent(drop);
    assert.equal(drop.defaultPrevented, true);
    assert.deepEqual(plain(p.editor.getValue()), before);
    p.editor.destroy();
    assert.equal(p.host.childElementCount, 0);
    assert.equal(p.editor.root.textContent, '');
    assert.equal(p.quill.history.stack.undo.length, 0);
    assert.equal(p.quill.history.stack.redo.length, 0);
    assert.deepEqual(plain(p.editor.getValue()), { content: '' });
    assert.deepEqual(plain(p.quill.emitter.eventNames()), []);
    p.editor.setValue({ content: 'must not resurrect' });
    assert.deepEqual(plain(p.editor.getValue()), { content: '' });
});
