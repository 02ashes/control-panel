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
    let timerId = 0;
    w.setTimeout = fn => { timeouts.set(++timerId, fn); return timerId; };
    w.clearTimeout = id => timeouts.delete(id);
    w.setInterval = () => ++timerId;
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
    w.console = { log() {}, error() {} };
    run(fs.readFileSync(path.join(root, 'public/snippets-sync.js'), 'utf8'));
    for (const script of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
        let code = script[1];
        if (!code.trim()) continue;
        // Disable only automatic login/requests; execute the actual app functions.
        code = code.replace('        ensureRegistration();', '');
        if (file === 'logs.html') code = code.replace(/        \(async function \(\) \{[\s\S]*?        \}\)\(\);/, '');
        run(code);
    }
    return { w, dom, listeners, timeouts, run, emit: (name, data) => (listeners.get(name) || []).forEach(fn => fn(data)) };
}
function initEditor(p, data = library()) {
    p.w.seed = data;
    p.run("currentNickname = 'alice'; currentRole = 'user'; receiveSnippets({snippets:seed, revision:'1'});");
}
function draft(p, id, text) {
    p.w.document.getElementById(`snippet-content-${id}`).querySelector('textarea').value = text;
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
    const input = p.w.document.getElementById('snippet-content-b').querySelector('textarea');
    assert.equal(input.value, 'updated by colleague');
    p.w.switchToSnippetTab('b'); draft(p, 'b', input.value + '!');
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
    assert.equal(p.w.document.querySelector('textarea.snippet-editor-textarea').value, 'local draft');
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
    assert.equal(p.w.document.querySelector('.snippet-editor-textarea').value, 'before close');
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
    assert.equal(p.w.document.querySelector('.snippet-editor-textarea').readOnly, true);
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
    p.run("allSnippetLogs = [{user_nickname:'alice',item_name:'Find me',action:'edit',item_type:'snippet',timestamp:'2025-01-01'}];");
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
    const textarea = p.w.document.querySelector('#snippet-content-a textarea');
    const tabs = p.w.document.getElementById('snippetTabs');
    textarea.focus(); textarea.setSelectionRange(1, 4, 'backward');
    textarea.scrollTop = 24; tabs.scrollLeft = 90;
    p.w.renderSnippetTabs();
    assert.equal(p.w.document.activeElement, textarea);
    assert.equal(textarea.selectionStart, 1);
    assert.equal(textarea.selectionEnd, 4);
    assert.equal(textarea.selectionDirection, 'backward');
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
    const textarea = p.w.document.querySelector('#snippet-content-a textarea');
    textarea.value = 'Current editor text';
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
    assert.equal(p.w.document.querySelector('#snippet-content-a textarea').value, 'first');
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
    p.run("currentNickname = 'alice'; currentRole = 'user';");
    p.w.localStorage.setItem('snippetsExpandedState', JSON.stringify({ parent: true }));
    p.w.fetch = async () => reply(200, { snippets: data, revision: '1' });
    assert.equal(await p.w.loadSnippets(), true);
    assert.equal(p.w.document.querySelector('.folder-label').getAttribute('aria-expanded'), 'true');
    assert.equal(p.w.document.querySelector('.snippet-folder-children .snippet-label').textContent, 'A');
    p.w.localStorage.setItem('snippetsExpandedState', 'null');
    p.w.loadExpandedState();
    assert.doesNotThrow(() => p.w.renderSnippetsTree());
});
