'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const backendState = require('../lib/backend-state');
const { startApplication } = require('./helpers/application');

test('initial case configuration rolls back on failure and concurrent retries seed only once', async t => {
  const app = await startApplication();
  t.after(() => app.close());
  await app.pool.query('DELETE FROM case_tier_prizes');
  await app.pool.query('DELETE FROM case_prizes');
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf('async function seedCasePrizes()');
  const end = source.indexOf('// Периодическая синхронизация', start);
  assert.ok(start >= 0 && end > start);
  const seed = new Function('pool', 'backendState', 'console',
    source.slice(start, end) + '\nreturn seedCasePrizes;')(app.pool, backendState, { log() {} });

  app.pool.failNext = /INSERT INTO case_tier_prizes/;
  await assert.rejects(seed(), /Deliberate isolated database failure/);
  assert.equal(Number((await app.pool.query('SELECT COUNT(*) AS n FROM case_prizes')).rows[0].n), 0);
  assert.equal(Number((await app.pool.query('SELECT COUNT(*) AS n FROM case_tier_prizes')).rows[0].n), 0);
  await Promise.all([seed(), seed()]);
  assert.equal(Number((await app.pool.query('SELECT COUNT(*) AS n FROM case_prizes')).rows[0].n), 12);
  assert.equal(Number((await app.pool.query('SELECT COUNT(*) AS n FROM case_tier_prizes')).rows[0].n), 17);
});
