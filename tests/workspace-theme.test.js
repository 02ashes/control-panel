'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { startApplication } = require('./helpers/application');

const root = path.join(__dirname, '..');
const themeSource = fs.readFileSync(path.join(root, 'public/workspace-theme.js'), 'utf8');
const themeStyles = fs.readFileSync(path.join(root, 'public/workspace-theme.css'), 'utf8');

function themePage(t, saved) {
  const dom = new JSDOM('<!doctype html><html><head></head><body class="work-ui"><form><button data-work-theme-toggle></button><button data-work-theme-toggle></button></form></body></html>', {
    url: 'https://workspace.test/admin',
    runScripts: 'outside-only'
  });
  t.after(() => dom.window.close());
  if (saved !== undefined) dom.window.localStorage.setItem('control-panel.theme', saved);
  return dom;
}

test('workbench initializes graphite immediately and reflects a saved light preference', t => {
  const dark = themePage(t);
  dark.window.eval(themeSource);
  assert.equal(dark.window.document.documentElement.dataset.workTheme, 'dark');
  assert.equal(dark.window.localStorage.getItem('control-panel.theme'), null);

  const light = themePage(t, 'light');
  light.window.eval(themeSource);
  assert.equal(light.window.document.documentElement.dataset.workTheme, 'light');
  assert.equal(light.window.document.querySelector('[data-work-theme-toggle]').getAttribute('aria-pressed'), 'true');
});

test('workbench rejects unknown stored values without overwriting storage', t => {
  const dom = themePage(t, 'invalid');
  dom.window.eval(themeSource);
  assert.equal(dom.window.document.documentElement.dataset.workTheme, 'dark');
  assert.equal(dom.window.localStorage.getItem('control-panel.theme'), 'invalid');
});

test('theme toggles synchronize accessible labels, persist, and never submit forms', t => {
  const dom = themePage(t);
  dom.window.eval(themeSource);
  const { document, localStorage } = dom.window;
  const buttons = [...document.querySelectorAll('[data-work-theme-toggle]')];
  let submits = 0;
  document.querySelector('form').addEventListener('submit', event => { submits++; event.preventDefault(); });
  buttons[0].click();
  assert.equal(document.documentElement.dataset.workTheme, 'light');
  assert.equal(localStorage.getItem('control-panel.theme'), 'light');
  for (const button of buttons) {
    assert.equal(button.type, 'button');
    assert.equal(button.textContent, 'Светлая тема');
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.match(button.title, /тёмную/);
  }
  buttons[1].click();
  assert.equal(document.documentElement.dataset.workTheme, 'dark');
  assert.equal(localStorage.getItem('control-panel.theme'), 'dark');
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'false');
  assert.equal(submits, 0);
});

test('blocked browser storage does not prevent initialization or theme changes', t => {
  const dom = themePage(t);
  Object.defineProperty(dom.window, 'localStorage', { get() { throw new Error('Storage blocked'); } });
  assert.doesNotThrow(() => dom.window.eval(themeSource));
  dom.window.document.querySelector('[data-work-theme-toggle]').click();
  assert.equal(dom.window.document.documentElement.dataset.workTheme, 'light');
});

test('theme controls loaded after head initialization are wired without inserting DOM', t => {
  const dom = themePage(t, 'light');
  dom.window.document.body.innerHTML = '';
  dom.window.eval(themeSource);
  assert.equal(dom.window.document.body.children.length, 0);
  const button = dom.window.document.createElement('button');
  button.setAttribute('data-work-theme-toggle', '');
  dom.window.document.body.appendChild(button);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  assert.equal(button.textContent, 'Светлая тема');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  button.click();
  assert.equal(dom.window.document.documentElement.dataset.workTheme, 'dark');
});

test('theme follows other tabs and resets to graphite when the preference is cleared', t => {
  const dom = themePage(t);
  dom.window.eval(themeSource);
  const notify = (key, value) => dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key, newValue: value }));
  notify('control-panel.theme', 'light');
  assert.equal(dom.window.document.documentElement.dataset.workTheme, 'light');
  notify('unrelated', 'dark');
  assert.equal(dom.window.document.documentElement.dataset.workTheme, 'light');
  dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: null, newValue: null, storageArea: dom.window.sessionStorage }));
  assert.equal(dom.window.document.documentElement.dataset.workTheme, 'light');
  notify(null, null);
  assert.equal(dom.window.document.documentElement.dataset.workTheme, 'dark');
});

test('preview aliases point to exact files without widening static access', () => {
  const source = fs.readFileSync(path.join(root, 'learn/day1-preview-server.js'), 'utf8');
  const start = source.indexOf('const WORKSPACE_ASSETS = new Map(');
  const end = source.indexOf("app.use('/vendor'", start);
  assert.ok(start >= 0 && end > start);
  let middleware;
  new Function('app', 'path', 'ROOT_DIR', source.slice(start, end))({ use(fn) { middleware = fn; } }, path, root);
  assert.equal(typeof middleware, 'function');
  for (const file of ['workspace-theme.css', 'workspace-theme.js', 'panel.css']) {
    let sent;
    const headers = {};
    middleware({ method: 'GET', path: `/${file}` }, {
      setHeader(name, value) { headers[name] = value; },
      sendFile(value) { sent = value; }
    }, () => assert.fail('A known theme alias must be served'));
    assert.equal(sent, path.join(root, 'public', file));
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  }
  for (const request of [{ method: 'GET', path: '/public/other.js' }, { method: 'POST', path: '/workspace-theme.js' }]) {
    let nextCalled = false;
    middleware(request, { sendFile() { assert.fail('Unknown files and writes are not theme assets'); } }, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  }
});

test('theme styles stay opt-in and retain keyboard focus and reduced-motion support', () => {
  assert.match(themeStyles, /body\.work-ui/);
  assert.match(themeStyles, /:focus-visible/);
  assert.match(themeStyles, /prefers-reduced-motion:\s*reduce/);
  assert.match(themeStyles, /:root\[data-work-theme="light"\]/);
  for (const token of ['bg', 'surface', 'surface-2', 'border', 'text', 'muted', 'accent', 'accent-hover', 'accent-soft', 'on-accent', 'success', 'warning', 'danger', 'shadow', 'radius', 'font']) {
    assert.ok(themeStyles.includes(`--work-${token}:`), `Missing palette token: ${token}`);
  }
});

test('production serves only explicit workspace assets without exposing adjacent source', async t => {
  const app = await startApplication();
  t.after(() => app.close());
  for (const [url, type, expected] of [
    ['/workspace-theme.css', /text\/css/, '--work-bg'],
    ['/workspace-theme.js', /javascript/, 'control-panel.theme']
  ]) {
    const response = await app.request(url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), type);
    assert.match(response.data, new RegExp(expected));
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
  for (const url of ['/tests/workspace-theme.test.js', '/public/workspace-theme.test.js', '/workspace-theme.test.js', '/server.js', '/.env']) {
    const response = await app.request(url);
    assert.equal(response.status, 404, `${url} must remain private`);
  }
});
