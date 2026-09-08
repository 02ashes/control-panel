'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, requestInterceptor, CookieJar, VirtualConsole } = require('jsdom');
const { startApplication } = require('./helpers/application');

test('complete panel and Day 1 pages initialize with actual HTTP assets/auth/state', async t => {
  const app = await startApplication();
  t.after(() => app.close());
  const editorCookie = await app.register('page-editor');
  const learnerCookie = await app.register('page-learner');
  await app.pool.query("UPDATE user_registrations SET role='user' WHERE nickname='page-editor'");
  await app.pool.query("UPDATE user_registrations SET role='new' WHERE nickname='page-learner'");

  async function open(route, cookie) {
    const errors = [];
    const jar = new CookieJar();
    jar.setCookieSync(cookie + '; Path=/; HttpOnly', app.base);
    const resources = { interceptors: [requestInterceptor(request => {
        const target = new URL(request.url);
        if (target.origin !== app.base) return new Response(null, { status: 204 });
        // Socket delivery is covered separately by real Socket.IO tests. Here
        // only this transport is stubbed; all page code, assets and APIs execute.
        if (target.pathname === '/socket.io/socket.io.js') return new Response(`
          window.io = () => ({connected:true, on(){return this;}, once(){return this;},
            emit(event,...args){const ack=args.at(-1);if(typeof ack==='function')ack({ok:true});return this;},
            connect(){return this;},disconnect(){return this;}});
        `, { headers: { 'Content-Type': 'application/javascript' } });
        return undefined;
    })] };
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', error => {
      if (error.type === 'unhandled-exception' || /Could not load script/.test(error.message)) errors.push(error);
    });
    const html = await app.request(route, { cookie });
    assert.equal(html.status, 200);
    const dom = new JSDOM(html.data, {
      url: app.base + route, cookieJar: jar, virtualConsole,
      resources, runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(window) {
        window.fetch = (url, options = {}) => {
          const target = new URL(url, window.location.href);
          if (target.origin !== app.base) throw new Error('External requests disabled');
          const headers = new Headers(options.headers || {});
          headers.set('Cookie', cookie);
          return fetch(target, { ...options, headers });
        };
        window.alert = () => {};
        window.ResizeObserver = class { observe() {} disconnect() {} };
        window.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} });
        window.addEventListener('error', event => errors.push(event.error || new Error(event.message)));
      }
    });
    t.after(() => dom.window.close());
    return { dom, errors };
  }

  async function until(predicate, errors) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      assert.deepEqual(errors, [], errors.map(error => error.stack).join('\n'));
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    throw new Error('Page did not finish initializing');
  }

  const panel = await open('/admin', editorCookie);
  await until(() => panel.dom.window.document.getElementById('appRoot').style.display === 'block', panel.errors);
  await until(() => panel.dom.window.document.getElementById('snippetSaveStatus'), panel.errors);
  assert.equal(panel.dom.window.localStorage.getItem('nickname'), 'page-editor');
  assert.match(panel.dom.window.document.getElementById('snippetSaveStatus').textContent, /сохранены/);

  const course = await open('/learn/day1.html', learnerCookie);
  await until(() => course.dom.window.document.querySelectorAll('#taskNavList button').length > 0, course.errors);
  assert.ok(course.dom.window.document.getElementById('taskContent').textContent.trim().length > 0);
  assert.deepEqual(panel.errors.concat(course.errors), []);
});
