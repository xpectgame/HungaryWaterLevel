'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { rankWell, wellStatus } = require('../src/domain/flow-history');
const { assess } = require('../src/domain/groundwater');
const { listWells, wellCoverage, WELL_KIND } = require('../src/config/wells');

/**
 * A well shaped like the real ones: a depth of about eighty metres below its own datum,
 * reported as a negative number, that barely moves across a decade.
 *
 * The numbers are Ragály K-1's actual ten-year August, because the case this whole module
 * exists to survive is that well's live feed disagreeing with its own archive.
 */
const AUGUST = {
  p: [-81.4, -81.2, -80.9, -80.61, -80.3, -80.05, -79.9],
  min: { value: -81.6, year: 2022, day: '2022-08-29' },
  max: { value: -79.8, year: 2019, day: '2019-08-03' },
  days: 280,
  years: 10,
};

function doc(entry = { months: months(AUGUST), unit: 'raw', rankable: true }) {
  return { 'ragaly-k-1': entry };
}

function months(august) {
  const out = Array.from({ length: 12 }, () => null);
  out[7] = august;
  return out;
}

const inAugust = (document) => ({ at: Date.UTC(2026, 7, 11), document });

test('a well is ranked against its own record for the calendar month', () => {
  const ranked = rankWell('ragaly-k-1', -80.61, inAugust(doc()));
  assert.ok(ranked, 'the median day should rank');
  assert.equal(ranked.month, 8);
  assert.ok(Math.abs(ranked.percentile - 50) < 1, `median should sit near p50, got ${ranked.percentile}`);
  assert.equal(ranked.band, 'normal');
});

test('a genuine record low still ranks, and says so', () => {
  // Twenty centimetres below the ten-year minimum: the reading that matters most, and
  // the one a sloppy outlier filter would throw away.
  const ranked = rankWell('ragaly-k-1', -81.8, inAugust(doc()));
  assert.ok(ranked, 'a record low must not be refused as implausible');
  assert.equal(ranked.belowRecord, true);
  assert.equal(ranked.band, 'record-low');
});

/**
 * The bug this guard was written for, in the exact form it appeared.
 *
 * Ragály K-1's archive is in negative metres and its live feed came back as +8039 -
 * eighty metres down, with the sign flipped and the unit multiplied by a hundred. Ranked
 * naively it is not merely wrong, it is the highest groundwater level in the record,
 * printed as a headline during a drought.
 */
test('a reading in a different convention from its own archive is refused, not ranked', () => {
  assert.equal(wellStatus('ragaly-k-1', 8039, inAugust(doc())), 'incommensurable');
  assert.equal(rankWell('ragaly-k-1', 8039, inAugust(doc())), null);
});

test('the same refusal for a hundredfold unit change with the sign intact', () => {
  // Budajenő-2: archive at -81.22 metres, feed at -8156.95 centimetres. Same water.
  assert.equal(wellStatus('ragaly-k-1', -8061, inAugust(doc())), 'incommensurable');
});

test('a stable well does not reject an ordinary seasonal swing', () => {
  // Four of these wells have a ten-year span under a metre. A margin built only from the
  // span would refuse a perfectly normal reading half a metre out.
  const ranked = rankWell('ragaly-k-1', -82.1, inAugust(doc()));
  assert.ok(ranked, 'half a metre outside a very tight record is still the same measurement');
});

test('the four ways a well can drop out are reported apart, not as one null', () => {
  assert.equal(wellStatus('no-such-well', -80, inAugust(doc())), 'no-record');
  assert.equal(wellStatus('ragaly-k-1', null, inAugust(doc())), 'no-reading');
  // February has no baked record on this fixture.
  assert.equal(wellStatus('ragaly-k-1', -80.61, { at: Date.UTC(2026, 1, 11), document: doc() }), 'no-month');
  assert.equal(
    wellStatus('ragaly-k-1', -80.61, inAugust(doc({ months: months(AUGUST), rankable: false }))),
    'unrankable',
  );
});

test('a depth is never turned into a ratio or labelled with a unit it does not have', () => {
  const ranked = rankWell('ragaly-k-1', -80.61, inAugust(doc()));
  assert.equal(ranked.ratioToMedian, undefined, 'a ratio between two depths from an arbitrary datum means nothing');
  assert.equal(ranked.medianM3s, undefined, 'a groundwater depth is not a discharge');
  assert.equal(ranked.unit, 'raw', 'the document must not claim to know the unit');
  assert.equal(ranked.medianRaw, -80.61);
});

/* --- the national aggregate ------------------------------------------------ */

test('the aggregate counts wells, and never averages a level', () => {
  const wells = listWells();
  assert.ok(wells.length > 50, 'the registry should be populated');

  // Two real wells from the registry, given a fabricated history each so the test does
  // not depend on what the last bake happened to produce.
  const [a, b] = wells;
  const document = {
    [a.id]: { months: months(AUGUST), unit: 'raw', rankable: true },
    [b.id]: { months: months(AUGUST), unit: 'raw', rankable: true },
  };
  const at = new Date(Date.UTC(2026, 7, 11));
  const readings = {
    [a.id]: { value: -81.7, at: '2026-08-10T06:00:00Z' },   // record low
    [b.id]: { value: -80.61, at: '2026-08-10T06:00:00Z' },  // dead normal
  };

  const out = assess(readings, { at, document });
  assert.equal(out.summary.comparable, 2);
  assert.equal(out.summary.recordLow, 1);
  assert.equal(out.summary.low, 1);

  // Structural rather than a search through the prose: no field in the summary may be a
  // mean of levels, because the moment one exists somebody will plot it.
  const numericFields = Object.entries(out.summary).filter(([, v]) => typeof v === 'number');
  for (const [key] of numericFields) {
    assert.ok(!/mean|avg|average|level/i.test(key), `summary.${key} looks like an averaged level`);
  }
  assert.ok(numericFields.length >= 4, 'the summary should still be reporting counts');
});

test('a reading too old to be "now" is excluded from the count rather than ranked', () => {
  const [a] = listWells();
  const document = { [a.id]: { months: months(AUGUST), unit: 'raw', rankable: true } };
  const at = new Date(Date.UTC(2026, 7, 11));

  const fresh = assess({ [a.id]: { value: -81.7, at: '2026-08-10T06:00:00Z' } }, { at, document });
  assert.equal(fresh.summary.comparable, 1);

  // Same value, read in April. It would rank perfectly well against August's distribution
  // and join the count as if it were current, which is how a shrinking network turns
  // into a trend.
  const stale = assess({ [a.id]: { value: -81.7, at: '2026-04-02T06:00:00Z' } }, { at, document });
  assert.equal(stale.summary.comparable, 0);
  assert.equal(stale.summary.statuses.stale, 1);
});

test('the coverage block names the directorates that are missing', () => {
  const coverage = wellCoverage();
  assert.ok(coverage.wells > 50);
  assert.ok(coverage.directorates.length >= 5);
  assert.ok(Array.isArray(coverage.missingDirectorates));
  assert.ok(coverage.note.includes('rétegvíz') || coverage.note.includes('Confined'));
});

test('the registry never lets rétegvíz be labelled talajvíz', () => {
  assert.equal(WELL_KIND.adatFajtaKod, 70);
  assert.match(WELL_KIND.note, /NOT talajv[ií]z/i);
  // 69 is the shallow table and returns nothing anywhere; if a future change starts
  // asking for it, the label has to change with it.
  assert.notEqual(WELL_KIND.adatFajtaKod, 69);
});

test('every registered well has the datum its reading is measured against', () => {
  for (const well of listWells()) {
    assert.equal(typeof well.nptM, 'number', `${well.id} has no datum`);
    assert.ok(well.nptM > 60 && well.nptM < 1000, `${well.id} datum ${well.nptM} is not a Hungarian elevation`);
    assert.ok(well.lat > 45.7 && well.lat < 48.7, `${well.id} is outside Hungary`);
    assert.ok(well.lon > 16 && well.lon < 23, `${well.id} is outside Hungary`);
  }
});
