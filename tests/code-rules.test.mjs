// Source rules. Each failure says what is banned, why, and what to use instead.
// Every source directory is scanned, including ones added later; only build output and data are skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const SKIP_DIRS = new Set(['.git', '.codebase-cleanup', 'node_modules', 'static', 'dist', 'data', 'reports',
  'test-results', 'playwright-report', 'maintenance', 'assets', '__pycache__']);
const manifest = JSON.parse(await readFile(new URL('assets-manifest.json', root), 'utf8'));
const GENERATED = new Set([...manifest.pages, 'sw.js', 'assets-manifest.json']);

async function walk(dir = '') {
  const files = [];
  for (const entry of await readdir(new URL(dir || './', root), {withFileTypes: true})) {
    const path = dir + entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...await walk(path + '/'));
    } else if (!GENERATED.has(path)) files.push(path);
  }
  return files;
}

const all = await walk();
const texts = new Map(await Promise.all(all.map(async path => [path, await readFile(new URL(path, root), 'utf8')])));
const isJS = path => /\.m?js$/.test(path);
// Tests assert on escaped output and fixed timestamps, so code-pattern rules apply to shipped and tooling code.
const codeFiles = all.filter(path => isJS(path) && !path.startsWith('tests/'));

function lineRule(name, pattern, allowed, message) {
  test(name, () => {
    const found = [];
    for (const path of codeFiles.filter(path => !allowed.includes(path))) {
      texts.get(path).split('\n').forEach((line, index) => {
        if (pattern.test(line)) found.push(`${path}:${index + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(found, [], `${message}\n${found.join('\n')}`);
  });
}

// Frozen exceptions: the listed files may keep at most this many matches; no other file may add one.
function frozenRule(name, find, frozen, message) {
  test(name, () => {
    const found = [];
    for (const path of codeFiles) {
      const hits = find(texts.get(path));
      if (hits.length > (frozen[path] ?? 0)) found.push(...hits.map(line => `${path}:${line}`));
    }
    assert.deepEqual(found, [], `${message}\n${found.join('\n')}`);
  });
}

lineRule('HTML escaping lives only in format.mjs', /&amp;|&lt;|&gt;|&quot;|&#39;/, ['format.mjs'],
  '禁止在 format.mjs 以外自行實作 HTML 跳脫：多份複製容易漏改而造成 XSS。請改用 import {esc} from \'./format.mjs\'。');

lineRule('Taipei date formatting lives only in format.mjs', /Intl\.DateTimeFormat|Asia\/Taipei/, ['format.mjs'],
  '禁止在 format.mjs 以外建立 Intl.DateTimeFormat 或寫死 Asia/Taipei：各自建立容易漏時區、重複建立浪費效能。請改用 format.mjs 的 taipeiFormat() 或 taipeiDay()。');

lineRule('One-day duration comes from DAY in format.mjs', /86_?400_?000|24\s*\*\s*60\s*\*\s*60/, ['format.mjs'],
  '禁止手寫一天的毫秒數（86400000、24 * 60 * 60 * 1000）：同一個概念多種寫法容易算錯。請改用 import {DAY} from \'./format.mjs\'。');

// Returns the line numbers of setTimeout(..., 0), requestAnimationFrame( and queueMicrotask( calls.
function timingPatches(text) {
  const lines = [];
  const lineOf = index => text.slice(0, index).split('\n').length;
  for (const match of text.matchAll(/\b(?:requestAnimationFrame|queueMicrotask)\s*\(/g)) lines.push(lineOf(match.index));
  for (const match of text.matchAll(/\bsetTimeout\s*\(/g)) {
    let depth = 0, lastComma = -1, end = -1;
    for (let i = match.index + match[0].length - 1; i < text.length; i++) {
      const char = text[i];
      if ('([{'.includes(char)) depth++;
      else if (')]}'.includes(char) && --depth === 0) { end = i; break; }
      else if (char === ',' && depth === 1) lastComma = i;
    }
    if (lastComma > 0 && text.slice(lastComma + 1, end).trim() === '0') lines.push(lineOf(match.index));
  }
  return lines;
}

frozenRule('No new zero-delay timers to patch timing', timingPatches, {'dialog-controller.mjs': 2},
  '禁止用 setTimeout(…, 0)、requestAnimationFrame、queueMicrotask 補時序：會掩蓋真正的原因且在不同瀏覽器表現不一。請改為監聽對應事件（如 scrollend、transitionend、popstate）或修正呼叫順序；確實無法避免時列入例外清單由人決定。');

const IGNORE_MARKER = new RegExp([
  ['eslint', 'disable'].join('-'), '@ts-' + '(?:ignore|nocheck|expect-error)', 'no' + 'qa\\b', 'type:\\s*' + 'ignore',
  'pragma:\\s*no ' + 'cover', ['biome', 'ignore'].join('-'), ['prettier', 'ignore'].join('-'), 'pylint:\\s*' + 'disable',
].join('|'));

test('No inline markers that silence checks', () => {
  const found = [];
  for (const path of all.filter(path => /\.(?:m?js|py|html|css|ya?ml)$/.test(path))) {
    texts.get(path).split('\n').forEach((line, index) => {
      if (IGNORE_MARKER.test(line)) found.push(`${path}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, [], '禁止新增「忽略檢查」標記：會讓規則悄悄失效。請修正寫法讓檢查通過；確實需要例外時列入例外清單由人決定。\n' + found.join('\n'));
});

test('Rules scan every source directory', () => {
  for (const path of ['app.js', 'format.mjs', 'templates/sw.js', 'scripts/health_report.mjs', 'scripts/build_site.py']) {
    assert.ok(all.includes(path), `規則掃描範圍漏掉 ${path}`);
  }
  assert.ok(!all.includes('sw.js') && !all.some(path => path.startsWith('static/')), '產生檔不應納入掃描');
});
