const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const sync = require('../public/snippets-sync');
const root = path.join(__dirname, '..');
const empty = () => ({ folders: {}, snippets: {}, structure: [] });
const library = () => ({ folders: {}, snippets: {
    a: { id: 'a', name: 'A', content: 'first', parentId: null },
    b: { id: 'b', name: 'B', content: 'second', parentId: null }
}, structure: ['a', 'b'] });
const reply = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function panel(file = 'index.html') {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const dom = new JSDOM(source, { url: 'https://panel.test/index.html', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    const context = dom.getInternalVMContext();
    const run = code => vm.runInContext(code, context);
    const listeners = new Map();
    const timeouts = new Map();
    const intervals = new Map();
    let timerId = 0;
    w.setTimeout = fn => { timeouts.set(++timerId, fn); return timerId; };
    w.clearTimeout = id => timeouts.delete(id);
    w.setInterval = fn => { intervals.set(++timerId, fn); return timerId; };
    w.clearInterval = () => {};
    w.alert = () => {};
    w.HTMLMediaElement.prototype.play = async () => {};
    w.HTMLMediaElement.prototype.pause = () => {};
    if (file === 'wheel.html') {
        const addListener = w.addEventListener.bind(w);
        w.addEventListener = (name, ...args) => { if (name !== 'load') addListener(name, ...args); };
    }
    w.confirm = () => true;
    w.ResizeObserver = class { observe() {} };
    w.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} });
    w.io = () => ({ connected: true, on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); }, once() {}, emit() {}, connect() {}, disconnect() {} });
    w.fetch = async () => reply(200, { ok: true, snippets: empty(), revision: '0', sessions: [] });
    w.console = { log() {}, error() {}, warn() {} };
    w.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
    w.Range.prototype.getClientRects = () => [];
    w.document.execCommand = () => false;
    run(fs.readFileSync(path.join(root, 'public/snippets-richtext.js'), 'utf8'));
    if (file === 'index.html') {
        run(fs.readFileSync(path.join(root, 'node_modules/quill/dist/quill.js'), 'utf8'));
        run(fs.readFileSync(path.join(root, 'public/snippet-editor.js'), 'utf8'));
    }
    run(fs.readFileSync(path.join(root, 'public/snippets-sync.js'), 'utf8'));
    for (const script of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
        let code = script[1];
        if (!code.trim()) continue;
        // Disable only automatic login/requests; execute the actual app functions.
        code = code.replace('        ensureRegistration();', '');
        if (file === 'logs.html') code = code.replace(/        \(async function \(\) \{[\s\S]*?        \}\)\(\);/, '');
        run(code);
    }
    return { w, dom, listeners, timeouts, intervals, run, emit: (name, data) => (listeners.get(name) || []).forEach(fn => fn(data)) };
}
function initEditor(p, data = library()) {
    p.w.seed = data;
    p.run("currentNickname = 'alice'; currentRole = 'user'; applySnippetsAccess(true); receiveSnippets({snippets:seed, revision:'1'});");
}
function snippetEditor(p, id) {
    p.w.testSnippetId = id;
    return p.run('snippetEditors.get(testSnippetId)');
}
function draft(p, id, text) {
    snippetEditor(p, id).setValue({ content: text });
    p.w.autoSaveSnippet(id);
}

test('merge preserves disjoint changes, detects same-field conflict and never mutates inputs', () => {
    const base = library(), mine = library(), theirs = library();
    mine.snippets.a.content = 'mine'; theirs.snippets.b.content = 'theirs';
    let result = sync.merge(base, mine, theirs);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.data.snippets.a.content, 'mine');
    assert.equal(result.data.snippets.b.content, 'theirs');
    theirs.snippets.a.content = 'other';
    result = sync.merge(base, mine, theirs);
    assert.deepEqual(result.conflicts, ['snippets.a.content']);
    assert.equal(result.data.snippets.a.content, 'mine');
    assert.equal(base.snippets.a.content, 'first');
});

test('remote inactive-tab updates cannot be replaced by stale DOM when tab opens', t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p);
    p.w.openSnippetViewer('b'); p.w.openSnippetViewer('a');
    const remote = library(); remote.snippets.b.content = 'updated by colleague';
    p.emit('snippets-updated', { snippets: remote, revision: '2' });
    const editor = snippetEditor(p, 'b');
    assert.equal(editor.getValue().content, 'updated by colleague');
    p.w.switchToSnippetTab('b'); draft(p, 'b', editor.getValue().content + '!');
    assert.equal(p.run('snippetsData.snippets.b.content'), 'updated by colleague!');
});

test('in-flight input is protected and conflicting remote edits block autosave visibly', async t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p); p.w.openSnippetViewer('a');
    draft(p, 'a', 'local draft');
    const remote = library(); remote.snippets.a.content = 'remote';
    p.emit('snippets-updated', { snippets: remote, revision: '2' });
    let writes = 0; p.w.fetch = async () => { writes++; throw new Error('must not save conflict'); };
    assert.equal(await p.w.saveSnippets(), false);
    assert.equal(writes, 0);
    assert.equal(snippetEditor(p, 'a').getValue().content, 'local draft');
    assert.match(p.w.document.getElementById('snippetSaveStatus').textContent, /Конфликт/);
});

test('rapid edits serialize saves and own socket acknowledgement preserves newer typing', async t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p); p.w.openSnippetViewer('a');
    draft(p, 'a', 'first edit');
    const first = deferred(); const writes = [];
    p.w.fetch = async (url, options) => {
        const body = JSON.parse(options.body); writes.push(body);
        if (writes.length === 1) return first.promise;
        return reply(200, { snippets: body.snippets, revision: '3' });
    };
    const saving = p.w.saveSnippets();
    draft(p, 'a', 'second edit');
    p.emit('snippets-updated', { snippets: writes[0].snippets, revision: '2' });
    assert.equal(p.run('snippetsData.snippets.a.content'), 'second edit');
    assert.equal(p.run('snippetsConflicts.length'), 0);
    first.resolve(reply(200, { snippets: writes[0].snippets, revision: '2' }));
    assert.equal(await saving, true);
    assert.equal(writes.length, 2);
    assert.equal(writes[1].baseRevision, 2);
    assert.equal(writes[1].snippets.snippets.a.content, 'second edit');
    assert.equal(p.run('hasUnsavedSnippets()'), false);
});

test('failed save leaves draft dirty and retryable; retry carries latest revision', async t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p); p.w.openSnippetViewer('a');
    draft(p, 'a', 'keep this');
    p.w.fetch = async () => { throw new Error('offline'); };
    assert.equal(await p.w.saveSnippets(), false);
    assert.equal(p.run('hasUnsavedSnippets()'), true);
    assert.match(p.w.document.getElementById('snippetSaveStatus').textContent, /Повторить сохранение/);
    p.w.fetch = async (url, options) => reply(200, { snippets: JSON.parse(options.body).snippets, revision: '2' });
    assert.equal(await p.w.saveSnippets(), true);
    assert.equal(p.run('hasUnsavedSnippets()'), false);
});

test('closing a dirty tab flushes debounce and safely deletes its editor DOM', async t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p); p.w.openSnippetViewer('a');
    draft(p, 'a', 'before close'); let saved;
    p.w.fetch = async (url, options) => { saved = JSON.parse(options.body); return reply(200, { snippets: saved.snippets, revision: '2' }); };
    p.w.closeSnippetTab('a'); await p.run('snippetsSavePromise');
    assert.equal(saved.snippets.snippets.a.content, 'before close');
    assert.equal(p.w.document.getElementById('snippet-content-a'), null);
    p.w.openSnippetViewer('a');
    assert.equal(snippetEditor(p, 'a').getValue().content, 'before close');
});

test('nickname, snippet names and IDs stay text, not executable markup or handlers', async t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p);
    const payload = '\"><img src=x onerror="window.pwned=1">\'\\';
    p.emit('online-update', [payload]);
    assert.equal(p.w.document.querySelector('#onlineList li').textContent, payload);
    assert.equal(p.w.document.querySelector('#onlineList img'), null);
    const data = empty(); data.snippets[payload] = { id: payload, name: payload, content: payload, parentId: null }; data.structure = [payload];
    p.w.seed = data; p.run('snippetsData = seed; refreshSnippetEditors();'); p.w.openSnippetViewer(payload);
    assert.equal(p.w.document.querySelector('.snippet-editor-title').value, payload);
    assert.equal(p.w.document.querySelector('#snippetContents img'), null);
    assert.equal(p.w.document.querySelector('[onerror]'), null);
    p.w.fetch = async () => reply(200, { users: [{ nickname: payload, role: 'user', registered_at: new Date().toISOString() }] });
    p.run("currentRole = 'admin';");
    await p.w.showUsersModal();
    assert.equal(p.w.document.querySelector('.role-select').dataset.nickname, payload);
    assert.equal(p.w.document.querySelector('#usersTableBody img'), null);
});

test('appending chat messages preserves existing audio element and escapes voice metadata', t => {
    const p = panel(); t.after(() => p.dom.window.close());
    p.w.displayMessage({ type: 'voice', from: 'admin', voiceFile: '\" onerror=bad ', duration: '<img src=x>', timestamp: Date.now() });
    const audio = p.w.document.querySelector('#chatMessages audio');
    p.w.displayMessage({ text: 'next', timestamp: Date.now() });
    assert.equal(p.w.document.querySelector('#chatMessages audio'), audio);
    assert.equal(p.w.document.querySelector('#chatMessages img'), null);
    assert.equal(p.w.document.querySelector('#chatMessages source').hasAttribute('onerror'), false);
});

test('session list is server-owned and malformed/shared account cache is ignored', async t => {
    const p = panel(); t.after(() => p.dom.window.close());
    p.w.localStorage.setItem('lovenseLinks', '{broken');
    p.run("currentNickname = 'alice';");
    p.w.fetch = async () => reply(200, { sessions: [
        { id: 'alice-link', creator_nickname: 'alice', created_at: new Date().toISOString(), expires_at: null },
        { id: 'bob-link', creator_nickname: 'bob', created_at: new Date().toISOString() }
    ] });
    await p.w.loadLinks();
    assert.equal(p.w.document.querySelectorAll('.link-item').length, 1);
    assert.equal(p.w.document.querySelector('.link-item').dataset.linkId, 'alice-link');
    assert.match(p.w.localStorage.getItem('lovenseLinks:alice'), /alice-link/);
    p.w.clearAccountLinks();
    assert.equal(p.w.localStorage.getItem('lovenseLinks:alice'), null);
    assert.equal(p.w.document.querySelectorAll('.link-item').length, 0);
});

test('late session-list response cannot restore links from a previous account', async t => {
    const p = panel(); t.after(() => p.dom.window.close());
    const request = deferred(); p.w.fetch = () => request.promise; p.run("currentNickname = 'alice';");
    const loading = p.w.loadLinks(); p.w.clearAccountLinks(); p.run("currentNickname = 'bob';");
    request.resolve(reply(200, { sessions: [{ id: 'alice-private', creator_nickname: 'alice' }] })); await loading;
    assert.equal(p.run('links.length'), 0);
});

test('logs renders hostile nickname safely and delete handler receives the original nickname', t => {
    const p = panel('logs.html'); t.after(() => p.dom.window.close());
    const payload = '\"><img src=x onerror="pwned=1">\'\\'; p.w.payload = payload;
    p.run("allRegistrations = [{nickname:payload, invited_by:payload, invite_code:payload, registered_at:'2025-01-01'}]; renderRegistrations();");
    assert.equal(p.w.document.querySelector('#sessionsList img'), null);
    assert.equal(p.w.document.querySelector('[data-delete-user]').dataset.deleteUser, payload);
    p.run('deleteUser = nickname => { window.deleted = nickname; };');
    p.w.document.querySelector('[data-delete-user]').click();
    assert.equal(p.w.deleted, payload);
    p.w.renderMessages([{ from: 'admin', text: 'hello', timestamp: Date.now() }], payload);
    assert.equal(p.w.document.querySelector('#chatMessages img'), null);
    assert.match(p.w.document.querySelector('#chatMessages').textContent, /hello/);
});

test('a 409 with unrelated edits safely rebases and retries without discarding either user', async t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p); p.w.openSnippetViewer('a');
    draft(p, 'a', 'local');
    const remote = library(); remote.snippets.b.content = 'remote';
    const writes = [];
    p.w.fetch = async (url, options) => {
        const body = JSON.parse(options.body); writes.push(body);
        return writes.length === 1 ? reply(409, { snippets: remote, revision: 2 }) : reply(200, { snippets: body.snippets, revision: 3 });
    };
    assert.equal(await p.w.saveSnippets(), true);
    assert.equal(writes.length, 2);
    assert.equal(writes[1].baseRevision, 2);
    assert.equal(writes[1].snippets.snippets.a.content, 'local');
    assert.equal(writes[1].snippets.snippets.b.content, 'remote');
});

test('reader can copy but cannot mutate snippets in the editor', async t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p);
    p.run("currentRole = 'reader'; renderSnippetsTree();"); p.w.openSnippetViewer('a');
    assert.equal(p.w.document.querySelector('.snippet-editor-title').readOnly, true);
    assert.equal(snippetEditor(p, 'a').root.getAttribute('contenteditable'), 'false');
    assert.equal(await p.w.saveSnippets(), false);
    assert.equal([...p.w.document.querySelectorAll('#snippetTree .snippet-mutation')].every(button => button.hidden), true);
});

test('delete-versus-edit conflict retains a reachable local draft, not an orphan', () => {
    const base = library(), local = library(), remote = library();
    local.snippets.a.content = 'unsaved'; delete remote.snippets.a; remote.structure = ['b'];
    const result = sync.merge(base, local, remote);
    assert.equal(result.data.snippets.a.content, 'unsaved');
    assert.ok(result.data.structure.includes('a'));
    assert.ok(result.conflicts.includes('snippets.a'));
});

test('nested folders render and deleting a folder also closes all descendant editors', async t => {
    const p = panel(); t.after(() => p.dom.window.close());
    const data = library();
    data.folders = { parent: { id:'parent', name:'Parent', parentId:null }, child: { id:'child', name:'Child', parentId:'parent' } };
    data.snippets.a.parentId = 'child'; data.structure = ['parent','b'];
    initEditor(p,data); p.run('expandedFolders = {parent:true,child:true}; renderSnippetsTree();');
    assert.equal(p.w.document.querySelectorAll('.snippet-folder').length, 2);
    p.w.openSnippetViewer('a');
    p.w.fetch = async (url, options) => reply(200, { snippets: JSON.parse(options.body).snippets, revision:2 });
    p.w.deleteSnippetFolder('parent'); await p.run('snippetsSavePromise');
    assert.equal(p.run('Object.keys(snippetsData.folders).length'), 0);
    assert.equal(p.run('snippetsData.snippets.a'), undefined);
    assert.equal(p.w.document.getElementById('snippet-content-a'), null);
    assert.equal(p.run('openSnippets.length'), 0);
});

test('chat input is cleared only on acknowledgement and never erases subsequent typing', t => {
    const p = panel(); t.after(() => p.dom.window.close());
    p.run("currentChatSessionId='session-a'; socket.emit = (event, payload, callback) => { window.ack = callback; window.sent = payload; };");
    const input = p.w.document.getElementById('chatInput'); input.value = 'keep until confirmed';
    p.w.sendChatMessage();
    assert.equal(input.value, 'keep until confirmed');
    p.w.ack({ ok:false, error:'database_error' });
    assert.equal(input.value, 'keep until confirmed');
    p.w.sendChatMessage(); input.value = 'newer typing'; input.dispatchEvent(new p.w.Event('input'));
    p.w.ack({ ok:true, messageId:'one' });
    assert.equal(input.value, 'newer typing');
    p.w.sendChatMessage(); p.w.ack({ ok:true, messageId:'two' });
    assert.equal(input.value, '');
});

test('chat drafts do not leak into a different control session', t => {
    const p = panel(); t.after(() => p.dom.window.close());
    p.w.openChat('first'); p.w.document.getElementById('chatInput').value = 'first session draft';
    p.w.openChat('second'); assert.equal(p.w.document.getElementById('chatInput').value, '');
    p.w.openChat('first'); assert.equal(p.w.document.getElementById('chatInput').value, 'first session draft');
});

test('log search in snippets mode actually searches snippet logs', t => {
    const p = panel('logs.html'); t.after(() => p.dom.window.close());
    p.run("applySnippetAccess(true); allSnippetLogs = [{user_nickname:'alice',item_name:'Find me',action:'edit',item_type:'snippet',timestamp:'2025-01-01'}];");
    p.w.document.getElementById('viewMode').value = 'snippets';
    const search = p.w.document.getElementById('searchInput'); search.value = 'find'; search.dispatchEvent(new p.w.Event('input'));
    assert.match(p.w.document.getElementById('sessionsList').textContent, /Find me/);
});

test('wheel blocks concurrent code checks and does not change the active code mid-spin', async t => {
    const p = panel('wheel.html'); t.after(() => p.dom.window.close());
    p.run('spinWheel = prize => { window.startedPrize = prize; isSpinning = true; };');
    let requests = 0; const check = deferred();
    p.w.fetch = () => { requests++; return check.promise; };
    p.w.document.getElementById('codeInput').value = 'AAAA1111';
    const first = p.w.checkCodeAndSpin();
    p.w.document.getElementById('codeInput').value = 'BBBB2222';
    await p.w.checkCodeAndSpin();
    assert.equal(requests, 1);
    check.resolve(reply(200, { targetPrize:'Lovense' })); await first;
    assert.equal(p.run('currentCode'), 'AAAA1111');
    assert.equal(p.w.document.getElementById('spinBtn').disabled, true);
});

test('wheel only announces persisted results and retries the same result after a network failure', async t => {
    const p = panel('wheel.html'); t.after(() => p.dom.window.close());
    p.run("pendingWheelResult = {code:'AAAA1111',prize:'Lovense'}; showResult = prize => { window.announced = prize; };");
    p.w.fetch = async () => { throw new Error('network'); };
    assert.equal(await p.w.sendResult(), false);
    assert.equal(p.w.announced, undefined);
    assert.match(p.w.document.getElementById('spinBtn').textContent, /Повторить сохранение/);
    p.w.document.getElementById('codeInput').value = 'BBBB2222';
    let body; p.w.fetch = async (url, options) => { body=JSON.parse(options.body); return reply(200, {ok:true,prize:'Lovense',reused:true}); };
    await p.w.checkCodeAndSpin();
    assert.equal(body.code, 'AAAA1111');
    assert.equal(p.w.announced, 'Lovense');
    assert.equal(p.run('pendingWheelResult'), null);
});

test('forced account invalidation clears private editors, cancels autosaves and cannot be canceled by beforeunload', t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p); p.w.openSnippetViewer('a');
    draft(p,'a','private unsaved draft');
    assert.equal(p.run('autoSaveTimeouts.size'), 1);
    const ordinary = new p.w.Event('beforeunload', { cancelable: true }); p.w.dispatchEvent(ordinary);
    assert.equal(ordinary.defaultPrevented, true);
    p.w.invalidateAuthenticatedPanel();
    assert.equal(p.w.document.getElementById('snippetContents').textContent, '');
    assert.equal(p.run('Object.keys(snippetsData.snippets).length'), 0);
    assert.equal(p.run('autoSaveTimeouts.size'), 0);
    assert.equal(p.w.document.getElementById('appRoot').style.display, 'none');
    assert.equal(p.w.document.getElementById('snippetsContainer').style.display, 'none');
    const forced = new p.w.Event('beforeunload', { cancelable: true }); p.w.dispatchEvent(forced);
    assert.equal(forced.defaultPrevented, false);
    p.emit('snippets-updated', { snippets:library(), revision:2 });
    assert.equal(p.run('Object.keys(snippetsData.snippets).length'), 0);
});

test('a late snippet POST acknowledgement cannot resurrect the previous account data', async t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p); p.w.openSnippetViewer('a'); draft(p,'a','old account');
    const response = deferred(); let payload;
    p.w.fetch = (url, options) => { payload = JSON.parse(options.body); return response.promise; };
    const saving = p.w.saveSnippets(); p.w.invalidateAuthenticatedPanel();
    response.resolve(reply(200, { snippets:payload.snippets, revision:2 }));
    assert.equal(await saving,false);
    assert.equal(p.run('Object.keys(snippetsData.snippets).length'),0);
    assert.equal(p.w.document.getElementById('snippetContents').textContent,'');
    assert.equal(p.run('snippetsSavePromise'),null);
});

test('a late snippet GET response cannot restore private content after forced logout', async t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p);
    const response = deferred(); p.w.fetch = () => response.promise;
    const loading = p.w.loadSnippets(); p.w.invalidateAuthenticatedPanel();
    response.resolve(reply(200, { snippets:library(), revision:2 }));
    assert.equal(await loading,false);
    assert.equal(p.run('Object.keys(snippetsData.snippets).length'),0);
});

test('voice sends announce success only after durable acknowledgement and reject visibly', t => {
    const p = panel(); t.after(() => p.dom.window.close());
    p.run("currentChatSessionId = 'session'; socket.emit = (event, payload, callback) => { window.ack = callback; };");
    p.w.document.getElementById('voicePicker').classList.add('show');
    p.w.sendVoiceMessage('voice','voice.ogg','0:05');
    assert.equal(p.w.document.getElementById('voicePicker').classList.contains('show'),true);
    assert.doesNotMatch(p.w.document.getElementById('toast').textContent,/отправлено/);
    p.w.ack({ok:false,error:'rate_limited'});
    assert.match(p.w.document.getElementById('toast').textContent,/Не удалось/);
    p.w.sendVoiceMessage('voice','voice.ogg','0:05'); p.w.ack({ok:true,messageId:'one'});
    assert.match(p.w.document.getElementById('toast').textContent,/отправлено/);
    assert.equal(p.w.document.getElementById('voicePicker').classList.contains('show'),false);
});

test('controller voice metadata stays text and filename is not executable inline code', t => {
    const html = fs.readFileSync(path.join(root, 'control.html'), 'utf8');
    const start = html.indexOf('    function addAdminMessage(');
    const end = html.indexOf('    function scroll()', start);
    const dom = new JSDOM('<div class="chat-list"><ul></ul></div>', { runScripts:'outside-only' }); t.after(() => dom.window.close());
    const context = dom.getInternalVMContext();
    vm.runInContext("const PINK_AVATAR='/avatar.png'; function scroll() {} function playVoice(element,file) { window.played=file; }",context);
    vm.runInContext(html.slice(start,end),context);
    const payload = '\'"><img src=x onerror="bad=1">';
    dom.window.addAdminMessage('',true,{voiceFile:payload,duration:payload});
    assert.equal(dom.window.document.querySelectorAll('img').length,1);
    assert.equal(dom.window.document.querySelector('[onerror]'),null);
    const voice = dom.window.document.querySelector('.voice-msg');
    assert.equal(voice.hasAttribute('onclick'),false);
    voice.click(); assert.equal(dom.window.played,payload);
});

function controllerComposer() {
    const html = fs.readFileSync(path.join(root,'control.html'),'utf8');
    const start = html.indexOf('    const displayedControllerMessageIds = new Set();');
    const end = html.indexOf('    function addUserMessage(t)',start);
    const dom = new JSDOM('<div><div class="inp" contenteditable="true"></div></div><ul id="messages"></ul>', {runScripts:'outside-only'});
    const w = dom.window, context=dom.getInternalVMContext(), timers=new Map(); let timer=0;
    w.setTimeout = fn => { timers.set(++timer,fn); return timer; }; w.clearTimeout = id => timers.delete(id);
    vm.runInContext("const sessionId='session'; const socket={connected:true,emit(event,payload,callback){ window.sent=payload; window.ack=callback; window.sendCount=(window.sendCount||0)+1; }}; function addUserMessage(text){const li=document.createElement('li');li.textContent=text;document.getElementById('messages').appendChild(li);}",context);
    vm.runInContext(html.slice(start,end),context);
    return {dom,w,timers,run:code=>vm.runInContext(code,context)};
}

test('controller send preserves failed draft/new typing and deduplicates durable broadcast versus ACK', t => {
    const p=controllerComposer(); t.after(()=>p.dom.window.close());
    const inp=p.w.document.querySelector('.inp'); inp.textContent='first';
    p.w.sendMessage();
    assert.equal(inp.textContent,'first');
    assert.equal(p.w.document.querySelectorAll('#messages li').length,0);
    p.w.ack({ok:false,error:'database_error'});
    assert.equal(inp.textContent,'first');
    assert.match(p.w.document.getElementById('controllerSendStatus').textContent,/not sent/);
    p.w.sendMessage();
    p.w.displayControllerMessage({id:'saved-1',text:'first'});
    inp.textContent='new typing';
    p.w.ack({ok:true,messageId:'saved-1'});
    assert.equal(inp.textContent,'new typing');
    assert.equal(p.w.document.querySelectorAll('#messages li').length,1);
    p.w.sendMessage(); p.w.ack({ok:true,messageId:'saved-2'});
    p.w.displayControllerMessage({id:'saved-2',text:'new typing'});
    assert.equal(inp.textContent,'');
    assert.equal(p.w.document.querySelectorAll('#messages li').length,2);
});

test('controller send blocks concurrent submissions and preserves text after timeout/offline', t => {
    const p=controllerComposer(); t.after(()=>p.dom.window.close());
    const inp=p.w.document.querySelector('.inp'); inp.textContent='draft';
    p.w.sendMessage(); p.w.sendMessage();
    assert.equal(p.w.sendCount,1);
    [...p.timers.values()][0]();
    assert.equal(inp.textContent,'draft');
    assert.match(p.w.document.getElementById('controllerSendStatus').textContent,/Check the chat/);
    p.run('socket.connected=false;'); p.w.sendMessage();
    assert.equal(p.w.sendCount,1);
    assert.equal(inp.textContent,'draft');
    assert.match(p.w.document.getElementById('controllerSendStatus').textContent,/Disconnected/);
});

test('snippet folder buttons retain keyboard focus while expanding and collapsing', t => {
    const p = panel(); t.after(() => p.dom.window.close());
    const data = library();
    data.folders.parent = { id: 'parent', name: 'Parent folder', parentId: null };
    data.folders.child = { id: 'child', name: 'Child folder', parentId: 'parent' };
    data.structure = ['parent', 'a', 'b'];
    initEditor(p, data);
    let button = p.w.document.querySelector('.folder-label');
    button.focus(); button.click();
    button = p.w.document.querySelector('.folder-label');
    assert.equal(p.w.document.activeElement, button);
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(p.w.document.querySelectorAll('.folder-label').length, 2);
    button.click();
    button = p.w.document.querySelector('.folder-label');
    assert.equal(p.w.document.activeElement, button);
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    const composer = p.w.document.getElementById('chatInput');
    composer.value = 'Keep typing here'; composer.focus(); composer.setSelectionRange(2, 5);
    p.w.toggleSnippetFolder('parent');
    assert.equal(p.w.document.activeElement, composer);
    assert.equal(composer.selectionStart, 2);
    assert.equal(composer.selectionEnd, 5);
});

test('snippet tab switches and closes restore focus to a remaining usable control', t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p);
    p.w.openSnippetViewer('a'); p.w.openSnippetViewer('b');
    const find = (id, kind = 'title') => [...p.w.document.querySelectorAll(`.snippet-tab-${kind}`)].find(button => button.dataset.snippetId === id);
    find('a').focus(); find('a').click();
    assert.equal(p.w.document.activeElement, find('a'));
    assert.equal(find('a').getAttribute('aria-pressed'), 'true');
    find('a', 'close').focus(); find('a', 'close').click();
    assert.equal(p.w.document.activeElement, find('b'));
    find('b', 'close').focus(); find('b', 'close').click();
    assert.equal(p.w.document.querySelectorAll('.snippet-tab').length, 0);
    assert.equal(p.w.document.activeElement, p.w.document.querySelector('#snippetsPanel .snippets-header button'));
});

test('unrelated snippet-tab rerenders preserve active editor selection and scrolling', t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p);
    p.w.openSnippetViewer('a'); p.w.openSnippetViewer('b'); p.w.switchToSnippetTab('a');
    const textarea = snippetEditor(p, 'a').root;
    const tabs = p.w.document.getElementById('snippetTabs');
    textarea.focus();
    const textNode = textarea.querySelector('p').firstChild;
    p.w.getSelection().setBaseAndExtent(textNode, 4, textNode, 1);
    textarea.scrollTop = 24; tabs.scrollLeft = 90;
    p.w.renderSnippetTabs();
    assert.equal(p.w.document.activeElement, textarea);
    assert.equal(p.w.getSelection().focusOffset, 1);
    assert.equal(p.w.getSelection().anchorOffset, 4);
    assert.equal(p.w.getSelection().toString(), 'irs');
    assert.equal(textarea.scrollTop, 24);
    assert.equal(tabs.scrollLeft, 90);
    assert.equal(textarea.closest('.snippet-content-area').classList.contains('active'), true);
    assert.equal(p.w.document.querySelector('#snippet-content-b').classList.contains('active'), false);
});

test('consecutive snippet copies clear previous feedback and stale completions cannot relabel it', async t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p);
    p.w.openSnippetViewer('a'); p.w.openSnippetViewer('b');
    const pending = deferred(); let count = 0;
    p.w.navigator.clipboard = { writeText: () => ++count === 1 ? pending.promise : Promise.resolve() };
    const first = p.w.copySnippetToClipboard('a');
    await p.w.copySnippetToClipboard('b');
    pending.resolve(); await first;
    const feedback = id => p.w.document.querySelector(`#snippet-content-${id} .snippet-copy-feedback`).textContent;
    assert.equal(feedback('a'), '');
    assert.equal(feedback('b'), 'Скопировано');
    await p.w.copySnippetToClipboard('a');
    assert.equal(feedback('a'), 'Скопировано');
    assert.equal(feedback('b'), '');
    [...p.timeouts.values()].forEach(callback => callback());
    assert.equal(feedback('a'), '');
    assert.equal(feedback('b'), '');
    assert.equal(p.w.document.getElementById('snippetCopyStatus').textContent, '');
});

test('copy failures are visible and late copy results cannot restore feedback after account invalidation', async t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p); p.w.openSnippetViewer('a');
    p.w.navigator.clipboard = { writeText: async () => { throw new Error('Clipboard blocked'); } };
    assert.equal(await p.w.copySnippetToClipboard('a'), false);
    assert.match(p.w.document.getElementById('snippetCopyStatus').textContent, /Не удалось скопировать/);
    const pending = deferred();
    p.w.navigator.clipboard.writeText = () => pending.promise;
    const copying = p.w.copySnippetToClipboard('a');
    assert.equal(p.w.document.getElementById('snippetCopyStatus').textContent, '');
    p.w.invalidateAuthenticatedPanel(); pending.resolve(); await copying;
    assert.equal(p.w.document.getElementById('snippetCopyStatus').textContent, '');
});

test('fallback snippet copy preserves the chat composer selection and copies the current draft', async t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p); p.w.openSnippetViewer('a');
    const textarea = snippetEditor(p, 'a').root;
    snippetEditor(p, 'a').setValue({ content: 'Current editor text' });
    const composer = p.w.document.getElementById('chatInput');
    composer.value = 'A chat draft'; composer.focus(); composer.setSelectionRange(2, 7);
    let copied;
    p.w.document.execCommand = action => { assert.equal(action, 'copy'); copied = p.w.document.activeElement.value; return true; };
    assert.equal(await p.w.copySnippetToClipboard('a'), true);
    assert.equal(copied, 'Current editor text');
    assert.equal(p.w.document.activeElement, composer);
    assert.equal(composer.selectionStart, 2);
    assert.equal(composer.selectionEnd, 7);
    assert.equal(composer.value, 'A chat draft');
});

test('snippet geometry is clamped to the viewport and session switches keep the left workspace intact', t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p); p.w.openSnippetViewer('a');
    p.w.innerWidth = 1200;
    p.run('preferredSnippetWidth = 1000;');
    p.w.toggleSnippetsPanel();
    const container = p.w.document.getElementById('snippetsContainer');
    const viewer = p.w.document.getElementById('snippetsViewer');
    assert.equal(viewer.style.width, '620px');
    assert.equal(p.w.document.querySelector('.container').style.marginLeft, '840px');
    p.w.openChat('session-one');
    p.w.document.getElementById('chatInput').value = 'Session one draft';
    p.w.openChat('session-two');
    assert.equal(container.classList.contains('show'), true);
    assert.equal(p.run('activeSnippetId'), 'a');
    assert.equal(snippetEditor(p, 'a').getValue().content, 'first');
    p.w.openChat('session-one');
    assert.equal(p.w.document.getElementById('chatInput').value, 'Session one draft');
    p.w.innerWidth = 600; p.w.updateContainerMargin();
    assert.equal(p.w.document.querySelector('.container').style.marginLeft, '');
    assert.equal(p.w.document.getElementById('chatModal').style.getPropertyValue('--snippets-width'), '0px');
    assert.equal(container.classList.contains('show'), true);
});

test('snippet resizing is keyboard accessible and covered background controls are inert', t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p); p.w.openSnippetViewer('a');
    p.w.innerWidth = 1280;
    p.w.initSnippetResize(); p.w.updateContainerMargin();
    const handle = p.w.document.getElementById('snippetResizeHandle');
    handle.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
    assert.equal(p.w.localStorage.getItem('control-panel.snippet-width'), '384');
    assert.equal(handle.getAttribute('aria-valuenow'), '384');
    p.w.toggleSnippetsPanel(); p.w.openChat('test-session');
    const app = p.w.document.getElementById('appRoot');
    assert.equal(app.inert, true);
    p.w.closeChat(); assert.equal(app.inert, false);
    p.w.innerWidth = 390; p.w.updateContainerMargin();
    assert.equal(app.inert, true);
    const close = p.w.document.querySelector('.snippets-header button'); close.focus(); p.w.toggleSnippetsPanel();
    assert.equal(app.inert, false);
    assert.equal(p.w.document.activeElement, app.querySelector('[data-snippets-toggle]'));
    assert.equal(app.querySelector('[data-snippets-toggle]').getAttribute('aria-expanded'), 'false');
});

test('saved folder expansion is restored before the initial library render', async t => {
    const p = panel(); t.after(() => p.dom.window.close());
    const data = library();
    data.folders.parent = { id: 'parent', name: 'Saved folder', parentId: null };
    data.snippets.a.parentId = 'parent'; data.structure = ['parent', 'b'];
    p.run("currentNickname = 'alice'; currentRole = 'user'; applySnippetsAccess(true);");
    p.w.localStorage.setItem('snippetsExpandedState', JSON.stringify({ parent: true }));
    p.w.fetch = async () => reply(200, { snippets: data, revision: '1' });
    assert.equal(await p.w.loadSnippets(), true);
    assert.equal(p.w.document.querySelector('.folder-label').getAttribute('aria-expanded'), 'true');
    assert.equal(p.w.document.querySelector('.snippet-folder-children .snippet-label').textContent, 'A');
    p.w.localStorage.setItem('snippetsExpandedState', 'null');
    p.w.loadExpandedState();
    assert.doesNotThrow(() => p.w.renderSnippetsTree());
});

test('snippet controls start hidden and all base roles require a separate server grant', async t => {
    const p = panel(); t.after(() => p.dom.window.close());
    let requests = 0; p.w.fetch = async () => { requests++; throw new Error('unauthorized fetch'); };
    p.w.localStorage.setItem('role', 'admin');
    p.w.localStorage.setItem('snippetsAccess', 'true');
    for (const role of ['admin', 'user', 'reader', 'new']) {
        p.w.testRole = role; p.run("currentNickname = 'alice'; currentRole = testRole;");
        assert.equal(p.w.receiveSnippets({ snippets: library(), revision: 1 }), false);
        assert.equal(await p.w.loadSnippets(), false);
        assert.equal(await p.w.saveSnippets(), false);
        p.w.toggleSnippetsPanel(); p.w.exportSnippets(); p.w.createNewSnippet();
        assert.ok([...p.w.document.querySelectorAll('[data-snippets-toggle]')].every(button => button.hidden));
        assert.equal(p.w.document.getElementById('snippetsContainer').hidden, true);
        assert.equal(p.w.document.getElementById('snippetsContainer').classList.contains('show'), false);
        assert.equal(p.run('Object.keys(snippetsData.snippets).length'), 0);
    }
    assert.equal(requests, 0);
    p.w.applySnippetsAccess(true);
    assert.equal(p.w.hasSnippetsAccess(), false, 'training remains isolated even with a stale true flag');
});

test('revoking snippet access immediately clears its workspace but preserves chat and the current draft', t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p);
    p.w.openSnippetViewer('a'); p.w.toggleSnippetsPanel(); draft(p, 'a', 'private edit');
    p.w.openChat('session-one');
    const composer = p.w.document.getElementById('chatInput'); composer.value = 'Keep this chat draft';
    snippetEditor(p, 'a').focus();
    p.emit('permissions-changed', { nickname: 'alice', role: 'user', snippetsAccess: false, canManageSnippetsAccess: false });
    assert.equal(p.w.hasSnippetsAccess(), false);
    assert.equal(p.run('panelAccountInvalidated'), false);
    assert.equal(p.run('autoSaveTimeouts.size'), 0);
    assert.equal(p.run('Object.keys(snippetsData.snippets).length'), 0);
    assert.equal(p.w.document.getElementById('snippetContents').textContent, '');
    assert.equal(p.w.document.getElementById('snippetTree').textContent, '');
    assert.equal(p.w.document.getElementById('snippetTabs').textContent, '');
    assert.equal(p.w.document.getElementById('snippetsContainer').hidden, true);
    assert.equal(p.w.document.getElementById('chatModal').classList.contains('snippets-open'), false);
    assert.equal(p.run('currentChatSessionId'), 'session-one');
    assert.equal(composer.value, 'Keep this chat draft');
    assert.equal(p.w.document.activeElement, composer);
    const leaving = new p.w.Event('beforeunload', { cancelable: true }); p.w.dispatchEvent(leaving);
    assert.equal(leaving.defaultPrevented, false);
    p.emit('snippets-updated', { snippets: library(), revision: 2 });
    assert.equal(p.run('Object.keys(snippetsData.snippets).length'), 0);
});

test('late snippet GET and POST responses remain fenced after revoke and regrant to the same account', async t => {
    for (const operation of ['GET', 'POST']) {
        const p = panel(); t.after(() => p.dom.window.close()); initEditor(p); p.w.openSnippetViewer('a');
        const pending = deferred(); let body;
        p.w.fetch = (url, options) => { body = options.body && JSON.parse(options.body); return pending.promise; };
        if (operation === 'POST') draft(p, 'a', 'old restricted draft');
        const work = operation === 'GET' ? p.w.loadSnippets() : p.w.saveSnippets();
        p.w.applySnippetsAccess(false); p.w.applySnippetsAccess(true);
        const fresh = library(); fresh.snippets.a.content = 'Newly authorized snapshot';
        p.w.receiveSnippets({ snippets: fresh, revision: 3 });
        pending.resolve(reply(200, { snippets: body?.snippets || library(), revision: 4 }));
        assert.equal(await work, false);
        assert.equal(p.run('snippetsData.snippets.a.content'), 'Newly authorized snapshot');
        assert.equal(p.run('snippetsRevision'), 3);
        assert.equal(p.run('snippetsSavePromise'), null);
    }
});

test('a server permission denial removes private snippets instead of offering to export a forbidden draft', async t => {
    for (const operation of ['GET', 'POST']) {
        const p = panel(); t.after(() => p.dom.window.close()); initEditor(p); p.w.openSnippetViewer('a');
        if (operation === 'POST') draft(p, 'a', 'pending private edit');
        p.w.fetch = async () => reply(403, { error: 'snippets_access_required' });
        const result = await (operation === 'GET' ? p.w.loadSnippets() : p.w.saveSnippets());
        assert.equal(result, false);
        assert.equal(p.w.hasSnippetsAccess(), false);
        assert.equal(p.run('snippetsSaveError'), '');
        assert.equal(p.run('Object.keys(snippetsData.snippets).length'), 0);
        assert.equal(p.w.document.getElementById('snippetContents').textContent, '');
    }
});

test('late clipboard feedback and file imports cannot revive snippet data after access is revoked', async t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p); p.w.openSnippetViewer('a');
    const clipboard = deferred(); p.w.navigator.clipboard = { writeText: () => clipboard.promise };
    const copying = p.w.copySnippetToClipboard('a');
    let reader; p.w.FileReader = class { constructor() { reader = this; } readAsText() {} };
    p.w.importSnippets({ files: [{}], value: 'test.json' });
    p.w.applySnippetsAccess(false);
    clipboard.resolve(); await copying;
    await reader.onload({ target: { result: JSON.stringify(library()) } });
    assert.equal(p.w.document.getElementById('snippetCopyStatus').textContent, '');
    assert.equal(p.run('Object.keys(snippetsData.snippets).length'), 0);
    assert.equal(p.w.document.getElementById('snippetContents').textContent, '');
});

test('live permission grant reveals controls and loads snippets without reopening the chat', async t => {
    const p = panel(); t.after(() => p.dom.window.close());
    p.run("currentNickname = 'alice'; currentRole = 'reader';");
    p.w.openChat('session-one'); p.w.document.getElementById('chatInput').value = 'Keep draft';
    const urls = [];
    p.w.fetch = async url => { urls.push(url); return reply(200, { snippets: library(), revision: 1 }); };
    p.emit('permissions-changed', { nickname: 'someone-else', role: 'reader', snippetsAccess: true });
    assert.equal(p.w.hasSnippetsAccess(), false);
    p.emit('permissions-changed', { nickname: 'alice', role: 'reader', snippetsAccess: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(urls, ['/api/snippets/list']);
    assert.equal(p.w.hasSnippetsAccess(), true);
    assert.ok([...p.w.document.querySelectorAll('[data-snippets-toggle]')].every(button => !button.hidden));
    p.w.openSnippetViewer('a');
    assert.equal(snippetEditor(p, 'a').root.getAttribute('contenteditable'), 'false');
    assert.equal(p.w.document.getElementById('chatInput').value, 'Keep draft');
});

test('a stale periodic auth response cannot restore snippets after a live revocation', async t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p);
    const pending = deferred(); p.w.fetch = () => pending.promise;
    const poll = [...p.intervals.values()].find(fn => String(fn).includes('/api/auth/check'));
    assert.ok(poll);
    const checking = poll();
    p.emit('permissions-changed', { nickname: 'alice', role: 'user', snippetsAccess: false });
    pending.resolve(reply(200, { nickname: 'alice', role: 'user', snippetsAccess: true }));
    await checking;
    assert.equal(p.w.hasSnippetsAccess(), false);
    assert.equal(p.w.document.getElementById('snippetsContainer').hidden, true);
});

test('only the owner sees snippet role controls and grant failures restore the previous state', async t => {
    const fixtures = [
        { nickname: '02ashes', role: 'admin', snippetsAccess: true, snippetsAccessGranted: true, registered_at: '2026-09-01' },
        { nickname: 'alice', role: 'reader', snippetsAccess: false, snippetsAccessGranted: false, registered_at: '2026-09-01' },
        { nickname: 'student', role: 'new', snippetsAccess: false, snippetsAccessGranted: true, registered_at: '2026-09-01' }
    ];
    for (const owner of [false, true]) {
        const p = panel(); t.after(() => p.dom.window.close());
        p.run(`currentNickname = '${owner ? '02ashes' : 'admin-user'}'; currentRole = 'admin'; canManageSnippetsAccess = ${owner};`);
        p.w.fetch = async () => reply(200, { users: fixtures.map(user => ({ ...user })) });
        await p.w.showUsersModal();
        const controls = p.w.document.querySelectorAll('.snippet-access-toggle');
        assert.equal(controls.length, owner ? 2 : 0);
        if (!owner) continue;
        assert.equal(p.w.document.querySelector('[data-nickname="02ashes"]'), null);
        assert.equal(controls[1].checked, true, 'owner can revoke a dormant trainee grant');
        const pending = deferred(); let payload;
        p.w.fetch = (url, options) => { assert.equal(url, '/api/user/snippets-access'); payload = JSON.parse(options.body); return pending.promise; };
        controls[0].click();
        assert.deepEqual(payload, { targetNickname: 'alice', enabled: true });
        assert.equal(controls[0].disabled, true);
        pending.resolve(reply(403, { error: 'owner_required' }));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(controls[0].checked, false);
        assert.equal(controls[0].disabled, false);
        assert.match(p.w.document.getElementById('usersAccessStatus').textContent, /Не удалось/);
        p.w.fetch = async () => reply(200, { snippetsAccess: true, snippetsAccessGranted: true });
        controls[0].click(); await new Promise(resolve => setImmediate(resolve));
        assert.equal(controls[0].checked, true);
        assert.match(controls[0].nextElementSibling.textContent, /Выдана/);
        assert.match(p.w.document.getElementById('usersAccessStatus').textContent, /выдана: alice/);
    }
});

function styledLibrary() {
    const data = library();
    data.snippets.a.richText = { ops: [
        { insert: 'first', attributes: { bold: true, color: '#93c5fd' } }, { insert: '\n' }
    ] };
    return data;
}

test('formatted snippets render their styles while the main copy action sends only exact plain text', async t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p, styledLibrary());
    p.w.openSnippetViewer('a');
    const editor = snippetEditor(p, 'a');
    assert.equal(editor.root.querySelector('strong').textContent, 'first');
    assert.match(editor.root.innerHTML, /color:/);
    p.w.openChat('session-one'); p.w.document.getElementById('chatInput').value = 'Keep the session draft';
    let copied; p.w.navigator.clipboard = { writeText: async value => { copied = value; } };
    assert.equal(await p.w.copySnippetToClipboard('a'), true);
    assert.equal(copied, 'first');
    assert.equal(p.w.document.getElementById('chatInput').value, 'Keep the session draft');
    assert.equal(p.run('hasUnsavedSnippets()'), false);
    assert.ok(editor.getValue().richText);
});

test('formatting through the live toolbar saves text and styles together and own acknowledgement preserves undo', async t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p); p.w.openSnippetViewer('a');
    const editor = snippetEditor(p, 'a');
    const quill = p.w.Quill.find(editor.root.parentElement);
    quill.setSelection(0, 5, 'silent');
    const button = p.w.document.querySelector('#snippet-content-a [data-editor-action="bold"]');
    button.dispatchEvent(new p.w.MouseEvent('mousedown', { bubbles: true, cancelable: true })); button.click();
    assert.equal(p.run('hasUnsavedSnippets()'), true);
    assert.ok(editor.root.querySelector('strong'));
    let payload;
    p.w.fetch = async (_url, options) => {
        payload = JSON.parse(options.body);
        return reply(200, { snippets: payload.snippets, revision: 2 });
    };
    assert.equal(await p.w.saveSnippets(), true);
    assert.equal(payload.snippets.snippets.a.content, 'first');
    assert.equal(payload.snippets.snippets.a.richText.ops[0].attributes.bold, true);
    assert.ok(quill.history.stack.undo.length > 0);
    p.w.document.querySelector('#snippet-content-a [data-editor-action="undo"]').click();
    assert.equal(editor.getValue().richText, undefined);
    assert.equal(editor.getValue().content, 'first');
    assert.equal(p.run('hasUnsavedSnippets()'), true);
});

test('remote formatting refreshes inactive editors and switching tabs cannot silently discard it', t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p);
    p.w.openSnippetViewer('a'); p.w.openSnippetViewer('b');
    p.emit('snippets-updated', { snippets: styledLibrary(), revision: 2 });
    p.w.switchToSnippetTab('a');
    assert.ok(snippetEditor(p, 'a').root.querySelector('strong'));
    p.w.switchToSnippetTab('b');
    assert.equal(p.run('hasUnsavedSnippets()'), false);
    assert.ok(p.run('snippetsData.snippets.a.richText'));
});

test('formatted local draft stays intact when a concurrent plain-text edit conflicts', async t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p); p.w.openSnippetViewer('a');
    snippetEditor(p, 'a').setValue(styledLibrary().snippets.a); p.w.autoSaveSnippet('a');
    const remote = library(); remote.snippets.a.content = 'Remote replacement text';
    p.emit('snippets-updated', { snippets: remote, revision: 2 });
    assert.equal(snippetEditor(p, 'a').getValue().content, 'first');
    assert.ok(snippetEditor(p, 'a').root.querySelector('strong'));
    assert.match(p.w.document.getElementById('snippetSaveStatus').textContent, /Конфликт/);
    let requests = 0; p.w.fetch = async () => { requests++; throw new Error('must resolve conflict'); };
    assert.equal(await p.w.saveSnippets(), false);
    assert.equal(requests, 0);
});

test('snippet export and import retain formatting without converting any content to HTML', async t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p, styledLibrary());
    let exported;
    p.w.Blob = class { constructor(parts) { exported = parts.join(''); } };
    p.w.URL.createObjectURL = () => 'blob:preview'; p.w.URL.revokeObjectURL = () => {};
    p.w.HTMLAnchorElement.prototype.click = () => {};
    p.w.exportSnippets();
    assert.deepEqual(JSON.parse(exported), styledLibrary());
    let reader; p.w.FileReader = class { constructor() { reader = this; } readAsText() {} };
    let saved; p.w.fetch = async (_url, options) => {
        saved = JSON.parse(options.body).snippets;
        return reply(200, { snippets: saved, revision: 2 });
    };
    const imported = styledLibrary(); imported.snippets.a.name = 'Formatted import';
    p.w.importSnippets({ files: [{}], value: 'snippets.json' });
    await reader.onload({ target: { result: JSON.stringify(imported) } });
    assert.deepEqual(saved, imported);
    p.w.openSnippetViewer('a');
    assert.ok(snippetEditor(p, 'a').root.querySelector('strong'));
});

test('access revocation destroys rich editor instances and their retained content', t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p, styledLibrary()); p.w.openSnippetViewer('a');
    const editor = snippetEditor(p, 'a');
    p.w.applySnippetsAccess(false);
    assert.equal(p.run('snippetEditors.size'), 0);
    assert.equal(editor.getValue().content, '');
    assert.equal(editor.root.textContent, '');
    assert.equal(p.w.document.querySelector('.ql-editor'), null);
    editor.setValue(styledLibrary().snippets.a);
    assert.equal(editor.getValue().content, '');
});

test('an unavailable rich editor retains formatted source and offers safe plain-text copying', async t => {
    const p = panel(); t.after(() => p.dom.window.close()); initEditor(p, styledLibrary());
    p.w.SnippetEditor = undefined; p.w.openSnippetViewer('a');
    assert.match(p.w.document.querySelector('.snippet-editor-error').textContent, /Редактор не загрузился/);
    assert.equal(p.w.document.querySelector('.snippet-editor-fallback').textContent, 'first');
    p.w.applyRoleRestrictions();
    assert.equal(p.w.document.querySelector('.snippet-editor-title').readOnly, true);
    let copied; p.w.navigator.clipboard = { writeText: async value => { copied = value; } };
    await p.w.copySnippetToClipboard('a');
    assert.equal(copied, 'first');
    assert.equal(p.run('hasUnsavedSnippets()'), false);
    assert.ok(p.run('snippetsData.snippets.a.richText'));
});
