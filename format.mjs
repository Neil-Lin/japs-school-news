// Shared presentation helpers. The only HTML escaper for template strings assigned to innerHTML.
const ENTITIES = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};

export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ENTITIES[char]);

// The only place browser code formats dates; every formatter is fixed to Taipei time and reused.
const formatters = new Map();

export function taipeiFormat(locale, options) {
  const key = locale + JSON.stringify(options);
  if (!formatters.has(key)) formatters.set(key, new Intl.DateTimeFormat(locale, {...options, timeZone: 'Asia/Taipei'}));
  return formatters.get(key);
}

export function taipeiDay(now = new Date()) {
  const parts = taipeiFormat('en', {year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(now);
  const value = type => parts.find(part => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
