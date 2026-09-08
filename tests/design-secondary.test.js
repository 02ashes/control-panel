const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const response = data => ({ ok: true, json: async () => data });

function screen(file, reducedMotion = false) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const dom = new JSDOM(source, { url: `https://panel.test/${file}`, runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    const run = code => vm.runInContext(code, dom.getInternalVMContext());
    const soundCalls = [];
    const frames = [];
    w.console = { log() {}, error() {} };
    w.HTMLMediaElement.prototype.play = async function () { soundCalls.push(this.id); };
    w.HTMLMediaElement.prototype.pause = function () {};
    w.matchMedia = () => ({ matches: reducedMotion });
    w.requestAnimationFrame = fn => { frames.push(fn); return frames.length; };
    w.setInterval = () => 1;
    w.setTimeout = () => 1;
    w.fetch = async () => response({ ok: true });
    w.alert = () => assert.fail('Work screens should not display decorative result alerts');
    const addEventListener = w.addEventListener.bind(w);
    if (file === 'wheel.html') w.addEventListener = (type, ...args) => { if (type !== 'load') addEventListener(type, ...args); };
    run(fs.readFileSync(path.join(root, 'public/workspace-theme.js'), 'utf8'));
    for (const script of dom.window.document.querySelectorAll('script:not([src])')) {
        let code = script.textContent;
        if (file === 'logs.html') code = code.replace(/        \(async function \(\) \{[\s\S]*?        \}\)\(\);/, '');
        if (file === 'cases.html') code = code.replace(/\n  init\(\);\s*$/, '');
        run(code);
    }
    return { dom, w, run, soundCalls, frames, source };
}

test('secondary work screens share the theme without remote fonts or decorative emoji controls', t => {
    for (const file of ['logs.html', 'cases.html', 'wheel.html']) {
        const p = screen(file); t.after(() => p.dom.window.close());
        const doc = p.w.document;
        assert.ok(doc.body.classList.contains('work-ui'));
        assert.ok(doc.head.querySelector('link[href="/workspace-theme.css"]'));
        const script = doc.head.querySelector('script[src="/workspace-theme.js"]');
        assert.ok(script && !script.defer && !script.async);
        assert.equal(doc.head.querySelector('link[href*="fonts.googleapis.com"]'), null);
        const toggle = doc.querySelector('[data-work-theme-toggle]');
        assert.equal(toggle.tagName, 'BUTTON');
        toggle.click();
        assert.equal(doc.documentElement.dataset.workTheme, 'light');
        assert.equal(toggle.getAttribute('aria-pressed'), 'true');
        toggle.click();
        assert.equal(doc.documentElement.dataset.workTheme, 'dark');
        for (const control of doc.querySelectorAll('button, nav a')) {
            assert.doesNotMatch(control.textContent, /\p{Extended_Pictographic}/u);
        }
    }
});

test('journal history links are keyboard buttons and drawer closes with Escape', t => {
    const p = screen('logs.html'); t.after(() => p.dom.window.close());
    p.run("allSessions = [{id:'session-1',creator_nickname:'alice',is_active:true,created_at:'2026-09-01',message_count:2}]; renderSessions();");
    const button = p.w.document.querySelector('[data-view-session]');
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.type, 'button');
    assert.match(button.getAttribute('aria-label'), /session-1/);
    p.run("viewChat = id => { window.selectedSession = id; };");
    button.click();
    assert.equal(p.w.selectedSession, 'session-1');
    p.w.document.getElementById('chatViewer').classList.add('show');
    p.w.document.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(p.w.document.getElementById('chatViewer').classList.contains('show'), false);
    assert.ok(p.w.document.getElementById('searchInput').getAttribute('aria-label'));
});

test('case admin tabs and tier choices support keyboard navigation without changing their selection model', t => {
    const p = screen('cases.html'); t.after(() => p.dom.window.close());
    p.run('loadWorkers = loadPending = loadConfig = loadLog = () => {}; initAdmin();');
    const doc = p.w.document;
    const grant = doc.getElementById('tab-grant');
    grant.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const pending = doc.getElementById('tab-pending');
    assert.equal(doc.activeElement, pending);
    assert.equal(pending.getAttribute('aria-selected'), 'true');
    assert.equal(grant.getAttribute('aria-selected'), 'false');
    assert.ok(doc.getElementById('panel-pending').classList.contains('active'));
    const tier = doc.querySelector('[data-tier="3"]');
    tier.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    assert.equal(p.w.selectedTier(), 3);
    assert.equal(tier.getAttribute('aria-checked'), 'true');
});

test('reduced-motion case opening displays the awarded reel item immediately and remains silent', t => {
    const p = screen('cases.html', true); t.after(() => p.dom.window.close());
    p.run("buildReel([{name:'Other prize',rarity:'common'}], {name:'Actual prize',rarity:'rare'}); runReel(() => { window.reelFinished = true; });");
    assert.equal(p.w.reelFinished, true);
    assert.match(p.w.document.querySelector('#reelStrip .center').textContent, /Actual prize/);
    assert.equal(p.frames.length, 0);
    assert.deepEqual(p.soundCalls, []);
    assert.equal(p.w.document.getElementById('caseSoundEnabled').checked, false);
    assert.equal(p.w.document.getElementById('spinSound'), null, 'Preserve the user’s case spin-sound removal');
});

test('wheel sound is explicitly opt-in rather than starting on ordinary interaction', t => {
    const p = screen('wheel.html'); t.after(() => p.dom.window.close());
    const doc = p.w.document;
    const sound = doc.getElementById('soundEnabled');
    assert.equal(sound.checked, false);
    doc.getElementById('codeInput').focus();
    doc.querySelector('[data-work-theme-toggle]').click();
    p.w.startBackgroundMusic();
    assert.deepEqual(p.soundCalls, []);
    sound.checked = true;
    sound.dispatchEvent(new p.w.Event('change'));
    assert.deepEqual(p.soundCalls, ['bgMusic']);
});

test('reduced-motion wheel saves the same target prize before showing the inline result', async t => {
    const p = screen('wheel.html', true); t.after(() => p.dom.window.close());
    let finish;
    let sent;
    p.w.fetch = (url, options) => {
        assert.equal(url, '/api/wheel/result');
        sent = JSON.parse(options.body);
        return new Promise(resolve => { finish = resolve; });
    };
    p.run("drawWheel = () => {}; currentCode = 'ABCD1234'; const originalSave = sendResult; sendResult = () => window.savePending = originalSave();");
    p.w.spinWheel('Custom');
    assert.deepEqual(sent, { code: 'ABCD1234', prize: 'Custom' });
    assert.equal(p.w.document.getElementById('wheelResult').hidden, true);
    assert.equal(p.w.document.getElementById('spinBtn').disabled, true);
    assert.equal(p.frames.length, 0);
    finish(response({ ok: true, prize: 'Custom' }));
    await p.w.savePending;
    assert.equal(p.w.document.getElementById('wheelResult').hidden, false);
    assert.equal(p.w.document.getElementById('wheelResultPrize').textContent, 'Custom');
    assert.deepEqual(p.soundCalls, []);
});

test('wheel result stays literal text and no celebration overlays are inserted', t => {
    const p = screen('wheel.html'); t.after(() => p.dom.window.close());
    p.w.showResult('<img src=x onerror=alert(1)>');
    const result = p.w.document.getElementById('wheelResultPrize');
    assert.equal(result.children.length, 0);
    assert.equal(result.textContent, '<img src=x onerror=alert(1)>');
    assert.equal(p.w.document.querySelector('.confetti-particle, .heart'), null);
});

test('background journal datasets cannot overwrite the selected mode and session filters stay scoped', async t => {
    const p = screen('logs.html'); t.after(() => p.dom.window.close());
    p.w.fetch = async url => response(url.includes('registrations')
        ? { registrations: [{ nickname: 'background-user', registered_at: '2026-09-01' }] }
        : { sessions: [{ id: 'selected-session', creator_nickname: 'alice', created_at: '2026-09-01' }] });
    await p.w.loadSessions();
    await p.w.loadRegistrations();
    const doc = p.w.document;
    assert.match(doc.getElementById('sessionsList').textContent, /selected-session/);
    assert.doesNotMatch(doc.getElementById('sessionsList').textContent, /background-user/);
    doc.getElementById('viewMode').value = 'registrations';
    await p.w.loadData();
    assert.match(doc.getElementById('sessionsList').textContent, /background-user/);
    assert.equal(doc.getElementById('statusFilter').disabled, true);
    assert.equal(doc.querySelector('.cleanup-btn').disabled, true);
    await p.w.loadSessions();
    doc.getElementById('statusFilter').dispatchEvent(new p.w.Event('change'));
    assert.match(doc.getElementById('sessionsList').textContent, /background-user/);
    assert.doesNotMatch(doc.getElementById('sessionsList').textContent, /selected-session/);
});

test('journal access failure renders a usable error screen without exposing data or starting refreshes', async t => {
    const p = screen('logs.html'); t.after(() => p.dom.window.close());
    let requests = 0;
    p.w.fetch = async () => { requests++; return response({}); };
    const init = p.source.match(/        \(async function \(\) \{[\s\S]*?        \}\)\(\);/)[0];
    await p.run(init);
    const app = p.w.document.getElementById('appRoot');
    assert.equal(app.style.display, 'block');
    assert.ok(app.classList.contains('access-denied'));
    assert.match(p.w.document.getElementById('errorContainer').textContent, /Требуется авторизация/);
    assert.equal(p.w.getComputedStyle(p.w.document.querySelector('.sessions-list')).display, 'none');
    assert.equal(p.run('accessGranted'), false);
    assert.equal(requests, 0);
});

test('journal history gives keyboard focus to its close button and returns it to the opener', async t => {
    const p = screen('logs.html'); t.after(() => p.dom.window.close());
    const search = p.w.document.getElementById('searchInput');
    search.focus();
    p.w.fetch = async () => response({ messages: [], session: { creator_nickname: 'alice' } });
    await p.w.viewChat('session-1');
    assert.equal(p.w.document.activeElement, p.w.document.querySelector('.close-chat'));
    p.w.closeChatViewer();
    assert.equal(p.w.document.activeElement, search);
});
