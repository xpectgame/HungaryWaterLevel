'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  compareYears, compareWindow, stationAcrossMonths, monthSeries, buildDroughtYears,
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

test('the running month is compared against the SAME days of other years', () => {
  // Seventeen days is not August, and the monthly table is right to say nothing about
  // it. Seventeen days against seventeen days is a different and answerable question.
  const daily = {
    'tisza-szolnok': {
      2022: augDays(31, 100),
      [THIS_YEAR]: augDays(17, 60),
    },
  };
  const w = compareWindow({ month: 7, throughDay: 17, document: daily });
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
  const w = compareWindow({ month: 7, throughDay: 17, document: daily });
  const s = w.stations[0];
  assert.equal(s.values['2019'], null, 'four days must not produce a value');
  assert.equal(s.daysCounted['2019'], 4, 'but the count is still reported');
  assert.ok(!w.years.includes(2019));
});

test('the window carries its own basis, distinct from the monthly table', () => {
  const daily = { 'tisza-szolnok': { 2022: augDays(17, 100), [THIS_YEAR]: augDays(17, 60) } };
  const w = compareWindow({ month: 7, throughDay: 17, document: daily });
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
  const w = compareWindow({ month: 7, throughDay: 5, document: daily });
  assert.equal(w.stations[0].referenceValue, 3, 'median of 1,2,3,4,100 is 3 - a mean would be 22');
});

test('with no daily archive it says so rather than returning an empty comparison', () => {
  const w = compareWindow({ month: 7, throughDay: 17, document: {} });
  assert.equal(w.available, false);
  assert.match(w.reason, /napi felbontású/);
});

test('the first of the month has no complete day yet, and says so', () => {
  const daily = { 'tisza-szolnok': { 2022: augDays(31, 100) } };
  const w = compareWindow({ month: 7, throughDay: 0, document: daily });
  assert.equal(w.available, false);
});

test('the payload attaches the window under its own key, never in the year columns', () => {
  // A consumer that could not tell them apart would put seventeen days in the August
  // column beside whole months.
  const daily = { 'tisza-szolnok': { 2022: augDays(17, 100), [THIS_YEAR]: augDays(17, 60) } };
  const b = buildDroughtYears({ month: AUG, document: FIXTURE, daily });
  assert.ok(b.running, 'no running-month block');
  assert.equal(b.running.basis, 'aligned-window');
  assert.equal(b.basis, 'monthly-median');
  // And the year columns still contain only whole months.
  const koros = b.stations.find((s) => s.id === 'feher-koros-gyula');
  assert.ok(!(String(THIS_YEAR) in koros.values) || koros.values[String(THIS_YEAR)] === undefined);
});
