#!/usr/bin/env node
import {readFile, writeFile, mkdir, appendFile} from 'node:fs/promises';
import {snapshotHealth, reviewState} from '../news-health.mjs';

const read = async name => JSON.parse(await readFile(new URL('../' + name, import.meta.url), 'utf8'));
const data = await read('data/version.json');
const info = await read('school-info.json');
const report = {generatedAt: new Date().toISOString(), announcements: snapshotHealth(data), reviews: [],
  lunch: {mode: 'browser-direct', note: 'Published backup age is not live browser availability. Cloud API 403 is not a browser outage.'}};
if (process.env.FEED_ATTEMPT_REPORT) {
  try {
    const attempt = JSON.parse(await readFile(process.env.FEED_ATTEMPT_REPORT, 'utf8'));
    report.latestAttempt = snapshotHealth({updatedAt: attempt.sourceStatus[0]?.lastAttemptAt, ...attempt});
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
for (const [slug, school] of Object.entries(info.schools)) {
  for (const [kind, review] of Object.entries(school.reviews)) {
    report.reviews.push({slug, kind, ...review, ...reviewState(review.checkedOn, Date.now(), review.intervalDays)});
  }
}
const active = report.latestAttempt || report.announcements;
const rows = active.sources.map(s => `| ${s.id} | ${s.severity} | ${s.label} | ${s.lastSuccessfulAt || 'none'} |`);
const markdown = ['## Data health', '', `Checked: ${active.checkedAt}; stale snapshot: ${active.stale}`, '',
  '| Source | Severity | State | Last successful read |', '| --- | --- | --- | --- |', ...rows, '',
  '### School information reviews', '', ...report.reviews.map(r => `- ${r.slug}/${r.kind}: ${r.checkedOn}${r.overdue ? ' — REVIEW OVERDUE' : ''}`), '',
  report.lunch.note, '', 'Raw fetch errors and repair details are in the attempt JSON artifact. No public timestamps were refreshed by this report.', ''].join('\n');
await mkdir('reports', {recursive: true});
await writeFile('reports/health.json', JSON.stringify(report, null, 2) + '\n');
await writeFile('reports/health.md', markdown);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
console.log(markdown);
if (active.stale || active.issues.length || report.reviews.some(r => r.overdue)) process.exitCode = 1;
