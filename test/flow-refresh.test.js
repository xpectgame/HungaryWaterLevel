'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { mergeFlowWindow, MIN_DAYS_IN_MONTH } = require('../src/domain/flow-refresh');
const { compareWindow } = require('../src/domain/drought-years');

/**
 * The daily refresh is what keeps "Rosszabb, mint 2022?" from freezing again. These guard
 * the three things it must get right: new days land where the bake would put them, a month
 * is published under exactly the bake's rule, and the merged archive is something the
 * running-month window can actually use.
 */

/** 'YYYY-MM-DD' -> value for days 1..n of a month. */
function window(year, monthIndex, n, valueFor = () => 50) {
  const mm = String(monthIndex + 1).padStart(2, '0');
  const out = {};
  for (let d = 1; d <= n; d += 1) out[`${year}-${mm}-${String(d).padStart(2, '0')}`] = valueFor(d);
  return out;
}

test('fresh days are added at one decimal, and the archive outside the window is untouched', () => {
  const daily = { 'tisza-szeged': { 2026: { '08-16': 90.1, '08-17': 88.4 } } };
  const fresh = { 'tisza-szeged': { '2026-09-01': 79.349, '2026-09-02': 78.95 } };
  const { daily: out } = mergeFlowWindow({ daily, yearly: {}, fresh });
  assert.equal(out['tisza-szeged'][2026]['09-01'], 79.3);
  assert.equal(out['tisza-szeged'][2026]['09-02'], 79);
  assert.equal(out['tisza-szeged'][2026]['08-17'], 88.4, 'days outside the window stay as baked');
});

test('a day that is already in the archive is overwritten by the fresh reading', () => {
  // Yesterday's run baked today's partial mean; today's run has the whole day.
  const daily = { 'tisza-szeged': { 2026: { '09-30': 40 } } };
  const fresh = { 'tisza-szeged': { '2026-09-30': 77.2 } };
  const { daily: out } = mergeFlowWindow({ daily, yearly: {}, fresh });
  assert.equal(out['tisza-szeged'][2026]['09-30'], 77.2);
});

test(`a month is published once it has ${MIN_DAYS_IN_MONTH} days, and not before`, () => {
  const yearly = { 'tisza-szeged': { 2026: [1, 1, 1, 1, 1, 1, 1, null, null, null, null, null] } };
  // August reaches 20 days: published. September has 5: still null.
  const fresh = { 'tisza-szeged': { ...window(2026, 7, 20, (d) => d), ...window(2026, 8, 5) } };
  const { yearly: out } = mergeFlowWindow({ daily: {}, yearly, fresh });
  const series = out['tisza-szeged'][2026];
  // The median of 1..20 is 10.5 - the bake's percentileOf(sorted, 50), exactly.
  assert.equal(series[7], 10.5);
  assert.equal(series[8], null, 'five days of September are not September');
  assert.deepEqual(series.slice(0, 7), [1, 1, 1, 1, 1, 1, 1], 'months not in the window are kept');
});

test('a month already in the archive is recomputed from the merged days, not just the fresh ones', () => {
  // The archive has 1-15 September, the refresh brings 16-30: the median is over all thirty.
  const daily = { g: { 2026: Object.fromEntries(Object.entries(window(2026, 8, 15, () => 10)).map(([k, v]) => [k.slice(5), v])) } };
  const fresh = { g: Object.fromEntries(Object.entries(window(2026, 8, 30, () => 30)).filter(([k]) => k >= '2026-09-16')) };
  const { yearly } = mergeFlowWindow({ daily, yearly: {}, fresh });
  assert.equal(yearly.g[2026][8], 20, 'fifteen 10s and fifteen 30s');
});

test('readings an instrument cannot have produced are dropped, as the bake drops them', () => {
  const fresh = { g: { '2026-09-01': -3, '2026-09-02': NaN, 'not-a-date': 5, '2026-09-03': 12 } };
  const { daily } = mergeFlowWindow({ daily: {}, yearly: {}, fresh });
  assert.deepEqual(daily.g[2026], { '09-03': 12 });
});

test('a window across New Year lands each day in its own year', () => {
  const fresh = { g: { '2026-12-31': 5, '2027-01-01': 6 } };
  const { daily } = mergeFlowWindow({ daily: {}, yearly: {}, fresh });
  assert.equal(daily.g[2026]['12-31'], 5);
  assert.equal(daily.g[2027]['01-01'], 6);
});

test('a new year with too few days does not add an empty column', () => {
  const { yearly } = mergeFlowWindow({ daily: {}, yearly: {}, fresh: { g: window(2027, 0, 3) } });
  assert.equal(yearly.g[2027], undefined);
});

test('the inputs are not mutated', () => {
  const daily = { g: { 2026: { '08-17': 1 } } };
  const yearly = { g: { 2026: new Array(12).fill(null) } };
  const before = JSON.stringify({ daily, yearly });
  mergeFlowWindow({ daily, yearly, fresh: { g: window(2026, 8, 25) } });
  assert.equal(JSON.stringify({ daily, yearly }), before);
});

test('after a refresh, the running-month window works again', () => {
  // The live state of September 2026, end to end: an archive that ends on 17 August gives
  // no September window at all; fold in a refresh and the comparison is there.
  const daily = {
    'tisza-szolnok': {
      2022: Object.fromEntries(Object.entries(window(2022, 8, 30, () => 100)).map(([k, v]) => [k.slice(5), v])),
      2026: Object.fromEntries(Object.entries(window(2026, 7, 17, () => 70)).map(([k, v]) => [k.slice(5), v])),
    },
  };
  const now = new Date(Date.UTC(2026, 8, 14, 12));
  assert.equal(compareWindow({ month: 8, document: daily, now }).available, false);

  const { daily: merged } = mergeFlowWindow({ daily, yearly: {}, fresh: { 'tisza-szolnok': window(2026, 8, 13, () => 60) } });
  const w = compareWindow({ month: 8, document: merged, now });
  assert.equal(w.available, true);
  assert.equal(w.throughDay, 13);
  assert.equal(w.summary.belowReference, 1, '60 against 100 over the same thirteen days');
});
