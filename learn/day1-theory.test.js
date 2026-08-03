'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const theory = require('./day1-theory');

test('Day 1 theory stays short, sequential, and deterministic', () => {
  assert.equal(theory.modules.length, 6);

  const ids = theory.modules.map(module => module.id);
  assert.equal(new Set(ids).size, ids.length);

  for (const module of theory.modules) {
    assert.ok(module.id);
    assert.ok(module.title);
    assert.ok(module.lead);
    assert.ok(Array.isArray(module.points));
    assert.ok(module.points.length >= 2 && module.points.length <= 4);
    assert.equal(module.check.options.length, 3);
    assert.ok(Number.isInteger(module.check.correctIndex));
    assert.ok(module.check.correctIndex >= 0);
    assert.ok(module.check.correctIndex < module.check.options.length);
    assert.ok(module.check.explanation);
  }
});

test('Day 1 theory covers lore, live scenes, and the core chat loop', () => {
  const source = JSON.stringify(theory);

  assert.match(source, /контекст/i);
  assert.match(source, /лор/i);
  assert.match(source, /прямо сейчас/i);
  assert.match(source, /молчун/i);
  assert.match(source, /оффер/i);
  assert.match(source, /видеочат/i);
});

test('mini-quizzes compare plausible messages instead of giveaway distractors', () => {
  const correctPositions = new Set();

  for (const module of theory.modules) {
    const options = module.check.options;
    const lengths = options.map(option => option.trim().split(/\s+/).length);
    const exampleTexts = (module.examples || []).map(example =>
      String(example.text || '').trim().toLowerCase()
    );
    const correct = options[module.check.correctIndex].trim().toLowerCase();

    correctPositions.add(module.check.correctIndex);
    assert.ok(
      !exampleTexts.includes(correct),
      `${module.id} repeats the demonstrated answer verbatim`
    );

    for (const option of options) {
      assert.doesNotMatch(
        option,
        /[\u0400-\u04ff]/,
        `${module.id} should test real English chat messages`
      );
      assert.ok(
        option.trim().split(/\s+/).length >= 10,
        `${module.id} has an obviously short distractor`
      );
    }

    const shortest = Math.min(...lengths);
    const longest = Math.max(...lengths);
    assert.ok(
      longest <= shortest * 1.75,
      `${module.id} gives away the answer by option length`
    );
  }

  assert.ok(correctPositions.size >= 3, 'correct options should not stay in one slot');
});

test('examples keep the real working voice without unexplained model knowledge', () => {
  const messages = theory.modules.flatMap(module => [
    ...(module.examples || []).map(example => String(example.text || '')),
    ...module.check.options
  ]);
  const source = messages.join('\n');

  assert.match(source, /What are your hobbies\?/);
  assert.match(source, /making beats after work actually sounds fun/);
  assert.match(source, /I won a talent visa, so\.\.\./);
  assert.match(source, /Let me find the lipstick/);
  assert.match(source, /Okayy, quiet mode haha\. Can I call you Joe\?/);
  assert.match(source, /Can I ask you a more personal question/);
  assert.match(source, /was it the price or did I move too quickly/);

  assert.doesNotMatch(source, /\bEva\b|pinned post|HISHOBBY/i);
  assert.doesNotMatch(source, /\bNAME\b/);
  assert.doesNotMatch(source, /[😭😏😅😇]/, 'random emoji should not replace the working voice');
  assert.doesNotMatch(source, /\b(?:babe|baby|wanna|rn|u|ur)\b/i);
  assert.doesNotMatch(source, /\bi\b/, 'first-person I should stay capitalized');
  assert.doesNotMatch(source, /—/, 'English chat examples should not use long dashes');
});

test('Day 1 explains that every scenario supplies its own model context', () => {
  const appSource = fs.readFileSync(path.resolve(__dirname, 'day1-app.js'), 'utf8');
  const htmlSource = fs.readFileSync(path.resolve(__dirname, 'day1.html'), 'utf8');

  assert.match(appSource, /Заранее знать модель не нужно/);
  assert.match(appSource, /факты из одного примера нельзя переносить в другой/);
  assert.match(htmlSource, /В каждом задании отдельно указаны факты модели/);
});

test('video-call theory matches the Day 1 written task', () => {
  const module = theory.modules.find(item => item.id === 'custom-and-videocall');
  const source = JSON.stringify(module);

  assert.match(source, /\$20/);
  assert.match(source, /second toy/i);
  assert.match(source, /10 mins/i);
  assert.doesNotMatch(source, /\$15.*five more minutes/i);
});

test('every Day 1 theory screenshot exists in the site', () => {
  const media = theory.modules.flatMap(module => module.media || []);
  assert.equal(media.length, 5);

  for (const item of media) {
    assert.match(item.src, /^\//);
    const localPath = path.resolve(
      __dirname,
      '..',
      item.src.replace(/^\/+/, '')
    );
    assert.ok(fs.existsSync(localPath), `Missing theory image: ${item.src}`);
  }
});
