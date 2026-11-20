// Shared by the parent-facing update details and the maintainer report.
import {DAY} from './format.mjs';

const repaired = warning => /已復原完整公告|已轉為空白並通過完整 XML 驗證/.test(warning);

export function sourceHealth(source, now = Date.now()) {
  const warnings = source.warnings || [];
  const attention = warnings.filter(warning => !repaired(warning));
  const lastSuccess = Date.parse(source.lastSuccessfulAt);
  const stale = !Number.isFinite(lastSuccess) || now - lastSuccess > DAY;
  const failed = source.status === 'error';
  const failures = source.consecutiveFailures ?? (failed ? 1 : 0);
  const severity = failed && (failures >= 3 || stale) ? 'error'
    : failed || stale || attention.length ? 'warning' : 'ok';
  const label = failed ? '更新未成功，保留上次資料' : stale ? '超過 24 小時未成功更新'
    : attention.length ? '來源內容待確認' : warnings.length ? '正常（來源格式已修復）' : '正常';
  return {id: source.id, name: source.name, severity, label, stale, failures, attention,
    repaired: warnings.filter(repaired), lastSuccessfulAt: source.lastSuccessfulAt};
}

export function reviewState(checkedOn, now = Date.now(), maxDays = 30) {
  const date = Date.parse(checkedOn + 'T00:00:00+08:00');
  const ageDays = Math.floor((now - date) / DAY);
  return {ageDays, overdue: !Number.isFinite(date) || ageDays > maxDays};
}

export function snapshotHealth(data, now = Date.now()) {
  const sources = (data.sourceStatus || []).map(source => sourceHealth(source, now));
  const checked = Date.parse(data.updatedAt);
  return {checkedAt: data.updatedAt, stale: !Number.isFinite(checked) || now - checked > DAY,
    sources, issues: sources.filter(source => source.severity !== 'ok')};
}
