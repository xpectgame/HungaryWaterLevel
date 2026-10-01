'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  compareYears, compareWindow, stationAcrossMonths, monthSeries, buildDroughtYears,
  archiveLastDay,
} = require('../src/domain/drought-years');

/* Two gauges, four years, August in index 7. Small enough to reason about by hand. */
const AUG = 7;
const FIXTURE = {
  'duna-budapest': {
    2021: month(AUG, 2562),
    2022: month(AUG, 1249),
    2024: month(AUG, 1729),
    2025: month(AUG, 1629),
  },
  'feher-koros-gyula': {
    2021: month(AUG, 1.6),
    2022: month(AUG, 0.85),
    2024: month(AUG, 0.47),
    2025: month(AUG, 0.09),
  },
};

function month(index, value) {
  const series = new Array(12).fill(null);
  series[index] = value;
  return series;
}

test('a month with no record is null, never a zero', () => {
  // A gap in the archive plotted as zero is a river that stopped, which is a different
  // and much more alarming claim than "we do not have that month".
  const s = monthSeries({ 2022: month(AUG, 5) }, 0);
  assert.equal(s['2022'], null);
});

test('the comparison counts gauges rather than averaging them', () => {
  const b = compareYears({ month: AUG, document: FIXTURE });
  assert.equal(b.available, true);
  assert.equal(b.summary.comparable, 2);
  // One of the two: the Fehér-Körös ran lower in 2025 than in 2022 (0.09 against 0.85),
  // the Danube ran higher (1 629 against 1 249). That split is the entire point of the
  // count - the same August was a record on one river and unremarkable on the other.
  assert.equal(b.summary.belowReference, 1);
  assert.deepEqual(b.summary.belowReferenceIds, ['feher-koros-gyula']);
  // And there is no national mean anywhere in the payload: 1 629 m3/s and 0.09 m3/s
  // cannot be averaged into anything a reader should see.
  assert.equal('nationalMean' in b.summary, false);
  assert.equal('total' in b.summary, false);
});

test('the payload names its basis, so nobody plots a live reading on this axis', () => {
  const b = compareYears({ month: AUG, document: FIXTURE });
  // MEDIAN, not mean. The bake writes percentileOf(daily, 50); this module called it a
  // mean in four places, which came out in Hungarian as "középvízhozam" - a defined
  // hydrological term (KÖQ) meaning precisely the arithmetic mean. That is not loose
  // wording, it is a wrong statement about which statistic the reader is looking at.
  assert.equal(b.basis, 'monthly-median');
  assert.match(b.basisNote, /mediánja/);
  assert.match(b.basisNote, /Nem átlag/);
  assert.match(b.basisNote, /Nem .*a mai pillanatnyi/);
});

test('the worst-hit gauge sorts first', () => {
  const b = compareYears({ month: AUG, document: FIXTURE });
  assert.equal(b.stations[0].id, 'feher-koros-gyula');
  // 0.09 / 0.85
  assert.ok(Math.abs(b.stations[0].latestVsReference - 0.106) < 0.002);
});

test('every year that beat the reference downward is listed, not only the latest', () => {
  // Otherwise a reader cannot tell whether the reference year was ever the worst on this
  // gauge at all - which on the Fehér-Körös it was not.
  const b = compareYears({ month: AUG, document: FIXTURE });
  const koros = b.stations.find((s) => s.id === 'feher-koros-gyula');
  assert.deepEqual(koros.worseYears, [2024, 2025]);
  assert.deepEqual(koros.lowest, { year: 2025, value: 0.09 });
});

test('a gauge with no reference-year figure is carried as not comparable, not dropped', () => {
  const doc = { 'x-gauge': { 2021: month(AUG, 10), 2025: month(AUG, 8) } };
  const b = compareYears({ month: AUG, document: doc });
  assert.equal(b.stations.length, 1);
  assert.equal(b.stations[0].comparable, false);
  assert.equal(b.summary.comparable, 0);
  assert.equal(b.summary.stations, 1, 'the table still says how many gauges there are');
});

test('the lowest-year tally is a count of gauges, ordered by how many', () => {
  const b = compareYears({ month: AUG, document: FIXTURE });
  // The Danube's lowest August in this fixture is 2022, the Fehér-Körös's is 2025 - one
  // gauge each. This is what "which was the worst year" has to mean when there is no
  // national total to rank: a tally, and a tie is a tie.
  assert.deepEqual(b.summary.lowestByYear, [{ year: 2022, count: 1 }, { year: 2025, count: 1 }]);

  // Weight one gauge more heavily and it takes the top spot on count, not on volume.
  const doc = { ...FIXTURE, 'extra-gauge': { 2022: month(AUG, 9), 2025: month(AUG, 1) } };
  const b2 = compareYears({ month: AUG, document: doc });
  assert.deepEqual(b2.summary.lowestByYear[0], { year: 2025, count: 2 });
});

test('an unloaded archive says so instead of returning an empty comparison', () => {
  const b = compareYears({ month: AUG, document: {} });
  assert.equal(b.available, false);
  assert.ok(b.reason);
});

test('one gauge can be walked across all twelve months', () => {
  const doc = {
    'duna-budapest': {
      2022: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      2025: [9, 9, 9, 9, 9, 9, 9, 1, 9, 9, 9, 9],
    },
  };
  const s = stationAcrossMonths('duna-budapest', { document: doc });
  assert.equal(s.months.length, 12);
  assert.equal(s.monthsComparable, 12);
  // 2025 is flat at 9 while 2022 climbs 1..12, so 2025 runs below it from October on,
  // plus the August spike down to 1. Four months, not one - the point of walking the
  // whole year is that "a dry August" and "a dry year" are different findings.
  assert.equal(s.monthsBelow, 4);
  assert.equal(s.months[7].belowReference, true, 'August: 1 against 8');
  assert.equal(s.months[0].belowReference, false, 'January: 9 against 1');
  assert.equal(s.months[8].belowReference, false, 'September: 9 against 9 is not below');
  assert.equal(s.months[11].belowReference, true, 'December: 9 against 12');
});

test('an unknown gauge is null rather than an empty year', () => {
  assert.equal(stationAcrossMonths('nincs-ilyen', { document: FIXTURE }), null);
});

/* --- against the real archive --------------------------------------------- */

test('the real archive reproduces the finding this section exists for', () => {
  // 2022 is the drought everyone remembers. On a real fraction of the gauges, the last
  // complete August already ran lower than it did. If this stops being true after a
  // re-bake the section needs rewriting, and this test is how that gets noticed.
  const b = compareYears({ month: AUG });
  assert.equal(b.available, true);
  assert.ok(b.summary.comparable >= 20, `only ${b.summary.comparable} comparable gauges`);
  assert.ok(b.summary.belowReference > 0,
    'no gauge ran below 2022 - the premise of the section has changed');
  assert.ok(b.years.includes(2022), 'the reference year must be in the archive');
});

test('the real archive still puts 2022 among the worst years on the most gauges', () => {
  const b = compareYears({ month: AUG });
  const top = b.summary.lowestByYear[0];
  assert.ok(top.count > 1, 'a single gauge does not make a worst year');
  assert.ok(b.summary.lowestByYear.some((x) => x.year === 2022),
    '2022 should hold the August record on at least one gauge');
});

test('the endpoint payload can carry one gauge in detail alongside the table', () => {
  const b = buildDroughtYears({ month: AUG, station: 'tisza-szolnok' });
  assert.ok(b.station, 'no per-gauge detail');
  assert.equal(b.station.id, 'tisza-szolnok');
  assert.equal(b.station.months.length, 12);
});

/* --- the running month, as an equal window -------------------------------- */

/** August days 1..n for one year, all at the same discharge. */
function augDays(n, value) {
  const days = {};
  for (let d = 1; d <= n; d += 1) days[`08-${String(d).padStart(2, '0')}`] = value;
  return days;
}

const THIS_YEAR = new Date().getUTCFullYear();

/**
 * A pinned clock, midday UTC on the given day of THIS_YEAR.
 *
 * The window and the missing-column reason both depend on what day it is, and these
 * tests used to read the real clock - so one of them failed on the 1st of every month,
 * and others encoded "August is not over yet", which was only true in August.
 */
const ON = (monthIndex, day) => new Date(Date.UTC(THIS_YEAR, monthIndex, day, 12));
const AUG_18 = ON(AUG, 18);

/** Days 1..n of a month (0-11) for one year, all at the same discharge. */
function monthDays(monthIndex, n, value) {
  const mm = String(monthIndex + 1).padStart(2, '0');
  const days = {};
  for (let d = 1; d <= n; d += 1) days[`${mm}-${String(d).padStart(2, '0')}`] = value;
  return days;
}

test('the running month is compared against the SAME days of other years', () => {
  // Seventeen days is not August, and the monthly table is right to say nothing about
  // it. Seventeen days against seventeen days is a different and answerable question.
  const daily = {
    'tisza-szolnok': {
      2022: augDays(31, 100),
      [THIS_YEAR]: augDays(17, 60),
    },
  };
  const w = compareWindow({ month: 7, throughDay: 17, document: daily, now: AUG_18 });
  assert.equal(w.available, true);
  assert.equal(w.windowDays, 17);
  assert.equal(w.throughDay, 17);
  const s = w.stations[0];
  // 2022's median is taken over the SAME seventeen days, not over its whole August.
  assert.equal(s.referenceValue, 100);
  assert.equal(s.thisYear.value, 60);
  assert.equal(s.vsReference, 0.6);
  assert.equal(w.summary.belowReference, 1);
});

test('a year missing most of the window does not compete', () => {
  // A median over four days compared against one over seventeen is not like for like,
  // and the failure would be invisible: a plausible number from a quarter of the data.
  const daily = {
    'tisza-szolnok': {
      2019: augDays(4, 5),
      2022: augDays(17, 100),
      [THIS_YEAR]: augDays(17, 60),
    },
  };
  const w = compareWindow({ month: 7, throughDay: 17, document: daily, now: AUG_18 });
  const s = w.stations[0];
  assert.equal(s.values['2019'], null, 'four days must not produce a value');
  assert.equal(s.daysCounted['2019'], 4, 'but the count is still reported');
  assert.ok(!w.years.includes(2019));
});

test('the window carries its own basis, distinct from the monthly table', () => {
  const daily = { 'tisza-szolnok': { 2022: augDays(17, 100), [THIS_YEAR]: augDays(17, 60) } };
  const w = compareWindow({ month: 7, throughDay: 17, document: daily, now: AUG_18 });
  assert.equal(w.basis, 'aligned-window');
  assert.match(w.basisNote, /augusztus 1–17/);
  assert.match(w.basisNote, /nem a teljes hónap/);
  assert.match(w.basisNote, /nem átlag/);
});

test('the window is a median, the same statistic as the table above', () => {
  // One row a median and the next a mean would invite exactly the comparison between
  // them that is not valid.
  const days = { '08-01': 1, '08-02': 2, '08-03': 3, '08-04': 4, '08-05': 100 };
  const daily = { 'tisza-szolnok': { 2022: days, [THIS_YEAR]: days } };
  const w = compareWindow({ month: 7, throughDay: 5, document: daily, now: AUG_18 });
  assert.equal(w.stations[0].referenceValue, 3, 'median of 1,2,3,4,100 is 3 - a mean would be 22');
});

test('with no daily archive it says so rather than returning an empty comparison', () => {
  const w = compareWindow({ month: 7, throughDay: 17, document: {}, now: AUG_18 });
  assert.equal(w.available, false);
  assert.match(w.reason, /napi felbontású/);
});

test('the first of the month has no complete day yet, and says so', () => {
  const daily = { 'tisza-szolnok': { 2022: augDays(31, 100) } };
  const w = compareWindow({ month: 7, throughDay: 0, document: daily, now: AUG_18 });
  assert.equal(w.available, false);
});

test('the payload attaches the window under its own key, never in the year columns', () => {
  // A consumer that could not tell them apart would put seventeen days in the August
  // column beside whole months.
  const daily = { 'tisza-szolnok': { 2022: augDays(17, 100), [THIS_YEAR]: augDays(17, 60) } };
  // Pinned to the 18th: on the real clock this test failed on the 1st of every month.
  const b = buildDroughtYears({ month: AUG, document: FIXTURE, daily, now: AUG_18 });
  assert.ok(b.running, 'no running-month block');
  assert.equal(b.running.basis, 'aligned-window');
  assert.equal(b.basis, 'monthly-median');
  // And the year columns still contain only whole months.
  const koros = b.stations.find((s) => s.id === 'feher-koros-gyula');
  assert.ok(!(String(THIS_YEAR) in koros.values) || koros.values[String(THIS_YEAR)] === undefined);
});

test('a ratio is withheld where either side sits on the archive resolution floor', () => {
  // The daily archive is stored to one decimal, so 0 means "below 0.05", not "nothing".
  // The Fehér-Körös reads 0 for weeks every August, in 2022 and 2025 as well as now.
  // 0.35 against 0 came out as "0% of 2022" and sorted that gauge FIRST - the worst-hit
  // river in the country, on two numbers that both mean "almost no water".
  const daily = {
    'feher-koros-gyula': {
      2022: augDays(17, 0.35),
      [THIS_YEAR]: augDays(17, 0),
    },
    'duna-budapest': {
      2022: augDays(17, 1000),
      [THIS_YEAR]: augDays(17, 700),
    },
  };
  const w = compareWindow({ month: 7, throughDay: 17, document: daily, now: AUG_18 });
  const koros = w.stations.find((s) => s.id === 'feher-koros-gyula');
  const duna = w.stations.find((s) => s.id === 'duna-budapest');

  assert.equal(koros.atFloor, true);
  assert.equal(koros.vsReference, null, 'no percentage across the floor');
  // The comparison itself survives: 0.35 to below 0.05 really is drier.
  assert.ok(w.summary.belowReferenceIds.includes('feher-koros-gyula'));

  assert.equal(duna.atFloor, false);
  assert.equal(duna.vsReference, 0.7);
  // And the gauge with the unusable ratio sorts last, not first.
  assert.equal(w.stations[w.stations.length - 1].id, 'feher-koros-gyula');
});

test('a drop entirely inside the floor is not counted as a drop', () => {
  const daily = {
    'tiny-gauge': { 2022: augDays(17, 0.05), [THIS_YEAR]: augDays(17, 0) },
  };
  const w = compareWindow({ month: 7, throughDay: 17, document: daily, now: AUG_18 });
  assert.equal(w.summary.belowReference, 0, '0.05 to 0 is noise, not a finding');
});

test('the archive range is reported separately from this month column list', () => {
  // In August 2026 the August columns stop at 2025, correctly - August 2026 is not a
  // finished month. Printing that column list as the archive's range said "2016-2025"
  // in the middle of 2026, which reads as an archive nobody has updated in a year.
  const doc = {
    'duna-budapest': {
      2022: month(AUG, 1249),
      2025: month(AUG, 1629),
      // The current year exists, with months up to July but not August.
      [THIS_YEAR]: [10, 10, 10, 10, 10, 10, 10, null, null, null, null, null],
    },
  };
  // On the 18th of August, when August genuinely is not over.
  const b = compareYears({ month: AUG, document: doc, now: AUG_18 });
  assert.deepEqual(b.years, [2022, 2025], 'no August column for the running year');
  assert.ok(b.archiveYears.includes(THIS_YEAR), 'but the archive does reach it');
  assert.equal(b.currentYearInArchive, true);
  assert.equal(b.currentYearMonthsComplete, 7);
  // And the reason is a field, not something the page has to reconstruct.
  assert.equal(b.currentYearMissingReason, 'month-not-complete');
});

test('a year genuinely absent from the archive is distinguished from an unfinished month', () => {
  // Two very different situations that look identical in the table: "the bake has not
  // run" and "the month is not over". Only one of them is anybody's fault.
  const doc = { 'duna-budapest': { 2022: month(AUG, 1249), 2025: month(AUG, 1629) } };
  const b = compareYears({ month: AUG, document: doc, now: AUG_18 });
  assert.equal(b.currentYearInArchive, false);
  assert.equal(b.currentYearMissingReason, 'year-not-baked');
});

test('a month that is over but missing from the archive is the archive lagging, not the month', () => {
  // The September 2026 bug: the archive was baked on 17 August and never again, and the
  // page went on telling readers August "had not ended yet" well into October.
  const doc = {
    'duna-budapest': {
      2022: month(AUG, 1249),
      2025: month(AUG, 1629),
      [THIS_YEAR]: [10, 10, 10, 10, 10, 10, 10, null, null, null, null, null],
    },
  };
  const b = compareYears({ month: AUG, document: doc, now: ON(9, 1) });
  assert.equal(b.currentYearMissingReason, 'archive-behind');
});

/* --- the window follows the data, not the calendar --------------------------- */

test('a month that is over is compared in full, whatever day it is today', () => {
  // The window used to end at "yesterday's day-of-month" for ANY month: in mid-October
  // the August window was 1-14 August, and on the 1st of a month it was empty.
  const daily = {
    'tisza-szolnok': { 2022: monthDays(AUG, 31, 100), [THIS_YEAR]: monthDays(AUG, 31, 60) },
  };
  const w = compareWindow({ month: AUG, document: daily, now: ON(9, 1) });
  assert.equal(w.available, true);
  assert.equal(w.throughDay, 31);
  assert.equal(w.windowDays, 31);
  assert.equal(w.lagDays, 0);
});

test('the window stops at the last day the archive holds, and says how far behind it is', () => {
  // 20 October, archive through the 15th: compare 1-15 October in every year, rather
  // than 1-19 with this year missing four days and failing coverage on every gauge.
  const OCT = 9;
  const daily = {
    'tisza-szolnok': { 2022: monthDays(OCT, 31, 100), [THIS_YEAR]: monthDays(OCT, 15, 60) },
  };
  const w = compareWindow({ month: OCT, document: daily, now: ON(OCT, 20) });
  assert.equal(w.available, true);
  assert.equal(w.throughDay, 15);
  assert.equal(w.calendarThroughDay, 19);
  assert.equal(w.lagDays, 4);
  assert.equal(w.summary.comparable, 1);
});

test('an archive that has not reached the month says so and names its last day', () => {
  // Exactly the state of the live site in September 2026: archive ends 17 August, the
  // running month is September. It used to come back available with "0 of 0".
  const SEP = 8;
  const daily = {
    'tisza-szolnok': { 2022: monthDays(SEP, 30, 100), [THIS_YEAR]: monthDays(AUG, 17, 60) },
  };
  const w = compareWindow({ month: SEP, document: daily, now: ON(SEP, 14) });
  assert.equal(w.available, false);
  assert.match(w.reason, new RegExp(`${THIS_YEAR}\\. szeptemberig`));
  assert.match(w.reason, new RegExp(`${THIS_YEAR}-08-17`));
});

test('a window with nothing comparable is unavailable, never "0 of 0"', () => {
  // This year has the days but the reference year does not: no gauge can be compared.
  const daily = { 'tisza-szolnok': { 2021: augDays(17, 100), [THIS_YEAR]: augDays(17, 60) } };
  const w = compareWindow({ month: AUG, throughDay: 17, document: daily, now: AUG_18 });
  assert.equal(w.available, false);
  assert.match(w.reason, /nincs olyan mérce/);
});

test("the archive's last day ignores the previous New Year's Eve filed under this year", () => {
  // The upstream reads the request window in local time, so every year's bucket opens
  // with a "12-31" that is really the previous year's. Taken at face value it dated the
  // archive to the end of THIS year.
  const daily = { 'tisza-szolnok': { [THIS_YEAR]: { '12-31': 5, '08-16': 3, '08-17': 3 } } };
  assert.equal(archiveLastDay(daily, ON(9, 1)), `${THIS_YEAR}-08-17`);
});

test("early in a month, this year's latest complete month is surfaced beside it", () => {
  // 1 October: October is a day old, so the table's figures are about last year. September
  // of THIS year is complete, and it is the finding - it must not be invisible.
  const SEP = 8;
  const sep = (v) => month(SEP, v);
  const doc = {
    'duna-budapest': { 2022: sep(1000), [THIS_YEAR]: sep(700) },   // below 2022
    'tisza-szolnok': { 2022: sep(100), [THIS_YEAR]: sep(150) },     // not below
    'feher-koros-gyula': { 2022: sep(0.8), 2025: sep(0.5) },        // no September this year
  };
  const b = buildDroughtYears({ document: doc, daily: {}, now: ON(9, 1) });
  assert.equal(b.month, 9, 'the default is still the running month');
  assert.ok(b.lastComplete, 'September of this year is surfaced');
  assert.equal(b.lastComplete.month, SEP);
  assert.equal(b.lastComplete.year, THIS_YEAR);
  assert.equal(b.lastComplete.belowReference, 1);
  // The gauge with no September this year is left out of the denominator, not counted as
  // "not below" - it was not measured, it was not wetter.
  assert.equal(b.lastComplete.comparable, 2);
  assert.deepEqual(b.lastComplete.belowReferenceIds, ['duna-budapest']);
});

test('no extra card when the month asked for already has this year in it', () => {
  const doc = { 'duna-budapest': { 2022: month(0, 100), [THIS_YEAR]: month(0, 40) } };
  const b = buildDroughtYears({ month: 0, document: doc, daily: {}, now: ON(5, 15) });
  assert.equal(b.lastComplete, undefined);
});

test('the payload names the archive’s last day for the page', () => {
  const daily = { 'tisza-szolnok': { 2022: augDays(17, 100), [THIS_YEAR]: augDays(17, 60) } };
  const b = buildDroughtYears({ month: AUG, document: FIXTURE, daily, now: AUG_18 });
  assert.equal(b.archiveThrough, `${THIS_YEAR}-08-17`);
});

test('a complete month in the current year does get its column', () => {
  const doc = {
    'duna-budapest': {
      2022: month(0, 100),
      [THIS_YEAR]: month(0, 40),
    },
  };
  const b = compareYears({ month: 0, document: doc });
  assert.ok(b.years.includes(THIS_YEAR), 'January is finished, so it has a column');
  assert.equal(b.currentYearMissingReason, null);
});
