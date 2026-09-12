'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { summariseRegions, headline, bandFor, BANDS } = require('./rainfall');

/**
 * National rainfall, from HungaroMet (OMSZ) open data, baked rather than fetched.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS REPLACED THE LIVE OVF RAIN
 * ---------------------------------------------------------------------------
 * The rain section used to call vizugy.hu live, per request, for 47 OVF gauges. That was
 * wrong twice over: the OVF meteorological network is not national (nothing in the
 * capital, a bare Dunántúl), and a live upstream call fails whenever that host is
 * unreachable from the serverless runtime - which is precisely when the section answered
 * "no data". OMSZ publishes a national daily network as open data, so the probe bakes it
 * into src/config/rain-omsz.json and this module serves it. Two problems, one fix: the map
 * covers the whole country, and it cannot 503 because nothing is fetched at request time.
 *
 * This deliberately produces the SAME response shape the OVF builder did - gauges,
 * regions, headline, coverage, bands - so the map and the section render it unchanged. A
 * station here is what a gauge was there: a place, a total, and that total against the
 * station's own long-term normal.
 */

const DOCUMENT_PATH = path.join(__dirname, '..', 'config', 'rain-omsz.json');
const MIN_YEARS = 3;
const DAYS_IN_MONTH = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
// A station whose freshest day trails the network's freshest by more than this is drawn
// stale rather than as a dry spot - the same three-day grace the OVF gauges were given.
const STALE_DAYS = 3;

const COVERAGE = Object.freeze({
  network: 'HungaroMet (OMSZ) napi csapadékmérő hálózat',
  note:
    'A csapadék mostantól az OMSZ országos napi csapadékmérő hálózatából származik, nem az ' +
    'OVF néhány állomásából - így az egész országra van adat, a Dunántúlra és a fővárosra is. ' +
    'Ahol nincs pont, ott nincs a közelben mérő; ez nem azt jelenti, hogy nem esett.',
});

const BASELINE_NOTE =
  'A "szokásos" érték minden állomásnál a saját több éves napi archívumából számolt havi ' +
  'átlag (legalább három év), a mért időszak naptári hónapjaira vetítve. Ez mérés, nem ' +
  'harmincéves klimatológiai normál.';

let cached;

function loadNationalRain({ reload = false } = {}) {
  if (cached !== undefined && !reload) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(DOCUMENT_PATH, 'utf8'));
  } catch {
    cached = null;
  }
  return cached;
}

/** The normal over a trailing window, blended from the calendar months it spans. */
function normalForWindow(normalMm, fromISO, toISO) {
  if (!Array.isArray(normalMm)) return null;
  const start = new Date(fromISO);
  const end = new Date(toISO);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
  let total = 0;
  let counted = 0;
  for (const day = new Date(start); day < end; day.setUTCDate(day.getUTCDate() + 1)) {
    const m = day.getUTCMonth();
    const monthly = normalMm[m];
    if (!Number.isFinite(monthly)) return null;
    total += monthly / DAYS_IN_MONTH[m];
    counted += 1;
  }
  return counted ? Math.round(total * 10) / 10 : null;
}

/**
 * The region a station rolls up into.
 *
 * OMSZ tags each station with its county (megye), which is a good rollup granularity - but
 * it splits Budapest across six district names ("Budapest XII.", "Budapest IV." ...), each
 * with one station, which would show as six one-station "regions". Collapse those into one
 * Budapest; leave the counties as they are.
 */
function normalizeRegion(r) {
  if (!r) return 'Egyéb';
  if (/^budapest/i.test(r)) return 'Budapest';
  return r;
}

/** ISO day key `days` before `toKey` (inclusive window is [fromKey, toKey]). */
function windowStartKey(toKey, days) {
  const d = new Date(`${toKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}

/**
 * One station over one window, measured against its own normal for exactly that window.
 *
 * Anchored to the network's freshest day rather than to wall-clock now, because the bake
 * is a day-resolution snapshot: summing to "today" would count days the data has not
 * reached yet and understate every station equally.
 */
function describeStation(st, asOfKey, days) {
  const fromKey = windowStartKey(asOfKey, days);
  const inWindow = (st.daily || []).filter((r) => r.day >= fromKey && r.day <= asOfKey);
  const totalMm = Math.round(inWindow.reduce((s, r) => s + r.mm, 0) * 10) / 10;
  const wetDays = inWindow.filter((r) => r.mm >= 1).length;

  const lastAt = st.daily && st.daily.length ? st.daily[st.daily.length - 1].day : null;
  const rained = (st.daily || []).filter((r) => r.mm > 0);
  const lastRainAt = rained.length ? rained[rained.length - 1].day : null;
  const dayGap = (a, b) => (a && b
    ? Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000)
    : null);

  const normalMm = st.normal ? normalForWindow(st.normal.mm,
    `${fromKey}T00:00:00Z`,
    new Date(Date.parse(`${asOfKey}T00:00:00Z`) + 86400000).toISOString()) : null;
  const ratio = normalMm && normalMm > 0 ? totalMm / normalMm : null;
  const stale = dayGap(asOfKey, lastAt) > STALE_DAYS;

  return {
    id: st.id,
    name: st.name,
    region: normalizeRegion(st.region),
    lat: st.lat,
    lon: st.lon,
    totalMm,
    normalMm,
    normalYears: st.normal ? st.normal.years : null,
    ratioToNormal: ratio === null ? null : Math.round(ratio * 100) / 100,
    deficitMm: normalMm === null ? null : Math.round((totalMm - normalMm) * 10) / 10,
    band: ratio === null ? null : bandFor(ratio).id,
    wetDays,
    lastRainAt,
    daysSinceRain: dayGap(asOfKey, lastRainAt),
    lastAt,
    stale,
    daily: st.daily || [],
  };
}

/**
 * Build the national rainfall payload from the baked document.
 *
 * Pure: takes the baked config (or an injected one) and the window, returns the answer in
 * the OVF builder's shape so nothing downstream has to know the source changed.
 */
function buildNationalRainfall(days = 30, { document, now = Date.now() } = {}) {
  const doc = document !== undefined ? document : loadNationalRain();
  if (!doc || !Array.isArray(doc.stations) || !doc.stations.length) {
    return {
      windowDays: days,
      gauges: [],
      gaugeCount: 0,
      reportingCount: 0,
      regions: [],
      missing: [],
      unavailable: true,
      source: 'OMSZ',
      error: 'csapadékadat nincs betöltve',
    };
  }

  const asOfKey = doc.asOf
    || doc.stations.flatMap((s) => (s.daily || []).map((d) => d.day)).sort().slice(-1)[0];
  const toKey = asOfKey;
  const fromKey = windowStartKey(toKey, days);

  const gauges = doc.stations.map((st) => describeStation(st, asOfKey, days));
  const reporting = gauges.filter((g) => !g.stale);
  const withNormal = gauges.filter((g) => g.normalYears && g.normalYears >= MIN_YEARS).length;

  return {
    windowDays: days,
    from: `${fromKey}T00:00:00Z`,
    to: `${toKey}T00:00:00Z`,
    asOf: asOfKey,
    // Days behind: OMSZ daily lags reality by about a day, and the whole network shares one
    // freshest day, so the section can honestly say "as of yesterday".
    ageDays: Math.max(0, Math.round((now - (Date.parse(`${asOfKey}T00:00:00Z`) + 86400000)) / 86400000)) + 1,
    fetchedAt: doc.generated || new Date(now).toISOString(),
    headline: headline(gauges, days),
    gaugeCount: gauges.length,
    reportingCount: reporting.length,
    withNormal,
    driest: reporting
      .filter((g) => g.ratioToNormal !== null)
      .slice()
      .sort((a, b) => a.ratioToNormal - b.ratioToNormal)
      .slice(0, 5)
      .map((g) => ({ id: g.id, name: g.name, totalMm: g.totalMm, normalMm: g.normalMm, ratioToNormal: g.ratioToNormal })),
    regions: summariseRegions(gauges),
    gauges,
    missing: [],
    coverage: COVERAGE,
    baselineNote: BASELINE_NOTE,
    source: 'OMSZ',
    provider: 'HungaroMet (OMSZ)',
    licence: doc.licence,
    bands: BANDS.map(({ id, label, hu }) => ({ id, label, hu })),
  };
}

module.exports = {
  buildNationalRainfall,
  describeStation,
  normalForWindow,
  loadNationalRain,
  windowStartKey,
  COVERAGE,
  BASELINE_NOTE,
  DOCUMENT_PATH,
  STALE_DAYS,
};
