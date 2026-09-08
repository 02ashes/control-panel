'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { startApplication } = require('./helpers/application');

const ROOT = path.resolve(__dirname, '..');
let app;
const cookies = {};
const textDelta = (content, attributes) => ({ ops: [
  ...(content ? [{ insert: content, ...(attributes ? { attributes } : {}) }] : []),
  { insert: '\n' }
] });
const snapshot = (content, richText) => ({ folders: {}, snippets: {
  rich_note: { id: 'rich_note', name: 'Formatted note', content, parentId: null,
    ...(richText === undefined ? {} : { richText }) }
}, structure: ['rich_note'] });
const post = (route, body, cookie = cookies['02ashes']) => app.request(route, { method: 'POST', body, cookie });
const list = (cookie = cookies['02ashes']) => app.request('/api/snippets/list', { cookie });
async function save(content, richText) {
  const base = await list();
  const result = await post('/api/snippets/save', { snippets: snapshot(content, richText), baseRevision: base.data.revision });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}

before(async () => {
  app = await startApplication();
  for (const [nickname, role] of Object.entries({
    '02ashes': 'admin', 'rich-editor': 'user', 'rich-reader': 'reader',
    'rich-admin-denied': 'admin', 'rich-trainee': 'new'
  })) {
    cookies[nickname] = await app.register(nickname);
    await app.pool.query('UPDATE user_registrations SET role=$1 WHERE nickname=$2', [role, nickname]);
  }
  for (const targetNickname of ['rich-editor', 'rich-reader', 'rich-trainee']) {
    assert.equal((await post('/api/user/snippets-access', { targetNickname, enabled: true })).status, 200);
  }
});
after(async () => { if (app) await app.close(); });

const publicEditorFiles = new Map([
  ['/vendor/quill.js', 'node_modules/quill/dist/quill.js'],
  ['/vendor/quill.core.css', 'node_modules/quill/dist/quill.core.css'],
  ['/snippet-editor.js', 'public/snippet-editor.js'],
  ['/snippet-editor.css', 'public/snippet-editor.css'],
  ['/snippets-richtext.js', 'public/snippets-richtext.js']
]);
const privateEditorFiles = [
  '/vendor', '/vendor/', '/vendor/quill.js.map', '/vendor/quill.core.css.map',
  '/vendor/quill.snow.css', '/vendor/quill.core.js', '/vendor/package.json',
  '/vendor/quill.js/extra', '/node_modules/quill/package.json',
  '/node_modules/quill/dist/quill.js', '/node_modules/quill/dist/quill.js.map',
  '/node_modules/quill/core.js', '/%6eode_modules/quill/dist/quill.js',
  '/vendor/../node_modules/quill/dist/quill.js'
];

async function verifyEditorAssets(request) {
  for (const [route, file] of publicEditorFiles) {
    const result = await request(route);
    assert.equal(result.status, 200, route);
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff', route);
    assert.match(result.headers.get('content-type'), route.endsWith('.css') ? /text\/css/ : /(?:application|text)\/javascript/);
    assert.equal(result.data, fs.readFileSync(path.join(ROOT, file), 'utf8'), route + ' must serve the exact local distribution');
  }
  for (const route of privateEditorFiles) assert.equal((await request(route)).status, 404, route);
}

test('production exposes only explicit editor distributions and no adjacent package sources', async () => {
  await verifyEditorAssets(route => app.request(route));
  for (const route of ['/public/snippet-editor.js', '/public/snippets-richtext.js', '/snippet-editor.js.map']) {
    assert.equal((await app.request(route)).status, 404, route);
  }
  const head = await app.request('/vendor/quill.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.data, '');
});

test('HTTP save preserves exact plain text and canonical inline styling across read and restart', async () => {
  const content = 'Hello team!\nSecond line.\n';
  const delta = { ops: [
    { insert: 'Hello', attributes: { background: '#FFEEDD', color: '#1255AA', strike: true, underline: true, italic: true, bold: true } },
    { insert: ' team!\nSecond line.\n\n' }
  ] };
  const expected = { ops: [
    { insert: 'Hello', attributes: { bold: true, italic: true, underline: true, strike: true, color: '#1255aa', background: '#ffeedd' } },
    { insert: ' team!\nSecond line.\n\n' }
  ] };
  const saved = await save(content, delta);
  assert.equal(saved.snippets.snippets.rich_note.content, content);
  assert.deepEqual(saved.snippets.snippets.rich_note.richText, expected);
  assert.deepEqual((await list(cookies['rich-reader'])).data, saved);
  const row = (await app.pool.query('SELECT data FROM snippets_data ORDER BY id DESC LIMIT 1')).rows[0].data;
  assert.deepEqual(row, saved.snippets);
  const pool = app.pool;
  await app.close({ keepDatabase: true });
  app = await startApplication({ pool });
  assert.deepEqual((await list()).data, saved);
});

test('formatting-only edits are durable, logged with unchanged plain text and protected from stale style writes', async () => {
  const content = 'Same text';
  const original = await save(content, textDelta(content, { bold: true }));
  const originalNote = original.snippets.snippets.rich_note;
  const edited = await post('/api/snippets/item', {
    id: 'rich_note', content, richText: textDelta(content, { italic: true, color: '#2244aa' }),
    baseContent: content, baseRichText: originalNote.richText
  }, cookies['rich-editor']);
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.deepEqual(edited.data.snippets.snippets.rich_note.richText, textDelta(content, { italic: true, color: '#2244aa' }));
  const latestLog = (await app.pool.query("SELECT details, old_content, new_content FROM snippet_logs WHERE snippet_id='rich_note' AND action='edit' ORDER BY id DESC LIMIT 1")).rows[0];
  assert.deepEqual(latestLog, { details: 'Оформление изменено; текст не менялся', old_content: content, new_content: content });
  for (const body of [
    { id: 'rich_note', content: 'Stale new text', baseContent: content, baseRichText: originalNote.richText },
    { id: 'rich_note', content, baseContent: content },
    { id: 'rich_note', content, richText: textDelta(content, { underline: true }), baseContent: content, baseRichText: originalNote.richText }
  ]) {
    const stale = await post('/api/snippets/item', body, cookies['rich-editor']);
    assert.equal(stale.status, 409, JSON.stringify(stale.data));
    assert.equal(stale.data.error, 'snippets_conflict');
    assert.deepEqual(stale.data.snippets, edited.data.snippets);
  }
  const staleFull = await post('/api/snippets/save', { snippets: original.snippets, baseRevision: original.revision });
  assert.equal(staleFull.status, 409);
  assert.deepEqual((await list()).data, edited.data);
  const cleared = await post('/api/snippets/item', {
    id: 'rich_note', content, baseContent: content, baseRichText: edited.data.snippets.snippets.rich_note.richText
  });
  assert.equal(cleared.status, 200);
  assert.equal(Object.hasOwn(cleared.data.snippets.snippets.rich_note, 'richText'), false);
});

test('legacy imports remain plain and exact; redundant plain Delta does not create a formatting-change audit', async () => {
  const content = '  Legacy literal <b>not HTML</b>\n\n';
  const oldFormat = snapshot(content);
  const imported = await save(content);
  assert.deepEqual(imported.snippets, oldFormat);
  const beforeCount = Number((await app.pool.query("SELECT COUNT(*) AS count FROM snippet_logs WHERE snippet_id='rich_note'")).rows[0].count);
  const equivalent = await post('/api/snippets/item', {
    id: 'rich_note', content, richText: textDelta(content), baseContent: content
  });
  assert.equal(equivalent.status, 200);
  assert.deepEqual(equivalent.data.snippets, oldFormat);
  const afterCount = Number((await app.pool.query("SELECT COUNT(*) AS count FROM snippet_logs WHERE snippet_id='rich_note'")).rows[0].count);
  assert.equal(afterCount, beforeCount);
  const exportedAndReimported = await post('/api/snippets/save', {
    snippets: JSON.parse(JSON.stringify(equivalent.data.snippets)), baseRevision: equivalent.data.revision
  });
  assert.equal(exportedAndReimported.status, 200);
  assert.deepEqual(exportedAndReimported.data.snippets, oldFormat);
});

test('formatted JSON library round-trips without dropping folders, legacy text or inline attributes', async () => {
  const content = 'Formatted and copied as text';
  const base = (await list()).data;
  const library = {
    folders: { folder1: { id: 'folder1', name: 'Replies', parentId: null } },
    snippets: {
      rich_note: { id: 'rich_note', name: 'Marked reply', content, parentId: 'folder1',
        richText: textDelta(content, { bold: true, background: '#ffeedd' }) },
      legacy_note: { id: 'legacy_note', name: 'Plain reply', content: '  Keep whitespace.\n', parentId: null }
    },
    structure: ['folder1', 'legacy_note']
  };
  const imported = await post('/api/snippets/save', { snippets: library, baseRevision: base.revision });
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  const exported = JSON.stringify((await list()).data.snippets);
  const reimported = await post('/api/snippets/save', { snippets: JSON.parse(exported), baseRevision: imported.data.revision });
  assert.equal(reimported.status, 200, JSON.stringify(reimported.data));
  assert.deepEqual(reimported.data.snippets, library);
});

test('invalid HTML, embeds, unsupported styles and mismatched rich text are rejected without writes', async () => {
  const content = 'Literal text';
  const good = await save(content, textDelta(content, { bold: true }));
  const invalid = [
    '<strong>Literal text</strong>', null,
    { html: '<strong>Literal text</strong>' },
    { ops: [{ insert: { image: 'https://invalid.example/image.png' } }, { insert: '\n' }] },
    { ops: [{ insert: { video: 'javascript:alert(1)' } }, { insert: '\n' }] },
    { ops: [{ insert: { formula: '<svg onload=alert(1)>' } }, { insert: '\n' }] },
    textDelta(content, { link: 'javascript:alert(1)' }),
    textDelta(content, { color: 'url(javascript:alert(1))' }),
    textDelta(content, { background: '#fff' }),
    textDelta(content, { bold: 'true' }),
    textDelta(content, { header: 1 }),
    { ops: [{ insert: content + '\n', attributes: { style: 'color:red' } }] },
    { ops: [{ retain: 5 }, { insert: content + '\n' }] },
    { ops: [{ insert: content }] },
    textDelta('Different content', { italic: true })
  ];
  for (const richText of invalid) {
    const full = await post('/api/snippets/save', { snippets: snapshot(content, richText), baseRevision: good.revision });
    assert.equal(full.status, 400, JSON.stringify(richText));
    const item = await post('/api/snippets/item', {
      id: 'rich_note', content, richText, baseContent: content, baseRichText: good.snippets.snippets.rich_note.richText
    });
    assert.equal(item.status, 400, JSON.stringify(richText));
  }
  assert.deepEqual((await list()).data, good);
});

test('formatting does not bypass the owner-issued permission, reader role or trainee restriction', async () => {
  const content = 'Protected styles';
  const state = await save(content, textDelta(content, { underline: true }));
  for (const [nickname, expected] of [['rich-reader', 403], ['rich-admin-denied', 403], ['rich-trainee', 403], ['', 401]]) {
    const cookie = cookies[nickname] || '';
    const denied = await post('/api/snippets/save', {
      baseRevision: state.revision, snippets: snapshot(content, textDelta(content, { bold: true }))
    }, cookie);
    assert.equal(denied.status, expected, nickname);
    const item = await post('/api/snippets/item', {
      id: 'rich_note', content, baseContent: content,
      baseRichText: state.snippets.snippets.rich_note.richText, richText: textDelta(content, { bold: true })
    }, cookie);
    assert.equal(item.status, expected, nickname);
    assert.equal(Object.hasOwn(item.data, 'snippets'), false, 'Denied request must not receive rich content in a conflict snapshot');
  }
  for (const nickname of ['rich-admin-denied', 'rich-trainee']) {
    assert.equal((await list(cookies[nickname])).status, 403);
    assert.equal((await app.request('/api/logs/snippets', { cookie: cookies[nickname] })).status, 403);
  }
  const revoke = await post('/api/user/snippets-access', { targetNickname: 'rich-editor', enabled: false });
  assert.equal(revoke.status, 200);
  const forbidden = await post('/api/snippets/save', {
    baseRevision: -1, snippets: snapshot(content, textDelta(content, { italic: true }))
  }, cookies['rich-editor']);
  assert.equal(forbidden.status, 403);
  assert.equal(Object.hasOwn(forbidden.data, 'snippets'), false);
  assert.deepEqual((await list()).data, state);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}
function previewReady(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Preview start timed out: ' + output)), 10000);
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (output.includes('Day 1 preview:')) { clearTimeout(timer); resolve(); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Preview exited: ' + code + ' ' + output)); });
  });
}

test('local preview serves identical explicit vendor assets without exposing node_modules or maps', { timeout: 20000 }, async t => {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'learn/day1-preview-server.js')], {
    cwd: ROOT,
    // Do not inherit real database credentials or the real grader key.
    env: { PATH: process.env.PATH, PREVIEW_PORT: String(port), NODE_ENV: 'test', XAI_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
  });
  await previewReady(child);
  await verifyEditorAssets(async route => {
    const result = await fetch(`http://127.0.0.1:${port}${route}`);
    return { status: result.status, data: await result.text(), headers: result.headers };
  });
});
