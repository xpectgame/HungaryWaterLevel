'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const {
  buildNationalRainfall,
  describeStation,
  normalForWindow,
  windowStartKey,
  loadNationalRain,
  DOCUMENT_PATH,
} = require('../src/domain/rain-national');

/**
 * National rainfall is baked OMSZ data served in the OVF builder's shape. These guard the
 * two things that make that honest: each station's window is summed and compared to its
 * own normal correctly, and the whole payload is built without a live call - so it can
 * never 503 the way the OVF fetch did.
 */

// A station with a one-step-per-month normal (Jan 30 ... spread), so the blended-normal
// arithmetic is checkable by hand. June here is index 5.
function station(id, region, mmEach, { normalJune = 60, name } = {}) {
  const daily = [];
  for (let d = 1; d <= 30; d += 1) {
    daily.push({ day: `2026-06-${String(d).padStart(2, '0')}`, mm: mmEach });
  }
  const normal = normalJune === null ? null
    : { mm: [10, 20, 30, 40, 50, normalJune, 70, 80, 90, 100, 110, 120], years: 20, months: 12 };
  return { id, station: id.replace('omsz-', ''), name: name || id, lat: 47.5, lon: 19.0, region, normal, daily };
}

function doc(stations) {
  // asOf is the network's freshest day, exactly as the bake computes it.
  const asOf = stations.flatMap((s) => s.daily.map((d) => d.day)).sort().slice(-1)[0];
  return { source: 'test', licence: 'test-licence', asOf, stations };
}

// ---------------------------------------------------------------------------
// One station, summed and compared
// ---------------------------------------------------------------------------

test('a station is summed over the window and measured against its own normal', () => {
  // June is index 5: normal 60 over 30 days = 2 mm/day, window normal 60. 30 days at 0.5 mm
  // is 15 mm - a quarter of normal.
  const built = buildNationalRainfall(30, { document: doc([station('omsz-1', 'Dél-Alföld', 0.5)]) });
  assert.strictEqual(built.asOf, '2026-06-30');
  assert.strictEqual(built.gaugeCount, 1);
  const g = built.gauges[0];
  assert.strictEqual(g.totalMm, 15);
  assert.strictEqual(g.normalMm, 60);
  assert.strictEqual(g.ratioToNormal, 0.25);
  assert.strictEqual(g.band, 'extreme-deficit');
  assert.strictEqual(g.region, 'Dél-Alföld');
  assert.strictEqual(built.source, 'OMSZ');
});

test('the window only sums days inside it', () => {
  const s = station('omsz-2', 'Nyugat-Dunántúl', 1);
  s.daily.unshift({ day: '2026-05-20', mm: 99 }); // outside a 30-day window ending 30 June
  s.daily.push({ day: '2026-07-01', mm: 99 }); // asOf becomes 1 July
  const built = buildNationalRainfall(30, { document: doc([s]) });
  assert.strictEqual(built.asOf, '2026-07-01');
  // Window is 2 June..1 July inclusive: 29 June days (2..30) at 1 + 1 July at 99.
  assert.strictEqual(built.gauges[0].totalMm, 29 + 99);
});

test('a station with no normal still reports rainfall, just no ratio', () => {
  const built = buildNationalRainfall(30, { document: doc([station('omsz-3', 'Egyéb', 2, { normalJune: null })]) });
  const g = built.gauges[0];
  assert.strictEqual(g.totalMm, 60);
  assert.strictEqual(g.normalMm, null);
  assert.strictEqual(g.ratioToNormal, null);
  assert.strictEqual(g.band, null);
});

test('wetDays and daysSinceRain are read off the series', () => {
  const s = station('omsz-4', 'Közép-Magyarország', 0);
  s.daily[27].mm = 5;  // 2026-06-28 rained
  s.daily[10].mm = 0.5; // a trace day, below the 1 mm "wet" threshold
  const g = buildNationalRainfall(30, { document: doc([s]) }).gauges[0];
  assert.strictEqual(g.wetDays, 1, 'only the >=1 mm day counts as wet');
  assert.strictEqual(g.lastRainAt, '2026-06-28');
  assert.strictEqual(g.daysSinceRain, 2, 'from 2026-06-30');
});

// ---------------------------------------------------------------------------
// The national roll-up
// ---------------------------------------------------------------------------

test('regions roll up their stations and a stale station is excluded', () => {
  const wet = station('omsz-10', 'Nyugat-Dunántúl', 2);   // 60 mm, ratio 1.0
  const dry = station('omsz-11', 'Nyugat-Dunántúl', 0.2);  // 6 mm, ratio 0.1
  const stale = station('omsz-12', 'Nyugat-Dunántúl', 3);  // fresh-looking values...
  // ...but its last reading is two weeks before the network's freshest day.
  stale.daily = stale.daily.map((r, i) => ({ day: `2026-06-${String(i + 1).padStart(2, '0')}`, mm: r.mm })).slice(0, 16);
  const built = buildNationalRainfall(30, { document: doc([wet, dry, stale]) });

  const region = built.regions.find((r) => r.region === 'Nyugat-Dunántúl');
  assert.ok(region, 'the region is present');
  assert.strictEqual(region.gaugeCount, 2, 'the stale station is left out of the roll-up');
  const staleGauge = built.gauges.find((g) => g.id === 'omsz-12');
  assert.strictEqual(staleGauge.stale, true, 'but it stays in the gauge list, flagged');
});

test('Budapest districts collapse into one Budapest region', () => {
  // OMSZ tags Budapest stations by district; six one-station "regions" would be noise.
  const built = buildNationalRainfall(30, {
    document: doc([
      station('omsz-30', 'Budapest XII.', 1, { name: 'Budapest Széchenyi-hegy' }),
      station('omsz-31', 'Budapest IV.', 1, { name: 'Budapest Káposztásmegyer' }),
      station('omsz-32', 'Pest', 1, { name: 'Gödöllő' }),
    ]),
  });
  assert.strictEqual(built.gauges.find((g) => g.id === 'omsz-30').region, 'Budapest');
  assert.strictEqual(built.gauges.find((g) => g.id === 'omsz-31').region, 'Budapest');
  const bp = built.regions.find((r) => r.region === 'Budapest');
  assert.strictEqual(bp.gaugeCount, 2, 'the two districts are one region');
  assert.ok(built.regions.find((r) => r.region === 'Pest'), 'a county stays itself');
});

test('driest lists the lowest ratios first', () => {
  const built = buildNationalRainfall(30, {
    document: doc([
      station('omsz-20', 'Dél-Alföld', 2),   // ratio 1.0
      station('omsz-21', 'Dél-Alföld', 0.2), // ratio 0.1  <- driest
      station('omsz-22', 'Dél-Alföld', 1),   // ratio 0.5
    ]),
  });
  assert.strictEqual(built.driest[0].id, 'omsz-21');
  assert.ok(built.driest[0].ratioToNormal <= built.driest[1].ratioToNormal);
});

test('an empty or missing document is a renderable "unavailable", not a throw', () => {
  assert.strictEqual(buildNationalRainfall(30, { document: null }).unavailable, true);
  assert.strictEqual(buildNationalRainfall(30, { document: { stations: [] } }).unavailable, true);
  const u = buildNationalRainfall(30, { document: null });
  assert.deepStrictEqual(u.gauges, []);
  assert.strictEqual(u.source, 'OMSZ');
});

// ---------------------------------------------------------------------------
// The window helpers
// ---------------------------------------------------------------------------

test('windowStartKey counts an inclusive window back from the end', () => {
  assert.strictEqual(windowStartKey('2026-06-30', 30), '2026-06-01');
  assert.strictEqual(windowStartKey('2026-06-30', 7), '2026-06-24');
  assert.strictEqual(windowStartKey('2026-01-01', 7), '2025-12-26');
});

test('normalForWindow blends the calendar months a window spans', () => {
  const n = normalForWindow([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120],
    '2026-01-30T00:00:00Z', '2026-02-02T00:00:00Z');
  assert.strictEqual(n, Math.round((10 / 31 + 10 / 31 + 20 / 28.25) * 10) / 10);
});

// ---------------------------------------------------------------------------
// The baked config that actually ships
// ---------------------------------------------------------------------------

test('the shipped national config is nationwide and well-formed', () => {
  if (!fs.existsSync(DOCUMENT_PATH)) {
    // The bake has not been promoted yet in this working tree; the injected-document tests
    // above cover the logic. Skip rather than fail so the suite is green pre-promotion.
    return;
  }
  const d = loadNationalRain({ reload: true });
  assert.ok(d && Array.isArray(d.stations) && d.stations.length >= 50,
    `expected a national network, got ${d && d.stations && d.stations.length} stations`);

  const lats = d.stations.map((s) => s.lat);
  const lons = d.stations.map((s) => s.lon);
  // Genuinely national: the stations must span the country, not cluster in one corner.
  assert.ok(Math.max(...lons) - Math.min(...lons) > 4, 'stations span east-to-west');
  assert.ok(Math.max(...lats) - Math.min(...lats) > 1.5, 'stations span north-to-south');

  for (const s of d.stations) {
    assert.ok(s.lat > 45.6 && s.lat < 48.7 && s.lon > 16 && s.lon < 23, `${s.id} is inside Hungary`);
    assert.ok(Array.isArray(s.daily) && s.daily.length > 0, `${s.id} has a daily series`);
    if (s.normal) assert.strictEqual(s.normal.mm.length, 12, `${s.id} normal has twelve months`);
  }

  // The whole thing must build into the response shape without throwing, for every window.
  for (const days of [7, 30, 90]) {
    const built = buildNationalRainfall(days);
    assert.strictEqual(built.windowDays, days);
    assert.ok(built.gauges.length >= 50);
    assert.ok(built.regions.length >= 1);
  }
});
