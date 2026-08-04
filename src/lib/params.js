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
function parseRange(query, { defaultDays = 7, maxDays = 400 } = {}) {
  const now = Date.now();

  let toMs = now;
  if (query.to) {
    toMs = Date.parse(query.to);
    if (Number.isNaN(toMs)) return { error: `Unparseable 'to' timestamp: ${query.to}` };
  }

  let fromMs = toMs - defaultDays * DAY_MS;
  if (query.from) {
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

module.exports = { parseMethod, parseCoolingModel, parseRange };
