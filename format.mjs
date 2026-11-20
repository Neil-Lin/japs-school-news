// Shared browser helpers. The only HTML escaper for template strings assigned to innerHTML.
const ENTITIES = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};

export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ENTITIES[char]);

export const DAY = 86_400_000;

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

// The only place browser code builds a request deadline: aborts on timeout or when the caller's signal aborts,
// and always clears the timer, detaches from the caller's signal and aborts leftover requests.
export async function withDeadline({timeoutMs, signal}, run) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener('abort', cancel, {once: true});
  const timer = setTimeout(cancel, timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.abort();
  }
}
