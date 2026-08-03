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

const HOUR = 3600 * 1000;

function reading(stationId, ts, flow) {
  return { stationId, timestamp: new Date(ts).toISOString(), flowM3s: flow, source: 'test', quality: 'measured' };
}

for (const [name, create] of implementations) {
  test(`${name}: stores and returns the latest reading per station`, () => {
    const store = create();
    const now = Date.now();

    store.putStationReadings({
      a: reading('duna-rajka', now - HOUR, 1900),
      b: reading('tisza-tiszabecs', now - HOUR, 140),
    });
    store.putStationReadings({ a: reading('duna-rajka', now, 2100) });

    const latest = store.latestReadings();
    assert.strictEqual(latest['duna-rajka'].flowM3s, 2100);
    assert.strictEqual(latest['tisza-tiszabecs'].flowM3s, 140);
    store.close();
  });

  test(`${name}: drops readings older than the freshness window`, () => {
    const store = create();
    store.putStationReadings({ a: reading('duna-rajka', Date.now() - 10 * HOUR, 2000) });

    assert.strictEqual(Object.keys(store.latestReadings()).length, 1);
    assert.strictEqual(Object.keys(store.latestReadings(6 * HOUR)).length, 0);
    store.close();
  });

  test(`${name}: upserts rather than duplicating the same timestamp`, () => {
    const store = create();
    const ts = Date.now();

    store.putStationReadings({ a: reading('duna-rajka', ts, 2000) });
    store.putStationReadings({ a: reading('duna-rajka', ts, 2500) });

    assert.strictEqual(store.stats().stationReadings, 1);
    assert.strictEqual(store.latestReadings()['duna-rajka'].flowM3s, 2500);
    store.close();
  });

  test(`${name}: readingAt finds the nearest sample inside the tolerance`, () => {
    const store = create();
    const now = Date.now();

    store.putStationReadings({ a: reading('duna-rajka', now - 90 * HOUR, 1800) });
    store.putStationReadings({ b: reading('duna-rajka', now, 2400) });

    const lagged = store.readingAt('duna-rajka', now - 90 * HOUR);
    assert.strictEqual(lagged.flowM3s, 1800);

    // Nothing within tolerance of a gap in the record.
    assert.strictEqual(store.readingAt('duna-rajka', now - 40 * HOUR), null);
    store.close();
  });

  test(`${name}: stationSeries returns an ascending window`, () => {
    const store = create();
    const now = Date.now();

    for (let i = 5; i >= 0; i -= 1) {
      store.putStationReadings({ a: reading('duna-rajka', now - i * HOUR, 2000 + i) });
    }

    const series = store.stationSeries('duna-rajka', now - 3 * HOUR, now);
    assert.strictEqual(series.length, 4);
    const times = series.map((r) => Date.parse(r.timestamp));
    assert.deepStrictEqual(times, [...times].sort((a, b) => a - b));
    store.close();
  });

  test(`${name}: round-trips generation and balance snapshots`, () => {
    const store = create();
    const now = new Date().toISOString();

    store.putGeneration({ timestamp: now, source: 'test', generationMw: { nuclear: 1980, naturalGas: 900 } });
    assert.strictEqual(store.latestGeneration().generationMw.nuclear, 1980);

    const balance = computeBalance({}, { now: Date.now() });
    store.putBalance(balance);

    const stored = store.latestBalance();
    assert.strictEqual(stored.net.m3s, balance.net.m3s);
    assert.strictEqual(store.balanceSeries(Date.now() - HOUR, Date.now() + HOUR).length, 1);
    store.close();
  });

  test(`${name}: reports poll status`, () => {
    const store = create();
    assert.strictEqual(store.lastPoll(), null);

    store.logPoll(true, { stationsStored: 29 });
    const last = store.lastPoll();
    assert.strictEqual(last.ok, true);
    assert.strictEqual(last.detail.stationsStored, 29);
    store.close();
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

  // Only the Danube has history reaching back to its 90 h travel time.
  store.putStationReadings({ a: reading('duna-rajka', now - 90 * HOUR, 1800) });
  store.putStationReadings({ b: reading('duna-rajka', now, 2000) });

  const balance = computeBalance(store.latestReadings(), {
    method: 'lagged',
    now,
    historyLookup: (id, atMs) => store.readingAt(id, atMs),
  });

  assert.strictEqual(balance.method, 'lagged');
  assert.strictEqual(balance.inflow.laggedCount, 1);
  assert.ok(balance.dataQuality.warnings.some((w) => w.includes('1 of 20 inflow stations')));
});
