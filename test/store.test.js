'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MemoryStore } = require('../src/store/memory');
const { TimeseriesStore } = require('../src/store/timeseries');
const { loadConfig } = require('../src/config');
const { computeBalance } = require('../src/domain/balance');

/**
 * Both stores back the same routes, so they are held to one contract. A behaviour that
 * only holds for SQLite would break the serverless deployment silently.
 */
const implementations = [
  ['MemoryStore', () => new MemoryStore()],
  ['TimeseriesStore', () => new TimeseriesStore(':memory:')],
];

// The Postgres store joins the same contract when a database is available. Without one
// the suite still passes - but then the serverless deployment path is untested, so CI
// for that path must set TEST_DATABASE_URL.
if (process.env.TEST_DATABASE_URL) {
  const { PostgresStore } = require('../src/store/postgres');
  implementations.push([
    'PostgresStore',
    async () => {
      const store = new PostgresStore(process.env.TEST_DATABASE_URL, { schema: 'test_store' });
      await store.init();
      // Each case starts from a clean slate; these tests own the database.
      await truncateAll(store);
      return store;
    },
  ]);
}

const HOUR = 3600 * 1000;

/**
 * Qualify table names the same way the store does.
 *
 * An unqualified TRUNCATE here would clear `public` while the store reads and writes its
 * own schema - which is precisely the production failure mode that made the store stop
 * relying on search_path in the first place.
 */
async function truncateAll(store) {
  const tables = ['station_readings', 'generation', 'balance_snapshots', 'poll_log']
    .map((t) => store.t(t))
    .join(', ');
  await store.query(`TRUNCATE ${tables}`);
}

function reading(stationId, ts, flow) {
  return { stationId, timestamp: new Date(ts).toISOString(), flowM3s: flow, source: 'test', quality: 'measured' };
}

for (const [name, create] of implementations) {
  test(`${name}: stores and returns the latest reading per station`, async () => {
    const store = await create();
    const now = Date.now();

    await store.putStationReadings({
      a: reading('duna-rajka', now - HOUR, 1900),
      b: reading('tisza-tiszabecs', now - HOUR, 140),
    });
    await store.putStationReadings({ a: reading('duna-rajka', now, 2100) });

    const latest = await store.latestReadings();
    assert.strictEqual(latest['duna-rajka'].flowM3s, 2100);
    assert.strictEqual(latest['tisza-tiszabecs'].flowM3s, 140);
    await store.close();
  });

  test(`${name}: drops readings older than the freshness window`, async () => {
    const store = await create();
    await store.putStationReadings({ a: reading('duna-rajka', Date.now() - 10 * HOUR, 2000) });

    assert.strictEqual(Object.keys(await store.latestReadings()).length, 1);
    assert.strictEqual(Object.keys(await store.latestReadings(6 * HOUR)).length, 0);
    await store.close();
  });

  test(`${name}: upserts rather than duplicating the same timestamp`, async () => {
    const store = await create();
    const ts = Date.now();

    await store.putStationReadings({ a: reading('duna-rajka', ts, 2000) });
    await store.putStationReadings({ a: reading('duna-rajka', ts, 2500) });

    assert.strictEqual((await store.stats()).stationReadings, 1);
    assert.strictEqual((await store.latestReadings())['duna-rajka'].flowM3s, 2500);
    await store.close();
  });

  test(`${name}: readingAt finds the nearest sample inside the tolerance`, async () => {
    const store = await create();
    const now = Date.now();

    await store.putStationReadings({ a: reading('duna-rajka', now - 90 * HOUR, 1800) });
    await store.putStationReadings({ b: reading('duna-rajka', now, 2400) });

    const lagged = await store.readingAt('duna-rajka', now - 90 * HOUR);
    assert.strictEqual(lagged.flowM3s, 1800);

    // Nothing within tolerance of a gap in the record.
    assert.strictEqual(await store.readingAt('duna-rajka', now - 40 * HOUR), null);
    await store.close();
  });

  test(`${name}: stationSeries returns an ascending window`, async () => {
    const store = await create();
    const now = Date.now();

    for (let i = 5; i >= 0; i -= 1) {
      await store.putStationReadings({ a: reading('duna-rajka', now - i * HOUR, 2000 + i) });
    }

    const series = await store.stationSeries('duna-rajka', now - 3 * HOUR, now);
    assert.strictEqual(series.length, 4);
    const times = series.map((r) => Date.parse(r.timestamp));
    assert.deepStrictEqual(times, [...times].sort((a, b) => a - b));
    await store.close();
  });

  test(`${name}: round-trips generation and balance snapshots`, async () => {
    const store = await create();
    const now = new Date().toISOString();

    await store.putGeneration({ timestamp: now, source: 'test', generationMw: { nuclear: 1980, naturalGas: 900 } });
    assert.strictEqual((await store.latestGeneration()).generationMw.nuclear, 1980);

    const balance = computeBalance({}, { now: Date.now() });
    await store.putBalance(balance);

    const stored = await store.latestBalance();
    assert.strictEqual(stored.net.m3s, balance.net.m3s);
    assert.strictEqual((await store.balanceSeries(Date.now() - HOUR, Date.now() + HOUR)).length, 1);
    await store.close();
  });

  test(`${name}: round-trips unit availability`, async () => {
    const store = await create();
    assert.strictEqual(await store.latestAvailability(), null);

    await store.putAvailability({ 'paks-1': { unitsOnline: 3, unitCount: 4 } });
    const stored = await store.latestAvailability();
    assert.strictEqual(stored['paks-1'].unitsOnline, 3);

    // The freshness window still applies. Wait first: a record written in this same
    // millisecond is genuinely fresh, so asserting otherwise tests the clock, not the store.
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.strictEqual(await store.latestAvailability(1), null);
    await store.close();
  });

  test(`${name}: reports poll status`, async () => {
    const store = await create();
    assert.strictEqual(await store.lastPoll(), null);

    await store.logPoll(true, { stationsStored: 29 });
    const last = await store.lastPoll();
    assert.strictEqual(last.ok, true);
    assert.strictEqual(last.detail.stationsStored, 29);
    await store.close();
  });
}

test('MemoryStore bounds its buffers so a long-lived instance cannot grow forever', () => {
  const store = new MemoryStore({ maxSamplesPerStation: 10 });
  const now = Date.now();

  for (let i = 0; i < 50; i += 1) {
    store.putStationReadings({ a: reading('duna-rajka', now + i * 1000, 2000 + i) });
  }

  assert.strictEqual(store.stats().stationReadings, 10);
  // The newest samples are the ones kept.
  assert.strictEqual(store.latestReadings()['duna-rajka'].flowM3s, 2049);
  store.close();
});

test('MemoryStore declares that it is not persistent', () => {
  const store = new MemoryStore();
  assert.strictEqual(store.stats().persistent, false);
  store.close();
});

test('stateless config selects memory store and on-demand refresh', () => {
  const config = loadConfig({ STATELESS: 'true' });
  assert.strictEqual(config.store, 'memory');
  assert.strictEqual(config.lazyRefresh, true);
  assert.strictEqual(config.backgroundPolling, false);
});

test('Vercel is detected without any explicit configuration', () => {
  const config = loadConfig({ VERCEL: '1' });
  assert.strictEqual(config.stateless, true);
  assert.strictEqual(config.store, 'memory');

  // ...but an explicit opt-out still wins.
  const overridden = loadConfig({ VERCEL: '1', STATELESS: 'false' });
  assert.strictEqual(overridden.stateless, false);
  assert.strictEqual(overridden.store, 'sqlite');
});

test('a server deployment keeps the background poller and SQLite', () => {
  const config = loadConfig({});
  assert.strictEqual(config.store, 'sqlite');
  assert.strictEqual(config.backgroundPolling, true);
  assert.strictEqual(config.lazyRefresh, false);
});

test('lagged degrades to instant when the store holds no history', () => {
  const store = new MemoryStore();
  const now = Date.now();
  store.putStationReadings({ a: reading('duna-rajka', now, 2000) });

  const balance = computeBalance(store.latestReadings(), {
    method: 'lagged',
    now,
    historyLookup: (id, atMs) => store.readingAt(id, atMs),
  });

  // The label must follow what happened, not what was asked for.
  assert.strictEqual(balance.requestedMethod, 'lagged');
  assert.strictEqual(balance.method, 'instant');
  assert.strictEqual(balance.inflow.laggedCount, 0);
  assert.ok(balance.dataQuality.warnings.some((w) => w.includes('this is an instant comparison')));
});

test('partial history stays lagged but says how much was actually shifted', () => {
  const store = new MemoryStore();
  const now = Date.now();

  // Only the Danube has history reaching back to its 80 h travel time.
  store.putStationReadings({ a: reading('duna-komarom', now - 80 * HOUR, 1800) });
  store.putStationReadings({ b: reading('duna-komarom', now, 2000) });

  const balance = computeBalance(store.latestReadings(), {
    method: 'lagged',
    now,
    historyLookup: (id, atMs) => store.readingAt(id, atMs),
  });

  assert.strictEqual(balance.method, 'lagged');
  assert.strictEqual(balance.inflow.laggedCount, 1);
  assert.ok(balance.dataQuality.warnings.some((w) => w.includes('1 of 20 inflow stations')));
});

if (process.env.TEST_DATABASE_URL) {
  const { PostgresStore } = require('../src/store/postgres');

  test('PostgresStore: a schema actually isolates the tables', async () => {
    // The bug this guards against: relying on search_path, which connection poolers in
    // transaction mode (Supabase's Supavisor, PgBouncer) may not forward. The store
    // would then read and write `public` while believing it was using the schema -
    // silently, and only in production, because a direct connection works fine.
    const a = new PostgresStore(process.env.TEST_DATABASE_URL, { schema: 'iso_a' });
    const b = new PostgresStore(process.env.TEST_DATABASE_URL, { schema: 'iso_b' });

    await a.init();
    await b.init();
    await truncateAll(a);
    await truncateAll(b);

    await a.putStationReadings({ x: reading('duna-rajka', Date.now(), 1111) });

    assert.strictEqual((await a.stats()).stationReadings, 1);
    assert.strictEqual((await b.stats()).stationReadings, 0, 'schema b must not see schema a rows');

    // And the qualified name is what actually reached the server.
    const { rows } = await b.query(
      `SELECT table_schema FROM information_schema.tables
        WHERE table_name = 'station_readings' AND table_schema IN ('iso_a','iso_b')
        ORDER BY table_schema`,
    );
    assert.deepStrictEqual(rows.map((r) => r.table_schema), ['iso_a', 'iso_b']);

    await a.close();
    await b.close();
  });

  test('PostgresStore: rejects a schema name that is not a plain identifier', () => {
    assert.throws(
      () => new PostgresStore(process.env.TEST_DATABASE_URL, { schema: 'a; DROP TABLE x' }),
      /must be a plain SQL identifier/,
    );
  });
}
