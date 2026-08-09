'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createApp } = require('../src/create-app');
const { createStore } = require('../src/store');
const { TtlCache } = require('../src/lib/cache');
const { loadConfig, assertProviderSafe } = require('../src/config');
const { runOnce } = require('../src/jobs/poll');

/**
 * Spin up the full app against a store seeded with one fixture poll.
 *
 * When TEST_DATABASE_URL is set the whole HTTP stack runs against real Postgres, which
 * is the only way to catch a route that forgot to await an async store - against SQLite
 * a missing await silently works, because the value is already there.
 */
async function withServer(fn, configOverrides = {}) {
  const usePostgres = !!process.env.TEST_DATABASE_URL;

  const config = {
    ...loadConfig({ DATA_PROVIDER: 'fixture', DB_PATH: ':memory:' }),
    dbPath: ':memory:',
    provider: 'fixture',
    pollOnStart: false,
    cacheTtlMs: 0,
    store: usePostgres ? 'postgres' : 'sqlite',
    databaseUrl: process.env.TEST_DATABASE_URL || null,
    // Own schema so this file cannot collide with store.test.js running in parallel.
    databaseSchema: 'test_api',
    lazyRefresh: false,
    ...configOverrides,
  };

  const store = createStore(config);
  if (usePostgres) {
    await store.init();
    await store.query(
      ['station_readings', 'generation', 'balance_snapshots', 'poll_log']
        .map((t) => store.t(t))
        .join(', ')
        .replace(/^/, 'TRUNCATE '),
    );
  }
  const cache = new TtlCache(config.cacheTtlMs);
  const silent = { log() {}, warn() {}, error() {} };

  await runOnce(store, config, silent);

  const app = createApp({ config, store, cache });
  const server = app.listen(0);
  const port = server.address().port;
  const get = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const body = await res.json();
    return { status: res.status, body };
  };

  try {
    await fn({ get, store, config });
  } finally {
    server.close();
    await store.close();
  }
}

test('GET /api/v1/health reports ok with fresh data', async () => {
  await withServer(async ({ get }) => {
    const { status, body } = await get('/api/v1/health');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(body.synthetic, true);
    assert.ok(body.store.stationReadings > 0);
  });
});

test('GET /api/v1/health reports degraded when data is stale', async () => {
  await withServer(
    async ({ get }) => {
      const { status, body } = await get('/api/v1/health');
      assert.strictEqual(status, 503);
      assert.strictEqual(body.status, 'degraded');
    },
    // Nothing can be fresher than 1 ms, so this forces the stale path.
    { maxReadingAgeMs: 1 },
  );
});

test('GET /api/v1/balance returns a complete, self-describing balance', async () => {
  await withServer(async ({ get }) => {
    const { status, body } = await get('/api/v1/balance');
    assert.strictEqual(status, 200);

    // A plausibility band, not a threshold. The synthetic generator swings each station
    // between a quarter of its mean and well above it, so a fixed floor near the
    // long-term average passes most of the time and fails whenever the seasonal and
    // weather factors happen to line up low. What must hold is the structure below.
    for (const side of ['inflow', 'outflow']) {
      assert.ok(
        body[side].totalM3s > 500 && body[side].totalM3s < 15000,
        `${side} ${body[side].totalM3s} m3/s is outside anything physically possible`,
      );
    }
    // The three figures are each rounded to one decimal independently, so the parts can
    // legitimately miss their total by one step. Asserting exact equality here passed by
    // luck for a while - the fixture data is time-dependent - and then did not.
    const parts = body.inflow.gaugedM3s + body.inflow.ungaugedM3s;
    assert.ok(
      Math.abs(parts - body.inflow.totalM3s) <= 0.11,
      `inflow parts ${parts} do not add up to ${body.inflow.totalM3s}`,
    );

    // Net must equal inflow minus outflow, within rounding.
    assert.ok(Math.abs(body.net.m3s - (body.inflow.totalM3s - body.outflow.totalM3s)) < 0.2);
    assert.ok(body.net.uncertaintyM3s > 0);
    assert.strictEqual(typeof body.net.significant, 'boolean');

    // Synthetic data must be labelled on the way out.
    assert.strictEqual(body._meta.synthetic, true);
  });
});

test('balance station shares sum to one on each side', async () => {
  await withServer(async ({ get }) => {
    const { body } = await get('/api/v1/balance');
    for (const side of ['inflow', 'outflow']) {
      const total = body[side].stations.reduce((sum, s) => sum + s.shareOfSide, 0);
      assert.ok(Math.abs(total - 1) < 0.01, `${side} shares sum to ${total}`);
    }
  });
});

test('GET /api/v1/balance?ungauged=false drops the estimated term', async () => {
  await withServer(async ({ get }) => {
    const { body } = await get('/api/v1/balance?ungauged=false');
    assert.strictEqual(body.inflow.ungaugedM3s, 0);
  });
});

test('GET /api/v1/snapshot combines balance and power in one response', async () => {
  await withServer(async ({ get }) => {
    const { status, body } = await get('/api/v1/snapshot');
    assert.strictEqual(status, 200);
    assert.ok(body.balance.net);
    assert.ok(body.power.totals.withdrawalM3s > 0);
    assert.ok(Array.isArray(body.power.plants));

    // The comparison that keeps withdrawal from being read as consumption.
    assert.ok(body.context.powerWithdrawalShareOfInflow > body.context.powerConsumptionShareOfInflow * 10);
  });
});

test('GET /api/v1/stations exposes which gauges count toward the balance', async () => {
  await withServer(async ({ get }) => {
    const { body } = await get('/api/v1/stations');
    const nagymaros = body.stations.find((s) => s.id === 'duna-nagymaros');
    const rajka = body.stations.find((s) => s.id === 'duna-rajka');
    const komarom = body.stations.find((s) => s.id === 'duna-komarom');

    assert.strictEqual(nagymaros.countsTowardBalance, false);
    assert.strictEqual(nagymaros.redundantWith, 'duna-komarom');

    // Rajka is published because people recognise it, and excluded from the sum because
    // it is below the Cunovo diversion and carries only the old riverbed.
    assert.strictEqual(rajka.countsTowardBalance, false);
    assert.strictEqual(komarom.countsTowardBalance, true);
  });
});

test('GET /api/v1/stations?role= filters and validates', async () => {
  await withServer(async ({ get }) => {
    const ok = await get('/api/v1/stations?role=outflow');
    assert.strictEqual(ok.body.count, 3);
    assert.ok(ok.body.stations.every((s) => s.role === 'outflow'));

    const bad = await get('/api/v1/stations?role=bogus');
    assert.strictEqual(bad.status, 400);
  });
});

test('GET /api/v1/stations/:id/timeseries returns an ordered series', async () => {
  await withServer(async ({ get }) => {
    const { status, body } = await get('/api/v1/stations/duna-rajka/timeseries');
    assert.strictEqual(status, 200);
    assert.ok(body.count >= 1);

    const times = body.series.map((s) => Date.parse(s.timestamp));
    assert.deepStrictEqual(times, [...times].sort((a, b) => a - b));
    // Stage travels with the series, not only with the latest reading, so the detail
    // chart can draw it.
    assert.ok('waterLevelCm' in body.series[0]);
  });
});

test('a station reading carries its stage in context', async () => {
  await withServer(async ({ get }) => {
    const { body } = await get('/api/v1/stations/duna-budapest');
    const stage = body.current.stage;

    assert.ok(Number.isFinite(stage.cm));
    assert.strictEqual(stage.recordLowCm, 33);
    assert.strictEqual(stage.recordHighCm, 891);
    assert.strictEqual(stage.aboveRecordLowCm, stage.cm - 33);
    assert.strictEqual(stage.thresholds.kf1, 620);
    // The whole chain: poll wrote waterLevelCm, the store kept it, the route interpreted
    // it. A rename anywhere along it drops the field silently, which is how the first
    // version of this shipped.
    assert.ok(['normal', 'grade-1', 'grade-2', 'grade-3', 'record-low', 'record-high'].includes(stage.band));
  });
});

test('a gauge outside the reference table still reports its level', async () => {
  await withServer(async ({ get }) => {
    // Tiszabecs has no entry in the catalogue the thresholds come from. The fixture
    // reproduces that gap rather than inventing a level for it.
    const { body } = await get('/api/v1/stations/tisza-tiszabecs');
    assert.strictEqual(body.current.stage, null);
    assert.ok(Number.isFinite(body.current.flowM3s), 'the discharge must survive the missing stage');
  });
});

test('unknown station and unknown plant return 404', async () => {
  await withServer(async ({ get }) => {
    assert.strictEqual((await get('/api/v1/stations/atlantis')).status, 404);
    assert.strictEqual((await get('/api/v1/powerplants/atlantis')).status, 404);
    assert.strictEqual((await get('/api/v1/lakes/atlantis')).status, 404);
  });
});

test('GET /api/v1/lakes serves levels the balance never sees', async () => {
  await withServer(async ({ get }) => {
    const { status, body } = await get('/api/v1/lakes');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.count, 4);

    const balaton = body.lakes.find((l) => l.id === 'balaton');
    assert.ok(Number.isFinite(balaton.current.levelCm), 'the poll must reach the lake gauges');
    assert.strictEqual(balaton.current.stage.recordLowCm, 23);
    assert.strictEqual(balaton.surface.millionM3PerCm, 5.94);

    // The lakes ride in the readings table alongside the gauges. If one ever leaked into
    // the balance, a level in centimetres would be summed as a discharge in m3/s.
    const balance = (await get('/api/v1/balance')).body;
    const summed = [...balance.inflow.stations, ...balance.outflow.stations].map((s) => s.id);
    assert.ok(!summed.some((id) => body.lakes.some((l) => l.id === id)));
  });
});

test('the Tisza-tó appears without a level and explains itself', async () => {
  await withServer(async ({ get }) => {
    const { body } = await get('/api/v1/lakes/tisza-to');
    assert.strictEqual(body.measured, false);
    assert.strictEqual(body.current, null);
    assert.match(body.unavailableReason, /Kisköre|kiskörei/);
  });
});

test('GET /api/v1/powerplants separates withdrawal from consumption', async () => {
  await withServer(async ({ get }) => {
    const { body } = await get('/api/v1/powerplants');
    const paks = body.plants.find((p) => p.id === 'paks-1');

    assert.ok(paks.water.withdrawalM3s > 50);
    assert.ok(paks.water.consumptionM3s < 1);
    assert.ok(
      Math.abs(paks.water.withdrawalM3s - (paks.water.dischargeM3s + paks.water.consumptionM3s)) < 0.01,
      'withdrawal must equal discharge plus consumption',
    );
    assert.strictEqual(paks.generation.confidence, 'measured');
  });
});

test('estimated per-plant figures carry their caveat all the way to the response', async () => {
  await withServer(async ({ get }) => {
    const { body } = await get('/api/v1/powerplants');
    const gas = body.plants.filter((p) => p.generation.confidence === 'estimated');

    assert.ok(gas.length > 0);
    assert.ok(gas.every((p) => p.generation.caveat), 'every estimate must explain itself');
  });
});

test('GET /api/v1/water-use ranks plants by withdrawal', async () => {
  await withServer(async ({ get }) => {
    const { body } = await get('/api/v1/water-use');
    const withdrawals = body.byPlant.map((p) => p.withdrawalM3s);
    assert.deepStrictEqual(withdrawals, [...withdrawals].sort((a, b) => b - a));
    assert.strictEqual(body.byPlant[0].id, 'paks-1');
  });
});

test('GET /api/v1/geojson is a valid FeatureCollection with usable weights', async () => {
  await withServer(async ({ get }) => {
    const { body } = await get('/api/v1/geojson');
    assert.strictEqual(body.type, 'FeatureCollection');
    assert.ok(body.features.length > 20);

    for (const feature of body.features) {
      assert.strictEqual(feature.geometry.type, 'Point');
      const [lon, lat] = feature.geometry.coordinates;
      // Everything must land inside Hungary's bounding box.
      assert.ok(lon > 16 && lon < 23, `lon ${lon} outside Hungary`);
      assert.ok(lat > 45.5 && lat < 48.8, `lat ${lat} outside Hungary`);
      assert.ok(feature.properties.weight >= 0 && feature.properties.weight <= 1);
    }
  });
});

test('GET /api/v1/meta/sources documents limitations, not just URLs', async () => {
  await withServer(async ({ get }) => {
    const { body } = await get('/api/v1/meta/sources');
    assert.ok(body.upstream.length >= 2);
    assert.ok(body.derived.every((d) => Array.isArray(d.caveats) && d.caveats.length > 0));
    assert.match(body.attribution, /OVF/);
  });
});

test('history endpoints reject an inverted range', async () => {
  await withServer(async ({ get }) => {
    const { status, body } = await get('/api/v1/balance/history?from=2026-09-01&to=2026-08-01');
    assert.strictEqual(status, 400);
    assert.match(body.error, /earlier/);
  });
});

test('unknown routes return a helpful 404', async () => {
  await withServer(async ({ get }) => {
    const { status, body } = await get('/api/v1/nope');
    assert.strictEqual(status, 404);
    assert.ok(body.hint.includes('/api/v1/snapshot'));
  });
});

test('production refuses to serve synthetic data without an explicit opt-in', () => {
  const unsafe = loadConfig({ NODE_ENV: 'production', DATA_PROVIDER: 'fixture' });
  assert.throws(() => assertProviderSafe(unsafe), /Refusing to start/);

  const optedIn = loadConfig({
    NODE_ENV: 'production',
    DATA_PROVIDER: 'fixture',
    ALLOW_FIXTURE_IN_PRODUCTION: 'true',
  });
  assert.doesNotThrow(() => assertProviderSafe(optedIn));

  const live = loadConfig({ NODE_ENV: 'production', DATA_PROVIDER: 'live' });
  assert.doesNotThrow(() => assertProviderSafe(live));
});

test('GET /api/v1/powerplants/:id returns a single plant', async () => {
  // The list route and the detail route take different paths through the domain layer;
  // covering only the list left a reference error in the detail one invisible.
  await withServer(async ({ get }) => {
    const { status, body } = await get('/api/v1/powerplants/paks-1');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.id, 'paks-1');
    assert.ok(body.water.withdrawalM3s > 0);
    assert.ok(body.thermalLoad, 'a once-through plant must report its thermal load');
  });
});

test('the units model reports how many units it assumed', async () => {
  await withServer(async ({ get }) => {
    const { body } = await get('/api/v1/powerplants/paks-1?model=units');
    assert.strictEqual(body.water.model, 'units');
    assert.ok(body.units, 'unit accounting must be exposed');
    assert.strictEqual(body.units.total, 4);
    assert.strictEqual(body.units.known, false, 'inferred, not measured');
    assert.ok(body.water.notes.some((n) => /lower bound/.test(n)));
  });
});

test('at part load the units model reports more water than the linear one', async () => {
  // Pumps belong to a unit, not to its output. This is the gap that matters when a
  // plant has been throttled back - exactly when someone looks.
  await withServer(async ({ get }) => {
    const linear = await get('/api/v1/powerplants/paks-1?model=linear');
    const units = await get('/api/v1/powerplants/paks-1?model=units');
    assert.ok(units.body.water.withdrawalM3s >= linear.body.water.withdrawalM3s);
  });
});
