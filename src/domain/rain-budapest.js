'use strict';

const path = require('node:path');
const fs = require('node:fs');

/**
 * Budapest rainfall, from a different source, and honest about being one.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS SEPARATELY FROM THE REST OF THE RAIN SECTION
 * ---------------------------------------------------------------------------
 * Every other number on this site comes from one source: the water directorate's open
 * data (OVF). Its meteorological network has no station in the capital at all - confirmed
 * live, zero gauges in the Közép-Duna-völgyi directorate and zero river-post rain gauges
 * anywhere near Budapest - so on that source the city is simply unmeasured, and a reader
 * in Budapest sees rain out the window that the map cannot show.
 *
 * This closes that one hole with a SECOND provider: HungaroMet (OMSZ) open data, station
 * 44121, Budapest belterület. It is a deliberate, labelled exception. The figure carries
 * `source: 'OMSZ'` so nothing here can be mistaken for the OVF network, and the page says
 * which provider it is wherever it appears.
 *
 * ---------------------------------------------------------------------------
 * BAKED, DAILY, WITH AN AS-OF DATE
 * ---------------------------------------------------------------------------
 * OMSZ daily observations update roughly once a day and arrive as zipped CSVs. Rather
 * than teach the serverless runtime to fetch and unzip a second provider on every
 * request, the probe bakes src/config/rain-budapest.json: the last ~130 daily values and
 * a twelve-month normal from 24 years of archive. So this is a day-resolution figure with
 * a real `asOf` date, not a live one, and it says so - which is the honest shape for a
 * daily measurement anyway.
 */

const DOCUMENT_PATH = path.join(__dirname, '..', 'config', 'rain-budapest.json');
const MIN_YEARS = 3;
const DAYS_IN_MONTH = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

let cached;

function loadBudapestRain({ reload = false } = {}) {
  if (cached !== undefined && !reload) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(DOCUMENT_PATH, 'utf8'));
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * The normal rainfall over a trailing window, blended from the calendar months it spans.
 *
 * Identical arithmetic to the OVF gauges' normalForWindow, kept here rather than imported
 * so this module has no dependency on the OVF rain config: each day in the window
 * contributes its own month's daily rate, which is what a climatologist does by hand and
 * needs nothing beyond the twelve monthly figures.
 */
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
 * The Budapest figure for one trailing window, or null when the config is absent.
 *
 * @param days   7, 30 or 90 - the same three windows the section offers.
 */
function budapestRainfall(days = 30, { document } = {}) {
  const doc = document !== undefined ? document : loadBudapestRain();
  if (!doc || !Array.isArray(doc.daily) || !doc.daily.length) return null;

  const last = doc.daily[doc.daily.length - 1];
  const asOf = last.day;
  const end = new Date(`${asOf}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1); // inclusive of the last day
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);

  const startKey = start.toISOString().slice(0, 10);
  const window = doc.daily.filter((r) => r.day >= startKey && r.day <= asOf);
  // Coverage: a window missing many days cannot be summed honestly. OMSZ daily is
  // usually complete, but a run of -999 was dropped at bake time, so check.
  const coverage = window.length / days;
  const actual = window.reduce((s, r) => s + r.mm, 0);
  const normal = normalForWindow(doc.normal && doc.normal.mm, start.toISOString(), end.toISOString());
  const enoughNormal = doc.normal && doc.normal.years >= MIN_YEARS;

  return {
    source: 'OMSZ',
    provider: 'HungaroMet (OMSZ)',
    station: doc.station,
    windowDays: days,
    asOf,
    // Days behind: OMSZ daily lags reality by about a day, and a reader deserves to see
    // that this figure is "as of yesterday", not "now".
    ageDays: Math.max(0, Math.round((Date.now() - end.getTime()) / 86400000)) + 1,
    actualMm: Math.round(actual * 10) / 10,
    normalMm: enoughNormal ? normal : null,
    ratioToNormal: enoughNormal && normal > 0 ? Math.round((actual / normal) * 100) / 100 : null,
    coverage: Math.round(coverage * 100) / 100,
    complete: coverage >= 0.8,
    licence: doc.licence,
    normalYears: doc.normal ? doc.normal.years : null,
  };
}

module.exports = { budapestRainfall, loadBudapestRain, normalForWindow, DOCUMENT_PATH };
