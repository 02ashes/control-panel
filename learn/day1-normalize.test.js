'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const text = require('./day1-normalize.js');
const grading = require('./grading-v2.js');

const CASES = [
  {
    input: '  Hi\u200b   Joe! \r\n\r\n\r\n  Tap   ❤️  ',
    normalized: 'Hi Joe!\n\nTap ❤',
    messages: 2,
    words: 4
  },
  {
    input: 'one\n\u200B\ntwo',
    normalized: 'one\n\ntwo',
    messages: 2,
    words: 2
  },
  {
    input: 'Message one\r\n  Message   two  ',
    normalized: 'Message one\nMessage two',
    messages: 2,
    words: 4
  },
  {
    input: 'Cafe\u0301\n\n\nChoice?',
    normalized: 'Café\n\nChoice?',
    messages: 2,
    words: 2
  },
  {
    input: 'First message\n\uFE0F\nSecond message',
    normalized: 'First message\n\nSecond message',
    messages: 2,
    words: 4
  }
];

test('browser and server share one canonical Day 1 text contract', () => {
  for (const sample of CASES) {
    assert.equal(text.normalizeAnswer(sample.input), sample.normalized);
    assert.equal(text.messageCount(sample.input), sample.messages);
    assert.equal(text.wordCount(sample.input), sample.words);
    assert.equal(grading.normalizeAnswer(sample.input), sample.normalized);
    assert.equal(grading.messageCount(sample.input), sample.messages);
    assert.equal(grading.wordCount(sample.input), sample.words);
  }
});

test('blank and invisible-only lines never become phantom messages', () => {
  const invisibleOnly = '\u200B\n\uFEFF\n\u2060\n\uFE0E\n\uFE0F\n\u{E0100}';
  assert.equal(text.messageCount(invisibleOnly), 0);
  assert.equal(text.normalizeAnswer(invisibleOnly), '');
});

test('emoji presentation selectors do not change normalized text or answer hashes', () => {
  const emojiPresentation = 'Tap ❤️ if you want me to keep going ☺️';
  const textPresentation = 'Tap ❤ if you want me to keep going ☺';

  assert.equal(text.normalizeAnswer(emojiPresentation), textPresentation);
  assert.equal(grading.hashAnswer(emojiPresentation), grading.hashAnswer(textPresentation));
});

test('an invisible variation-selector line matches the equivalent blank-line layout', () => {
  const withInvisibleSpacer = 'First message\n\uFE0F\nSecond message';
  const withBlankLine = 'First message\n\nSecond message';

  assert.equal(text.normalizeAnswer(withInvisibleSpacer), text.normalizeAnswer(withBlankLine));
  assert.equal(text.messageCount(withInvisibleSpacer), 2);
  assert.equal(grading.messageCount(withInvisibleSpacer), 2);
  assert.equal(grading.hashAnswer(withInvisibleSpacer), grading.hashAnswer(withBlankLine));
});
