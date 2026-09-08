'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { io } = require('socket.io-client');
const { startApplication } = require('./helpers/application');
let app, owner, outsider;
const post = (route, body, cookie = owner) => app.request(route, { method: 'POST', body, cookie });
before(async () => {
    app = await startApplication();
    owner = await app.register('control-owner');
    outsider = await app.register('control-outsider');
});
after(async () => { if (app) await app.close(); });
async function connect(cookie) {
    const socket = io(app.base, { transports: ['websocket'], extraHeaders: { Cookie: cookie }, reconnection: false });
    await once(socket, 'connect');
    return socket;
}

test('session creation is owner-bound, persists its audit log atomically and rejects deleted ids', async () => {
    app.pool.failNext = /INSERT INTO session_logs/;
    assert.equal((await post('/api/create', { sessionId: 'create01' })).status, 500);
    assert.equal((await app.pool.query("SELECT * FROM sessions WHERE id='create01'")).rows.length, 0);
    assert.equal((await post('/api/create', { sessionId: 'create01' })).status, 200);
    assert.equal((await post('/api/create', { sessionId: 'create01' }, outsider)).status, 403);
    assert.equal((await post('/api/revoke', { sessionId: 'create01' }, outsider)).status, 403);
    assert.equal((await post('/api/delete', { sessionId: 'create01' }, outsider)).status, 403);
    assert.equal((await post('/api/delete', { sessionId: 'create01' })).status, 200);
    assert.equal((await post('/api/create', { sessionId: 'create01' })).status, 409);
});

test('a far-future control expiry survives Node timer overflow and a server restart', async () => {
    const expiresAt = new Date(Date.now() + 365 * 86400000).toISOString();
    assert.equal((await post('/api/create', { sessionId: 'future01', expiresAt })).status, 200);
    await delay(25);
    assert.equal((await app.pool.query("SELECT revoked FROM sessions WHERE id='future01'")).rows[0].revoked, false);
    const pool = app.pool;
    await app.close({ keepDatabase: true });
    app = await startApplication({ pool });
    await delay(25);
    assert.equal((await app.pool.query("SELECT revoked FROM sessions WHERE id='future01'")).rows[0].revoked, false);
});

test('restart re-arms persisted expired control sessions without a client visit', async () => {
    await app.pool.query(`INSERT INTO sessions(id,creator_nickname,is_active,revoked,expires_at,created_at)
        VALUES ('expired1','control-owner',true,false,NOW()-INTERVAL '1 hour',NOW())`);
    const pool = app.pool;
    await app.close({ keepDatabase: true });
    app = await startApplication({ pool });
    for (let attempt = 0; attempt < 20; attempt++) {
        const row = (await app.pool.query("SELECT revoked,is_active FROM sessions WHERE id='expired1'")).rows[0];
        if (row.revoked) { assert.equal(row.is_active, false); return; }
        await delay(10);
    }
    assert.fail('persisted expiry job did not execute');
});

test('chat acknowledgements follow durable commit; failed messages are not broadcast or cached', async t => {
    assert.equal((await post('/api/create', { sessionId: 'chat0001' })).status, 200);
    const socket = await connect(owner);
    t.after(() => socket.disconnect());
    let joined = once(socket, 'session-data');
    socket.emit('join-session', 'chat0001', 'operator');
    await joined;
    const messages = [];
    socket.on('new-message', message => messages.push(message));
    app.pool.failNext = /INSERT INTO messages/;
    const failed = await socket.timeout(3000).emitWithAck('chat-message', {
        sessionId: 'chat0001', message: { text: 'Unsaved draft', type: 'text' }
    });
    assert.deepEqual(failed, { ok: false, error: 'database_error' });
    assert.equal(messages.length, 0);
    joined = once(socket, 'session-data');
    socket.emit('join-session', 'chat0001', 'operator');
    const [snapshot] = await joined;
    assert.equal(snapshot.messages.length, 0);
    const saved = await socket.timeout(3000).emitWithAck('chat-message', {
        sessionId: 'chat0001', message: { text: 'Saved message', type: 'text' }
    });
    assert.equal(saved.ok, true);
    assert.equal(typeof saved.messageId, 'string');
    assert.equal((await app.pool.query("SELECT text FROM messages WHERE session_id='chat0001'")).rows[0].text, 'Saved message');
    const invalid = await socket.timeout(3000).emitWithAck('chat-message', {
        sessionId: 'chat0001', message: { text: 'x'.repeat(1001), type: 'text' }
    });
    assert.deepEqual(invalid, { ok: false, error: 'invalid_message' });
});

test('a delayed session load cannot resurrect a session after deletion', async t => {
    assert.equal((await post('/api/create', { sessionId: 'staler01' })).status, 200);
    const pool = app.pool;
    await app.close({ keepDatabase: true });
    app = await startApplication({ pool });
    const originalQuery = pool.query.bind(pool);
    let release, loaded;
    const blocked = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { loaded = resolve; });
    let intercepted = false;
    pool.query = async (sql, values) => {
        const result = await originalQuery(sql, values);
        if (!intercepted && String(sql).includes('SELECT * FROM messages WHERE session_id') && values?.[0] === 'staler01') {
            intercepted = true;
            loaded();
            await blocked;
        }
        return result;
    };
    t.after(() => { pool.query = originalQuery; release(); });
    const socket = await connect(owner);
    t.after(() => socket.disconnect());
    let published = false;
    socket.on('session-data', () => { published = true; });
    socket.emit('join-session', 'staler01', 'operator');
    await started;
    assert.equal((await post('/api/delete', { sessionId: 'staler01' })).status, 200);
    const rejected = once(socket, 'session-error');
    release();
    assert.deepEqual((await rejected)[0], { error: 'session_not_found' });
    assert.equal(published, false);
});

test('demoted trainee cannot rejoin an owned control session as operator', async t => {
    await app.pool.query("UPDATE user_registrations SET role='new' WHERE nickname='control-owner'");
    const socket = await connect(owner);
    t.after(() => socket.disconnect());
    const denied = once(socket, 'session-error');
    socket.emit('join-session', 'chat0001', 'operator');
    assert.deepEqual((await denied)[0], { error: 'permission_denied' });
});
