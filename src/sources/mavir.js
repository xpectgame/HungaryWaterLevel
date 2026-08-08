'use strict';

const { fetchBuffer, browserHeaders } = require('../lib/http');
const { readXlsx, excelDate } = require('../lib/xlsx');

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
 * THERE IS NO JSON FEED. THE CHART IS A PICTURE.
 * ---------------------------------------------------------------------------
 * The portal frames a separate application, and that application embeds Play's
 * generated jsRoutes table inline - the complete server-side route list:
 *
 *   GET /chart/{chartId}/image/actual?lastTimestamp=
 *   GET /chart/{chartId}/image/custom/from/{fromTime}/to/{toTime}
 *   GET /chart/{chartId}/export?exportType=&fromTime=&toTime=&periodType=&period=
 *   GET /reload_needed/{lastReloadTime}
 *
 * The chart is rendered server-side as an image. That is why no data endpoint was ever
 * found behind it: there is none to find. The only numeric route is the export, and it
 * answers exactly one combination out of the twenty tried:
 *
 *   GET /rtdwweb/webuser/chart/4401/export
 *       ?exportType=xlsx&periodType=hour&period=1&fromTime=<ms>&toTime=<ms>
 *   -> application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
 *
 * xlsx only; csv and every other periodType answer 500. Times are epoch milliseconds,
 * the unit the page's own data-reload-time uses. The base is /rtdwweb/webuser - the
 * host root answers 403, even though jsRoutes writes its paths from "/".
 *
 * RATE LIMITED, HARD. Twenty requests in a few seconds took the whole host to 429,
 * including the page itself, and it stayed there. One request per poll is the budget;
 * a retry loop here will lock the source out rather than recover it.
 *
 * Chart 4401 is listed as "Erőművi termelés" - power plant generation - and it is not.
 * Confirmed against the live export: its columns are national aggregates.
 *
 *   Nettó terv erőművi termelés    3138.2 MW
 *   Bruttó tény erőművi termelés   3018.8 MW
 *   Bruttó terv erőművi termelés   2875.8 MW
 *
 * Planned against actual, gross against net. No plant appears anywhere in it, so this
 * route cannot answer what Paks is generating - the question the cooling model exists
 * to answer. The name promised a breakdown the file does not contain.
 *
 * The rest of the catalogue: 4423 import/export, 5229 cross-border flows, 7678 planned
 * and actual system load, 10260 system data. None is per-plant either.
 *
 * So the conclusion from the first paragraph stands and hardens: for per-plant, and
 * especially per-unit output, ENTSO-E document A73 is the only source available. This
 * adapter is worth keeping for the national total, which it does give, and which is a
 * genuine cross-check against ENTSO-E's A75.
 *
 * Worth recording how this was found, because it generalises: literal-mining returned
 * zero candidates. Play builds its URLs by concatenation - "/" + "chart/" + id - so no
 * single string literal is ever an endpoint. Printing the inline block found in one
 * pass what mining could not find at all.
 *
 * ---------------------------------------------------------------------------
 * PREFER ENTSO-E
 * ---------------------------------------------------------------------------
 * ENTSO-E publishes the same aggregate as document A75, over a documented API, and
 * publishes per-unit generation as A73 - which this service has no equivalent of and
 * which the units cooling model needs. See sources/entsoe.js. This adapter is worth
 * keeping as an independent cross-check, not as the primary source.
 */

const DEFAULTS = {
  // The publication app, not the portal that frames it. The host root answers 403.
  baseUrl: 'https://rtdwweb.mavir.hu/rtdwweb/webuser',
  chartId: '4401', // "Erőművi termelés" - generation per power plant
  // The only combination that answers; every other exportType or periodType is a 500.
  exportType: 'xlsx',
  periodType: 'hour',
  period: '1',
  lookbackHours: 6,
  timeoutMs: 30000,
};

const REFERER = 'https://rtdwweb.mavir.hu/rtdwweb/webuser/GenerateChartsServlet?hunLang=hu-hu&tabId=tab4402';


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
  const num = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    baseUrl: env.MAVIR_BASE_URL || DEFAULTS.baseUrl,
    chartId: env.MAVIR_CHART_ID || DEFAULTS.chartId,
    exportType: env.MAVIR_EXPORT_TYPE || DEFAULTS.exportType,
    periodType: env.MAVIR_PERIOD_TYPE || DEFAULTS.periodType,
    period: env.MAVIR_PERIOD || DEFAULTS.period,
    lookbackHours: num(env.MAVIR_LOOKBACK_HOURS, DEFAULTS.lookbackHours),
    timeoutMs: num(env.MAVIR_TIMEOUT_MS, DEFAULTS.timeoutMs),
  };
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

/** The one URL that answers. Times are epoch milliseconds. */
function exportUrl(cfg, now = new Date()) {
  const to = now.getTime();
  const from = to - cfg.lookbackHours * 3600 * 1000;
  const base = cfg.baseUrl.replace(/\/+$/, '');
  return (
    `${base}/chart/${cfg.chartId}/export` +
    `?exportType=${cfg.exportType}&fromTime=${from}&toTime=${to}` +
    `&periodType=${cfg.periodType}&period=${cfg.period}`
  );
}

/**
 * Download the spreadsheet. Exactly one request, deliberately.
 *
 * Twenty requests in a few seconds put the whole host into 429 - the page included -
 * and it stayed there. A retry here does not recover the source, it locks it out, so
 * there is none: a failed poll waits for the next quarter hour like everything else.
 */
async function fetchSheet(env = process.env, now = new Date()) {
  const cfg = config(env);
  const url = exportUrl(cfg, now);

  const { buffer, contentType } = await fetchBuffer(url, {
    timeoutMs: cfg.timeoutMs,
    headers: browserHeaders('https://rtdwweb.mavir.hu', REFERER),
  });

  // A 429 or an error page arrives as HTML with a 200 often enough to be worth naming,
  // and "not a ZIP archive" three frames later says nothing about why.
  if (!/spreadsheet|officedocument|octet-stream/i.test(contentType)) {
    throw new Error(`Expected a spreadsheet from ${url}, got ${contentType || 'no content-type'}`);
  }

  return { url, rows: readXlsx(buffer).rows };
}

/**
 * Read the grid into { plantName -> MW } at the newest timestamped row.
 *
 * The layout is taken from the sheet rather than assumed: the header is the first row
 * carrying two or more non-numeric labels, and the time column is the first column of
 * the row below it that parses as a date. Hard-coding row 1 and column A would work
 * until MAVIR adds a title row, and then it would silently read the title as a plant.
 */
function parseSheet(rows) {
  const headerIndex = rows.findIndex(
    (row) => row.filter((cell) => typeof cell === 'string' && cell.trim()).length >= 2,
  );
  if (headerIndex === -1) throw new Error('No header row in the MAVIR export');

  const header = rows[headerIndex].map((cell) => (typeof cell === 'string' ? cell.trim() : cell));

  let latest = null;
  for (const row of rows.slice(headerIndex + 1)) {
    const stamp = typeof row[0] === 'number' ? excelDate(row[0]) : row[0] ? new Date(row[0]) : null;
    if (!stamp || Number.isNaN(stamp.getTime())) continue;
    // Rows with no numbers at all are separators or footers, not observations.
    if (!row.slice(1).some((cell) => Number.isFinite(cell))) continue;
    if (!latest || stamp > latest.stamp) latest = { stamp, row };
  }

  if (!latest) throw new Error('No timestamped row with values in the MAVIR export');

  const byPlant = {};
  for (let i = 1; i < header.length; i += 1) {
    const name = header[i];
    const value = latest.row[i];
    if (typeof name === 'string' && name && Number.isFinite(value)) byPlant[name] = value;
  }

  return { timestamp: latest.stamp.toISOString(), byPlant, columns: header };
}

/** Fetch the current per-plant generation. Throws on transport failure. */
async function fetchGeneration(env = process.env, now = new Date()) {
  const { rows } = await fetchSheet(env, now);
  const { timestamp, byPlant } = parseSheet(rows);

  return {
    source: 'mavir',
    fetchedAt: new Date().toISOString(),
    timestamp,
    byPlant,
    // The aggregate the rest of the project already consumes is derived downstream,
    // once the column names are mapped onto the plant registry.
    generationMw: {},
  };
}

module.exports = {
  fetchSheet,
  exportUrl,
  parseSheet,
  fetchGeneration,
  parseGeneration,
  resolveSourceType,
  normalise,
  config,
  SERIES_ALIASES,
  DEFAULTS,
};
