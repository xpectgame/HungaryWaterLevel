'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { outlookFor, seasonalPath } = require('../src/domain/outlook');

/**
 * A lake with a clean seasonal shape: full in spring, lowest in October, refilling
 * through the winter. Percentiles are [5 10 25 50 75 90 95].
 */
function month(median, spread = 20) {
  const p = [median - spread, median - spread * 0.75, median - spread * 0.5, median,
    median + spread * 0.5, median + spread * 0.75, median + spread];
  return { p, min: { value: p[0] - 5, year: 2022 }, max: { value: p[6] + 5, year: 2016 }, days: 300, years: 10 };
}

const MEDIANS = [110, 120, 120, 119, 118, 118, 107, 100, 91, 90, 97, 105];
const LAKE = { months: MEDIANS.map((m) => month(m)), unit: 'cm' };
const history = { 'to': LAKE };

const AUG = 7;
const inAugust = { at: Date.UTC(2026, AUG, 14) };

// ---------------------------------------------------------------------------
// The seasonal path
// ---------------------------------------------------------------------------

test('the path wraps past December into the following spring', () => {
  // A drought question asked in August is answered in February. A path that stopped at
  // the end of the calendar year would stop exactly before the part being asked about.
  const p = seasonalPath(LAKE.months, AUG);
  assert.strictEqual(p.path.length, 12);
  assert.deepStrictEqual(p.path.map((s) => s.month), [9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test('the seasonal low and the turn are both reported', () => {
  const p = seasonalPath(LAKE.months, AUG);
  assert.strictEqual(p.lowestAhead.month, 10, 'October is the lowest median ahead');
  assert.strictEqual(p.risesFrom.month, 11, 'November is the first month that rises and keeps rising');
});

test('a one-month blip is not the turn of the season', () => {
  // Told "it starts rising in October" because of one wet October, a reader has been
  // misled about the only thing they asked.
  const blip = [100, 100, 100, 100, 100, 100, 100, 100, 95, 120, 90, 95].map((m) => month(m));
  const p = seasonalPath(blip, AUG);
  assert.notStrictEqual(p.risesFrom && p.risesFrom.month, 10, 'the lone high October is not a turn');
});

test('a month missing from the record leaves a hole rather than a guess', () => {
  const gappy = LAKE.months.slice();
  gappy[9] = null;
  const p = seasonalPath(gappy, AUG);
  assert.strictEqual(p.path.find((s) => s.month === 10).median, null);
});

// ---------------------------------------------------------------------------
// Analogue years
// ---------------------------------------------------------------------------

const YEARLY = {
  'to': {
    // August is index 7. 2022 starts low and climbs back; 2021 starts low and keeps
    // sinking; 2019 is an ordinary year.
    2019: [110, 120, 120, 119, 118, 118, 107, 100, 91, 90, 97, 105],
    2021: [100, 102, 102, 104, 104, 102, 89, 75, 70, 66, 64, 62],
    2022: [60, 62, 70, 80, 90, 95, 90, 76, 74, 78, 88, 96],
    2023: [100, 105, 112, 118, 120, 121, 115, 105, 100, 98, 104, 112],
  },
};

const opts = { ...inAugust, history, yearly: YEARLY };

test('a year that fell further is not reported as having recovered', () => {
  // The regression this was written for. The normal band is the p25 of a record that
  // CONTAINS the drought years, so in a run of dry summers the bar sinks toward the
  // crisis it is meant to measure - and a level still falling can cross it from above.
  // Recovery has to mean the water came back, not that the yardstick came down.
  const o = outlookFor('lake', 'to', 76, opts);
  const y2021 = o.analogues.years.find((y) => y.year === 2021);
  assert.ok(y2021, '2021 started at 75, within tolerance of 76');
  assert.strictEqual(y2021.recovered, null, '2021 sank from 75 to 62 and never came back');
});

test('a genuine refill is found, with the month it happened in', () => {
  const o = outlookFor('lake', 'to', 76, opts);
  const y2022 = o.analogues.years.find((y) => y.year === 2022);
  assert.ok(y2022.recovered, '2022 climbed from 76 back to 96 by December');
  assert.ok(y2022.recovered.value >= y2022.valueThen, 'the level is above where it started');
  assert.ok(y2022.recovered.value >= y2022.recovered.normalBar, 'and inside the normal band');
});

test('the path chains into the following year', () => {
  const o = outlookFor('lake', 'to', 76, opts);
  const y2022 = o.analogues.years.find((y) => y.year === 2022);
  const january = y2022.steps.find((s) => s.month === 1);
  assert.strictEqual(january.year, 2023, 'January after an August belongs to the next year');
  assert.strictEqual(january.value, 100, 'and takes its value from that year');
});

test('a path that runs off the end of the record is unknown, not a failure to recover', () => {
  // The most recent analogue is usually last year, whose path stops in December because
  // this year has not been baked. Collapsing that into "never recovered" would turn
  // missing data into a pessimistic claim.
  const short = { 'to': { 2025: [90, 92, 95, 98, 100, 99, 88, 76, 72, 70, 71, 74] } };
  const o = outlookFor('lake', 'to', 76, { ...inAugust, history, yearly: short });
  const y = o.analogues.years[0];
  assert.strictEqual(y.recovered, null);
  assert.strictEqual(y.truncated, true);
  assert.strictEqual(o.analogues.recovery.unknown, 1);
  assert.strictEqual(o.analogues.recovery.never, 0);
});

test('a year already in the normal band claims no recovery', () => {
  // True, meaningless, and read by every reader as a recovery time.
  const o = outlookFor('lake', 'to', 105, opts);
  for (const y of o.analogues.years.filter((x) => !x.startedBelow)) {
    assert.strictEqual(y.recovered, null, `${y.year} had nothing to recover from`);
  }
});

test('how long it took is a spread, never an average', () => {
  const o = outlookFor('lake', 'to', 76, opts);
  const r = o.analogues.recovery;
  assert.ok(Array.isArray(r.months));
  assert.ok(!('mean' in r) && !('average' in r) && !('typical' in r),
    'an average of two recovery times is a number that happened in neither year');
  assert.strictEqual(r.earliest, r.months[0]);
  assert.strictEqual(r.latest, r.months[r.months.length - 1]);
});

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

test('a lake tolerance is centimetres, not a percentage of the reading', () => {
  // A lake level is measured against an arbitrary gauge datum - the Balaton's zero is a
  // mark on a wall at Siofok, not an empty lake. A percentage of it means nothing, and
  // near zero it would either admit everything or nothing.
  const o = outlookFor('lake', 'to', 76, opts);
  assert.strictEqual(o.analogues.toleranceKind, 'absolute');
  const near = outlookFor('lake', 'to', 4, { ...opts, history: { to: { months: MEDIANS.map(() => month(5, 20)) } } });
  assert.ok(near.analogues.tolerance >= 8, 'a level near zero still gets a usable window');
});

test('a river tolerance scales with the flow', () => {
  const yearly = { r: { 2022: Array.from({ length: 12 }, () => 100) } };
  const hist = { r: { months: MEDIANS.map(() => month(200, 100)) } };
  const small = outlookFor('river', 'r', 100, { ...inAugust, history: hist, yearly });
  const large = outlookFor('river', 'r', 1000, { ...inAugust, history: hist, yearly });
  assert.strictEqual(small.analogues.toleranceKind, 'relative');
  assert.ok(large.analogues.tolerance > small.analogues.tolerance * 5);
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test('groundwater is not accepted at all', () => {
  // Every "recovered" test here is a >=. The shallow network reports depth to water,
  // where bigger means drier, so pointing this at a well would report a drought as a
  // recovery. Refused rather than silently mishandled.
  assert.strictEqual(outlookFor('well', 'x', 100, opts), null);
  assert.strictEqual(outlookFor('shallow', 'x', 100, opts), null);
});

test('an unbaked document is absent, not an error', () => {
  assert.strictEqual(outlookFor('lake', 'to', 76, { ...inAugust, history: null, yearly: null }), null);
  assert.strictEqual(outlookFor('lake', 'nincs-ilyen', 76, opts), null);
});

test('a missing yearly document still yields the seasonal path', () => {
  // The pooled record is the robust half and does not depend on the per-year bake.
  const o = outlookFor('lake', 'to', 76, { ...inAugust, history, yearly: null });
  assert.ok(o.normal.path.length === 12);
  assert.strictEqual(o.analogues.available, false);
});

test('a reading unlike every past year says so rather than reaching for the least-bad match', () => {
  const o = outlookFor('lake', 'to', 20, opts);
  assert.deepStrictEqual(o.analogues.years, []);
  assert.strictEqual(o.analogues.lowerThanAll, true);
});

test('it says out loud that it is not a forecast', () => {
  const o = outlookFor('lake', 'to', 76, opts);
  assert.match(o.note, /nem előrejelzés/i);
});
