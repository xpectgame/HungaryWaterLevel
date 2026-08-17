'use strict';

const { loadYearly, loadDaily } = require('./flow-history');
const { getStation } = require('../config/stations');

/**
 * Is it worse than 2022?
 *
 * ---------------------------------------------------------------------------
 * THE QUESTION EVERY READER ACTUALLY HAS
 * ---------------------------------------------------------------------------
 * This site can say a river is at the 8th percentile of its decade. That is precise and
 * it lands on nobody, because a percentile has no memory attached to it. What people
 * remember is 2022: the summer the Tisza was walkable in places and it was on the news
 * for a month. "Worse than 2022" is a sentence with a picture behind it.
 *
 * The archive answers it. flow-yearly.json holds, per gauge per year, the MEDIAN of that
 * calendar month's daily mean discharges - and comparing one August to another August is
 * arithmetic, not modelling.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS COMPARED, AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 * MONTHLY MEDIANS ONLY, one calendar month against the same calendar month in other years.
 * That is the only comparison the archive supports, and the restriction matters: today's
 * live reading is an instantaneous discharge, and placing it in a table of monthly medians
 * would put a number measured at 09:15 next to numbers averaged over 31 days. It would
 * look like the same kind of thing and it is not. Today's reading against the decade's
 * distribution is a different question, already answered by flow-history.
 *
 * So the current year appears here only once its months are baked. Until then the page
 * compares completed years, which is where the finding is anyway.
 *
 * ---------------------------------------------------------------------------
 * NO NATIONAL TOTAL
 * ---------------------------------------------------------------------------
 * There is no single number for how the country's rivers did in a year, and this module
 * will not invent one. Summing 28 gauges would be dominated by the Danube - 1 500 m3/s
 * against the Fehér-Körös's 0.09 - so a "national mean" would be the Danube wearing a
 * hat, and averaging the ratios would weight a small border stream equal to the river
 * that carries most of the country's water.
 *
 * What is published instead is a COUNT: on how many gauges was this year lower than the
 * reference year. Counting is a fair operation over incommensurable things, and "11 of
 * 28 gauges ran lower than in 2022" is a sentence that survives being checked.
 */

const MONTHS_HU = Object.freeze([
  'január', 'február', 'március', 'április', 'május', 'június',
  'július', 'augusztus', 'szeptember', 'október', 'november', 'december',
]);

/**
 * The adjectival form, spelled out rather than built by appending -i.
 *
 * The page needs "az augusztusi vízhozam" and would otherwise write `monthHu + 'i'`,
 * which is right for eight months and wrong for four: január becomes januári, február
 * februári, and the vowel lengthens. Doing it here means the API carries Hungarian that
 * is correct rather than the frontend carrying a rule that is nearly correct - and this
 * project has already shipped one bug of exactly that shape.
 */
const MONTHS_ADJ_HU = Object.freeze([
  'januári', 'februári', 'márciusi', 'áprilisi', 'májusi', 'júniusi',
  'júliusi', 'augusztusi', 'szeptemberi', 'októberi', 'novemberi', 'decemberi',
]);

const REFERENCE_YEAR = 2022;

/**
 * One gauge's value for a given month, across every year in the archive.
 *
 * Returns null where the month was not covered - a gap in the record is not a zero and
 * must not be plotted as one.
 */
function monthSeries(byYear, month) {
  const out = {};
  for (const [year, series] of Object.entries(byYear || {})) {
    const v = Array.isArray(series) ? series[month] : null;
    out[year] = Number.isFinite(v) ? v : null;
  }
  return out;
}

/**
 * The whole comparison, for one calendar month.
 *
 * @param month     0-11. Defaults to the current month.
 * @param reference the year to compare against; 2022 unless told otherwise.
 */
function compareYears({ month, reference = REFERENCE_YEAR, document } = {}) {
  const yearly = document !== undefined ? document : loadYearly();
  if (!yearly || !Object.keys(yearly).length) {
    return { available: false, reason: 'A vízhozam-archívum nincs betöltve.' };
  }

  const m = Number.isInteger(month) ? month : new Date().getUTCMonth();
  const stations = [];
  const yearSet = new Set();

  for (const [id, byYear] of Object.entries(yearly)) {
    const station = getStation(id);
    const values = monthSeries(byYear, m);
    for (const [year, v] of Object.entries(values)) if (v !== null) yearSet.add(Number(year));

    const referenceValue = values[String(reference)];
    if (!Number.isFinite(referenceValue) || referenceValue <= 0) {
      // A gauge with no reference-year figure is carried with `comparable: false` rather
      // than dropped: "we have 28 gauges and 26 of them can be compared" is a fact about
      // the answer, and a silently shorter table hides it.
      stations.push({
        id,
        name: station ? station.name : id,
        river: station ? station.river : null,
        values,
        referenceValue: null,
        comparable: false,
      });
      continue;
    }

    const present = Object.entries(values)
      .filter(([, v]) => Number.isFinite(v))
      .map(([year, v]) => ({ year: Number(year), value: v }));

    const worse = present.filter((p) => p.year !== reference && p.value < referenceValue);
    const lowest = present.reduce((a, b) => (a === null || b.value < a.value ? b : a), null);
    const latest = present.reduce((a, b) => (a === null || b.year > a.year ? b : a), null);

    stations.push({
      id,
      name: station ? station.name : id,
      river: station ? station.river : null,
      values,
      referenceValue: round(referenceValue, 2),
      comparable: true,
      // Every year that ran lower than the reference, not just the latest, so a reader
      // can see whether the reference year was ever the worst on this gauge at all.
      worseYears: worse.map((p) => p.year).sort((a, b) => a - b),
      lowest: lowest ? { year: lowest.year, value: round(lowest.value, 2) } : null,
      latest: latest ? { year: latest.year, value: round(latest.value, 2) } : null,
      // The one derived figure, and it is per gauge rather than pooled: the latest
      // complete year as a share of the reference year on THIS river.
      latestVsReference: latest && latest.year !== reference
        ? round(latest.value / referenceValue, 3)
        : null,
    });
  }

  stations.sort((a, b) => {
    const av = a.latestVsReference, bv = b.latestVsReference;
    if (av === null && bv === null) return a.name.localeCompare(b.name, 'hu');
    if (av === null) return 1;
    if (bv === null) return -1;
    return av - bv;
  });

  const years = [...yearSet].sort((a, b) => a - b);
  const comparable = stations.filter((s) => s.comparable);
  const latestYear = years.length ? years[years.length - 1] : null;
  const belowReference = comparable.filter((s) => s.latest
    && s.latest.year === latestYear && s.latest.value < s.referenceValue);

  return {
    available: true,
    month: m,
    monthHu: MONTHS_HU[m],
    monthAdjHu: MONTHS_ADJ_HU[m],
    reference,
    latestYear,
    years,
    stations,
    summary: {
      stations: stations.length,
      comparable: comparable.length,
      // The headline, and it is a count rather than a mean for the reason at the top of
      // this file: 28 gauges spanning four orders of magnitude cannot be averaged.
      belowReference: belowReference.length,
      belowReferenceIds: belowReference.map((s) => s.id),
      // How many gauges saw their lowest month of this record in each year. This is what
      // "which was the worst year" means when there is no national total to rank.
      lowestByYear: countLowestByYear(comparable),
    },
    // Said in the payload rather than left to the page, because a consumer that plotted
    // a live reading on this axis would be comparing an instant to a monthly median.
    //
    // `monthly-median`, not `monthly-mean`. The bake writes percentileOf(daily, 50) and
    // this file called it a mean in four places, which in Hungarian came out as
    // "középvízhozam" - a defined hydrological term (KÖQ) that means precisely the
    // arithmetic mean. Naming a median with it is not loose wording, it is a wrong
    // statement about which statistic the reader is looking at.
    basis: 'monthly-median',
    basisNote: 'A havi napi vízhozamok mediánja, azonos naptári hónapok között. Nem átlag, és nem a mai pillanatnyi érték.',
  };
}

function countLowestByYear(stations) {
  const counts = {};
  for (const s of stations) {
    if (!s.lowest) continue;
    counts[s.lowest.year] = (counts[s.lowest.year] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([year, count]) => ({ year: Number(year), count }))
    .sort((a, b) => b.count - a.count || a.year - b.year);
}

/**
 * The same comparison for one gauge, month by month through the year.
 *
 * Answers "was the whole year worse, or only the summer" - which is the first thing
 * anyone asks after seeing a single month, and the difference between a dry August and
 * a dry year.
 */
function stationAcrossMonths(id, { reference = REFERENCE_YEAR, document } = {}) {
  const yearly = document !== undefined ? document : loadYearly();
  const byYear = yearly && yearly[id];
  if (!byYear) return null;

  const station = getStation(id);
  const months = [];
  for (let m = 0; m < 12; m += 1) {
    const values = monthSeries(byYear, m);
    const ref = values[String(reference)];
    const present = Object.entries(values)
      .filter(([, v]) => Number.isFinite(v))
      .map(([year, v]) => ({ year: Number(year), value: v }));
    const latest = present.reduce((a, b) => (a === null || b.year > a.year ? b : a), null);
    months.push({
      month: m,
      monthHu: MONTHS_HU[m],
      monthAdjHu: MONTHS_ADJ_HU[m],
      reference: Number.isFinite(ref) ? round(ref, 2) : null,
      latest: latest ? { year: latest.year, value: round(latest.value, 2) } : null,
      belowReference: Number.isFinite(ref) && latest ? latest.value < ref : null,
    });
  }

  return {
    available: true,
    id,
    name: station ? station.name : id,
    river: station ? station.river : null,
    reference,
    months,
    monthsBelow: months.filter((x) => x.belowReference === true).length,
    monthsComparable: months.filter((x) => x.belowReference !== null).length,
  };
}

/* --- the running month, compared like for like ---------------------------- */

/**
 * The same window of days, in every year.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MONTHLY TABLE CANNOT ANSWER THIS
 * ---------------------------------------------------------------------------
 * On the 17th of August the monthly table has nothing to say about this year, and it is
 * right not to: seventeen days is not August, and publishing it as August would be the
 * exact error the 20-day guard in the bake exists to prevent.
 *
 * But "is it worse than 2022 right now" is a different question, and it has an honest
 * answer: compare the 1st to the 17th of August against the 1st to the 17th of August in
 * every other year. Equal windows, same calendar days, no partial month presented as a
 * whole one. That needs day resolution, which is why the bake now keeps a third document.
 *
 * ---------------------------------------------------------------------------
 * THE SAME STATISTIC AS THE TABLE ABOVE
 * ---------------------------------------------------------------------------
 * The median of the window's daily means, not the mean of them - because the monthly
 * table is medians, and a section where one row is a median and the next is a mean
 * invites exactly the comparison that is not valid. One statistic throughout.
 *
 * ---------------------------------------------------------------------------
 * A YEAR WITH A GAP IN THE WINDOW DOES NOT COMPETE
 * ---------------------------------------------------------------------------
 * If 2019 reported four of the seventeen days, its median is the median of four days and
 * comparing it to seventeen is not like for like. Such a year comes back null with its
 * day count attached, rather than silently contributing a number built from a quarter of
 * the evidence.
 */
const MIN_WINDOW_COVERAGE = 0.8;

function compareWindow({ month, throughDay, reference = REFERENCE_YEAR, document } = {}) {
  const daily = document !== undefined ? document : loadDaily();
  if (!daily || !Object.keys(daily).length) {
    return {
      available: false,
      reason: 'A napi felbontású archívum nincs betöltve.',
    };
  }

  const now = new Date();
  const m = Number.isInteger(month) ? month : now.getUTCMonth();
  // Through yesterday by default: today is usually partial at whatever hour this runs,
  // and a half-day would drag the window's last value down for this year alone.
  const through = Number.isInteger(throughDay) ? throughDay : now.getUTCDate() - 1;
  if (through < 1) {
    return { available: false, reason: 'A hónapból még nincs teljes nap.' };
  }

  const keys = [];
  for (let d = 1; d <= through; d += 1) {
    keys.push(`${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  const needed = Math.ceil(keys.length * MIN_WINDOW_COVERAGE);

  const stations = [];
  const yearSet = new Set();

  for (const [id, byYear] of Object.entries(daily)) {
    const station = getStation(id);
    const values = {};
    const daysCounted = {};

    for (const [year, days] of Object.entries(byYear)) {
      const present = keys.map((k) => days[k]).filter((v) => Number.isFinite(v));
      daysCounted[year] = present.length;
      if (present.length < needed) { values[year] = null; continue; }
      const sorted = present.slice().sort((a, b) => a - b);
      values[year] = round(median(sorted), 2);
      yearSet.add(Number(year));
    }

    const referenceValue = values[String(reference)];
    const present = Object.entries(values)
      .filter(([, v]) => Number.isFinite(v))
      .map(([year, v]) => ({ year: Number(year), value: v }));
    const thisYear = present.find((p) => p.year === now.getUTCFullYear()) || null;

    stations.push({
      id,
      name: station ? station.name : id,
      river: station ? station.river : null,
      values,
      daysCounted,
      referenceValue: Number.isFinite(referenceValue) ? referenceValue : null,
      comparable: Number.isFinite(referenceValue) && referenceValue > 0 && !!thisYear,
      thisYear,
      lowest: present.length
        ? present.reduce((a, b) => (b.value < a.value ? b : a))
        : null,
      vsReference: thisYear && Number.isFinite(referenceValue) && referenceValue > 0
        ? round(thisYear.value / referenceValue, 3)
        : null,
    });
  }

  stations.sort((a, b) => {
    const av = a.vsReference, bv = b.vsReference;
    if (av === null && bv === null) return a.name.localeCompare(b.name, 'hu');
    if (av === null) return 1;
    if (bv === null) return -1;
    return av - bv;
  });

  const comparable = stations.filter((s) => s.comparable);
  const below = comparable.filter((s) => s.thisYear.value < s.referenceValue);

  return {
    available: true,
    month: m,
    monthHu: MONTHS_HU[m],
    monthAdjHu: MONTHS_ADJ_HU[m],
    year: now.getUTCFullYear(),
    throughDay: through,
    windowDays: keys.length,
    reference,
    years: [...yearSet].sort((a, b) => a - b),
    stations,
    summary: {
      stations: stations.length,
      comparable: comparable.length,
      belowReference: below.length,
      belowReferenceIds: below.map((s) => s.id),
      lowestByYear: countLowestByYear(comparable),
    },
    basis: 'aligned-window',
    basisNote: `${MONTHS_HU[m]} 1–${through}., ugyanaz a napszakasz minden évben. `
      + 'A napi vízhozamok mediánja az ablakon belül — nem a teljes hónap, és nem átlag.',
  };
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The payload for the endpoint and the section. */
function buildDroughtYears({ month, reference, station, document, daily } = {}) {
  const body = compareYears({ month, reference, document });
  if (!body.available) return body;
  if (station) {
    const detail = stationAcrossMonths(station, { reference, document });
    if (detail) body.station = detail;
  }

  // The running month, as an equal window across years. Attached under its own key with
  // its own `basis`, never merged into the year columns above: those are whole months
  // and this is seventeen days, and a consumer that could not tell them apart would put
  // a partial figure in the August column.
  const window = compareWindow({ month, reference, document: daily });
  body.running = window.available ? window : { available: false, reason: window.reason };
  return body;
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

module.exports = {
  buildDroughtYears, compareYears, compareWindow, stationAcrossMonths, monthSeries,
  REFERENCE_YEAR, MONTHS_HU, MONTHS_ADJ_HU, MIN_WINDOW_COVERAGE,
};
