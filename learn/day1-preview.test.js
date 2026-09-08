'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const THEORY = require('./day1-theory.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Preview start timed out: ${output}`)), 5000);
    const onData = chunk => {
      output += chunk.toString('utf8');
      if (!output.includes('Day 1 preview:')) return;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      resolve();
    };
    child.stdout.on('data', onData);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Preview exited early with ${code}: ${output}`));
    });
  });
}

async function request(base, pathname, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('X-Nickname', options.nickname || 'preview-contract-worker');
  if (options.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(base + pathname, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    redirect: options.redirect || 'follow'
  });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  return { response, data };
}

test('local preview mirrors Day 1 theory, reset, and private-file contracts', async t => {
  const port = await freePort();
  const child = spawn(process.execPath, [path.resolve(__dirname, 'day1-preview-server.js')], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PREVIEW_PORT: String(port),
      XAI_API_KEY: 'preview-test-key-not-called'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => {
    if (!child.killed) child.kill('SIGTERM');
  });
  await waitForReady(child);

  const base = `http://127.0.0.1:${port}`;
  let result = await request(base, '/', { redirect: 'manual' });
  assert.equal(result.response.status, 302);
  assert.equal(result.response.headers.get('location'), '/learn/day1.html?preview=1');

  result = await request(base, '/learn/day1-normalize.js');
  assert.equal(result.response.status, 200);
  assert.match(result.data, /function normalizeAnswer\(value\)/);

  for (const privatePath of [
    '/learn/evals/day1-eval-cases.js',
    '/learn/programs/day1-v1-rubrics.js',
    '/learn/grading-v2.js',
    '/learn/server.js',
    '/learn/results.json',
    '/clear-db.js'
  ]) {
    result = await request(base, privatePath);
    assert.equal(result.response.status, 404, `${privatePath} must stay private`);
  }

  result = await request(base, '/api/training/check-paste');
  assert.equal(result.response.status, 410);
  assert.equal(result.data.error, 'legacy_training_disabled');

  const root = '/api/training/v2/programs/day1-v1';
  result = await request(base, root);
  assert.equal(result.response.status, 200);
  assert.equal(result.data.program.tasks.length, 8);
  assert.equal(result.data.program.theory.version, THEORY.version);

  result = await request(base, `${root}/tasks/personalized_opener/grade`, {
    nickname: 'preview-gated-worker',
    method: 'POST',
    body: { answer: 'Hey Ethan, night shifts sound intense. Do you still train after work?' }
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.data.error, 'theory_required');

  const second = THEORY.modules[1];
  result = await request(base, `${root}/theory`, {
    method: 'POST',
    body: {
      moduleId: second.id,
      theoryId: THEORY.id,
      theoryVersion: THEORY.version,
      selectedIndex: second.check.correctIndex
    }
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.data.error, 'theory_module_locked');

  const first = THEORY.modules[0];
  result = await request(base, `${root}/theory`, {
    method: 'POST',
    body: {
      moduleId: first.id,
      theoryId: THEORY.id,
      theoryVersion: THEORY.version,
      selectedIndex: (first.check.correctIndex + 1) % first.check.options.length
    }
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.correct, false);
  assert.equal(result.data.theory.completedCount, 0);

  for (const module of THEORY.modules) {
    result = await request(base, `${root}/theory`, {
      method: 'POST',
      body: {
        moduleId: module.id,
        theoryId: THEORY.id,
        theoryVersion: THEORY.version,
        selectedIndex: module.check.correctIndex
      }
    });
    assert.equal(result.response.status, 200, module.id);
    assert.equal(result.data.correct, true, module.id);
  }

  result = await request(base, `${root}/state`);
  assert.equal(result.data.state.theory.complete, true);
  assert.equal(result.data.state.theory.completedCount, THEORY.modules.length);

  result = await request(base, '/api/training/v2/preview/reset', {
    method: 'POST',
    body: {}
  });
  assert.equal(result.data.resetGeneration, 1);
  result = await request(base, `${root}/state`);
  assert.equal(result.data.state.theory.completedCount, 0);
  assert.equal(result.data.state.resetGeneration, 1);

  result = await request(base, `${root}/theory`, {
    method: 'POST',
    body: {
      moduleId: first.id,
      theoryId: THEORY.id,
      theoryVersion: THEORY.version,
      selectedIndex: first.check.correctIndex,
      resetGeneration: 0
    }
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.data.error, 'training_reset');
  result = await request(base, `${root}/tasks/personalized_opener/grade`, {
    method: 'POST',
    body: { answer: 'Hey Ethan, night shifts sound intense. Do you still train after work?', resetGeneration: 0 }
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.data.error, 'training_reset');
  result = await request(base, `${root}/state`);
  assert.equal(result.data.state.theory.completedCount, 0);
});

test('Day 1 migrates the old production draft only before an admin reset', () => {
  const source = fs.readFileSync(path.join(__dirname, 'day1-app.js'), 'utf8');
  assert.match(source, /function legacyDraftKey\(taskId\)/);
  assert.match(source, /value === null && resetGeneration === 0/);
  assert.match(source, /localStorage\.getItem\(legacyDraftKey\(taskId\)\)/);
  assert.match(source, /localStorage\.setItem\(currentKey, value\)/);
});

test('Day 1 loads shared normalization before the app and shows a multiline counter', () => {
  const html = fs.readFileSync(path.join(__dirname, 'day1.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, 'day1-app.js'), 'utf8');
  assert.ok(html.indexOf('/learn/day1-normalize.js') < html.indexOf('/learn/day1-app.js'));
  assert.match(app, /TEXT\.normalizeAnswer\(value\)/);
  assert.match(app, /Сообщения:.*messages.*expected/);
});

test('production Day 1 rate-limits real Grok calls, not formatting errors or cached reuse', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(
    source,
    /requireDay1Role,\s*day1GradeRateLimit/,
    'the route-level limiter would charge validation and cache hits'
  );
  assert.match(source, /if \(!gradingPromise\) \{[\s\S]{0,500}consumeMemoryRateLimit\(/);
  assert.match(source, /answerHash:\s*row\.answer_hash/);
  assert.match(source, /SELECT id, task_id, answer_text, answer_hash/);
});

test('production maps every upstream xAI failure to retryable grader downtime', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /const upstreamXaiError = \/\^xai_\//);
  assert.match(source, /const status = upstreamXaiError\s*\?\s*503/);
  assert.match(source, /status === 503[\s\S]{0,300}'grader_unavailable'/);
  assert.match(
    source,
    /err\.code === 'invalid_assessment'\s*\?\s*'grading_error'\s*:\s*'internal_error'/,
    'only deterministic Grok assessment failures should use the parse-error toast'
  );
});
