'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const PROGRAM = require('./programs/day1-v1.js');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function fixture({ submission = null, slotStatus = null, resetGeneration = 0 } = {}) {
  const queries = [];
  const grader = { ...require('./grading-v2.js') };
  let released = false;
  const client = {
    release() { released = true; },
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('FROM user_registrations')) return { rows: [{ nickname: 'fixture' }] };
      if (sql.includes('FROM training_v2_submissions')) {
        // The fixture enforces the actual submission lookup identity, rather than matching source text.
        const matches = submission && params[3] === PROGRAM.rubricVersion &&
          params[4] === submission.task_id && params[5] === submission.answer_hash;
        return { rows: matches ? [submission] : [] };
      }
      if (sql.includes('SELECT status FROM training_v2_attempt_slots')) {
        return { rows: slotStatus ? [{ status: slotStatus }] : [] };
      }
      if (sql.includes('INSERT INTO training_v2_attempt_slots')) {
        return { rows: [{ attempt_number: 1, reservation_token: params[6] }] };
      }
      return { rows: [] };
    }
  };
  const context = {
    crypto, DAY1_PROGRAM: PROGRAM, gradingV2: grader,
    pool: { connect: async () => client },
    getDay1TheoryState: async () => ({ theory: { complete: true }, resetGeneration })
  };
  const snippet = source.slice(source.indexOf('function getDay1Hashes('), source.indexOf('async function releaseDay1Attempt('));
  vm.createContext(context);
  vm.runInContext(snippet, context, { filename: 'server-day1-attempts.js' });
  return { context, grader, queries, released: () => released };
}

test('completed answer is reused across grader/model cache invalidation without spending another attempt', async () => {
  const taskId = PROGRAM.tasks[0].id;
  const answer = 'An answer used only by an isolated test.';
  const answerHash = require('./grading-v2.js').hashAnswer(answer);
  const submission = { id: 17, task_id: taskId, answer_hash: answerHash };
  const { context, grader, queries, released } = fixture({ submission, slotStatus: 'completed' });
  const original = context.getDay1Hashes(taskId, answer);
  grader.MODEL = 'different-fixture-model';
  grader.GRADER_VERSION = 'different-fixture-grader';
  const updated = context.getDay1Hashes(taskId, answer);
  assert.notEqual(original.cacheKey, updated.cacheKey);
  const reservation = await context.reserveDay1Attempt('fixture', taskId, answerHash, updated.cacheKey, 0);
  assert.equal(reservation.existing.id, 17);
  assert.equal(queries.some(item => item.sql.includes('INSERT INTO training_v2_attempt_slots')), false);
  assert.equal(queries.at(-1).sql, 'COMMIT');
  assert.equal(released(), true);
});

test('a genuinely reserved duplicate remains blocked and rolls back cleanly', async () => {
  const { context, queries, released } = fixture({ slotStatus: 'reserved' });
  await assert.rejects(
    context.reserveDay1Attempt('fixture', PROGRAM.tasks[0].id, 'hash', 'key', 0),
    error => error.code === 'grading_in_progress' && error.statusCode === 409
  );
  assert.equal(queries.at(-1).sql, 'ROLLBACK');
  assert.equal(released(), true);
});

test('stale generation cannot reserve an attempt even after the new theory has been completed', async () => {
  const { context, queries } = fixture({ resetGeneration: 2 });
  await assert.rejects(
    context.reserveDay1Attempt('fixture', PROGRAM.tasks[0].id, 'hash', 'key', 1),
    error => error.code === 'training_reset' && error.resetGeneration === 2
  );
  assert.equal(queries.some(item => item.sql.includes('training_v2_submissions')), false);
  assert.equal(queries.some(item => item.sql.includes('INSERT INTO training_v2_attempt_slots')), false);
  assert.equal(queries.at(-1).sql, 'ROLLBACK');
});

test('current generation reserves a token under the user lock', async () => {
  const { context, queries } = fixture({ resetGeneration: 2 });
  const reservation = await context.reserveDay1Attempt('fixture', PROGRAM.tasks[0].id, 'hash', 'key', 2);
  assert.equal(reservation.attemptNumber, 1);
  assert.match(reservation.reservationToken, /^[a-f0-9]{64}$/);
  assert.equal(queries[0].sql, 'BEGIN');
  assert.equal(queries[1].sql, 'SELECT nickname FROM user_registrations WHERE nickname=$1 FOR UPDATE');
  assert.equal(queries.at(-1).sql, 'COMMIT');
});

test('the production theory endpoint rejects an old-generation write without recreating progress', async () => {
  const queries = [];
  let handler;
  const context = {
    app: { post(pathname, ...handlers) { handler = handlers.at(-1); } },
    requireAuthenticatedSession() {}, requireDay1Role() {},
    DAY1_ENABLED: true, DAY1_PROGRAM: PROGRAM,
    DAY1_THEORY: { id: 'fixture', version: 1, modules: [{ id: 'module1' }] },
    getDay1TheoryModule: () => ({ check: { options: ['A', 'B'], correctIndex: 0 } }),
    getDay1TheoryState: async () => ({ theory: { completed: [] }, resetGeneration: 3 }),
    pool: { connect: async () => ({
      release() {},
      query: async sql => { queries.push(sql); return { rows: [{ nickname: 'fixture' }] }; }
    }) },
    console: { error() {} }
  };
  const helper = source.slice(source.indexOf('function assertDay1ResetGeneration('), source.indexOf('async function reserveDay1Attempt('));
  const endpoint = source.slice(
    source.indexOf("app.post('/api/training/v2/programs/day1-v1/theory'"),
    source.indexOf("app.post('/api/training/v2/programs/day1-v1/tasks/:taskId/grade'")
  );
  vm.createContext(context);
  vm.runInContext(helper + endpoint, context);
  let status, payload;
  const response = { status(value) { status = value; return this; }, json(value) { payload = value; return this; } };
  await handler({ user: { nickname: 'fixture' }, body: { moduleId: 'module1', theoryId: 'fixture', theoryVersion: 1, selectedIndex: 0, resetGeneration: 2 } }, response);
  assert.equal(status, 409);
  assert.equal(payload.error, 'training_reset');
  assert.equal(queries.some(sql => sql.includes('INSERT INTO training_v2_theory_progress')), false);
  assert.equal(queries.at(-1), 'ROLLBACK');
});

test('state aggregation reads and persists through one transaction protected from reset', async () => {
  const queries = [];
  let released = false;
  const client = {
    release() { released = true; },
    async query(sql) {
      queries.push(sql);
      return { rows: sql.includes('FROM user_registrations') ? [{ nickname: 'fixture' }] : [] };
    }
  };
  const context = {
    DAY1_PROGRAM: PROGRAM,
    pool: { connect: async () => client, query() { throw new Error('unlocked pool access'); } },
    serializeDay1Submission: row => row,
    getDay1TheoryState: async (nickname, queryable) => {
      assert.equal(queryable, client);
      assert.equal(queries[0], 'BEGIN');
      assert.equal(queries[1], 'SELECT nickname FROM user_registrations WHERE nickname=$1 FOR SHARE');
      return { theory: { complete: false, completed: [] }, resetGeneration: 1 };
    }
  };
  const snippet = source.slice(source.indexOf('async function computeDay1State('), source.indexOf('async function safeComputeDay1State('));
  vm.createContext(context);
  vm.runInContext(snippet, context);
  const state = await context.computeDay1State('fixture');
  assert.equal(state.resetGeneration, 1);
  assert.equal(state.completedTasks, 0);
  assert.equal(queries.some(sql => sql.includes('INSERT INTO training_v2_progress')), true);
  assert.equal(queries.at(-1), 'COMMIT');
  assert.equal(released, true);
});

test('state refresh after account deletion rolls back without recreating training progress', async () => {
  const queries = [];
  let released = false;
  const context = {
    pool: { connect: async () => ({
      release() { released = true; },
      async query(sql) { queries.push(sql); return { rows: [] }; }
    }) }
  };
  const snippet = source.slice(source.indexOf('async function computeDay1State('), source.indexOf('async function computeDay1StateSnapshot('));
  vm.createContext(context);
  vm.runInContext(snippet, context);
  await assert.rejects(context.computeDay1State('deleted'), error => error.code === 'login_required');
  assert.equal(queries.at(-1), 'ROLLBACK');
  assert.equal(queries.some(sql => sql.includes('INSERT')), false);
  assert.equal(released, true);
});
