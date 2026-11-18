import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceHealth, snapshotHealth, reviewState} from '../news-health.mjs';
const now = Date.parse('2026-11-18T12:00:00+08:00');
const source = {id: 'school', status: 'ok', lastSuccessfulAt: '2026-11-18T01:00:00Z', warnings: []};
test('complete format repairs are healthy; empty/truncated responses still need attention', () => {
  assert.equal(sourceHealth({...source, status: 'warning', warnings: ['來源內文含控制字元，已轉為空白並通過完整 XML 驗證。']}, now).severity, 'ok');
  assert.equal(sourceHealth({...source, warnings: ['本次來源回傳 0 筆，保留歷史公告。']}, now).severity, 'warning');
  assert.equal(sourceHealth({...source, warnings: ['來源筆數由 100 降至 3，請確認來源內容。']}, now).severity, 'warning');
});
test('first failure, repeated failures, and stale successes are distinguished', () => {
  assert.equal(sourceHealth({...source, status: 'error'}, now).severity, 'warning');
  assert.equal(sourceHealth({...source, status: 'error', consecutiveFailures: 3}, now).severity, 'error');
  assert.equal(sourceHealth({...source, lastSuccessfulAt: '2026-11-15T01:00:00Z'}, now).stale, true);
  assert.equal(snapshotHealth({updatedAt: '2026-11-15T01:00:00Z', sourceStatus: [source]}, now).stale, true);
});
test('school reviews use each independent date and do not renew themselves', () => {
  assert.equal(reviewState('2026-11-18', now).overdue, false);
  assert.equal(reviewState('2026-10-01', now).overdue, true);
  assert.equal(reviewState('invalid', now).overdue, true);
});
