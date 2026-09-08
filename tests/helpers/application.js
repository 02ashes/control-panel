'use strict';

// Match production's legacy TIMESTAMP contract within this isolated test worker.
process.env.TZ = 'UTC';

// The actual production source runs against PostgreSQL in WASM, never pg's
// network driver. No host environment, credentials, or real grader is used.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.resolve(__dirname, '../..');

async function createTestPool() {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  const pool = {
    db,
    failNext: null,
    statements: [],
    on() { return pool; },
    async lease() {
      const previous = queue;
      let unlock;
      queue = new Promise(resolve => { unlock = resolve; });
      await previous;
      let released = false;
      return {
        async query(sql, values = []) {
          if (sql && typeof sql === 'object') { values = sql.values || values; sql = sql.text; }
          pool.statements.push(String(sql));
          if (pool.failNext && pool.failNext.test(String(sql))) {
            pool.failNext = null;
            throw new Error('Deliberate isolated database failure');
          }
          const result = await db.query(sql, values);
          return { ...result, rows: result.rows || [], rowCount: result.affectedRows || result.rows?.length || 0 };
        },
        release() { if (!released) { released = true; unlock(); } }
      };
    },
    connect(callback) {
      const pending = pool.lease();
      if (callback) { pending.then(client => callback(null, client, client.release), callback); return; }
      return pending;
    },
    async query(sql, values) {
      const client = await pool.lease();
      try { return await client.query(sql, values); } finally { client.release(); }
    },
    async end() { await queue; await db.close(); }
  };
  return pool;
}

async function startApplication({ pool: existingPool, env = {} } = {}) {
  const pool = existingPool || await createTestPool();
  const requireFromRoot = createRequire(path.join(ROOT, 'server.js'));
  const intervals = new Set();
  const timeouts = new Set();
  const logs = [];
  let actualServer;
  const safeEnv = {
    NODE_ENV: 'test', PORT: '0', XAI_API_KEY: 'test-not-a-real-api-key',
    MASTER_INVITE_CODE: 'test-only-master-invitation', DATABASE_URL: 'postgresql://unused.invalid/test',
    ...env
  };
  const context = {
    __dirname: ROOT, __filename: path.join(ROOT, 'server.js'),
    module: { exports: {} }, exports: {}, Buffer, URL, URLSearchParams,
    process: {
      env: safeEnv, on() {}, once() {},
      exit(code) { throw new Error(`Unexpected application exit ${code}: ${logs.join('\n')}`); }
    },
    console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(method => [method,
      (...args) => logs.push(args.map(value => value instanceof Error ? value.message : String(value)).join(' '))])),
    setInterval(fn, ms) { const timer = setInterval(fn, ms); timer.unref(); intervals.add(timer); return timer; },
    clearInterval(timer) { clearInterval(timer); intervals.delete(timer); },
    setTimeout(fn, ms, ...args) {
      const timer = setTimeout(() => { timeouts.delete(timer); fn(...args); }, ms);
      timer.unref(); timeouts.add(timer); return timer;
    },
    clearTimeout(timer) { clearTimeout(timer); timeouts.delete(timer); },
    setImmediate, clearImmediate,
    require(name) {
      if (name === 'pg') return { Pool: class { constructor() { return pool; } } };
      if (name === 'http') return { ...http, createServer(...args) {
        actualServer = http.createServer(...args);
        const listen = actualServer.listen.bind(actualServer);
        actualServer.listen = (port, ...args) => listen(Number(port), '127.0.0.1', ...args.filter(arg => typeof arg === 'function'));
        return actualServer;
      } };
      if (name === 'https') return {
        get() { throw new Error('External network disabled in integration test'); },
        request() { throw new Error('External network disabled in integration test'); }
      };
      if (name === './learn/grading-v2.js') return {
        ...requireFromRoot(name), callGrok: async () => { throw new Error('Live grader disabled in integration test'); }
      };
      return requireFromRoot(name);
    }
  };
  const code = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  try {
    // Same-realm evaluation is intentional: Express 4 checks route RegExp with
    // instanceof, which rejects otherwise identical cross-VM regular expressions.
    context.fixture = new Function(...Object.keys(context), code + '\nreturn { app, server, io, databaseReady, shutdown };')(...Object.values(context));
    await context.fixture.databaseReady;
    if (!actualServer.listening) await once(actualServer, 'listening');
  } catch (error) {
    for (const timer of intervals) clearInterval(timer);
    for (const timer of timeouts) clearTimeout(timer);
    context.fixture?.io.close();
    if (!existingPool) await pool.end();
    error.message += '\n' + logs.join('\n');
    throw error;
  }
  const base = `http://127.0.0.1:${actualServer.address().port}`;
  let closed = false;
  return {
    pool, base, logs, ...context.fixture,
    async request(route, { method = 'GET', body, cookie, headers = {} } = {}) {
      const response = await fetch(base + route, {
        method, redirect: 'manual',
        headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch (_) { data = text; }
      return { status: response.status, data, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    },
    async register(nickname) {
      const response = await this.request('/api/register', {
        method: 'POST', body: { nickname, password: 'Test-password-2026!', code: safeEnv.MASTER_INVITE_CODE }
      });
      if (response.status !== 200) throw new Error('Test registration failed: ' + JSON.stringify(response.data));
      return response.cookie;
    },
    async close({ keepDatabase = false } = {}) {
      if (closed) return;
      closed = true;
      for (const timer of intervals) clearInterval(timer);
      for (const timer of timeouts) clearTimeout(timer);
      if (keepDatabase) {
        await new Promise(resolve => context.fixture.io.close(resolve));
        actualServer.closeAllConnections();
      } else {
        await context.fixture.shutdown('test teardown');
      }
    }
  };
}

module.exports = { createTestPool, startApplication };
