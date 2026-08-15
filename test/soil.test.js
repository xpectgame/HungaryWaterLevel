'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildSoil, rankSoil, BANDS } = require('../src/domain/soil');
const { build, KIND } = require('../scripts/build-soil-stations');

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** One station, one calendar month of record, so the bands can be driven exactly. */
const DOC = {
  unit: '%',
  quantiles: [5, 25, 50, 75, 95],
  stations: {
    'talaj-1': {
      name: 'Teszt',
      months: Array.from({ length: 12 }, (_, m) => (m === 7
        ? { p: [10, 15, 20, 26, 32], min: 8, max: 35, days: 62, years: 2 }
        : null)),
    },
  },
};

const REGISTRY = {
  source: 'test',
  kind: KIND,
  coverage: 'teszt',
  hasSensorDepth: false,
  hasSoilType: false,
  stations: [{ id: 'talaj-1', name: 'Teszt', settlement: 'Teszt', lat: 46.5, lon: 20.5 }],
};

const AUGUST = new Date('2026-08-15T09:00:00Z');

test('a reading below everything on record is a record low, not a percentile', () => {
  const r = rankSoil('talaj-1', 7, { at: AUGUST, document: DOC });
  assert.equal(r.band, 'record-low');
});

test('the bands step through the record in order', () => {
  const at = AUGUST;
  assert.equal(rankSoil('talaj-1', 10, { at, document: DOC }).band, 'very-low');
  assert.equal(rankSoil('talaj-1', 12, { at, document: DOC }).band, 'low');
  assert.equal(rankSoil('talaj-1', 15, { at, document: DOC }).band, 'low');
  assert.equal(rankSoil('talaj-1', 22, { at, document: DOC }).band, 'middle');
  assert.equal(rankSoil('talaj-1', 30, { at, document: DOC }).band, 'high');
  assert.equal(rankSoil('talaj-1', 40, { at, document: DOC }).band, 'record-high');
});

test('a month with no record ranks to null rather than borrowing another month', () => {
  // A station that started in March has no February. Filling it from March would be the
  // quietest possible way to be wrong.
  const r = rankSoil('talaj-1', 20, { at: new Date('2026-02-10T09:00:00Z'), document: DOC });
  assert.equal(r, null);
});

test('every ranking carries how many years are behind it', () => {
  // The whole reason this field exists: one year cannot say "usually", and a consumer
  // that renders a one-year band in the words of a ten-year band is overclaiming.
  const r = rankSoil('talaj-1', 20, { at: AUGUST, document: DOC });
  assert.equal(r.years, 2);
  assert.deepEqual(r.p, [10, 15, 20, 26, 32]);
  assert.equal(r.min, 8);
  assert.equal(r.max, 35);
});

test('a missing or unreadable value ranks to null', () => {
  assert.equal(rankSoil('talaj-1', null, { at: AUGUST, document: DOC }), null);
  assert.equal(rankSoil('talaj-1', NaN, { at: AUGUST, document: DOC }), null);
  assert.equal(rankSoil('nincs-ilyen', 20, { at: AUGUST, document: DOC }), null);
});

test('no band is called normal', () => {
  // One year of record has no "usually" in it, so no label may imply one.
  for (const b of BANDS) {
    assert.ok(!/normál|normal|szokásos/i.test(b.hu), `band "${b.code}" claims a normal: ${b.hu}`);
  }
});

test('buildSoil places a live reading and reports the network it came from', () => {
  const out = buildSoil(
    { 'talaj-1': { value: 12, at: '2026-08-15T09:00:00Z', samples: 72 } },
    { registry: REGISTRY, document: DOC, now: AUGUST },
  );
  assert.equal(out.available, true);
  assert.equal(out.count, 1);
  assert.equal(out.measuredCount, 1);
  assert.equal(out.rankedCount, 1);
  assert.equal(out.dryCount, 1);
  assert.equal(out.stations[0].current.percent, 12);
  assert.equal(out.stations[0].current.history.band, 'low');
  assert.equal(out.stations[0].current.ageMinutes, 0);
  // The coverage caveat travels in the response, not only in the registry.
  assert.match(out.coverage, /teszt/);
  assert.equal(out.hasSensorDepth, false);
});

test('a station that did not report is kept, with a reason', () => {
  // Dropping it would make a network that shrank look identical to one whose readings
  // all moved, and only one of those is news.
  const out = buildSoil({}, { registry: REGISTRY, document: DOC, now: AUGUST });
  assert.equal(out.count, 1);
  assert.equal(out.measuredCount, 0);
  assert.equal(out.stations[0].current, null);
  assert.match(out.stations[0].unavailableReason, /nem jelentett/);
  assert.equal(out.driest, null);
});

test('the national figure is a count, never a mean of the percentages', () => {
  // A mean of readings from unknown soils at unknown depths has no referent, and would
  // move when a station broke.
  const out = buildSoil(
    { 'talaj-1': { value: 12, at: AUGUST.toISOString() } },
    { registry: REGISTRY, document: DOC, now: AUGUST },
  );
  for (const key of Object.keys(out)) {
    assert.ok(!/mean|avg|atlag|átlag/i.test(key), `${key} looks like an average of percentages`);
  }
});

/* --- the registry builder ------------------------------------------------- */

function scanFile(wells) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'soil-')), 'scan.json');
  fs.writeFileSync(file, JSON.stringify([{ adatFajtaKod: 299, adatTipusKod: 100, answered: wells.length, wells }]));
  return file;
}

const WELL = { tsz: 1322, name: 'Hódmezővásárhely', telepules: 'Hódmezővásárhely', lat: 46.46134, lon: 20.36012, vizig: 14, samples: 8604 };

test('the registry keys stations by the portal station number', () => {
  const doc = build(scanFile([WELL]));
  assert.equal(doc.stations[0].id, 'talaj-1322');
  assert.equal(doc.stations[0].tsz, 1322);
  assert.equal(doc.count, 1);
});

test('a station with no coordinates is dropped and counted', () => {
  const doc = build(scanFile([WELL, { ...WELL, tsz: 2, lat: null, lon: null }]));
  assert.equal(doc.count, 1);
  assert.equal(doc.droppedRows, 1);
});

test('the registry announces the three things the source does not publish', () => {
  const doc = build(scanFile([WELL]));
  assert.equal(doc.hasSensorDepth, false);
  assert.equal(doc.hasSoilType, false);
  assert.equal(doc.hasWiltingPoint, false);
  assert.match(doc.coverage, /nem országos/);
});

test('a scan with no soil-moisture rows is an error, not an empty registry', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'soil-')), 'other.json');
  fs.writeFileSync(file, JSON.stringify([{ adatFajtaKod: 78, wells: [WELL] }]));
  assert.throws(() => build(file), /no AdatFajtaKod 299/);
});

test('the baked registry is committed and every station is inside Hungary', () => {
  const reg = require('../src/config/soil-stations.json');
  assert.equal(reg.count, reg.stations.length);
  assert.equal(reg.kind.adatFajtaKod, 299);
  for (const s of reg.stations) {
    assert.ok(s.lon > 15.8 && s.lon < 23.2, `${s.name} lon ${s.lon}`);
    assert.ok(s.lat > 45.6 && s.lat < 48.7, `${s.name} lat ${s.lat}`);
  }
});
