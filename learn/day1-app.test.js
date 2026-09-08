'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const TEXT = require('./day1-normalize.js');

class Element {
  constructor() {
    this.value = '';
    this.textContent = '';
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.listeners = {};
  }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
  querySelectorAll() { return []; }
  focus() {}
}

function createApp() {
  const storage = new Map();
  const requests = [];
  const context = {
    window: {
      location: { hostname: 'example.test', search: '' },
      DAY1_TEXT: TEXT,
      DAY1_THEORY: { id: 'fixture', version: 1, modules: [{ id: 'module1' }] },
      scrollTo() {}
    },
    document: {
      getElementById: () => new Element(), querySelector: () => new Element(),
      createElement: () => new Element(), createTextNode: text => text
    },
    localStorage: {
      get length() { return storage.size; },
      key: index => Array.from(storage.keys())[index],
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    URLSearchParams, Headers, setTimeout, clearTimeout,
    fetch(url, config) {
      return new Promise((resolve, reject) => {
        requests.push({ url, body: JSON.parse(config.body || '{}'), reject,
          respond(payload, status = 200) {
            resolve({ ok: status < 400, status, headers: new Headers(), json: async () => payload });
          }
        });
      });
    }
  };
  const source = fs.readFileSync(path.join(__dirname, 'day1-app.js'), 'utf8');
  // Exercise the real application functions and event handlers; skip network bootstrap only.
  const instrumented = source.replace(/  load\(\);\s*\}\)\(\);\s*$/, `
    window.fixture = {
      init(limit = 2) {
        program = { version: 1, rubricVersion: 'fixture', maxAttemptsPerTask: limit, passingScore: 85 };
        NICKNAME = 'fixture';
        tasks = ['task1', 'task2'].map(id => ({ id, title: id, minMessages: 1, maxMessages: 1, maxWords: 100 }));
        state = { tasks: {}, completedTasks: 0, totalTasks: 2 };
        theoryState = { completed: ['module1'] };
        renderNavigation = () => {};
        renderSummary = () => {};
        showToast = () => {};
        renderTasks();
      },
      edit(answer) {
        const input = views.get(tasks[activeTaskIndex].id).textarea;
        input.value = answer;
        input.listeners.input();
      },
      submit: submitTask,
      select: index => selectTask(index, false),
      draft: readDraft,
      value: () => views.get(tasks[activeTaskIndex].id).textarea.value,
      disabled: () => views.get(tasks[activeTaskIndex].id).gradeButton.disabled,
      pending: taskId => pendingSubmissions.has(taskId),
      state: () => state,
      apply: applyServerState,
      fallback: mergeFallbackResult
    };
  })();`);
  assert.notEqual(instrumented, source, 'application bootstrap must be instrumented');
  vm.runInNewContext(instrumented, context, { filename: 'day1-app.js' });
  return { app: context.window.fixture, requests };
}

function result(id, answer, extra = {}) {
  return { id, answer, score: 90, pass: true, createdAt: Date.now() + 10000, ...extra };
}

test('grading preserves edits made while awaiting a verdict, including after navigation', async () => {
  const { app, requests } = createApp();
  app.init();
  app.edit('Original answer before checking.');
  const pending = app.submit('task1');
  assert.equal(requests[0].body.resetGeneration, 0);
  app.edit('Improved draft written during the check.');
  requests[0].respond({ ok: true, result: result(1, 'Original answer before checking.'), state: null });
  await pending;
  assert.equal(app.draft('task1').answer, 'Improved draft written during the check.');
  app.select(1);
  app.select(0);
  assert.equal(app.value(), 'Improved draft written during the check.');
});

test('pending submission survives rerender and blocks a second answer until completion', async () => {
  const { app, requests } = createApp();
  app.init();
  app.edit('The first answer before checking.');
  const pending = app.submit('task1');
  assert.equal(app.disabled(), true);
  app.select(1);
  app.select(0);
  app.edit('A different answer before the first verdict.');
  assert.equal(app.disabled(), true);
  await app.submit('task1');
  assert.equal(requests.length, 1);
  requests[0].respond({ ok: true, result: result(1, 'The first answer before checking.') });
  await pending;
  assert.equal(app.disabled(), false);
  assert.equal(app.pending('task1'), false);
});

test('shared cache fallback spends an attempt, reused submissions do not, and totals update', () => {
  const { app } = createApp();
  app.init(3);
  app.fallback('task1', result(1, 'Cached answer.', { cacheHit: true }), 'Cached answer.');
  assert.equal(app.state().tasks.task1.attempts, 1);
  assert.equal(app.state().completedTasks, 1);
  assert.equal(app.state().averageScore, 90);
  app.fallback('task1', result(1, 'Cached answer.', { reused: true }), 'Cached answer.');
  assert.equal(app.state().tasks.task1.attempts, 1);
  app.fallback('task1', result(2, 'Second answer.'), 'Second answer.');
  app.edit('A third answer allowed by the program.');
  assert.equal(app.disabled(), false, 'program limit is three, not a hardcoded two');
  app.fallback('task1', result(3, 'Third answer.'), 'Third answer.');
  app.edit('A fourth answer beyond the program limit.');
  assert.equal(app.disabled(), true);
});

test('reset fences stale responses and an old finally cannot unlock a new request', async () => {
  const { app, requests } = createApp();
  app.init();
  app.edit('An answer from the previous generation.');
  const oldPending = app.submit('task1');
  app.apply({ resetGeneration: 1, theory: { completed: ['module1'] }, tasks: {} });
  assert.equal(app.draft('task1'), null);
  app.edit('A new answer after the reset.');
  const newPending = app.submit('task1');
  assert.equal(requests[1].body.resetGeneration, 1);
  requests[0].respond({ ok: true, result: result(1, 'An answer from the previous generation.'), state: { resetGeneration: 0, tasks: {} } });
  await oldPending;
  assert.equal(app.pending('task1'), true);
  assert.equal(app.draft('task1').answer, 'A new answer after the reset.');
  assert.equal(app.apply({ resetGeneration: 0, tasks: {} }), false);
  requests[1].respond({ ok: true, result: result(2, 'A new answer after the reset.') });
  await newPending;
  assert.equal(app.pending('task1'), false);
  assert.equal(app.state().tasks.task1.latest.id, 2);
});

test('failed grading releases pending state without discarding the draft', async () => {
  const { app, requests } = createApp();
  app.init();
  app.edit('A draft that survives the network failure.');
  const pending = app.submit('task1');
  requests[0].reject(new TypeError('Failed to fetch'));
  await pending;
  assert.equal(app.pending('task1'), false);
  assert.equal(app.disabled(), false);
  assert.equal(app.draft('task1').answer, 'A draft that survives the network failure.');
});

test('out-of-order state responses cannot remove a completed attempt from the same generation', () => {
  const { app } = createApp();
  app.init();
  const first = result(1, 'First task answer.');
  const second = result(2, 'Second task answer.');
  app.apply({ resetGeneration: 0, theory: { completed: ['module1'] }, tasks: {
    task1: { best: first, latest: first, attempts: 1 },
    task2: { best: second, latest: second, attempts: 1 }
  } });
  app.apply({ resetGeneration: 0, theory: { completed: [] }, tasks: {
    task1: { best: first, latest: first, attempts: 1 },
    task2: { best: null, latest: null, attempts: 0 }
  } });
  assert.equal(app.state().tasks.task2.attempts, 1);
  assert.equal(app.state().completedTasks, 2);
  assert.equal(app.state().passed, true);
});
