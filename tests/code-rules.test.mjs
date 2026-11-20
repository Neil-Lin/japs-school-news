// Source rules for browser code. Each failure says what is banned, why, and what to use instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const sources = (await readdir(root)).filter(name => name === 'app.js' || name.endsWith('.mjs'));
const read = async name => (await readFile(new URL(name, root), 'utf8')).split('\n');

async function violations(pattern, allowed) {
  const found = [];
  for (const name of sources.filter(name => !allowed.includes(name))) {
    (await read(name)).forEach((line, index) => {
      if (pattern.test(line)) found.push(`${name}:${index + 1}: ${line.trim()}`);
    });
  }
  return found;
}

function rule(name, pattern, allowed, message) {
  test(name, async () => {
    const found = await violations(pattern, allowed);
    assert.deepEqual(found, [], `${message}\n${found.join('\n')}`);
  });
}

rule('HTML escaping lives only in format.mjs', /&amp;|&lt;|&gt;|&quot;|&#39;/, ['format.mjs'],
  '禁止在 format.mjs 以外自行實作 HTML 跳脫：多份複製容易漏改而造成 XSS。請改用 import {esc} from \'./format.mjs\'。');

rule('Taipei date formatting lives only in format.mjs', /Intl\.DateTimeFormat|Asia\/Taipei/, ['format.mjs'],
  '禁止在 format.mjs 以外建立 Intl.DateTimeFormat 或寫死 Asia/Taipei：各自建立容易漏時區、重複建立浪費效能。請改用 format.mjs 的 taipeiFormat() 或 taipeiDay()。');
