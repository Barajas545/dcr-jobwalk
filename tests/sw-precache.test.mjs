// sw-precache.test.mjs — the service worker caches the whole program, and nothing that is not there.
//
// A module the app can load but the worker does not precache works online
// and breaks the first time the app opens with no signal. A listed file that
// does not exist fails the worker's install (addAll is all or nothing), so
// the app would never work offline at all. Both are checked here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const listed = [...sw.match(/const PROGRAM = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((u) => u !== './');

/** Every module reachable from js/main.js by static or dynamic import with a literal path. */
function reachable() {
  const seen = new Set();
  const todo = ['js/main.js'];
  while (todo.length) {
    const rel = todo.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const re = /(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|^\s*import\s*['"](\.[^'"]+)['"]/gm;
    for (const m of src.matchAll(re)) {
      const spec = m[1] || m[2] || m[3];
      const next = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      if (fs.existsSync(path.join(ROOT, next))) todo.push(next);
      else assert.fail(`${rel} imports ${spec}, which does not exist`);
    }
  }
  return seen;
}

test('every listed file exists (a missing one fails the whole install)', () => {
  const missing = listed.filter((u) => !fs.existsSync(path.join(ROOT, u)));
  assert.deepEqual(missing, []);
});

test('every module the app can load is precached', () => {
  const notListed = [...reachable()].filter((m) => !listed.includes(m));
  assert.deepEqual(notListed, []);
});

test('a new version waits instead of taking over a running page', () => {
  // Taking over would serve new files for screens not loaded yet next to the
  // old modules already in memory. It takes over only when the page asks
  // (main.js, after the screen allows leaving it).
  const install = sw.match(/addEventListener\('install'[\s\S]*?\n\}\);/)[0].replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(install, /skipWaiting\s*\(/);
  assert.match(sw, /event\.data === 'skipWaiting'\) self\.skipWaiting\(\)/);
  const main = fs.readFileSync(path.join(ROOT, 'js/main.js'), 'utf8');
  assert.match(main, /postMessage\('skipWaiting'\)/);
});

test('every stylesheet index.html links is precached', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const css = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(css.filter((c) => !listed.includes(c)), []);
});
