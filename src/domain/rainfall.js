'use strict';

const {
  listRainGauges,
  normalForWindow,
  normalYears,
  COVERAGE,
  BASELINE_NOTE,
} = require('../config/rain-gauges');

/**
 * What a rainfall total means, which is nothing until it is compared to something.
 *
 * "12 mm in thirty days" is a number most people cannot place. "12 mm where 58 is
 * normal - a fifth of it" is a sentence anyone can act on, and it is the same
 * measurement. Everything in this module exists to make that second sentence, from the
 * gauge's own ten-year archive rather than from an adjective.
 */

/**
 * Where the bands come from.
 *
 * These are percentage-of-normal thresholds, the standard way a rainfall deficit is
 * graded, and they are stated here rather than borrowed from a specific national index
 * because this is a ratio of measurements and not a claim to be that index. In
 * particular this is NOT the Hungarian aszályindex (HDI), which combines soil moisture
 * and temperature and is published by OVF's own drought monitoring service. Calling a
 * rainfall ratio a drought index would be borrowing an authority this does not have.
 *
 * So the bands are named for what they describe - how much of the normal rain arrived -
 * and the wording never asserts a drought classification.
 */
const BANDS = Object.freeze([
  { id: 'extreme-deficit', maxRatio: 0.25, label: 'Rendkívül kevés', hu: 'a szokásos negyede sem esett le' },
  { id: 'severe-deficit', maxRatio: 0.5, label: 'Nagyon kevés', hu: 'a szokásos fele sem esett le' },
  { id: 'deficit', maxRatio: 0.75, label: 'Kevés', hu: 'a szokásosnál jóval kevesebb esett' },
  { id: 'near-normal', maxRatio: 1.25, label: 'Szokásos', hu: 'a szokásos körüli mennyiség esett' },
  { id: 'surplus', maxRatio: 2, label: 'Sok', hu: 'a szokásosnál jóval több esett' },
  { id: 'extreme-surplus', maxRatio: Infinity, label: 'Rendkívül sok', hu: 'a szokásos többszöröse esett' },
]);

function bandFor(ratio) {
  if (!Number.isFinite(ratio)) return null;
  return BANDS.find((band) => ratio <= band.maxRatio) || BANDS[BANDS.length - 1];
}

/**
 * How stale a gauge may be before its total stops meaning anything.
 *
 * Most of the network reports once a day. Three days allows for a weekend of missed
 * telemetry without dropping a gauge; beyond that a low total is more likely to be a
 * silent instrument than a dry field, and reporting it as rainfall would put a false
 * dry spot on the map.
 */
const STALE_AFTER_MS = 3 * 24 * 3600 * 1000;

/** Whole days since a timestamp, or null. */
function daysSince(iso, now) {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.floor((now - then) / (24 * 3600 * 1000));
}

/**
 * One gauge, measured against its own normal for exactly the window that was measured.
 *
 * The window matters: comparing a 30-day total against a calendar-month normal would be
 * wrong by however much the two months either side differ, and in a Hungarian summer
 * that is the difference between June and August - about 20 mm.
 */
function describeGauge(gauge, reading, { from, to, now }) {
  const stale = reading.lastAt ? now - Date.parse(reading.lastAt) > STALE_AFTER_MS : true;
  const normalMm = normalForWindow(gauge.id, from, to);
  const ratio = normalMm && normalMm > 0 ? reading.totalMm / normalMm : null;

  return {
    id: gauge.id,
    name: gauge.name,
    region: gauge.region,
    lat: gauge.lat,
    lon: gauge.lon,
    totalMm: reading.totalMm,
    normalMm,
    normalYears: normalYears(gauge.id),
    ratioToNormal: ratio === null ? null : Math.round(ratio * 100) / 100,
    deficitMm: normalMm === null ? null : Math.round((reading.totalMm - normalMm) * 10) / 10,
    band: ratio === null ? null : bandFor(ratio).id,
    wetDays: reading.wetDays,
    lastRainAt: reading.lastRainAt,
    daysSinceRain: daysSince(reading.lastRainAt, now),
    lastAt: reading.lastAt,
    // A stale gauge stays in the payload with the flag set rather than disappearing:
    // a hole that appears and vanishes as gauges drop in and out is harder to read
    // than a dot that says it is out of date.
    stale,
    daily: reading.daily || [],
  };
}

/** Regional roll-up. Rain is patchy, so a region is only as meaningful as its spread. */
function summariseRegions(gauges) {
  const byRegion = new Map();

  for (const gauge of gauges) {
    if (gauge.stale || gauge.normalMm === null) continue;
    if (!byRegion.has(gauge.region)) byRegion.set(gauge.region, []);
    byRegion.get(gauge.region).push(gauge);
  }

  return [...byRegion.entries()]
    .map(([region, members]) => {
      const totalMm = members.reduce((sum, g) => sum + g.totalMm, 0) / members.length;
      const normalMm = members.reduce((sum, g) => sum + g.normalMm, 0) / members.length;
      const ratio = normalMm > 0 ? totalMm / normalMm : null;
      const driest = members.slice().sort((a, b) => a.ratioToNormal - b.ratioToNormal)[0];

      return {
        region,
        gaugeCount: members.length,
        meanMm: Math.round(totalMm * 10) / 10,
        normalMm: Math.round(normalMm * 10) / 10,
        ratioToNormal: ratio === null ? null : Math.round(ratio * 100) / 100,
        band: ratio === null ? null : bandFor(ratio).id,
        // The range within a region, because an average of 20 mm made of 0 and 40 is a
        // different situation from one made of 19 and 21.
        minMm: Math.min(...members.map((g) => g.totalMm)),
        maxMm: Math.max(...members.map((g) => g.totalMm)),
        driestGauge: driest ? { id: driest.id, name: driest.name, totalMm: driest.totalMm } : null,
      };
    })
    .sort((a, b) => (a.ratioToNormal ?? 99) - (b.ratioToNormal ?? 99));
}

/**
 * The one-line summary, written so it cannot overstate what was measured.
 *
 * Deliberately built from counts of gauges rather than from a national average: the
 * network does not cover the country evenly, so an average over it is an average over
 * the Alföld wearing a national label.
 */
function headline(gauges, windowDays) {
  const fresh = gauges.filter((g) => !g.stale);
  const usable = fresh.filter((g) => g.ratioToNormal !== null);

  if (usable.length === 0) {
    // Two different failures that would otherwise read the same. A reader seeing "no
    // data" while the gauges are plainly reporting is being told something false, and
    // the fix for each case is different: one is an upstream outage, the other is a
    // missing rain-normals.json that `npm run probe -- --rain-normals` regenerates.
    if (fresh.length > 0) {
      const total = fresh.reduce((sum, g) => sum + g.totalMm, 0) / fresh.length;
      return {
        text:
          `${fresh.length} állomás jelentett, átlagosan ${Math.round(total * 10) / 10} mm az elmúlt ` +
          `${windowDays} napban. Összehasonlítási alap (sokéves átlag) egyelőre nincs betöltve.`,
        severity: 0,
        noBaseline: true,
      };
    }
    return { text: 'Nincs elég friss csapadékadat a mérlegeléshez.', severity: 0 };
  }

  const dry = usable.filter((g) => g.ratioToNormal <= 0.5);
  const veryDry = usable.filter((g) => g.ratioToNormal <= 0.25);
  const wet = usable.filter((g) => g.ratioToNormal >= 2);

  if (veryDry.length >= usable.length / 2) {
    const worst = usable.slice().sort((a, b) => a.totalMm - b.totalMm)[0];
    return {
      text:
        `${usable.length} mérőállomásból ${veryDry.length} helyen a szokásos csapadék negyede sem esett le ` +
        `az elmúlt ${windowDays} napban. A legszárazabb ${worst.name}: ${worst.totalMm} mm, ` +
        `a szokásos ${worst.normalMm} mm helyett.`,
      severity: 3,
    };
  }

  if (dry.length >= usable.length / 2) {
    return {
      text:
        `${usable.length} mérőállomásból ${dry.length} helyen a szokásos csapadék fele sem esett le ` +
        `az elmúlt ${windowDays} napban.`,
      severity: 2,
    };
  }

  if (wet.length >= usable.length / 3) {
    return {
      text: `${usable.length} mérőállomásból ${wet.length} helyen a szokásos csapadék legalább kétszerese esett le az elmúlt ${windowDays} napban.`,
      severity: 1,
    };
  }

  return {
    text: `Az elmúlt ${windowDays} nap csapadéka nagyjából a szokásos körül alakult a mért területeken.`,
    severity: 0,
  };
}

/**
 * Build the rainfall payload from a fetch result.
 *
 * Pure: takes what the adapter returned and the clock, returns the answer. The upstream
 * call lives in the route so this can be tested without one.
 */
function buildRainfall(fetched, { now = Date.now() } = {}) {
  const readings = (fetched && fetched.gauges) || {};
  const windowDays = (fetched && fetched.windowDays) || 30;
  const to = (fetched && fetched.to) || new Date(now).toISOString();
  const from = (fetched && fetched.from) || new Date(now - windowDays * 24 * 3600 * 1000).toISOString();

  const gauges = listRainGauges()
    .filter((gauge) => readings[gauge.id])
    .map((gauge) => describeGauge(gauge, readings[gauge.id], { from, to, now }));

  const missing = listRainGauges()
    .filter((gauge) => !readings[gauge.id])
    .map((gauge) => ({ id: gauge.id, name: gauge.name, region: gauge.region }));

  const reporting = gauges.filter((g) => !g.stale);

  return {
    windowDays,
    from,
    to,
    fetchedAt: (fetched && fetched.fetchedAt) || new Date(now).toISOString(),
    headline: headline(gauges, windowDays),
    gaugeCount: gauges.length,
    reportingCount: reporting.length,
    driest: reporting
      .filter((g) => g.ratioToNormal !== null)
      .slice()
      .sort((a, b) => a.ratioToNormal - b.ratioToNormal)
      .slice(0, 5)
      .map((g) => ({ id: g.id, name: g.name, totalMm: g.totalMm, normalMm: g.normalMm, ratioToNormal: g.ratioToNormal })),
    regions: summariseRegions(gauges),
    gauges,
    missing,
    coverage: COVERAGE,
    baselineNote: BASELINE_NOTE,
    bands: BANDS.map(({ id, label, hu }) => ({ id, label, hu })),
  };
}

module.exports = {
  buildRainfall,
  describeGauge,
  summariseRegions,
  headline,
  bandFor,
  BANDS,
  STALE_AFTER_MS,
};
