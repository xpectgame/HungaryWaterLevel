'use strict';

/**
 * Environment variables are strings typed into a dashboard, which makes them a
 * reliable source of near-misses: a trailing space from a copy-paste, `"true"` with
 * the quotes included, `TRUE`, `1`, `yes`.
 *
 * A strict `=== 'true'` check turns every one of those into a silent wrong default -
 * and for a flag like ALLOW_FIXTURE_IN_PRODUCTION, into a refusal to boot at all.
 * Accept what people actually type.
 */
function boolEnv(raw, fallback = false) {
  if (raw == null) return fallback;

  const value = String(raw)
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase();

  if (value === '') return fallback;
  if (['true', '1', 'yes', 'y', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(value)) return false;
  return fallback;
}

/** Same trimming for plain string settings - a stray quote breaks a connection string. */
function strEnv(raw, fallback = null) {
  if (raw == null) return fallback;
  const value = String(raw).trim().replace(/^["']|["']$/g, '');
  return value === '' ? fallback : value;
}

function numEnv(raw, fallback) {
  const text = strEnv(raw);
  // Guard the empty case explicitly: Number(null) is 0, and 0 is finite, so a missing
  // variable would otherwise sail through as a legitimate zero. For a value like
  // maxReadingAgeMs that means every reading counts as stale.
  if (text == null) return fallback;

  const value = Number(text);
  return Number.isFinite(value) ? value : fallback;
}

module.exports = { boolEnv, strEnv, numEnv };
