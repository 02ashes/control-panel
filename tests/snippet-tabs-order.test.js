'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const ROOT = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const storageKey = nickname => 'control-panel.snippet-tabs:' + encodeURIComponent(nickname);
const library = () => ({ folders: {}, snippets: Object.fromEntries(['a', 'b', 'c'].map(id => [id,
    { id, name: 'Name ' + id, content: 'Private content ' + id, parentId: null }
])), structure: ['a', 'b', 'c'] });

function setup(t, { saved = {}, role = 'user', nickname = 'alice', authorize = true } = {}) {
    const html = source('index.html');
    const dom = new JSDOM(html, { url: 'https://panel.test/admin', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    const context = dom.getInternalVMContext();
    const run = code => vm.runInContext(code, context);
    const timers = new Map();
    let nextTimer = 0;
    w.setTimeout = fn => { timers.set(++nextTimer, fn); return nextTimer; };
    w.clearTimeout = id => timers.delete(id);
    w.setInterval = () => ++nextTimer;
    w.clearInterval = () => {};
    w.console = { log() {}, error() {}, warn() {} };
    w.confirm = () => true;
    w.alert = () => {};
    w.ResizeObserver = class { observe() {} };
    w.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
    w.Range.prototype.getClientRects = () => [];
    w.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} });
    w.io = () => ({ connected: true, on() {}, once() {}, emit() {}, connect() {}, disconnect() {} });
    w.fetch = async () => { throw new Error('Ordering tabs must not send a shared-state request'); };
    for (const [key, value] of Object.entries(saved)) w.localStorage.setItem(key, value);
    for (const file of ['public/snippets-richtext.js', 'node_modules/quill/dist/quill.js', 'public/snippet-editor.js', 'public/snippets-sync.js']) run(source(file));
    for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
        if (script[1].trim()) run(script[1].replace('        ensureRegistration();', ''));
    }
    w.testNickname = nickname;
    w.testRole = role;
    run('currentNickname = testNickname; currentRole = testRole;');
    if (authorize) run('applySnippetsAccess(true);');
    t.after(() => { run('clearSnippetWorkspace();'); dom.window.close(); });
    const load = (data = library(), revision = 1) => {
        w.testSnapshot = data;
        w.testRevision = revision;
        run('receiveSnippets({snippets:testSnapshot, revision:testRevision});');
    };
    const open = (...ids) => ids.forEach(id => w.openSnippetViewer(id));
    const order = () => plain(run('openSnippets'));
    const title = id => [...w.document.querySelectorAll('.snippet-tab-title')].find(node => node.dataset.snippetId === id);
    function dragEvent(node, type, x = 0) {
        const event = new w.Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, { clientX: { value: x }, dataTransfer: { value: { setData() {}, effectAllowed: '', dropEffect: '' } } });
        node.dispatchEvent(event);
        return event;
    }
    return { w, dom, run, timers, load, open, order, title, dragEvent };
}

test('authorized snapshots restore private per-account tab ids/order/active state and prune deleted or duplicate ids', t => {
    const p = setup(t, { saved: {
        [storageKey('alice')]: JSON.stringify({ open: ['c', 'deleted', 'a', 'c'], active: 'a' }),
        [storageKey('bob')]: JSON.stringify({ open: ['b'], active: 'b' })
    } });
    assert.equal(p.w.restoreSnippetTabs(), false, 'Do not restore before authorized data has arrived');
    assert.deepEqual(p.order(), []);
    p.load();
    assert.deepEqual(p.order(), ['c', 'a']);
    assert.equal(p.run('activeSnippetId'), 'a');
    assert.ok(p.w.document.getElementById('snippet-content-a').classList.contains('active'));
    assert.deepEqual(JSON.parse(p.w.localStorage.getItem(storageKey('alice'))), { open: ['c', 'a'], active: 'a' });
    assert.deepEqual(JSON.parse(p.w.localStorage.getItem(storageKey('bob'))), { open: ['b'], active: 'b' });
    const remote = library(); delete remote.snippets.a; remote.structure = ['b', 'c'];
    p.load(remote, 2);
    assert.deepEqual(p.order(), ['c']);
    assert.deepEqual(JSON.parse(p.w.localStorage.getItem(storageKey('alice'))), { open: ['c'], active: 'c' });
});

test('open, activate, reorder and close persist only ids and active id, never private names or content', t => {
    const p = setup(t); p.load(); p.open('a', 'b', 'c');
    assert.equal(p.w.reorderSnippetTab('c', 'a', 'before'), true);
    p.w.switchToSnippetTab('b');
    assert.deepEqual(JSON.parse(p.w.localStorage.getItem(storageKey('alice'))), { open: ['c', 'a', 'b'], active: 'b' });
    p.w.closeSnippetTab('a');
    const saved = p.w.localStorage.getItem(storageKey('alice'));
    assert.deepEqual(JSON.parse(saved), { open: ['c', 'b'], active: 'b' });
    assert.ok(!/Private|Name|content|richText/.test(saved));
    assert.deepEqual(p.run('JSON.parse(JSON.stringify(snippetsData.structure))'), p.run("['a','b','c']"));
});

test('reordering leaves active rich editor, selection, undo, draft and autosave untouched', t => {
    const p = setup(t); p.load(); p.open('a', 'b', 'c'); p.w.switchToSnippetTab('a');
    const editor = p.run("snippetEditors.get('a')");
    const quill = p.w.Quill.find(editor.root.parentNode);
    quill.setSelection(0, 7, 'user');
    quill.formatText(0, 7, 'bold', true, 'user');
    const value = plain(editor.getValue());
    const historyLength = quill.history.stack.undo.length;
    const timeout = p.run("autoSaveTimeouts.get('a')");
    const selection = plain(quill.getSelection());
    const focused = p.w.document.activeElement;
    editor.root.scrollTop = 70;
    assert.equal(p.w.reorderSnippetTab('a', 'c', 'after'), true);
    assert.deepEqual(p.order(), ['b', 'c', 'a']);
    assert.equal(p.run('activeSnippetId'), 'a');
    assert.equal(p.run("snippetEditors.get('a')"), editor);
    assert.equal(p.w.document.activeElement, focused);
    assert.equal(editor.root.scrollTop, 70);
    assert.deepEqual(plain(quill.getSelection()), selection);
    assert.equal(quill.history.stack.undo.length, historyLength);
    assert.equal(p.run("autoSaveTimeouts.get('a')"), timeout);
    assert.deepEqual(plain(editor.getValue()), value);
});

test('reader can reorder with Alt+arrows without changing active tab and keyboard focus follows the moved title', t => {
    const p = setup(t, { role: 'reader' }); p.load(); p.open('a', 'b', 'c');
    p.title('a').focus();
    const event = new p.w.KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true });
    p.title('a').dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(p.order(), ['b', 'a', 'c']);
    assert.equal(p.run('activeSnippetId'), 'c');
    assert.equal(p.w.document.activeElement, p.title('a'));
    assert.match(p.w.document.getElementById('snippetTabOrderStatus').textContent, /2 из 3/);
    assert.match(p.title('a').getAttribute('aria-keyshortcuts'), /Alt\+ArrowLeft/);
    p.title('b').dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true }));
    assert.deepEqual(p.order(), ['b', 'a', 'c']);
    for (const modifier of ['ctrlKey', 'metaKey']) {
        const shortcut = new p.w.KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, [modifier]: true, bubbles: true, cancelable: true });
        p.title('b').dispatchEvent(shortcut);
        assert.equal(shortcut.defaultPrevented, false);
        assert.deepEqual(p.order(), ['b', 'a', 'c']);
    }
});

test('dragging supports before/after indicators, suppresses post-drop activation and cannot start from close', t => {
    const p = setup(t); p.load(); p.open('a', 'b', 'c');
    const close = p.title('a').parentNode.querySelector('.snippet-tab-close');
    assert.equal(close.draggable, false);
    assert.equal(p.dragEvent(close, 'dragstart').defaultPrevented, true);
    assert.equal(p.run('snippetTabDrag'), null);
    p.dragEvent(p.title('c'), 'dragstart');
    const target = p.title('a').parentNode;
    target.getBoundingClientRect = () => ({ left: 0, width: 100 });
    assert.equal(p.dragEvent(target, 'dragover', 10).defaultPrevented, true);
    assert.ok(target.classList.contains('tab-drop-before'));
    p.dragEvent(target, 'dragover', 90);
    assert.ok(target.classList.contains('tab-drop-after'));
    p.dragEvent(target, 'drop', 10);
    assert.deepEqual(p.order(), ['c', 'a', 'b']);
    assert.equal(p.run('activeSnippetId'), 'c');
    p.title('a').click();
    assert.equal(p.run('activeSnippetId'), 'c', 'A synthetic click after dropping must not activate the drop target');
    assert.equal(p.w.document.querySelector('.tab-drop-before,.tab-drop-after'), null);
    assert.equal(p.run('snippetTabDrag'), null);
});

test('revoke clears cached tab ids and drag state; default denied boot does not erase an authenticated reload preference', t => {
    const saved = JSON.stringify({ open: ['a'], active: 'a' });
    const p = setup(t, { authorize: false, saved: { [storageKey('alice')]: saved } });
    p.w.resetSnippetTabState();
    assert.equal(p.w.localStorage.getItem(storageKey('alice')), saved);
    p.load();
    assert.deepEqual(p.order(), []);
    assert.equal(p.w.reorderSnippetTab('a', 'b'), false);
    p.run('applySnippetsAccess(true);'); p.load(); p.open('b');
    p.dragEvent(p.title('a'), 'dragstart');
    assert.ok(p.run('snippetTabDrag'));
    p.run('applySnippetsAccess(false);');
    assert.equal(p.run('snippetTabDrag'), null);
    assert.equal(p.w.localStorage.getItem(storageKey('alice')), null);
    assert.deepEqual(p.order(), []);
    assert.equal(p.w.reorderSnippetTab('a', 'b'), false);
});

test('malformed local preferences and external drag payloads do not change an authorized workspace', t => {
    const p = setup(t, { saved: { [storageKey('alice')]: '{broken json' } });
    p.load(); p.open('a', 'b');
    const tab = p.title('b').parentNode;
    assert.equal(p.dragEvent(tab, 'drop', 0).defaultPrevented, false);
    assert.deepEqual(p.order(), ['a', 'b']);
    assert.equal(p.w.reorderSnippetTab('missing', 'a'), false);
    assert.equal(p.w.reorderSnippetTab('a', 'b', 'inside'), false);
});

test('edge dragging scrolls a narrow strip and a remote rerender cancels the detached source gesture', t => {
    const p = setup(t); p.load(); p.open('a', 'b', 'c');
    const strip = p.w.document.getElementById('snippetTabs');
    strip.getBoundingClientRect = () => ({ left: 0, right: 100, width: 100 });
    Object.defineProperties(strip, { clientWidth: { value: 100 }, scrollWidth: { value: 400 } });
    const frames = new Map();
    let frameId = 0;
    p.w.requestAnimationFrame = fn => { frames.set(++frameId, fn); return frameId; };
    p.w.cancelAnimationFrame = id => frames.delete(id);
    p.dragEvent(p.title('a'), 'dragstart');
    p.dragEvent(strip, 'dragover', 98);
    assert.ok(strip.scrollLeft > 0);
    assert.equal(frames.size, 1);
    const before = strip.scrollLeft;
    const [id, frame] = [...frames][0]; frames.delete(id); frame();
    assert.ok(strip.scrollLeft > before, 'Autoscroll continues while the pointer remains at the edge');
    p.dragEvent(strip, 'dragover', 50);
    assert.equal(frames.size, 0);
    p.dragEvent(strip, 'dragover', 2);
    assert.ok(strip.scrollLeft < before + 12);
    p.w.renderSnippetTabs();
    assert.equal(p.run('snippetTabDrag'), null);
    assert.equal(frames.size, 0);
    assert.equal(p.dragEvent(p.title('b').parentNode, 'drop', 0).defaultPrevented, false);
    assert.deepEqual(p.order(), ['a', 'b', 'c']);
});

test('opening and activating offscreen tabs reveal only the horizontal strip, not editor/page focus or scroll', t => {
    const p = setup(t); p.load();
    const strip = p.w.document.getElementById('snippetTabs');
    Object.defineProperties(strip, { clientWidth: { value: 100 }, scrollWidth: { value: 300 } });
    const baseBounds = p.w.HTMLElement.prototype.getBoundingClientRect;
    p.w.HTMLElement.prototype.getBoundingClientRect = function () {
        if (this === strip) return { left: 0, right: 100, width: 100 };
        if (this.classList.contains('snippet-tab')) {
            const index = [...strip.children].indexOf(this);
            const left = index * 100 - strip.scrollLeft;
            return { left, right: left + 100, width: 100 };
        }
        return baseBounds.call(this);
    };
    p.open('a', 'b', 'c');
    assert.equal(strip.scrollLeft, 200, 'Newly opened third tab is visible');
    const editor = p.run("snippetEditors.get('c')");
    editor.focus();
    editor.root.scrollTop = 55;
    const focused = p.w.document.activeElement;
    const pageScroll = p.w.document.documentElement.scrollTop;
    p.w.switchToSnippetTab('a');
    assert.equal(strip.scrollLeft, 0, 'Activating the first tab scrolls back horizontally');
    assert.equal(p.w.document.activeElement, focused);
    assert.equal(editor.root.scrollTop, 55);
    assert.equal(p.w.document.documentElement.scrollTop, pageScroll);
    // A background rerender must not drag the strip away from a position the
    // user chose manually while reading or preparing a different tab.
    strip.scrollLeft = 150;
    p.w.renderSnippetTabs();
    assert.equal(strip.scrollLeft, 150);
    p.title('a').focus();
    p.title('a').dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true }));
    assert.equal(strip.scrollLeft, 100, 'The keyboard-moved tab is brought into view');
});

test('restored active tab reveals once when the hidden strip becomes visible', t => {
    const p = setup(t, { saved: { [storageKey('alice')]: JSON.stringify({ open: ['a', 'b', 'c'], active: 'c' }) } });
    p.load();
    assert.equal(p.run('snippetTabPendingReveal'), 'c');
    const strip = p.w.document.getElementById('snippetTabs');
    Object.defineProperties(strip, { clientWidth: { value: 100 }, scrollWidth: { value: 300 } });
    strip.getBoundingClientRect = () => ({ left: 20, right: 120, width: 100 });
    p.title('c').parentNode.getBoundingClientRect = () => ({ left: 220, right: 320, width: 100 });
    assert.equal(p.w.revealSnippetTab(), true);
    assert.equal(strip.scrollLeft, 200);
    assert.equal(p.run('snippetTabPendingReveal'), null);
    strip.scrollLeft = 40;
    p.w.renderSnippetTabs();
    assert.equal(strip.scrollLeft, 40);
    const changed = setup(t, { saved: { [storageKey('alice')]: JSON.stringify({ open: ['a', 'b', 'c'], active: 'c' }) } });
    changed.load();
    changed.w.switchToSnippetTab('a');
    assert.equal(changed.run('snippetTabPendingReveal'), null,
        'An explicit activation supersedes the hidden restored tab, even before geometry is available');
});
