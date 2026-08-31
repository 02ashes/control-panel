(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else if (root) {
    root.DAY1_TEXT = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normalizeAnswer(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .normalize('NFKC')
      .replace(/\r\n?/g, '\n')
      // Presentation selectors and zero-width formatting characters must not
      // create a different cache key or turn an otherwise blank line into a
      // phantom chat message. Include the supplementary variation-selector
      // range as well as the common BMP selectors used by emoji.
      .replace(/[\u200B-\u200D\u2060\uFE00-\uFE0F\uFEFF]|[\u{E0100}-\u{E01EF}]/gu, '')
      .split('\n')
      .map(function (line) { return line.replace(/[^\S\n]+/g, ' ').trim(); })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function wordCount(value) {
    const normalized = normalizeAnswer(value);
    return normalized ? (normalized.match(/\S+/gu) || []).length : 0;
  }

  function messageCount(value) {
    return normalizeAnswer(value)
      .split('\n')
      .filter(function (line) { return line.trim(); })
      .length;
  }

  return { normalizeAnswer, wordCount, messageCount };
});
