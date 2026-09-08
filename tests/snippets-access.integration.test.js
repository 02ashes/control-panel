'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { io } = require('socket.io-client');
const { startApplication } = require('./helpers/application');

let app;
const cookies = {};
const roles = {
  '02ashes': 'admin',
  'access-admin': 'admin',
  'access-editor': 'user',
  'access-reader': 'reader',
  'access-trainee': 'new',
  '02Ashes': 'admin'
};
const snapshot = text => ({ folders: {}, snippets: {
  restricted: { id: 'restricted', name: 'Restricted note', content: text, parentId: null }
}, structure: ['restricted'] });
const post = (route, body, cookie = cookies['02ashes']) => app.request(route, { method: 'POST', body, cookie });
const grant = (targetNickname, enabled = true, cookie = cookies['02ashes']) =>
  post('/api/user/snippets-access', { targetNickname, enabled }, cookie);
const roleFor = nickname => app.request('/api/user/role', { cookie: cookies[nickname] });
const listFor = nickname => app.request('/api/snippets/list', { cookie: cookies[nickname] });
async function ownerSave(text) {
  const state = await listFor('02ashes');
  assert.equal(state.status, 200);
  const result = await post('/api/snippets/save', { snippets: snapshot(text), baseRevision: state.data.revision });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}

before(async () => {
  app = await startApplication();
  for (const [nickname, role] of Object.entries(roles)) {
    cookies[nickname] = await app.register(nickname);
    await app.pool.query('UPDATE user_registrations SET role=$1 WHERE nickname=$2', [role, nickname]);
  }
});
after(async () => { if (app) await app.close(); });

test('only the exact owner has implicit snippets access; every ordinary role starts denied', async () => {
  for (const nickname of Object.keys(roles)) {
    const role = await roleFor(nickname);
    assert.equal(role.status, 200);
    assert.equal(role.data.snippetsAccess, nickname === '02ashes', nickname);
    assert.equal(role.data.canManageSnippetsAccess, nickname === '02ashes', nickname);
    assert.equal((await listFor(nickname)).status, nickname === '02ashes' ? 200 : 403, nickname);
  }
  assert.equal((await app.request('/api/snippets/list')).status, 401);
  const saved = await ownerSave('Owner-only initial content');
  assert.equal(saved.snippets.snippets.restricted.content, 'Owner-only initial content');
});

test('denied accounts cannot read snapshots, conflict responses, individual edits or snippet logs', async () => {
  for (const nickname of ['access-admin', 'access-editor', 'access-reader', 'access-trainee', '02Ashes']) {
    const cookie = cookies[nickname];
    for (const route of ['/api/snippets/list', '/API/SNIPPETS/LIST', '/api/logs/snippets', '/API/LOGS/SNIPPETS']) {
      const result = await app.request(route, { cookie });
      assert.equal(result.status, 403, nickname + ' ' + route);
      assert.ok(!JSON.stringify(result.data).includes('Owner-only initial content'));
    }
    for (const [route, body] of [
      ['/api/snippets/save', { baseRevision: -1, snippets: snapshot('Forbidden overwrite') }],
      ['/api/snippets/item', { id: 'restricted', baseContent: 'Wrong stale content', content: 'Forbidden edit' }]
    ]) {
      const result = await post(route, body, cookie);
      assert.equal(result.status, 403, nickname + ' ' + route);
      assert.ok(!Object.hasOwn(result.data, 'snippets'), 'Conflict response must not leak the snapshot');
    }
  }
  assert.equal((await listFor('02ashes')).data.snippets.snippets.restricted.content, 'Owner-only initial content');
});

test('admins and spoofed owner claims cannot grant access or smuggle it through the base-role endpoint', async () => {
  for (const nickname of ['access-admin', 'access-editor', 'access-reader', 'access-trainee', '02Ashes']) {
    const result = await post('/api/user/snippets-access', {
      targetNickname: nickname, enabled: true, nickname: '02ashes', actorNickname: '02ashes', role: 'admin'
    }, cookies[nickname]);
    assert.equal(result.status, 403, nickname);
    assert.equal((await roleFor(nickname)).data.snippetsAccess, false);
  }
  assert.equal((await grant('access-reader', true, '')).status, 401);
  const promoted = await post('/api/user/role', {
    targetNickname: 'access-reader', newRole: 'admin', snippetsAccess: true, snippets_access: true
  }, cookies['access-admin']);
  assert.equal(promoted.status, 200);
  assert.equal((await roleFor('access-reader')).data.snippetsAccess, false);
  assert.equal((await grant('access-reader', true, cookies['access-reader'])).status, 403);
  assert.equal((await post('/api/user/role', { targetNickname: 'access-reader', newRole: 'reader' })).status, 200);
});

test('owner grant validation is strict and does not affect the owner or missing accounts', async () => {
  for (const enabled of ['true', 'false', 1, 0, null, {}, []]) {
    const result = await post('/api/user/snippets-access', { targetNickname: 'access-reader', enabled });
    assert.equal(result.status, 400, JSON.stringify(enabled));
  }
  assert.equal((await post('/api/user/snippets-access', { targetNickname: 'access-reader' })).status, 400);
  assert.equal((await post('/api/user/snippets-access', { enabled: true })).status, 400);
  assert.equal((await grant('missing-account')).status, 404);
  assert.equal((await grant('02ashes', false)).status, 403);
  assert.equal((await roleFor('02ashes')).data.snippetsAccess, true);
  assert.equal((await roleFor('02ashes')).data.canManageSnippetsAccess, true);
});

test('an owner grant enables reader copying and editor writes without changing their base roles', async () => {
  for (const nickname of ['access-reader', 'access-editor', 'access-admin']) {
    const granted = await grant(nickname);
    assert.equal(granted.status, 200, JSON.stringify(granted.data));
    const role = await roleFor(nickname);
    assert.equal(role.data.snippetsAccess, true);
    assert.equal(role.data.canManageSnippetsAccess, false);
    assert.equal(role.data.role, roles[nickname]);
    assert.equal((await listFor(nickname)).status, 200);
  }
  const readerState = (await listFor('access-reader')).data;
  assert.equal(readerState.snippets.snippets.restricted.content, 'Owner-only initial content');
  assert.equal((await post('/api/snippets/save', { snippets: snapshot('Reader write'), baseRevision: readerState.revision }, cookies['access-reader'])).status, 403);
  assert.equal((await post('/api/snippets/item', { id: 'restricted', content: 'Reader edit', baseContent: 'Owner-only initial content' }, cookies['access-reader'])).status, 403);
  const editorSave = await post('/api/snippets/save', { snippets: snapshot('Granted editor content'), baseRevision: readerState.revision }, cookies['access-editor']);
  assert.equal(editorSave.status, 200, JSON.stringify(editorSave.data));
  assert.equal((await post('/api/snippets/item', { id: 'restricted', content: 'Granted item edit', baseContent: 'Granted editor content' }, cookies['access-editor'])).status, 200);
  assert.equal((await app.request('/api/logs/snippets', { cookie: cookies['access-admin'] })).status, 200);
  const users = (await app.request('/api/users', { cookie: cookies['02ashes'] })).data.users;
  assert.equal(users.find(user => user.nickname === 'access-reader').snippetsAccess, true);
  assert.equal(users.find(user => user.nickname === 'access-trainee').snippetsAccess, false);
  assert.equal((await grant('access-admin', false)).status, 200);
  assert.equal((await app.request('/api/logs/snippets', { cookie: cookies['access-admin'] })).status, 403);
});

test('trainee restrictions remain in force even when an owner records a snippets grant', async () => {
  const result = await grant('access-trainee');
  // The assigned role is visible/revocable to the owner but never bypasses training.
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.snippetsAccessGranted, true);
  assert.equal((await roleFor('access-trainee')).data.snippetsAccess, false);
  assert.equal((await listFor('access-trainee')).status, 403);
  assert.equal((await app.request('/learn/day1.html', { cookie: cookies['access-trainee'] })).status, 200);
});

test('a save authorized before a concurrent revoke rechecks access before the durable write', { timeout: 10000 }, async t => {
  assert.equal((await grant('access-editor')).status, 200);
  const beforeSave = (await listFor('02ashes')).data;
  const originalQuery = app.pool.query.bind(app.pool);
  let release;
  let notifyStarted;
  let intercepted = false;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { notifyStarted = resolve; });
  app.pool.query = async (sql, values) => {
    const result = await originalQuery(sql, values);
    if (!intercepted && /FROM auth_sessions s/.test(String(sql)) && result.rows[0]?.nickname === 'access-editor') {
      intercepted = true;
      notifyStarted();
      await blocked;
    }
    return result;
  };
  t.after(() => { app.pool.query = originalQuery; release(); });
  const pending = post('/api/snippets/save', {
    snippets: snapshot('Write queued before revoke'), baseRevision: beforeSave.revision
  }, cookies['access-editor']);
  await started;
  assert.equal((await grant('access-editor', false)).status, 200);
  release();
  const denied = await pending;
  assert.equal(denied.status, 403, JSON.stringify(denied.data));
  assert.ok(!Object.hasOwn(denied.data, 'snippets'));
  assert.deepEqual((await listFor('02ashes')).data, beforeSave);
  app.pool.query = originalQuery;
  assert.equal((await grant('access-editor')).status, 200);
});

test('grant and revoke update every connected client while preserving chat and excluding forbidden broadcasts', async t => {
  const connect = async cookie => {
    const socket = io(app.base, {
      transports: ['websocket'], forceNew: true, reconnection: false,
      ...(cookie ? { extraHeaders: { Cookie: cookie } } : {})
    });
    t.after(() => socket.disconnect());
    await once(socket, 'connect', { signal: AbortSignal.timeout(5000) });
    return socket;
  };
  const editorOne = await connect(cookies['access-editor']);
  const editorTwo = await connect(cookies['access-editor']);
  assert.equal((await post('/api/create', { sessionId: 'access01' }, cookies['access-editor'])).status, 200);
  const joined = once(editorOne, 'session-data', { signal: AbortSignal.timeout(5000) });
  editorOne.emit('join-session', 'access01', 'operator');
  await joined;
  const deniedAdmin = await connect(cookies['access-admin']);
  const guest = await connect('');
  const leaked = [];
  for (const socket of [deniedAdmin, guest]) socket.on('snippets-updated', value => leaked.push(value));

  const initialUpdates = [editorOne, editorTwo].map(socket => once(socket, 'snippets-updated', { signal: AbortSignal.timeout(5000) }));
  const stale = await ownerSave('Visible before revocation');
  for (const update of await Promise.all(initialUpdates)) assert.equal(update[0].snippets.snippets.restricted.content, 'Visible before revocation');

  const revocations = [editorOne, editorTwo].map(socket => once(socket, 'permissions-changed', { signal: AbortSignal.timeout(5000) }));
  assert.equal((await grant('access-editor', false)).status, 200);
  for (const change of await Promise.all(revocations)) {
    assert.equal(change[0].nickname, 'access-editor');
    assert.equal(change[0].snippetsAccess, false);
  }
  assert.equal(editorOne.connected, true, 'Access revoke must not terminate the working session');
  assert.equal(editorTwo.connected, true);
  const sent = await editorOne.timeout(5000).emitWithAck('chat-message', {
    sessionId: 'access01', message: { text: 'Session continues without snippets', type: 'text' }
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal((await app.pool.query("SELECT text FROM messages WHERE session_id='access01'")).rows[0].text, 'Session continues without snippets');
  const revokedUpdates = [];
  for (const socket of [editorOne, editorTwo]) socket.on('snippets-updated', value => revokedUpdates.push(value));
  const reconnected = await connect(cookies['access-editor']);
  reconnected.on('snippets-updated', value => revokedUpdates.push(value));
  // A stale tab can still submit its exact old snapshot and version; the server
  // must deny access before returning any newer content in a conflict response.
  assert.equal((await post('/api/snippets/save', { snippets: snapshot('Stale edit'), baseRevision: stale.revision }, cookies['access-editor'])).status, 403);
  assert.equal((await post('/api/snippets/item', { id: 'restricted', baseContent: 'Visible before revocation', content: 'Stale item edit' }, cookies['access-editor'])).status, 403);
  assert.equal((await listFor('access-editor')).status, 403);
  await ownerSave('Never deliver to revoked clients');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(revokedUpdates, []);
  assert.deepEqual(leaked, []);

  const grants = [editorOne, editorTwo, reconnected].map(socket => once(socket, 'permissions-changed', { signal: AbortSignal.timeout(5000) }));
  assert.equal((await grant('access-editor')).status, 200);
  for (const change of await Promise.all(grants)) assert.equal(change[0].snippetsAccess, true);
  const regrantedUpdates = [editorOne, editorTwo, reconnected].map(socket => once(socket, 'snippets-updated', { signal: AbortSignal.timeout(5000) }));
  await ownerSave('Visible after explicit regrant');
  for (const update of await Promise.all(regrantedUpdates)) assert.equal(update[0].snippets.snippets.restricted.content, 'Visible after explicit regrant');
});

test('owner-issued access survives restart but a pre-access database migration denies all non-owner accounts', async () => {
  const pool = app.pool;
  await app.close({ keepDatabase: true });
  app = await startApplication({ pool });
  assert.equal((await roleFor('access-editor')).data.snippetsAccess, true);
  assert.equal((await roleFor('access-reader')).data.snippetsAccess, true);
  assert.equal((await roleFor('access-admin')).data.snippetsAccess, false);

  const beforeMigration = (await listFor('02ashes')).data;
  await app.close({ keepDatabase: true });
  // Simulate the existing production schema without the additive permission
  // column, retaining actual accounts, auth sessions and durable snippets.
  await pool.query('ALTER TABLE user_registrations DROP COLUMN snippets_access');
  app = await startApplication({ pool });
  for (const nickname of Object.keys(roles)) {
    const role = await roleFor(nickname);
    assert.equal(role.data.snippetsAccess, nickname === '02ashes', nickname);
    assert.equal((await listFor(nickname)).status, nickname === '02ashes' ? 200 : 403, nickname);
  }
  assert.deepEqual((await listFor('02ashes')).data, beforeMigration);
});
