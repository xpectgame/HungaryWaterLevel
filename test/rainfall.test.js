'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildRainfall, describeGauge, headline, bandFor, STALE_AFTER_MS } = require('../src/domain/rainfall');
const {
  listRainGauges,
  getRainGauge,
  normalForWindow,
  monthlyNormal,
  NORMALS,
  MIN_YEARS,
} = require('../src/config/rain-gauges');
const { summarise, dailyTotals, buildRainRequest } = require('../src/sources/vizugy-rain');
const { config: vizugyConfig } = require('../src/sources/vizugy');

const NOW = Date.parse('2026-08-10T09:00:00Z');
const DAY = 24 * 3600 * 1000;

function sample(mm, at) {
  return { UTCTime: new Date(at).toISOString(), Adat: mm };
}

// ---------------------------------------------------------------------------
// The registry and its baselines
// ---------------------------------------------------------------------------

test('every gauge has coordinates inside Hungary and a unique id', () => {
  const seen = new Set();
  for (const gauge of listRainGauges()) {
    assert.ok(!seen.has(gauge.id), `duplicate gauge id ${gauge.id}`);
    seen.add(gauge.id);
    assert.ok(gauge.lat > 45.7 && gauge.lat < 48.6, `${gauge.id} latitude ${gauge.lat} is outside Hungary`);
    assert.ok(gauge.lon > 16.0 && gauge.lon < 22.9, `${gauge.id} longitude ${gauge.lon} is outside Hungary`);
    assert.ok(gauge.tsz && gauge.name && gauge.region);
  }
});

test('a normal built from too few years is withheld rather than published', () => {
  // Érsekcsanád came back from the archive with a single usable year. One year is not a
  // normal, it is that year, and a ratio against it would look exactly as confident as a
  // ratio against ten. The gauge still reports rainfall; it just gets no baseline.
  const thin = Object.entries(NORMALS).filter(([, entry]) => entry.years < MIN_YEARS);
  for (const [id] of thin) {
    assert.strictEqual(monthlyNormal(id, 8), null, `${id} has ${NORMALS[id].years} year(s) and must have no normal`);
  }

  // ...and the ones that do qualify are physically plausible for Hungary: annual totals
  // between 350 and 900 mm. A unit slip or a partial-month bug shows up here first.
  for (const [id, entry] of Object.entries(NORMALS)) {
    if (entry.years < MIN_YEARS || entry.months < 12) continue;
    const annual = entry.mm.reduce((sum, v) => sum + v, 0);
    assert.ok(annual > 350 && annual < 900, `${id} annual normal is ${annual.toFixed(0)} mm`);
  }
});

test('the normal for a window is blended from the months it spans', () => {
  const gauge = 'mezotur';
  const july = monthlyNormal(gauge, 7);
  const august = monthlyNormal(gauge, 8);
  assert.ok(july && august);

  // A window wholly inside August must land near August's own rate, not near the annual
  // mean - the whole point of blending rather than picking one month.
  const inAugust = normalForWindow(gauge, '2026-08-02T00:00:00Z', '2026-08-12T00:00:00Z');
  assert.ok(Math.abs(inAugust - (august / 31) * 10) < 0.2);

  // A window straddling the boundary must sit between the two months' rates.
  const straddling = normalForWindow(gauge, '2026-07-27T00:00:00Z', '2026-08-06T00:00:00Z');
  const lo = Math.min(july / 31, august / 31) * 10;
  const hi = Math.max(july / 31, august / 31) * 10;
  assert.ok(straddling >= lo - 0.2 && straddling <= hi + 0.2, `${straddling} outside ${lo}..${hi}`);
});

test('a longer window has a proportionally larger normal', () => {
  const thirty = normalForWindow('karcag', '2026-07-11T00:00:00Z', '2026-08-10T00:00:00Z');
  const ninety = normalForWindow('karcag', '2026-05-12T00:00:00Z', '2026-08-10T00:00:00Z');
  assert.ok(ninety > thirty * 2.5, `90-day normal ${ninety} should dwarf the 30-day ${thirty}`);
});

// ---------------------------------------------------------------------------
// Reading the upstream series
// ---------------------------------------------------------------------------

test('a period total is the sum of the increments, whatever the interval', () => {
  // Daily gauge and a quarter-hourly one reporting the same 6 mm must total the same.
  const daily = summarise({ TsItemList: [sample(2, NOW - 2 * DAY), sample(0, NOW - DAY), sample(4, NOW)] });
  const frequent = summarise({
    TsItemList: Array.from({ length: 24 }, (_, i) => sample(i === 3 || i === 9 ? 3 : 0, NOW - i * 3600000)),
  });

  assert.strictEqual(daily.totalMm, 6);
  assert.strictEqual(frequent.totalMm, 6);
});

test('a negative increment is a fault, not negative rain', () => {
  // Letting one through would subtract from a total that is supposed to be monotonic.
  const summary = summarise({ TsItemList: [sample(5, NOW - DAY), sample(-3, NOW - 3600000), sample(2, NOW)] });
  assert.strictEqual(summary.totalMm, 7);
});

test('a dry gauge reports zero; a silent gauge reports nothing', () => {
  // The single most important distinction in this feature: 0 mm is a drought reading and
  // "no samples" is a broken instrument, and they must never collapse into each other.
  const dry = summarise({ TsItemList: [sample(0, NOW - DAY), sample(0, NOW)] });
  assert.strictEqual(dry.totalMm, 0);
  assert.strictEqual(dry.wetDays, 0);
  assert.strictEqual(dry.lastRainAt, null);

  assert.strictEqual(summarise({ TsItemList: [] }), null);
  assert.strictEqual(summarise(undefined), null);
  assert.strictEqual(summarise({ TsItemList: [{ UTCTime: '2026-08-10T00:00:00Z', Adat: null }] }), null);
});

test('daily totals collapse a sub-daily series onto its days', () => {
  const totals = dailyTotals({
    TsItemList: [
      sample(1, Date.parse('2026-08-09T03:00:00Z')),
      sample(2, Date.parse('2026-08-09T15:00:00Z')),
      sample(4, Date.parse('2026-08-10T03:00:00Z')),
    ],
  });
  assert.deepStrictEqual(totals, [
    { date: '2026-08-09', mm: 3 },
    { date: '2026-08-10', mm: 4 },
  ]);
});

test('the request asks for rainfall, for every gauge, in one POST', () => {
  const body = buildRainRequest(listRainGauges(), vizugyConfig(), { days: 30, now: new Date(NOW) });
  assert.strictEqual(body.length, listRainGauges().length);
  assert.ok(body.every((entry) => entry.AdatFajtaKod === 71));
  // Dense and unique, or one gauge's rain is filed under another's name.
  assert.deepStrictEqual(
    body.map((e) => e.ItemId),
    body.map((_, i) => i),
  );
  const span = Date.parse(body[0].EndTime) - Date.parse(body[0].StartTime);
  assert.ok(span > 30 * DAY && span < 31 * DAY);
});

// ---------------------------------------------------------------------------
// What a total means
// ---------------------------------------------------------------------------

function reading(overrides = {}) {
  return {
    totalMm: 10,
    samples: 30,
    wetDays: 2,
    firstAt: new Date(NOW - 30 * DAY).toISOString(),
    lastAt: new Date(NOW - 4 * 3600000).toISOString(),
    lastRainAt: new Date(NOW - 9 * DAY).toISOString(),
    daily: [],
    ...overrides,
  };
}

const WINDOW = { from: new Date(NOW - 30 * DAY).toISOString(), to: new Date(NOW).toISOString(), now: NOW };

test('a gauge is judged against its own normal for the window measured', () => {
  const gauge = getRainGauge('mezotur');
  const described = describeGauge(gauge, reading({ totalMm: 10 }), WINDOW);

  assert.ok(described.normalMm > 0);
  assert.strictEqual(described.ratioToNormal, Math.round((10 / described.normalMm) * 100) / 100);
  assert.strictEqual(described.deficitMm, Math.round((10 - described.normalMm) * 10) / 10);
  assert.strictEqual(described.daysSinceRain, 9);
  assert.strictEqual(described.stale, false);
});

test('a gauge that stopped reporting is flagged, not deleted', () => {
  // A dot that vanishes and reappears as gauges drop in and out is harder to read than
  // one that says it is out of date - and a stale low total must never colour the map
  // as a dry spot.
  const gauge = getRainGauge('karcag');
  const fresh = describeGauge(gauge, reading(), WINDOW);
  const stale = describeGauge(
    gauge,
    reading({ lastAt: new Date(NOW - STALE_AFTER_MS - DAY).toISOString() }),
    WINDOW,
  );

  assert.strictEqual(fresh.stale, false);
  assert.strictEqual(stale.stale, true);
  assert.strictEqual(stale.totalMm, 10, 'the reading is still reported');
});

test('the bands run from extreme deficit to extreme surplus without a gap', () => {
  assert.strictEqual(bandFor(0.1).id, 'extreme-deficit');
  assert.strictEqual(bandFor(0.25).id, 'extreme-deficit');
  assert.strictEqual(bandFor(0.4).id, 'severe-deficit');
  assert.strictEqual(bandFor(1).id, 'near-normal');
  assert.strictEqual(bandFor(1.5).id, 'surplus');
  assert.strictEqual(bandFor(9).id, 'extreme-surplus');
  assert.strictEqual(bandFor(null), null);
});

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

function fetched(perGauge) {
  return {
    windowDays: 30,
    from: WINDOW.from,
    to: WINDOW.to,
    fetchedAt: WINDOW.to,
    gauges: perGauge,
    errors: [],
  };
}

test('a gauge missing from the response is listed as missing, not as dry', () => {
  const built = buildRainfall(fetched({ mezotur: reading() }), { now: NOW });

  assert.strictEqual(built.gaugeCount, 1);
  assert.strictEqual(built.missing.length, listRainGauges().length - 1);
  assert.ok(built.missing.every((m) => m.id !== 'mezotur'));
});

test('the headline counts gauges rather than averaging a network that is not national', () => {
  // Every gauge at a fifth of normal.
  const dry = {};
  for (const gauge of listRainGauges()) {
    const normal = normalForWindow(gauge.id, WINDOW.from, WINDOW.to);
    if (normal === null) continue;
    dry[gauge.id] = reading({ totalMm: Math.round(normal * 0.2 * 10) / 10 });
  }

  const built = buildRainfall(fetched(dry), { now: NOW });
  assert.strictEqual(built.headline.severity, 3);
  assert.match(built.headline.text, /negyede sem/);
  assert.strictEqual(built.driest.length, 5);
  assert.ok(built.driest[0].ratioToNormal <= built.driest[4].ratioToNormal, 'driest first');
});

test('readings without a baseline say so instead of reporting no data', () => {
  // Two different failures that would otherwise read identically to a user: the upstream
  // being down, and rain-normals.json not being loaded. Only one of them means there is
  // no rainfall measurement.
  const withNoNormal = headline(
    [{ stale: false, ratioToNormal: null, totalMm: 12, name: 'X' }],
    30,
  );
  assert.strictEqual(withNoNormal.noBaseline, true);
  assert.match(withNoNormal.text, /12 mm|jelentett/);

  const withNothing = headline([], 30);
  assert.ok(!withNothing.noBaseline);
  assert.match(withNothing.text, /Nincs elég friss/);
});

test('a region reports its spread, not only its mean', () => {
  // An average of 20 mm made of 0 and 40 is a different situation from 19 and 21, and a
  // regional average that hides that is worse than no regional figure.
  const perGauge = {};
  const korosGauges = listRainGauges().filter((g) => g.region === 'Körös-vidék');
  korosGauges.forEach((gauge, i) => {
    perGauge[gauge.id] = reading({ totalMm: i === 0 ? 0 : 40 });
  });

  const built = buildRainfall(fetched(perGauge), { now: NOW });
  const koros = built.regions.find((r) => r.region === 'Körös-vidék');

  assert.ok(koros);
  assert.strictEqual(koros.minMm, 0);
  assert.strictEqual(koros.maxMm, 40);
  assert.strictEqual(koros.gaugeCount, korosGauges.length);
  assert.strictEqual(koros.driestGauge.totalMm, 0);
});

test('a stale gauge is kept out of the regional roll-up', () => {
  const perGauge = {};
  for (const gauge of listRainGauges().filter((g) => g.region === 'Homokhátság')) {
    perGauge[gauge.id] = reading({ totalMm: 40 });
  }
  const [first] = Object.keys(perGauge);
  perGauge[first] = reading({ totalMm: 0, lastAt: new Date(NOW - 30 * DAY).toISOString() });

  const built = buildRainfall(fetched(perGauge), { now: NOW });
  const region = built.regions.find((r) => r.region === 'Homokhátság');
  assert.strictEqual(region.minMm, 40, 'the stale zero must not drag the region down');
});

test('the payload states what the network does not cover and what the baseline is', () => {
  // A reader looking at an empty Transdanubia has to be told it is unmeasured rather
  // than dry, and told that the baseline is a recent decade rather than a 30-year normal.
  const built = buildRainfall(fetched({ mezotur: reading() }), { now: NOW });

  assert.ok(built.coverage && built.coverage.note.length > 0);
  assert.match(built.coverage.note, /nem mérik|nem országos/);
  assert.match(built.baselineNote, /tízéves|nem harmincéves/);
});
