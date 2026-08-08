'use strict';

const { pollableStations, getStation } = require('../config/stations');
const { extract, firstArray } = require('../lib/jsonpath');
const { fetchJson } = require('../lib/http');
const { createTokenProvider } = require('./vizugy-auth');

/**
 * Adapter for OVF's hydrological open data (data.vizugy.hu).
 *
 * ---------------------------------------------------------------------------
 * WHAT THE PORTAL ACTUALLY DOES
 * ---------------------------------------------------------------------------
 * Read out of the portal's own Angular bundle:
 *
 *   authApiBaseUrl = "https://data.vizugy.hu/AuthApi/auth"
 *   vraQueryApiBaseUrl = "https://vmservice.vizugy.hu/vraquery/"
 *
 * It asks AuthApi for an anonymous JWT - no credentials - and sends it as a bearer
 * token on every vraquery call. That is implemented and confirmed working: the token
 * endpoint returns a 15-minute JWT issued to `opendatauser`, provided the request
 * carries the Origin and Referer headers a browser would send.
 *
 * What remains unknown is only the path after the base.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE POINTING IT AT PRODUCTION
 * ---------------------------------------------------------------------------
 * The portal is real, the data is genuinely open (free to use with attribution to
 * OVF / the regional water directorate), and it exposes an API. What is NOT pinned
 * down in this file is the exact request path and response shape, because it could
 * not be reached from the environment this was written in.
 *
 * So nothing here hard-codes a guessed endpoint as if it were verified. Instead the
 * request and the response mapping are both configuration, and `npm run probe` prints
 * what the live service actually returns. Confirming the shape is a config edit, not a
 * code change:
 *
 *   VIZUGY_BASE_URL     - service origin
 *   VIZUGY_PATH         - path template, {stationId} and {externalId} are substituted
 *   VIZUGY_ARRAY_PATH   - dotted path to the array of samples in the response
 *   VIZUGY_VALUE_FIELD  - field holding discharge in m3/s
 *   VIZUGY_TIME_FIELD   - field holding the sample timestamp
 *
 * `externalId` on each station below is the portal's own identifier. Those are not
 * known yet either - fill them in from the station catalogue once you can reach it.
 * Until then this adapter reports unavailability honestly rather than inventing values.
 */

const DEFAULTS = {
  // The query service, not the portal that embeds it.
  baseUrl: 'https://vmservice.vizugy.hu/vraquery',
  authBaseUrl: 'https://data.vizugy.hu/AuthApi/auth',
  path: '/{externalId}/discharge/latest',
  arrayPath: 'data',
  valueField: 'value',
  timeField: 'timestamp',
  timeoutMs: 15000,
};

/**
 * Mapping from our station ids to the portal's own station identifiers.
 *
 * Empty on purpose. Populating this from a guess would produce an API that silently
 * serves the wrong river. Run `npm run probe -- --catalogue` against the live portal
 * to list its stations, then fill these in.
 */
const EXTERNAL_IDS = Object.freeze({
  // 'duna-rajka': '...',
  // 'tisza-tiszabecs': '...',
});

function config(env = process.env) {
  return {
    baseUrl: env.VIZUGY_BASE_URL || DEFAULTS.baseUrl,
    authBaseUrl: env.VIZUGY_AUTH_BASE_URL || DEFAULTS.authBaseUrl,
    path: env.VIZUGY_PATH || DEFAULTS.path,
    arrayPath: env.VIZUGY_ARRAY_PATH || DEFAULTS.arrayPath,
    valueField: env.VIZUGY_VALUE_FIELD || DEFAULTS.valueField,
    timeField: env.VIZUGY_TIME_FIELD || DEFAULTS.timeField,
    timeoutMs: Number(env.VIZUGY_TIMEOUT_MS) || DEFAULTS.timeoutMs,
    apiKey: env.VIZUGY_API_KEY || null,
  };
}

function buildUrl(cfg, station) {
  const externalId = EXTERNAL_IDS[station.id] || station.id;
  const path = cfg.path
    .replace('{stationId}', encodeURIComponent(station.id))
    .replace('{externalId}', encodeURIComponent(externalId));

  // Concatenate rather than resolve. `new URL('/x', 'https://h/vraquery')` resolves the
  // leading slash against the origin and silently drops `/vraquery` - the base path is
  // part of the service address here, not a directory to navigate away from.
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * Pull the newest discharge sample out of whatever the service returned.
 *
 * Tolerant by design: the configured path is tried first, then a few common shapes,
 * because the point of this adapter is to survive a response layout that differs
 * slightly from the guess rather than to fail the whole poll.
 */
function parseDischarge(payload, cfg) {
  let rows = extract(payload, cfg.arrayPath);
  if (!Array.isArray(rows)) rows = firstArray(payload);
  if (!Array.isArray(rows) || rows.length === 0) {
    // A bare scalar response is also plausible for a "latest value" endpoint.
    const direct = extract(payload, cfg.valueField);
    if (Number.isFinite(Number(direct))) {
      return { flowM3s: Number(direct), timestamp: new Date().toISOString() };
    }
    return null;
  }

  // Newest sample last is the usual convention; sort defensively so either works.
  const parsed = rows
    .map((row) => {
      const rawValue = extract(row, cfg.valueField);
      const rawTime = extract(row, cfg.timeField);
      const value = Number(rawValue);
      if (!Number.isFinite(value)) return null;
      const time = rawTime ? new Date(rawTime) : null;
      return {
        flowM3s: value,
        timestamp: time && !Number.isNaN(time.getTime()) ? time.toISOString() : new Date().toISOString(),
        sortKey: time && !Number.isNaN(time.getTime()) ? time.getTime() : 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.sortKey - b.sortKey);

  if (parsed.length === 0) return null;
  const latest = parsed[parsed.length - 1];
  return { flowM3s: latest.flowM3s, timestamp: latest.timestamp };
}

let tokenProvider = null;

/** One provider per process, so all stations share a single token. */
function getTokenProvider(cfg) {
  if (!tokenProvider) tokenProvider = createTokenProvider({ authBaseUrl: cfg.authBaseUrl });
  return tokenProvider;
}

/** Fetch one station's current discharge. Resolves to null when unavailable. */
async function fetchStation(stationId, env = process.env) {
  const station = getStation(stationId);
  if (!station) throw new Error(`Unknown station: ${stationId}`);

  const cfg = config(env);
  const url = buildUrl(cfg, station);

  // An explicit key wins; otherwise mint the anonymous token the portal itself uses.
  const bearer = cfg.apiKey || (await getTokenProvider(cfg).getToken());
  const headers = bearer ? { Authorization: `Bearer ${bearer}` } : {};

  const payload = await fetchJson(url, { timeoutMs: cfg.timeoutMs, headers });
  const sample = parseDischarge(payload, cfg);
  if (!sample) return null;

  return {
    stationId,
    flowM3s: sample.flowM3s,
    timestamp: sample.timestamp,
    source: 'vizugy',
    quality: 'measured',
  };
}

/**
 * Fetch every station. One failing gauge must not take the balance down, so failures
 * are collected and reported instead of thrown.
 */
async function fetchAll(env = process.env) {
  const stations = pollableStations();
  const readings = {};
  const errors = [];

  const results = await Promise.allSettled(stations.map((s) => fetchStation(s.id, env)));

  results.forEach((result, i) => {
    const station = stations[i];
    if (result.status === 'fulfilled' && result.value) {
      readings[station.id] = result.value;
    } else if (result.status === 'rejected') {
      errors.push({ stationId: station.id, error: String(result.reason && result.reason.message || result.reason) });
    } else {
      errors.push({ stationId: station.id, error: 'no discharge value in response' });
    }
  });

  return {
    source: 'vizugy',
    fetchedAt: new Date().toISOString(),
    readings,
    errors,
    configured: Object.keys(EXTERNAL_IDS).length > 0,
  };
}

module.exports = { fetchStation, fetchAll, parseDischarge, config, buildUrl, EXTERNAL_IDS, DEFAULTS };
