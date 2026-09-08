'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { io } = require('socket.io-client');
const { startApplication } = require('./helpers/application');

let app;
let admin;
let editor;
let learner;
let reader;
const empty = () => ({ folders: {}, snippets: {}, structure: [] });
const snapshot = text => ({ folders: {}, snippets: {
  note1: { id: 'note1', name: 'Team note', content: text, parentId: null }
}, structure: ['note1'] });
const post = (route, body, cookie = admin) => app.request(route, { method: 'POST', body, cookie });

before(async () => {
  app = await startApplication();
  admin = await app.register('02ashes');
  editor = await app.register('test-editor');
  learner = await app.register('test-learner');
  reader = await app.register('test-reader');
  await app.pool.query("UPDATE user_registrations SET role='user' WHERE nickname='test-editor'");
  await app.pool.query("UPDATE user_registrations SET role='new' WHERE nickname='test-learner'");
});
after(async () => { if (app) await app.close(); });

test('production static routes expose only intended assets and preserve protected training', async () => {
  for (const route of ['/', '/admin', '/cases', '/control', '/wheel', '/snippets-sync.js', '/assets/lovense-base.css']) {
    assert.equal((await app.request(route)).status, 200, route);
  }
  for (const route of ['/server.js', '/%73erver.js', '/package.json', '/package-lock.json', '/.env',
    '/lib/backend-state.js', '/scripts/check-syntax.js', '/tests/application.integration.test.js',
    '/railway.json', '/START.bat', '/node_modules/express/package.json', '/learn/grading-v2.js']) {
    assert.equal((await app.request(route)).status, 404, route);
  }
  assert.equal((await app.request('/learn/day1.html')).status, 401);
  assert.equal((await app.request('/learn/day1.html', { cookie: learner })).status, 200);
  assert.equal((await app.request('/learn/day1-dashboard.html', { cookie: learner })).status, 403);
  assert.equal((await app.request('/learn/day1-dashboard.html', { cookie: admin })).status, 200);
});

test('role restrictions survive alternate URL casing and reject readers on write', async () => {
  for (const route of ['/api/snippets/save', '/API/snippets/save', '/Api/Snippets/Save']) {
    const response = await post(route, { snippets: empty(), baseRevision: 0 }, learner);
    assert.equal(response.status, 403, route);
  }
  assert.equal((await post('/api/snippets/save', { snippets: empty(), baseRevision: 0 }, reader)).status, 403);
  assert.equal((await post('/api/snippets/save', { snippets: empty(), baseRevision: 0 }, '')).status, 401);
  assert.equal((await app.request('/API/user/role', { cookie: learner })).status, 200);
});

test('health probes reflect database readiness and malformed API input stays JSON', async () => {
  assert.equal((await app.request('/healthz')).status, 200);
  assert.equal((await app.request('/readyz')).status, 200);
  app.pool.failNext = /^SELECT 1$/;
  assert.equal((await app.request('/readyz')).status, 503);
  assert.equal((await app.request('/readyz')).status, 200);
  const malformed = await fetch(app.base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{invalid'
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'invalid_request' });
  assert.equal(malformed.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(malformed.headers.get('cache-control'), 'private, no-store');
});

test('registration rejects HTML nicknames and atomically consumes one invitation', async () => {
  const invalid = await post('/api/register', {
    nickname: '<img src=x onerror=void(0)>', password: 'Test-password-2026!', code: 'test-only-master-invitation'
  }, '');
  assert.equal(invalid.status, 400);
  await app.pool.query(`INSERT INTO invite_codes (code, creator_nickname, created_at)
    VALUES ('single-use-test', '02ashes', NOW())`);
  const results = await Promise.all(['invited-one', 'invited-two'].map(nickname => post('/api/register', {
    nickname, password: 'Test-password-2026!', code: 'single-use-test'
  }, '')));
  assert.deepEqual(results.map(item => item.status).sort(), [200, 400]);
  assert.equal(Number((await app.pool.query("SELECT COUNT(*) FROM user_registrations WHERE invite_code='single-use-test'")).rows[0].count), 1);

  await app.pool.query(`INSERT INTO invite_codes (code, creator_nickname, created_at)
    VALUES ('rollback-invite', '02ashes', NOW())`);
  const duplicate = await post('/api/register', {
    nickname: 'test-editor', password: 'Test-password-2026!', code: 'rollback-invite'
  }, '');
  assert.equal(duplicate.status, 409);
  assert.equal((await app.pool.query("SELECT used FROM invite_codes WHERE code='rollback-invite'")).rows[0].used, false);
});

test('new registration validation does not lock out legacy long credentials at login', async () => {
  const nickname = 'legacy-' + 'name'.repeat(20);
  const password = 'legacy-password-'.repeat(6);
  const hash = await require('bcrypt').hash(password, 10);
  await app.pool.query(`INSERT INTO user_registrations (nickname,password_hash,role,registered_at)
    VALUES ($1,$2,'reader',NOW())`, [nickname, hash]);
  const response = await post('/api/login', { nickname, password }, '');
  assert.equal(response.status, 200);
  assert.ok(response.cookie);
});

test('real Socket.IO does not send internal data or presence to guests and trainees', async t => {
  const connect = async cookie => {
    const socket = io(app.base, {
      transports: ['websocket'], forceNew: true, reconnection: false,
      ...(cookie ? { extraHeaders: { Cookie: cookie } } : {})
    });
    t.after(() => socket.disconnect());
    await once(socket, 'connect', { signal: AbortSignal.timeout(3000) });
    return socket;
  };
  const guest = await connect('');
  const trainee = await connect(learner);
  const staff = await connect(editor);
  const leaked = [];
  for (const socket of [guest, trainee]) {
    socket.on('snippets-updated', payload => leaked.push(payload));
    socket.on('online-update', payload => leaked.push(payload));
  }
  const online = once(staff, 'online-update', { signal: AbortSignal.timeout(3000) });
  staff.emit('identify', 'test-editor');
  await online;
  const updated = once(staff, 'snippets-updated', { signal: AbortSignal.timeout(3000) });
  const state = await app.request('/api/snippets/list', { cookie: editor });
  const saved = await post('/api/snippets/save', { snippets: snapshot('Private team text'), baseRevision: state.data.revision }, editor);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal((await updated)[0].snippets.snippets.note1.content, 'Private team text');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(leaked, []);
});

test('snippet revisions prevent lost updates and failures leave durable state unchanged', async () => {
  const original = (await app.request('/api/snippets/list', { cookie: editor })).data;
  const saved = await post('/api/snippets/save', { snippets: snapshot('First edit'), baseRevision: original.revision }, editor);
  assert.equal(saved.status, 200);
  const conflict = await post('/api/snippets/save', { snippets: snapshot('Stale edit'), baseRevision: original.revision }, editor);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.snippets.snippets.note1.content, 'First edit');
  app.pool.failNext = /INSERT INTO snippets_data/;
  const failed = await post('/api/snippets/save', { snippets: snapshot('Lost request'), baseRevision: saved.data.revision }, editor);
  assert.equal(failed.status, 500);
  const latest = (await app.request('/api/snippets/list', { cookie: editor })).data;
  assert.equal(latest.revision, saved.data.revision);
  assert.equal(latest.snippets.snippets.note1.content, 'First edit');
  const patched = await post('/api/snippets/item', { id: 'note1', content: 'Single item', baseContent: 'First edit' }, editor);
  assert.equal(patched.status, 200);
  const staleItem = await post('/api/snippets/item', { id: 'note1', content: 'Stale item', baseContent: 'First edit' }, editor);
  assert.equal(staleItem.status, 409);
});

test('case opening rolls back a failed prize insert and retries return the same prize', async () => {
  const grant = (await app.pool.query(`INSERT INTO case_grants
    (worker_nickname,tier,granted_by) VALUES ('test-editor',1,'02ashes') RETURNING id`)).rows[0];
  app.pool.failNext = /INSERT INTO case_openings/;
  const failed = await post('/api/cases/open', { grantId: grant.id }, editor);
  assert.equal(failed.status, 500);
  assert.equal((await app.pool.query('SELECT opened FROM case_grants WHERE id=$1', [grant.id])).rows[0].opened, false);
  assert.equal(Number((await app.pool.query('SELECT COUNT(*) FROM case_openings WHERE grant_id=$1', [grant.id])).rows[0].count), 0);
  const opened = await post('/api/cases/open', { grantId: grant.id }, editor);
  assert.equal(opened.status, 200);
  const retried = await post('/api/cases/open', { grantId: grant.id }, editor);
  assert.equal(retried.status, 200);
  assert.equal(retried.data.reused, true);
  assert.deepEqual(retried.data.prize, opened.data.prize);
  assert.equal(Number((await app.pool.query('SELECT COUNT(*) FROM case_openings WHERE grant_id=$1', [grant.id])).rows[0].count), 1);
});

test('history cleanup respects foreign keys and cannot remove active sessions', async () => {
  assert.equal((await post('/api/create', { sessionId: 'audit001' }, editor)).status, 200);
  assert.equal((await post('/api/create', { sessionId: 'audit002' }, editor)).status, 200);
  await app.pool.query(`INSERT INTO messages (session_id,message_id,from_user,text,timestamp)
    VALUES ('audit001','test-message','admin','Test',NOW())`);
  assert.equal((await post('/api/delete', { sessionId: 'audit001' }, editor)).status, 200);
  const cleanup = await post('/api/logs/cleanup-all', {});
  assert.equal(cleanup.status, 200, JSON.stringify(cleanup.data));
  assert.equal((await app.pool.query("SELECT id FROM sessions WHERE id='audit001'")).rows.length, 0);
  assert.equal((await app.pool.query("SELECT id FROM session_logs WHERE session_id='audit001'")).rows.length, 0);
  assert.equal((await app.pool.query("SELECT id FROM sessions WHERE id='audit002'")).rows.length, 1);
  const ownList = (await app.request('/api/sessions', { cookie: editor })).data.sessions;
  assert.ok(ownList.some(session => session.id === 'audit002'));
  assert.ok(!(await app.request('/api/sessions', { cookie: reader })).data.sessions.some(session => session.id === 'audit002'));
});

test('deleting an account removes learner records and revokes its old authentication', async () => {
  await app.pool.query(`INSERT INTO training_progress (nickname,lesson,passed_at)
    VALUES ('test-learner',1,NOW())`);
  assert.equal((await post('/api/users/delete', { nickname: '02ashes' })).status, 403);
  const removed = await post('/api/users/delete', { nickname: 'test-learner' });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal((await app.request('/api/auth/check', { cookie: learner })).status, 401);
  assert.equal((await app.pool.query("SELECT * FROM training_progress WHERE nickname='test-learner'")).rows.length, 0);
});

test('wheel codes survive application restart and can only be consumed with their actual prize once', async () => {
  assert.equal((await post('/api/wheel/create', { code: 'restart-code', prize: 'Custom' }, editor)).status, 200);
  const pool = app.pool;
  await app.close({ keepDatabase: true });
  app = await startApplication({ pool });
  assert.equal((await post('/api/wheel/check', { code: 'restart-code' }, '')).status, 200);
  assert.equal((await post('/api/wheel/result', { code: 'restart-code', prize: 'Lovense' }, '')).status, 409);
  const results = await Promise.all([1, 2].map(() => post('/api/wheel/result', { code: 'restart-code', prize: 'Custom' }, '')));
  assert.deepEqual(results.map(item => item.status).sort(), [200, 200]);
  assert.equal(results.filter(item => item.data.reused).length, 1);
  assert.equal((await post('/api/wheel/check', { code: 'restart-code' }, '')).status, 410);
});

test('production graceful shutdown closes the server and database without leaving timers', async () => {
  await app.close();
  assert.equal(app.server.listening, false);
  assert.equal(app.pool.db.closed, true);
});
