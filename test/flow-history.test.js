'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { rankFlow, percentileWithin, historyCoverage, loadHistory } = require('../src/domain/flow-history');

/**
 * A fabricated station whose August is well described and whose February is not.
 *
 * The numbers are a plausible Tisza-like August: a median around 200, a record low of 96
 * from a drought year, a record high of 900 from a flood. Shaped so every branch has an
 * unambiguous expected answer rather than one that needs the implementation to explain it.
 */
const AUGUST = {
  p: [110, 125, 160, 200, 260, 380, 520],
  min: { value: 96, year: 2022, day: '2022-08-29' },
  max: { value: 900, year: 2019, day: '2019-08-03' },
  days: 300,
  years: 10,
};

function doc(august = AUGUST, february = null) {
  const months = Array.from({ length: 12 }, () => null);
  months[7] = august;
  months[1] = february;
  return { 'tisza-szeged': { months, unit: 'm3s' } };
}

const inAugust = { at: Date.UTC(2026, 7, 15), document: doc() };

// ---------------------------------------------------------------------------
// Where a reading lands
// ---------------------------------------------------------------------------

test('the median reads as the fiftieth percentile', () => {
  const r = rankFlow('tisza-szeged', 200, inAugust);
  assert.strictEqual(r.percentile, 50);
  assert.strictEqual(r.band, 'normal');
});

test('a quantile point reads as its own quantile', () => {
  // Every stored point must map back to itself, or the interpolation is off by a step -
  // which would be invisible in the middle and wrong at exactly the cut that decides
  // whether the page says "unusually low".
  const expected = [[110, 5], [125, 10], [160, 25], [200, 50], [260, 75], [380, 90], [520, 95]];
  for (const [flow, percentile] of expected) {
    assert.strictEqual(rankFlow('tisza-szeged', flow, inAugust).percentile, percentile, `${flow} m3/s`);
  }
});

test('the bands follow the percentile cuts', () => {
  const band = (flow) => rankFlow('tisza-szeged', flow, inAugust).band;
  assert.strictEqual(band(100), 'very-low');   // between the record low and p5
  assert.strictEqual(band(140), 'low');        // p10..p25
  assert.strictEqual(band(220), 'normal');     // p25..p75
  assert.strictEqual(band(300), 'high');       // p75..p95
  assert.strictEqual(band(700), 'very-high');  // above p95, below the record
});

test('a reading below the whole record is its own band, not percentile zero', () => {
  // Ten years is a short record. Reporting "percentile 0" for a reading nobody has seen
  // before implies we know how unusual it is; we know only that it is outside what we
  // have. The phrasing the page can build from this is different, so the code is too.
  const r = rankFlow('tisza-szeged', 80, inAugust);
  assert.strictEqual(r.band, 'record-low');
  assert.strictEqual(r.belowRecord, true);
  assert.strictEqual(r.percentile, 0, 'clamped, never extrapolated below zero');
  assert.deepStrictEqual(r.recordLow, { value: 96, year: 2022, day: '2022-08-29' });
});

test('a reading above the whole record is symmetric', () => {
  const r = rankFlow('tisza-szeged', 1200, inAugust);
  assert.strictEqual(r.band, 'record-high');
  assert.strictEqual(r.aboveRecord, true);
  assert.strictEqual(r.percentile, 100);
  assert.strictEqual(r.recordHigh.year, 2019);
});

test('the record low itself is not reported as below the record', () => {
  const r = rankFlow('tisza-szeged', 96, inAugust);
  assert.strictEqual(r.belowRecord, false, 'equal to the record is not below it');
  assert.strictEqual(r.percentile, 0);
});

// ---------------------------------------------------------------------------
// The comparison is to the right month
// ---------------------------------------------------------------------------

test('the month decides which distribution is used', () => {
  // 200 m3/s is the August median. In February - which this fixture leaves unmeasured -
  // there is nothing to compare against, and the answer must be "no record", not the
  // August answer applied to a February reading.
  assert.strictEqual(rankFlow('tisza-szeged', 200, inAugust).percentile, 50);
  assert.strictEqual(rankFlow('tisza-szeged', 200, { at: Date.UTC(2026, 1, 15), document: doc() }), null);
});

test('a month is used only if the probe published one', () => {
  const thin = { p: [10, 11, 12, 13, 14, 15, 16], min: null, max: null, days: 40, years: 2 };
  const r = rankFlow('tisza-szeged', 13, { at: Date.UTC(2026, 1, 15), document: doc(AUGUST, thin) });
  // The probe already refuses to emit a month under five years, but a consumer must be
  // able to see the count and decide for itself rather than trusting the file's vintage.
  assert.strictEqual(r.years, 2);
});

// ---------------------------------------------------------------------------
// Missing data is a normal state
// ---------------------------------------------------------------------------

test('an unbaked document is absent, not an error', () => {
  // The probe behind this only runs from a GitHub runner, so a fresh checkout has no
  // file at all. Every consumer has to keep working without it.
  assert.strictEqual(rankFlow('tisza-szeged', 200, { document: null }), null);
  assert.strictEqual(rankFlow('nincs-ilyen', 200, inAugust), null);
  assert.strictEqual(rankFlow('tisza-szeged', null, inAugust), null);
  assert.strictEqual(rankFlow('tisza-szeged', NaN, inAugust), null);
});

test('loadHistory returns null rather than throwing when the file is missing', () => {
  // Whatever the checkout has, it must be a document or null - never a throw, because
  // this is called on the request path.
  const loaded = loadHistory({ reload: true });
  assert.ok(loaded === null || typeof loaded === 'object');
});

test('coverage reports the unbaked case as unavailable', () => {
  assert.deepStrictEqual(historyCoverage(null), { stations: 0, monthsComplete: 0, available: false });
  const c = historyCoverage(doc());
  assert.strictEqual(c.available, true);
  assert.strictEqual(c.stations, 1);
  assert.strictEqual(c.withAnyMonth, 1);
  assert.strictEqual(c.monthsComplete, 0, 'one month of twelve is not a complete station');
});

// ---------------------------------------------------------------------------
// Degenerate distributions
// ---------------------------------------------------------------------------

test('a flat section does not divide by zero', () => {
  // A heavily regulated reach can sit at the same discharge for most of a month, and the
  // probe rounds to two decimals - so adjacent quantiles land on the same value.
  // Interpolating across a zero-width step is a division by zero.
  const flat = {
    p: [50, 50, 50, 50, 50, 50, 50],
    min: { value: 50, year: 2020, day: '2020-08-01' },
    max: { value: 50, year: 2021, day: '2021-08-01' },
    days: 300,
    years: 10,
  };
  const r = rankFlow('tisza-szeged', 50, { at: Date.UTC(2026, 7, 15), document: doc(flat) });
  assert.ok(Number.isFinite(r.percentile), `percentile was ${r.percentile}`);
  assert.strictEqual(r.belowRecord, false);
});

test('a partial quantile row still ranks', () => {
  const gappy = { p: [110, null, 160, 200, 260, null, 520], min: null, max: null, days: 200, years: 6 };
  const r = rankFlow('tisza-szeged', 180, { at: Date.UTC(2026, 7, 15), document: doc(gappy) });
  assert.ok(r.percentile > 25 && r.percentile < 50, `expected between p25 and p50, got ${r.percentile}`);
});

test('percentileWithin is monotonic across the whole range', () => {
  // The one property that must hold everywhere: more water is never a lower percentile.
  // A sign slip or a mis-ordered points array would show up here and nowhere else.
  let previous = -1;
  for (let flow = 50; flow <= 1200; flow += 5) {
    const p = percentileWithin(flow, AUGUST);
    assert.ok(p >= previous, `percentile fell from ${previous} to ${p} at ${flow} m3/s`);
    previous = p;
  }
  assert.strictEqual(previous, 100);
});

// ---------------------------------------------------------------------------
// Analogue years - the only forward-looking thing on the site, and not a forecast
// ---------------------------------------------------------------------------

const YEARLY = {
  'tisza-szeged': {
    2018: [null, null, null, null, null, null, null, 287.5, 252.25, null, null, null],
    2019: [null, null, null, null, null, null, null, 297.5, 178.25, null, null, null],
    2022: [null, null, null, null, null, null, null, 140.25, 266.68, null, null, null],
    2025: [null, null, null, null, null, null, null, 131, 149.5, null, null, null],
  },
};

const inAug = { at: Date.UTC(2026, 7, 15), document: YEARLY };

test('only years within tolerance count as comparable', () => {
  // "The closest year on record" is meaningless when the closest is twice the flow, and
  // a reader who hears "the last time it was like this" will not go and check.
  const { findAnalogues } = require('../src/domain/flow-history');
  const r = findAnalogues('tisza-szeged', 135, inAug);
  const years = r.matches.map((m) => m.year).sort();
  assert.deepStrictEqual(years, [2022, 2025], 'only the two low Augusts are within 25% of 135');
});

test('a value unlike every past year returns nothing rather than the least-bad match', () => {
  const { findAnalogues } = require('../src/domain/flow-history');
  assert.strictEqual(findAnalogues('tisza-szeged', 900, inAug), null);
});

test('what happened next is per year, never averaged', () => {
  // 2022 went +90% and 2025 +14%. "+52% on average" would be a number that happened in
  // neither year, and it is exactly the number that would get quoted.
  const { findAnalogues } = require('../src/domain/flow-history');
  const r = findAnalogues('tisza-szeged', 135, inAug);
  assert.strictEqual(r.matches.length, 2);
  for (const m of r.matches) assert.ok(Number.isFinite(m.changePct));
  assert.ok(!('averageChangePct' in r), 'an average would be quoted as though it were a forecast');
});

test('the closest year comes first', () => {
  const { findAnalogues } = require('../src/domain/flow-history');
  const r = findAnalogues('tisza-szeged', 135, inAug);
  assert.strictEqual(r.matches[0].year, 2025, '131 is closer to 135 than 140.25 is');
});

test('December has no next month in the record and is refused', () => {
  // January of the SAME year came eleven months BEFORE December. Reporting it as what
  // happened next would present the past as the future.
  const { findAnalogues } = require('../src/domain/flow-history');
  const dec = { 'x': { 2022: Array.from({ length: 12 }, () => 100) } };
  assert.strictEqual(findAnalogues('x', 100, { at: Date.UTC(2026, 11, 15), document: dec }), null);
  assert.ok(findAnalogues('x', 100, { at: Date.UTC(2026, 10, 15), document: dec }), 'November is fine');
});

test('an unbaked document is absent, not an error', () => {
  const { findAnalogues } = require('../src/domain/flow-history');
  assert.strictEqual(findAnalogues('tisza-szeged', 135, { document: null }), null);
  assert.strictEqual(findAnalogues('nincs-ilyen', 135, inAug), null);
});
