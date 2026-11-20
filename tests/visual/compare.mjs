#!/usr/bin/env node
// Compare two screenshot folders byte for byte and report. Report-only unless --strict is given.
// Usage: node tests/visual/compare.mjs <baseDir> <headDir> [--strict]
import {appendFile, readdir, readFile} from 'node:fs/promises';

const [baseDir, headDir] = process.argv.slice(2);
const strict = process.argv.includes('--strict');
const list = async dir => (await readdir(dir).catch(() => [])).filter(name => name.endsWith('.png')).sort();
const [base, head] = await Promise.all([list(baseDir), list(headDir)]);
let markdown = '## Screenshot comparison\n\n';
let changed = 0;
if (!base.length) {
  markdown += 'Base screenshots are unavailable (the base branch could not be built with this data), so nothing was compared.\n';
} else {
  const rows = [];
  for (const name of [...new Set([...base, ...head])].sort()) {
    const [a, b] = await Promise.all([readFile(`${baseDir}/${name}`).catch(() => null), readFile(`${headDir}/${name}`).catch(() => null)]);
    const status = !a ? 'added' : !b ? 'removed' : Buffer.compare(a, b) === 0 ? 'identical' : 'changed';
    if (status !== 'identical') changed++;
    rows.push(`| ${name} | ${status} |`);
  }
  markdown += changed
    ? `${changed} of ${rows.length} screenshots differ from the base branch. Review them in the \`visual-comparison\` artifact; intended UI changes are expected to differ.\n\n| Screenshot | Status |\n| --- | --- |\n${rows.join('\n')}\n`
    : `All ${rows.length} screenshots are identical to the base branch.\n`;
}
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
console.log(markdown);
if (strict && (changed || !base.length)) process.exitCode = 1;
