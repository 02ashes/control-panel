'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const themeScript = fs.readFileSync(path.join(root, 'public/workspace-theme.js'), 'utf8');
const pages = [
  { html: 'day1.html', css: 'day1-styles.css', hooks: ['programTitle', 'taskContent', 'taskNavList', 'theoryStageButton', 'practiceStageButton', 'courseProgress', 'toast'] },
  { html: 'day1-dashboard.html', css: 'day1-dashboard.css', hooks: ['refreshButton', 'candidateSearch', 'candidateList', 'candidateDetails', 'candidateCount', 'toast'] }
];

for (const page of pages) {
  test(`${page.html}: shared theme is initialized before styles without replacing application hooks`, t => {
    const html = fs.readFileSync(path.join(root, 'learn', page.html), 'utf8');
    const dom = new JSDOM(html, { url: `https://training.test/learn/${page.html}`, runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    const document = dom.window.document;
    assert.equal(document.body.classList.contains('work-ui'), true);
    assert.equal(document.querySelector('meta[name="color-scheme"]').content, 'dark light');
    const loader = document.head.querySelector('script[src="/workspace-theme.js"]');
    assert.ok(loader);
    assert.equal(loader.defer, false);
    assert.equal(loader.hasAttribute('async'), false);
    assert.ok(html.indexOf('/workspace-theme.js') < html.indexOf('/workspace-theme.css'));
    assert.ok(html.indexOf('/workspace-theme.css') < html.indexOf(`/learn/${page.css}`));
    for (const id of page.hooks) assert.equal(document.querySelectorAll(`#${id}`).length, 1, id);
    assert.equal(document.querySelector('.learning-topbar a').getAttribute('href'), '/admin');
    assert.equal(document.querySelector('[data-work-theme-toggle]').type, 'button');
    dom.window.eval(themeScript);
    document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    assert.equal(document.documentElement.dataset.workTheme, 'dark');
    document.querySelector('[data-work-theme-toggle]').click();
    assert.equal(document.documentElement.dataset.workTheme, 'light');
    assert.equal(document.querySelector('[data-work-theme-toggle]').getAttribute('aria-pressed'), 'true');
    for (const id of page.hooks) assert.equal(document.querySelectorAll(`#${id}`).length, 1, id);
  });

  test(`${page.css}: theme tokens, local specificity, quiet surfaces and reduced motion remain intact`, t => {
    const css = fs.readFileSync(path.join(root, 'learn', page.css), 'utf8');
    const dom = new JSDOM('<!doctype html><body class="work-ui"></body>');
    t.after(() => dom.window.close());
    const style = dom.window.document.createElement('style');
    style.textContent = css;
    dom.window.document.head.appendChild(style);
    assert.ok(style.sheet.cssRules.length > 100, 'the full stylesheet must parse');
    assert.match(css, /--page:\s*var\(--work-bg\)/);
    assert.match(css, /--radius:\s*var\(--work-radius\)/);
    assert.match(css, /font-family:\s*var\(--work-font\)/);
    assert.doesNotMatch(css, /#[\da-f]{3,8}\b|rgba?\(|(?:linear|radial)-gradient\(/i);
    assert.doesNotMatch(css, /border-radius:\s*(?:[7-9]|\d{2,})px/);
    const shadows = [...css.matchAll(/box-shadow:\s*([^;]+);/g)].map(match => match[1].trim());
    assert.ok(shadows.every(value => value === 'none'), 'decorative shadows must stay disabled');
    assert.match(css, /body\.work-ui .*:focus-visible/);
    assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    const action = page.css === 'day1-styles.css' ? '.grade-button' : '.primary-button';
    const actionRule = [...style.sheet.cssRules].find(rule => rule.selectorText?.split(',').map(value => value.trim()).includes(`body.work-ui ${action}`));
    assert.ok(actionRule, 'local action styles must outrank generic shared button styles');
    assert.equal(actionRule.style.getPropertyValue('background'), 'var(--accent)');
    assert.equal(actionRule.style.getPropertyValue('color'), 'var(--work-on-accent)');
  });
}

test('dashboard can collapse to a single column instead of forcing desktop width on phones', () => {
  const css = fs.readFileSync(path.join(root, 'learn/day1-dashboard.css'), 'utf8');
  assert.match(css, /body\.work-ui\s*\{\s*min-width:\s*0;/);
  assert.doesNotMatch(css, /min-width:\s*1100px/);
  assert.match(css, /@media\s*\(max-width:\s*800px\)/);
  assert.match(css, /body\.work-ui \.dashboard-layout\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(css, /@media\s*\(max-width:\s*520px\)/);
  assert.match(css, /@media print/);
});

test('lesson examples and answer fields retain readable text rather than clipped navigation labels', () => {
  const css = fs.readFileSync(path.join(root, 'learn/day1-styles.css'), 'utf8');
  assert.match(css, /body\.work-ui \.theory-example blockquote\s*\{[^}]*font-size:\s*15px;[^}]*line-height:\s*1\.7;/);
  assert.match(css, /body\.work-ui \.answer-input\s*\{[^}]*min-height:\s*210px;/);
  assert.match(css, /body\.work-ui \.task-nav__title\s*\{[^}]*white-space:\s*normal;/);
  assert.match(css, /body\.work-ui \.theory-media img\s*\{[^}]*object-fit:\s*contain;/);
});
