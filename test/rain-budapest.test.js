'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const {
  budapestRainfall,
  loadBudapestRain,
  normalForWindow,
  DOCUMENT_PATH,
} = require('../src/domain/rain-budapest');

/**
 * Budapest is the one number on the site from a second provider (OMSZ), because the OVF
 * network has no gauge in the capital. These guard the two things that make that honest:
 * the window is summed and compared correctly, and the module can only ever make Budapest
 * absent - never wrong, and never able to take the rain endpoint down.
 */

// A document with a normal that is one step per month (Jan 10 mm ... Dec 120 mm), so the
// blended-normal arithmetic is checkable by hand rather than by trusting the function.
function docFor(daily, { years = 24 } = {}) {
  return {
    source: 'test',
    provider: 'HungaroMet (OMSZ)',
    licence: 'test-licence',
    station: { id: '44121', name: 'Budapest belterület', lat: 47.5111, lon: 19.0281 },
    normal: { mm: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120], years, months: 12 },
    daily,
  };
}

/** Every day of June 2026 at a fixed depth, the clean case: full window, one month. */
function june(mmEach) {
  const out = [];
  for (let d = 1; d <= 30; d += 1) {
    out.push({ day: `2026-06-${String(d).padStart(2, '0')}`, mm: mmEach });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The window, summed and compared
// ---------------------------------------------------------------------------

test('a full 30-day window is summed and measured against its blended normal', () => {
  // June is all month index 5: normal 60 mm over 30 days = 2 mm/day, so the window normal
  // is exactly 60. Thirty days at 0.5 mm is 15 mm - a quarter of normal.
  const bp = budapestRainfall(30, { document: docFor(june(0.5)) });
  assert.strictEqual(bp.asOf, '2026-06-30');
  assert.strictEqual(bp.actualMm, 15);
  assert.strictEqual(bp.normalMm, 60);
  assert.strictEqual(bp.ratioToNormal, 0.25);
  assert.strictEqual(bp.coverage, 1);
  assert.strictEqual(bp.complete, true);
  assert.strictEqual(bp.source, 'OMSZ');
  assert.strictEqual(bp.provider, 'HungaroMet (OMSZ)');
  assert.strictEqual(bp.licence, 'test-licence');
  assert.strictEqual(bp.normalYears, 24);
  assert.deepStrictEqual(bp.station, { id: '44121', name: 'Budapest belterület', lat: 47.5111, lon: 19.0281 });
  // As-of, not now: the figure lags reality by at least a day and must say so.
  assert.ok(bp.ageDays >= 1);
});

test('the window only pulls the days it should, not the whole archive', () => {
  // A tail of May and a head of July flank the 30 June days; a 30-day window ending 30 June
  // must ignore both, or the total is inflated by rain from outside the window.
  const daily = [
    { day: '2026-05-20', mm: 99 },
    { day: '2026-05-31', mm: 99 },
    ...june(1),
    { day: '2026-07-01', mm: 99 },
  ];
  const bp = budapestRainfall(30, { document: docFor(daily) });
  assert.strictEqual(bp.asOf, '2026-07-01');
  // Window is 2 July back to and including 2 June: 29 June days (2..30) plus 1 July.
  assert.strictEqual(bp.actualMm, 29 * 1 + 99);
});

test('a normal from too few years is withheld, and so is the ratio', () => {
  // Two years is not a normal. The measurement still stands; the comparison does not.
  const bp = budapestRainfall(30, { document: docFor(june(0.5), { years: 2 }) });
  assert.strictEqual(bp.actualMm, 15);
  assert.strictEqual(bp.normalMm, null);
  assert.strictEqual(bp.ratioToNormal, null);
  assert.strictEqual(bp.normalYears, 2);
});

test('a gappy window reports low coverage and is marked incomplete', () => {
  // Only ten of the last thirty days survived the bake; a total over a tenth of a window
  // cannot be presented as the window, so coverage says so and complete is false.
  const daily = june(1).slice(0, 10); // 1..10 June only, asOf 2026-06-10
  const bp = budapestRainfall(30, { document: docFor(daily) });
  assert.strictEqual(bp.asOf, '2026-06-10');
  assert.ok(bp.coverage < 0.8, `coverage ${bp.coverage} should be well under 0.8`);
  assert.strictEqual(bp.complete, false);
});

test('an absent or empty document yields null, never a throw', () => {
  assert.strictEqual(budapestRainfall(30, { document: null }), null);
  assert.strictEqual(budapestRainfall(30, { document: {} }), null);
  assert.strictEqual(budapestRainfall(30, { document: { daily: [] } }), null);
});

// ---------------------------------------------------------------------------
// The blended normal, across a month boundary
// ---------------------------------------------------------------------------

test('normalForWindow blends the calendar months a window spans', () => {
  // 30 Jan, 31 Jan, 1 Feb: two January days at 10/31 mm and one February day at 20/28.25.
  const n = normalForWindow([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120],
    '2026-01-30T00:00:00Z', '2026-02-02T00:00:00Z');
  assert.strictEqual(n, Math.round((10 / 31 + 10 / 31 + 20 / 28.25) * 10) / 10);
});

test('normalForWindow refuses a broken range rather than guessing', () => {
  assert.strictEqual(normalForWindow(null, '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z'), null);
  assert.strictEqual(normalForWindow([1, 2, 3], 'not-a-date', '2026-07-01T00:00:00Z'), null);
  assert.strictEqual(normalForWindow([1, 2, 3], '2026-07-01T00:00:00Z', '2026-06-01T00:00:00Z'), null);
});

// ---------------------------------------------------------------------------
// The baked config that actually ships
// ---------------------------------------------------------------------------

test('the shipped Budapest config is a real Budapest station with twelve monthly normals', () => {
  const doc = JSON.parse(fs.readFileSync(DOCUMENT_PATH, 'utf8'));
  assert.match(doc.station.name, /budapest/i);
  assert.ok(doc.station.lat > 47.3 && doc.station.lat < 47.7, `lat ${doc.station.lat} is not Budapest`);
  assert.ok(doc.station.lon > 18.9 && doc.station.lon < 19.3, `lon ${doc.station.lon} is not Budapest`);
  assert.strictEqual(doc.normal.mm.length, 12);
  for (const m of doc.normal.mm) assert.ok(Number.isFinite(m) && m >= 0, `normal ${m} is not a sane monthly mm`);
  assert.ok(doc.normal.years >= 3, 'a published normal needs at least three years behind it');
  assert.ok(/OMSZ|HungaroMet/i.test(doc.source), 'the source names the provider');
  assert.ok(doc.licence, 'the licence is recorded, because the data is only usable with attribution');
});

test('the shipped daily series is sorted, well-formed, and free of the -999 sentinel', () => {
  const doc = JSON.parse(fs.readFileSync(DOCUMENT_PATH, 'utf8'));
  assert.ok(Array.isArray(doc.daily) && doc.daily.length > 0);
  let prev = '';
  for (const row of doc.daily) {
    assert.match(row.day, /^\d{4}-\d{2}-\d{2}$/, `day ${row.day} is not an ISO date`);
    assert.ok(row.day > prev, `daily series is not strictly ascending at ${row.day}`);
    prev = row.day;
    assert.ok(Number.isFinite(row.mm) && row.mm >= 0, `mm ${row.mm} on ${row.day} is not a real reading`);
  }
});

test('all three offered windows compute against the shipped config without throwing', () => {
  const live = loadBudapestRain({ reload: true });
  assert.ok(live, 'the baked config loads');
  for (const days of [7, 30, 90]) {
    const bp = budapestRainfall(days);
    assert.ok(bp, `window ${days} returned a figure`);
    assert.strictEqual(bp.windowDays, days);
    assert.ok(Number.isFinite(bp.actualMm) && bp.actualMm >= 0);
    assert.strictEqual(bp.asOf, live.daily[live.daily.length - 1].day);
  }
});
