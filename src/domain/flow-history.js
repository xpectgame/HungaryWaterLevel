'use strict';

const path = require('node:path');
const fs = require('node:fs');

/**
 * Where today's discharge sits in ten years of the same calendar month.
 *
 * The site could already say "411 m3/s, 73% of the long-term mean", and that sentence
 * is useless to a reader: 73% of the mean is an ordinary August on a river whose August
 * is always low, and an emergency on one whose August is not. A mean has no width, so it
 * cannot tell those apart. A distribution can.
 *
 * The document behind this is baked by `npm run probe -- --flow-history`, not fetched:
 * it is 290 requests against someone else's public service and it changes once a year.
 * Its shape, per station, is twelve months of
 *
 *     { p: [p5, p10, p25, p50, p75, p90, p95], min: {value, year, day}, max: {...},
 *       days, years }
 *
 * with `null` for a month that did not clear the coverage bar in the probe.
 *
 * TWO THINGS THIS DELIBERATELY REFUSES TO DO:
 *
 * 1. It does not extrapolate past the record. A reading below the lowest day ever seen
 *    is reported as `belowRecord`, not as "percentile -3" or "percentile 0". Ten years
 *    is a short record, and the honest statement is "lower than anything in this record",
 *    not a number implying we know how unusual it is.
 *
 * 2. It does not speak. Every field here is a code or a number, because the API is in
 *    English and the page is in Hungarian, and this project already shipped a bug where
 *    the frontend printed English prose - complete with a raw station id - straight into
 *    a Hungarian page. The consumer writes the sentence.
 */

const QUANTILES = Object.freeze([5, 10, 25, 50, 75, 90, 95]);

/**
 * Bands, in ascending order. The cuts are the conventional hydrological quintile-ish
 * split rather than anything derived: below p5 is the bottom twentieth of a decade,
 * which is where "unusually low" starts meaning something.
 */
const BANDS = Object.freeze([
  { code: 'very-low', upTo: 5 },
  { code: 'low', upTo: 25 },
  { code: 'normal', upTo: 75 },
  { code: 'high', upTo: 95 },
  { code: 'very-high', upTo: 100 },
]);

const DOCUMENT_PATH = path.join(__dirname, '..', 'config', 'flow-history.json');

let cached;

/**
 * The baked document, or null when it has not been baked yet.
 *
 * Missing is a normal state, not an error: the probe that produces this only runs from a
 * GitHub runner, so a fresh checkout has no file and every consumer has to keep working
 * without it. Reported as absent rather than thrown.
 */
function loadHistory({ reload = false } = {}) {
  if (cached !== undefined && !reload) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(DOCUMENT_PATH, 'utf8'));
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * @param {string} stationId
 * @param {number} flowM3s        today's discharge
 * @param {object} [opts]
 * @param {Date|number} [opts.at=Date.now()]  which calendar month to compare against
 * @param {object} [opts.document]            inject the document instead of reading it
 * @returns {object|null} null when this station or month has no usable record
 */
function rankFlow(stationId, flowM3s, opts = {}) {
  if (!Number.isFinite(flowM3s)) return null;
  const document = opts.document !== undefined ? opts.document : loadHistory();
  const station = document && document[stationId];
  if (!station || !Array.isArray(station.months)) return null;

  const at = opts.at ? new Date(opts.at) : new Date();
  const month = at.getUTCMonth();
  const record = station.months[month];
  if (!record || !Array.isArray(record.p)) return null;

  const percentile = percentileWithin(flowM3s, record);
  const belowRecord = record.min ? flowM3s < record.min.value : false;
  const aboveRecord = record.max ? flowM3s > record.max.value : false;

  return {
    month: month + 1,
    percentile,
    // A record low is its own band rather than the bottom of `very-low`, because it is
    // the one case where the honest phrasing changes: not "in the driest 5%" but
    // "lower than any day in this record".
    band: belowRecord ? 'record-low' : aboveRecord ? 'record-high' : bandFor(percentile),
    belowRecord,
    aboveRecord,
    medianM3s: record.p[3],
    recordLow: record.min || null,
    recordHigh: record.max || null,
    ratioToMedian: record.p[3] > 0 ? round(flowM3s / record.p[3], 3) : null,
    // Carried so a consumer can decide whether "in N years" is worth saying, and so a
    // thin month cannot quietly pass itself off as a decade.
    years: record.years,
    days: record.days,
  };
}

/**
 * Percentile of `value` against the stored quantile points.
 *
 * Piecewise-linear between the points we actually have - min at 0, the seven quantiles,
 * max at 100 - which is the most that can be said from a seven-point summary. Outside
 * [min, max] it clamps rather than extrapolating: see the note at the top about not
 * inventing a number for a reading below the whole record.
 */
function percentileWithin(value, record) {
  const points = [];
  if (record.min) points.push([record.min.value, 0]);
  QUANTILES.forEach((q, i) => {
    if (Number.isFinite(record.p[i])) points.push([record.p[i], q]);
  });
  if (record.max) points.push([record.max.value, 100]);
  if (!points.length) return null;

  // The probe rounds to two decimals, so two adjacent quantiles can land on the same
  // value on a flat, heavily regulated section. Interpolating across a zero-width step
  // divides by zero; taking the higher percentile of the tie is the meaningful answer.
  if (value <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (value >= last[0]) return last[1];

  for (let i = 1; i < points.length; i += 1) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (value > x1) continue;
    if (x1 === x0) return y1;
    return round(y0 + ((value - x0) / (x1 - x0)) * (y1 - y0), 1);
  }
  return last[1];
}

function bandFor(percentile) {
  if (percentile === null) return null;
  for (const band of BANDS) {
    if (percentile <= band.upTo) return band.code;
  }
  return BANDS[BANDS.length - 1].code;
}

/**
 * What this station normally carries in this calendar month - the median day.
 *
 * The number the whole balance was missing. Every ratio on the site was drawn against an
 * ANNUAL mean, and Hungary's rivers run at about two thirds of their annual mean in
 * August, so a normal late summer already reads as "68% of normal" before anything is
 * wrong. A genuinely dry August then reads as 36%, which sounds like the rivers have
 * half vanished when the honest figure against the season is nearer 56%.
 *
 * Returns null where the archive has no usable month, so a caller can leave that station
 * out of both sides of its comparison rather than counting a zero.
 */
function monthlyMedian(stationId, month, document = loadHistory()) {
  const station = document && document[stationId];
  if (!station || !Array.isArray(station.months)) return null;
  const record = station.months[month];
  if (!record || !Array.isArray(record.p)) return null;
  return Number.isFinite(record.p[3]) ? record.p[3] : null;
}

/** How much of the network has a usable record, for the methodology section. */
function historyCoverage(document = loadHistory()) {
  if (!document) return { stations: 0, monthsComplete: 0, available: false };
  const ids = Object.keys(document);
  let complete = 0;
  let anyMonth = 0;
  for (const id of ids) {
    const months = (document[id] && document[id].months) || [];
    const usable = months.filter(Boolean).length;
    if (usable === 12) complete += 1;
    if (usable > 0) anyMonth += 1;
  }
  return { available: true, stations: ids.length, withAnyMonth: anyMonth, monthsComplete: complete };
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

module.exports = {
  rankFlow, loadHistory, historyCoverage, percentileWithin, monthlyMedian,
  BANDS, QUANTILES, DOCUMENT_PATH,
};
