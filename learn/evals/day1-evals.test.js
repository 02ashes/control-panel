'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cases = require('./day1-eval-cases.js');
const DAY1 = require('../programs/day1-v1.js');
const {
  REQUIRED_KINDS,
  validateEvalCases,
  compareVerdict,
  matchedFeedbackConcepts
} = require('./day1-eval-utils.js');
const { parseArgs, selectedCases, compareStability } = require('./run-day1-evals.js');

test('Day 1 calibration dataset is complete and dry-run safe', () => {
  assert.deepEqual(validateEvalCases(cases), []);
  assert.equal(cases.length, DAY1.tasks.length * REQUIRED_KINDS.length);

  for (const task of DAY1.tasks) {
    assert.deepEqual(
      new Set(cases.filter(entry => entry.taskId === task.id).map(entry => entry.kind)),
      new Set(REQUIRED_KINDS)
    );
  }
});

test('every eval case declares score band, per-task pass result, and critical result', () => {
  for (const entry of cases) {
    assert.ok(entry.expected.band.label);
    assert.ok(Number.isInteger(entry.expected.band.min));
    assert.ok(Number.isInteger(entry.expected.band.max));
    assert.equal(typeof entry.expected.taskPass, 'boolean');
    assert.equal(typeof entry.expected.criticalOk, 'boolean');
  }
});

test('unusual valid answers do not depend on greeting punctuation markers', () => {
  const markerPattern = /(?:\.\.\.|\bhaha\b|:3|>_<)/i;
  const unusual = cases.filter(entry => entry.kind === 'unusual');
  assert.equal(unusual.length, DAY1.tasks.length);
  assert.ok(unusual.every(entry => !markerPattern.test(entry.answer)));
  assert.ok(unusual.every(entry => entry.expected.taskPass && entry.expected.criticalOk));
});

test('verdict comparison checks every expected dimension', () => {
  const entry = cases.find(item => item.id === 'personalized_opener.unusual');
  const criteria = Object.fromEntries(Object.entries(entry.expected.criteria).map(([id, range]) => [
    id,
    { rating: range.min }
  ]));
  assert.deepEqual(compareVerdict(entry, {
    score: entry.expected.band.min,
    pass: entry.expected.taskPass,
    criticalOk: entry.expected.criticalOk,
    criteria,
    feedback_ru: 'Ответ использует детали карточки и естественно продолжает разговор.'
  }), []);
  const failures = compareVerdict(entry, {
    score: 0,
    pass: !entry.expected.taskPass,
    criticalOk: !entry.expected.criticalOk,
    criteria: {},
    feedback_ru: 'Нужно добавить haha и эмодзи.'
  });
  assert.ok(failures.length >= 9);
  assert.ok(failures.some(failure => failure.includes('persona_marker')));
});

test('feedback concepts match only explicit rubric regressions', () => {
  assert.deepEqual(
    matchedFeedbackConcepts('Нужно добавить haha и эмодзи, чтобы звучать живее.'),
    ['persona_marker', 'forced_rewrite']
  );
  assert.deepEqual(
    matchedFeedbackConcepts('Лёгкий флирт здесь не требовал отдельного согласия. Не нужно добавлять haha.'),
    []
  );
  for (const feedback of [
    'Добавьте больше конкретики.',
    'Уточните вопрос.',
    'Сделайте формулировку короче.'
  ]) {
    assert.ok(matchedFeedbackConcepts(feedback).includes('forced_rewrite'));
  }
  for (const feedback of [
    'Для лёгкого флирта сначала следовало спросить согласие.',
    'Перед suggestive-флиртом нужно было получить разрешение.'
  ]) {
    assert.ok(matchedFeedbackConcepts(feedback).includes('permission_for_light_flirt'));
  }
  for (const feedback of [
    'Сначала спросите имя, затем страну и хобби.',
    'Следовало начать с имени, страны и хобби.',
    'Ответ должен идти по приветке: имя, страна, хобби.'
  ]) {
    assert.ok(matchedFeedbackConcepts(feedback).includes('greeting_formula'));
  }
});

test('live eval options isolate stability cases and clamp repeat cost', () => {
  const options = parseArgs(['--live', '--stability-only', '--repeats=20']);
  assert.equal(options.live, true);
  assert.equal(options.repeats, 5);
  const selected = selectedCases(options);
  assert.ok(selected.length >= 6);
  assert.ok(selected.every(entry => entry.expected.stability === true));
});

test('stability comparison catches score and decision variance', () => {
  const stable = compareStability([
    { score: 82, pass: true, criticalOk: true, critical: [{ id: 'context_use' }], criteria: { context_use: { rating: 3 } } },
    { score: 86, pass: true, criticalOk: true, critical: [{ id: 'context_use' }], criteria: { context_use: { rating: 3 } } }
  ]);
  assert.deepEqual(stable.failures, []);

  const unstable = compareStability([
    { score: 59, pass: false, criticalOk: false, critical: [{ id: 'context_use' }], criteria: { context_use: { rating: 1 } } },
    { score: 90, pass: true, criticalOk: true, critical: [{ id: 'context_use' }], criteria: { context_use: { rating: 3 } } }
  ]);
  assert.ok(unstable.failures.some(failure => failure.includes('pass changed')));
  assert.ok(unstable.failures.some(failure => failure.includes('crossed the pass boundary')));
});
