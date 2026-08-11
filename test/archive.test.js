'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildDay, dayToCsv, baselineStamp, COLUMNS } = require('../src/jobs/archive');
const { createStore } = require('../src/store');
const { loadConfig } = require('../src/config');

/**
 * The archive is the one part of this project whose job is to still be right in ten
 * years. Everything here is about that: a day written once, a baseline recorded with
 * it, and nothing quietly deleted.
 */

/**
 * The memory store writes synchronously and the postgres one does not, so this awaits
 * whatever it gets back rather than assuming a promise - the first version called .then
 * on a number.
 */
async function storeWith(readings) {
  const store = createStore({ ...loadConfig({ DATA_PROVIDER: 'fixture' }), store: 'memory' });
  await store.putStationReadings(readings);
  return store;
}

const DAY = '2026-08-11';
const at = (h) => `${DAY}T${String(h).padStart(2, '0')}:00:00.000Z`;

test('a day carries min, mean and max, not just a mean', () => {
  // A daily mean hides the day a flood wave passed through. This file has to answer
  // questions nobody has thought of yet, and the extremes are where those live.
  return storeWith([
    { stationId: 'tisza-szeged', timestamp: at(0), flowM3s: 100, waterLevelCm: 200, quality: 'measured', source: 't' },
    { stationId: 'tisza-szeged', timestamp: at(12), flowM3s: 300, waterLevelCm: 260, quality: 'measured', source: 't' },
  ]).then(async (store) => {
    const day = await buildDay(store, `${DAY}T12:00:00Z`);
    const row = day.rows.find((r) => r.station_id === 'tisza-szeged');
    assert.strictEqual(row.flow_min_m3s, 100);
    assert.strictEqual(row.flow_mean_m3s, 200);
    assert.strictEqual(row.flow_max_m3s, 300);
    assert.strictEqual(row.samples, 2);
    await store.close();
  });
});

test('a day contains only its own readings', () => {
  // The whole premise is that a dated file is about that date. A boundary that leaks
  // makes every figure in the archive slightly wrong in a way nobody would ever catch.
  return storeWith([
    { stationId: 'tisza-szeged', timestamp: '2026-08-10T23:59:59.000Z', flowM3s: 999, quality: 'measured', source: 't' },
    { stationId: 'tisza-szeged', timestamp: at(12), flowM3s: 100, quality: 'measured', source: 't' },
    { stationId: 'tisza-szeged', timestamp: '2026-08-12T00:00:00.000Z', flowM3s: 999, quality: 'measured', source: 't' },
  ]).then(async (store) => {
    const day = await buildDay(store, `${DAY}T12:00:00Z`);
    const row = day.rows.find((r) => r.station_id === 'tisza-szeged');
    assert.strictEqual(row.samples, 1, 'the neighbouring days must not leak in');
    assert.strictEqual(row.flow_max_m3s, 100);
    await store.close();
  });
});

test('a station with no readings that day is absent, not a row of nulls', () => {
  // A row of nulls asserts "we measured and found nothing". Absence asserts nothing,
  // which is the truth when a gauge simply did not report.
  return storeWith([
    { stationId: 'tisza-szeged', timestamp: at(12), flowM3s: 100, quality: 'measured', source: 't' },
  ]).then(async (store) => {
    const day = await buildDay(store, `${DAY}T12:00:00Z`);
    assert.strictEqual(day.rows.length, 1);
    await store.close();
  });
});

test('the CSV is self-describing: every column names its unit', () => {
  // Someone opens this in 2036 with none of this code. A column called `flow` would be
  // unreadable; `flow_mean_m3s` is not.
  for (const c of COLUMNS.filter((c) => /flow|level/.test(c))) {
    assert.match(c, /_(m3s|cm)$/, `${c} does not say its unit`);
  }
  assert.ok(COLUMNS.includes('date'), 'every row carries its own date, so files concatenate');
  assert.ok(COLUMNS.includes('station_name'), 'an id alone is not readable without this repository');
});

test('the CSV of an empty day is a header, not an empty file', () => {
  assert.strictEqual(dayToCsv({ date: DAY, rows: [] }), COLUMNS.join(',') + '\r\n');
});

test('the baseline is stamped, because the yardstick moves', () => {
  // "53% of normal" is only reconstructable later if the normal it used is recorded
  // with it. Without this, a reader in 2036 cannot tell whether a difference is in the
  // rivers or in what we compared them to.
  const b = baselineStamp();
  assert.ok(Number.isInteger(b.schema));
  assert.ok('flowHistory' in b && 'lakeHistory' in b);
  assert.ok(typeof b.flowHistory.present === 'boolean');
  assert.match(b.note, /rebaked/);
});

test('retention defaults to keeping everything', () => {
  // This defaulted to 400 days, which made the project a rolling window that could show
  // what was happening and prove nothing about what had happened.
  assert.strictEqual(loadConfig({}).retentionDays, 0);
  assert.strictEqual(loadConfig({ RETENTION_DAYS: '400' }).retentionDays, 400, 'still settable');
});
