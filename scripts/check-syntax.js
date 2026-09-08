'use strict';

// Parse source and executable inline scripts without starting the application,
// loading .env, opening a database, or evaluating browser code.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const ignored = new Set(['node_modules', '.git', '.claude', '.openai', 'dist', 'build']);
let checked = 0;
let failures = 0;

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ignored.has(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) { visit(filename); continue; }
    if (!entry.isFile()) continue;
    if (/\.(?:[cm]?js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8' });
      checked++;
      if (result.status !== 0) {
        failures++;
        process.stderr.write(result.stderr || String(result.error || 'Syntax check failed'));
      }
    } else if (entry.name.endsWith('.html')) {
      const dom = new JSDOM(fs.readFileSync(filename, 'utf8'));
      for (const [index, script] of [...dom.window.document.scripts].entries()) {
        const type = (script.getAttribute('type') || '').trim().toLowerCase();
        if (script.hasAttribute('src') || (type && !['module', 'text/javascript', 'application/javascript'].includes(type))) continue;
        if (!script.textContent.trim()) continue;
        checked++;
        try {
          if (type === 'module') {
            const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
              input: script.textContent, encoding: 'utf8'
            });
            if (result.status !== 0) throw new Error(result.stderr);
          } else {
            new vm.Script(script.textContent, { filename: `${filename}:script-${index + 1}` });
          }
        } catch (error) {
          failures++;
          process.stderr.write(`${filename}:script-${index + 1}\n${error.stack}\n`);
        }
      }
      dom.window.close();
    }
  }
}

visit(root);
console.log(`Syntax: ${checked} JavaScript files/inline scripts checked, ${failures} errors.`);
process.exitCode = failures ? 1 : 0;
