'use strict';

/** Query-parameter parsing shared by the routes. */

const DAY_MS = 86400000;
const MAX_LIMIT = 20000;

function parseMethod(raw, fallback = 'instant') {
  if (raw === 'lagged' || raw === 'instant') return raw;
  return fallback;
}

function parseCoolingModel(raw, fallback = 'linear') {
  if (raw === 'thermal' || raw === 'linear' || raw === 'units') return raw;
  return fallback;
}

/**
 * Parse a from/to/limit window.
 *
 * Rejects rather than silently clamping an inverted or unparseable range: a chart
 * quietly showing the wrong week is harder to notice than a 400.
 */
/**
 * Rows to CSV, RFC 4180.
 *
 * Here rather than in a route because two endpoints serve it and a second
 * implementation would quote differently from the first. Station names carry commas
 * ("Duna – Rajka" does not, but an editorial note will), so quoting is not optional:
 * one unquoted comma shifts every column after it and the file still opens, which is
 * the worst kind of wrong.
 */
function toCsv(columns, rows) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c])).join(','));
  // CRLF and a trailing newline: Excel is the tool most of these files will be opened
  // in, and it is the one that cares.
  return lines.join('\r\n') + '\r\n';
}

function parseRange(query, { defaultDays = 7, maxDays = 400 } = {}) {
  const now = Date.now();

  let toMs = now;
  if (query.to) {
    toMs = Date.parse(query.to);
    if (Number.isNaN(toMs)) return { error: `Unparseable 'to' timestamp: ${query.to}` };
  }

  // `days` before `from`, because it is the one most callers want and the only one that
  // can be written from memory. It was missing, so `?days=30` parsed as nothing at all
  // and quietly returned the 7-day default - a request that looks honoured, returns 200,
  // and is a quarter of what was asked for. The site's own chart was doing exactly that.
  let fromMs = toMs - defaultDays * DAY_MS;
  if (query.days !== undefined) {
    const days = Number(query.days);
    if (!Number.isFinite(days) || days <= 0) return { error: `'days' must be a positive number, got '${query.days}'` };
    fromMs = toMs - days * DAY_MS;
  }
  if (query.from) {
    if (query.days !== undefined) return { error: `Use either 'days' or 'from', not both` };
    fromMs = Date.parse(query.from);
    if (Number.isNaN(fromMs)) return { error: `Unparseable 'from' timestamp: ${query.from}` };
  }

  if (fromMs >= toMs) {
    return { error: `'from' must be earlier than 'to'` };
  }

  if (toMs - fromMs > maxDays * DAY_MS) {
    return { error: `Range too large: maximum ${maxDays} days` };
  }

  let limit = Number(query.limit) || 5000;
  if (!Number.isFinite(limit) || limit <= 0) limit = 5000;
  limit = Math.min(limit, MAX_LIMIT);

  return { fromMs, toMs, limit };
}

module.exports = { parseMethod, parseCoolingModel, parseRange, toCsv };
