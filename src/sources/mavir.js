'use strict';

const { extract, firstArray } = require('../lib/jsonpath');
const { fetchJson } = require('../lib/http');

/**
 * Adapter for MAVIR's real-time electricity system data.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAVIR ACTUALLY PUBLISHES
 * ---------------------------------------------------------------------------
 * MAVIR publishes near-real-time generation on a 15-minute cadence, aggregated
 * BY PRIMARY SOURCE - nuclear, lignite, natural gas, wind, PV, and so on - plus
 * system load and the import/export balance. It does not publish a live per-plant
 * feed for every station.
 *
 * That limitation is survivable, because of one useful fact: Paks I is the only
 * nuclear generator in Hungary, so the nuclear aggregate IS Paks I's output. The
 * plant that dominates water withdrawal by an order of magnitude is exactly the one
 * that can be read directly. Everything else has to be allocated across plants
 * sharing a fuel type, and is labelled 'estimated' all the way to the API response.
 *
 * ---------------------------------------------------------------------------
 * ENDPOINT STATUS: UNVERIFIED
 * ---------------------------------------------------------------------------
 * The default path below follows MAVIR's known chart-backend pattern
 * (/rtdwweb/webuser/chart/<chartId>/...), but it could not be reached from the
 * environment this was written in, so treat it as a starting hypothesis rather than
 * a confirmed contract. Run `npm run probe -- --mavir` against the live service and
 * adjust via configuration:
 *
 *   MAVIR_BASE_URL, MAVIR_PATH, MAVIR_CHART_ID,
 *   MAVIR_ARRAY_PATH, MAVIR_TIME_FIELD
 *
 * Series names are mapped case-insensitively and accent-insensitively, so the
 * Hungarian labels ("Atomerőmű", "Földgáz") and English ones both resolve.
 */

const DEFAULTS = {
  baseUrl: 'https://www.mavir.hu',
  path: '/rtdwweb/webuser/chart/{chartId}/data',
  chartId: '7678',
  arrayPath: 'data',
  timeField: 'timestamp',
  timeoutMs: 20000,
};

/**
 * Maps whatever MAVIR calls a series onto our internal source types.
 * Keys are normalised (lowercase, accents stripped) before lookup.
 */
const SERIES_ALIASES = {
  nuclear: ['atomeromu', 'atom', 'nuklearis', 'nuclear'],
  coal: ['szen', 'lignit', 'barnaszen', 'feketeszen', 'coal', 'lignite'],
  naturalGas: ['foldgaz', 'gaz', 'gas', 'naturalgas', 'natural gas'],
  oil: ['olaj', 'oil', 'fuel oil'],
  biomass: ['biomassza', 'biomass'],
  waste: ['hulladek', 'waste'],
  wind: ['szel', 'szeleromu', 'wind'],
  pv: ['nap', 'naperomu', 'pv', 'solar', 'fotovoltaikus'],
  hydro: ['viz', 'vizeromu', 'hydro'],
  other: ['egyeb', 'other'],
  load: ['nettoterheles', 'netto terheles', 'terheles', 'load', 'brutto terheles'],
  netImport: ['import', 'szaldo', 'nettoimport', 'net import'],
};

const NORMALISED_ALIASES = buildAliasIndex();

function buildAliasIndex() {
  const index = new Map();
  for (const [sourceType, aliases] of Object.entries(SERIES_ALIASES)) {
    for (const alias of aliases) index.set(normalise(alias), sourceType);
  }
  return index;
}

/** Lowercase, strip diacritics, drop non-alphanumerics - "Atomerőmű" -> "atomeromu". */
function normalise(str) {
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function resolveSourceType(seriesName) {
  const key = normalise(seriesName);
  if (NORMALISED_ALIASES.has(key)) return NORMALISED_ALIASES.get(key);
  // Fall back to substring matching for labels like "Atomerőmű termelés [MW]".
  for (const [alias, sourceType] of NORMALISED_ALIASES.entries()) {
    if (key.includes(alias)) return sourceType;
  }
  return null;
}

function config(env = process.env) {
  return {
    baseUrl: env.MAVIR_BASE_URL || DEFAULTS.baseUrl,
    path: env.MAVIR_PATH || DEFAULTS.path,
    chartId: env.MAVIR_CHART_ID || DEFAULTS.chartId,
    arrayPath: env.MAVIR_ARRAY_PATH || DEFAULTS.arrayPath,
    timeField: env.MAVIR_TIME_FIELD || DEFAULTS.timeField,
    timeoutMs: Number(env.MAVIR_TIMEOUT_MS) || DEFAULTS.timeoutMs,
  };
}

function buildUrl(cfg) {
  const path = cfg.path.replace('{chartId}', encodeURIComponent(cfg.chartId));
  return new URL(path, cfg.baseUrl).toString();
}

/**
 * Reduce a MAVIR response to { sourceType: MW } for the most recent complete sample.
 *
 * Handles both row-per-timestamp layouts ({time, "Atomerőmű": 1980, ...}) and
 * series-of-points layouts ({name, data:[[t, v], ...]}), since the chart backend has
 * used both over time.
 */
function parseGeneration(payload, cfg = config()) {
  const bySource = {};
  let timestamp = null;

  const rows = Array.isArray(extract(payload, cfg.arrayPath))
    ? extract(payload, cfg.arrayPath)
    : firstArray(payload);

  if (!Array.isArray(rows) || rows.length === 0) return null;

  // Layout A: array of series objects, each with its own points.
  const looksLikeSeries = rows.every(
    (r) => r && typeof r === 'object' && (Array.isArray(r.data) || Array.isArray(r.values)),
  );

  if (looksLikeSeries) {
    for (const series of rows) {
      const sourceType = resolveSourceType(series.name || series.label || series.title || '');
      if (!sourceType) continue;
      const points = series.data || series.values;
      const last = lastNumericPoint(points);
      if (!last) continue;
      bySource[sourceType] = last.value;
      if (last.time && (!timestamp || last.time > timestamp)) timestamp = last.time;
    }
  } else {
    // Layout B: array of timestamped rows with one key per series.
    const sorted = rows
      .map((row) => ({ row, t: toMillis(extract(row, cfg.timeField)) }))
      .sort((a, b) => a.t - b.t);

    // Walk back from the newest row until one carries actual generation values -
    // MAVIR often publishes the current quarter-hour with nulls before it closes.
    for (let i = sorted.length - 1; i >= 0 && Object.keys(bySource).length === 0; i -= 1) {
      const { row, t } = sorted[i];
      for (const [key, value] of Object.entries(row)) {
        const sourceType = resolveSourceType(key);
        if (!sourceType) continue;
        const num = Number(value);
        if (!Number.isFinite(num)) continue;
        bySource[sourceType] = num;
      }
      if (Object.keys(bySource).length > 0 && Number.isFinite(t)) timestamp = t;
    }
  }

  if (Object.keys(bySource).length === 0) return null;

  return {
    timestamp: new Date(timestamp || Date.now()).toISOString(),
    generationMw: bySource,
  };
}

function lastNumericPoint(points) {
  if (!Array.isArray(points)) return null;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const p = points[i];
    if (Array.isArray(p)) {
      const value = Number(p[1]);
      if (Number.isFinite(value)) return { value, time: toMillis(p[0]) };
    } else if (p && typeof p === 'object') {
      const value = Number(p.y ?? p.value);
      if (Number.isFinite(value)) return { value, time: toMillis(p.x ?? p.t ?? p.timestamp) };
    } else {
      const value = Number(p);
      if (Number.isFinite(value)) return { value, time: null };
    }
  }
  return null;
}

function toMillis(raw) {
  if (raw == null) return NaN;
  if (typeof raw === 'number') return raw > 1e12 ? raw : raw * 1000;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? NaN : parsed;
}

/** Fetch the current generation mix. Throws on transport failure. */
async function fetchGeneration(env = process.env) {
  const cfg = config(env);
  const url = buildUrl(cfg);
  const payload = await fetchJson(url, { timeoutMs: cfg.timeoutMs });
  const parsed = parseGeneration(payload, cfg);

  if (!parsed) {
    throw new Error(`MAVIR response from ${url} contained no recognisable generation series`);
  }

  return { source: 'mavir', fetchedAt: new Date().toISOString(), ...parsed };
}

module.exports = {
  fetchGeneration,
  parseGeneration,
  resolveSourceType,
  normalise,
  config,
  buildUrl,
  SERIES_ALIASES,
  DEFAULTS,
};
