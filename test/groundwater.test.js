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
  // 69 is the shallow table, and it is served - on vmoType 12, not here. If this
  // registry ever starts asking for it, the label has to change with it or the page
  // will call the confined aquifer by the shallow table's name.
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

/* --- the HTTP surface ------------------------------------------------------ */

const { createApp } = require('../src/create-app');
const { createStore } = require('../src/store');
const { TtlCache } = require('../src/lib/cache');
const { loadConfig } = require('../src/config');

async function withServer(fn) {
  const config = {
    ...loadConfig({ DATA_PROVIDER: 'fixture', DB_PATH: ':memory:' }),
    dbPath: ':memory:', provider: 'fixture', pollOnStart: false, cacheTtlMs: 0,
    store: 'sqlite', lazyRefresh: false,
  };
  const store = createStore(config);
  const app = createApp({ config, store, cache: new TtlCache(0) });
  const server = app.listen(0);
  const port = server.address().port;
  const get = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: await res.json() };
  };
  try { await fn({ get }); } finally { server.close(); await store.close(); }
}

test('GET /groundwater ranks the network and admits what it could not rank', async () => {
  await withServer(async ({ get }) => {
    const { status, body } = await get('/api/v1/groundwater');
    assert.equal(status, 200);
    assert.equal(body.synthetic, true, 'the fixture must announce itself');
    assert.ok(body.summary.registered > 50);
    assert.ok(body.summary.comparable > 0, 'the fixture has to exercise the ranking, not bypass it');
    assert.ok(body.summary.comparable <= body.summary.registered);
    assert.ok(body.summary.statuses, 'the reasons wells dropped out have to be in the payload');
    assert.ok(body.coverage.missingDirectorates, 'the holes in the network are part of the answer');

    // The rule the whole module exists for.
    for (const [key, value] of Object.entries(body.summary)) {
      if (typeof value === 'number') assert.ok(!/mean|avg|level/i.test(key), `summary.${key}`);
    }
  });
});

test('GET /groundwater/:id carries the datum and the record it was judged against', async () => {
  await withServer(async ({ get }) => {
    const { body: all } = await get('/api/v1/groundwater');
    const first = all.wells.find((w) => w.rank);
    assert.ok(first, 'at least one well should rank under the fixture');

    const { status, body } = await get(`/api/v1/groundwater/${first.id}`);
    assert.equal(status, 200);
    assert.equal(typeof body.well.nptM, 'number');
    assert.match(body.well.datumNote, /Baltic/);
    assert.ok(body.history && Array.isArray(body.history.months));
    assert.equal(body.current.id, first.id);

    const missing = await get('/api/v1/groundwater/no-such-well');
    assert.equal(missing.status, 404);
  });
});

/* --- the shallow water table, where bigger means drier --------------------- */

const { rankShallow } = require('../src/domain/flow-history');
const { assessDrought } = require('../src/domain/drought');
const { listShallowWells, shallowCoverage, SHALLOW_KIND, DEPTH_MEANS_DRIER } = require('../src/config/shallow-wells');

/** A real station's August: depths in cm, 219 shallow to 358 deep. */
const AUG_DEPTH = {
  p: [218.6, 263.92, 284.75, 303.4, 330.5, 351.53, 358.1],
  min: { value: 117, year: 2021, day: '2021-08-04' },     // shallowest = wettest
  max: { value: 366.33, year: 2022, day: '2022-08-28' },  // deepest = driest
  days: 310,
  years: 10,
};

function depthDoc(id){
  const months = Array.from({ length: 12 }, () => null);
  months[7] = AUG_DEPTH;
  return { [id]: { months, unit: 'cm' } };
}

test('the shallow ranking is inverted: deeper reads as drier', () => {
  const [w] = listShallowWells();
  const o = { at: Date.UTC(2026, 7, 12), document: depthDoc(w.id) };

  const deepest = rankShallow(w.id, 366.33, o);
  const median = rankShallow(w.id, 303.4, o);
  const shallowest = rankShallow(w.id, 117, o);

  // This is the assertion the whole feature turns on. Ranked naively, the deepest water
  // table in the record would come out at the top of the scale and the page would print
  // "unusually wet" during a drought.
  assert.equal(deepest.percentile, 0, 'the deepest day on record must be the driest');
  assert.equal(deepest.band, 'very-low');
  assert.equal(shallowest.percentile, 100, 'the shallowest day on record must be the wettest');
  assert.equal(shallowest.band, 'very-high');
  assert.ok(Math.abs(median.percentile - 50) < 1);
  assert.equal(median.band, 'normal');
});

test('a table deeper than anything in the record is a record, in the dry direction', () => {
  const [w] = listShallowWells();
  const o = { at: Date.UTC(2026, 7, 12), document: depthDoc(w.id) };
  const r = rankShallow(w.id, 372, o);
  assert.equal(r.belowRecord, true, 'deeper than the deepest is a dry record');
  assert.equal(r.aboveRecord, false);
  assert.equal(r.band, 'record-low');
  assert.ok(r.deeperThanMedianCm > 0, 'and it is reported as deeper than its median');
});

test('depths are reported as depths, not as the negated values used for ranking', () => {
  const [w] = listShallowWells();
  const r = rankShallow(w.id, 340, { at: Date.UTC(2026, 7, 12), document: depthDoc(w.id) });
  assert.equal(r.depthCm, 340);
  assert.equal(r.medianDepthCm, 303.4);
  assert.equal(r.unit, 'cm');
  assert.equal(r.deeperThanMedianCm, 36.6);
});

test('the drought summary counts dry stations and names both measured inputs', () => {
  const [a, b] = listShallowWells();
  const document = { ...depthDoc(a.id), ...depthDoc(b.id) };
  const at = new Date(Date.UTC(2026, 7, 12));
  const out = assessDrought({
    [a.id]: { value: 372, at: '2026-08-11T06:00:00Z' },     // record deep
    [b.id]: { value: 303.4, at: '2026-08-11T06:00:00Z' },   // dead normal
  }, { at, document });

  assert.equal(out.summary.comparable, 2);
  assert.equal(out.summary.dry, 1);
  assert.equal(out.summary.deepestOnRecord, 1);
  assert.equal(out.summary.dryShare, 0.5);
  assert.ok(out.inputs.shallowWaterTable.stations > 100);
  // The claim has to stay precise: measurements are theirs, the arithmetic is ours.
  assert.match(out.note, /NOT the/i);
  assert.match(out.note, /HDI|Drought Index/i);
});

test('a stale reading does not join the drought count', () => {
  const [a] = listShallowWells();
  const at = new Date(Date.UTC(2026, 7, 12));
  const fresh = assessDrought({ [a.id]: { value: 372, at: '2026-08-11T06:00:00Z' } }, { at, document: depthDoc(a.id) });
  const old = assessDrought({ [a.id]: { value: 372, at: '2026-06-01T06:00:00Z' } }, { at, document: depthDoc(a.id) });
  assert.equal(fresh.summary.comparable, 1);
  assert.equal(old.summary.comparable, 0);
  assert.equal(old.summary.statuses.stale, 1);
});

test('the shallow network is talajviz and says so, and covers every directorate', () => {
  assert.equal(SHALLOW_KIND.adatFajtaKod, 69);
  assert.equal(SHALLOW_KIND.vmoType, 12);
  assert.equal(DEPTH_MEANS_DRIER, true);
  const c = shallowCoverage();
  assert.ok(c.stations > 500, `expected a national network, got ${c.stations}`);
  assert.equal(c.missingDirectorates.length, 0, 'all twelve directorates should be present');
});

test('GET /drought ranks the network', async () => {
  await withServer(async ({ get }) => {
    const { status, body } = await get('/api/v1/drought');
    assert.equal(status, 200);
    assert.equal(body.synthetic, true);
    assert.ok(body.summary.registered > 500);
    assert.ok(body.summary.comparable > 0, 'the fixture must exercise the ranking');
    assert.ok(Array.isArray(body.regions) && body.regions.length > 5);
    assert.ok(body.coverage.stations > 500);
  });
});

/* --- the watchdog ---------------------------------------------------------- */

const { networkHealth, HEALTH } = require('../src/domain/drought');

/**
 * The failure this exists for is not an error. The request succeeds, the JSON parses,
 * and the page renders numbers that are simply older than they look - which on a
 * quantity that moves centimetres a month is indistinguishable from a stable water
 * table for weeks, and the frozen number is the one a reader quotes.
 */
/** The whole registry reporting at once, so freshness is the only variable. */
function wholeNetwork(when, value = 340) {
  const document = {};
  const readings = {};
  for (const w of listShallowWells()) {
    Object.assign(document, depthDoc(w.id));
    readings[w.id] = { value, at: when };
  }
  return { document, readings };
}

test('a frozen feed is reported as silent, not as stable', () => {
  const at = new Date(Date.UTC(2026, 7, 12));

  const live = wholeNetwork('2026-08-11T06:00:00Z');
  const healthy = assessDrought(live.readings, { at, document: live.document });
  assert.equal(healthy.health.ok, true, JSON.stringify(healthy.health.reasons));

  // Every station still answering, none of them advancing - the failure a status code
  // cannot show, and the one that looks like a stable water table.
  const old = wholeNetwork('2026-06-20T06:00:00Z');
  const frozen = assessDrought(old.readings, { at, document: old.document });
  assert.equal(frozen.health.ok, false, 'a month-old newest reading is not healthy');
  assert.ok(frozen.health.reasons.some((r) => r.code === 'stale'));
  assert.ok(frozen.health.quietDays > HEALTH.quietDays);
  // And the numbers underneath it must have been withdrawn, not merely annotated: a
  // reading too old to be "now" never entered the count in the first place.
  assert.equal(frozen.summary.comparable, 0);
});

test('an empty response is silence, not a dry country', () => {
  const at = new Date(Date.UTC(2026, 7, 12));
  const out = assessDrought({}, { at });
  assert.equal(out.health.ok, false);
  assert.ok(out.health.reasons.some((r) => r.code === 'no-readings'));
  // And crucially it must not look like good news: nothing dry, because nothing measured.
  assert.equal(out.summary.comparable, 0);
  assert.equal(out.summary.dry, 0);
});

test('a collapsed denominator is flagged, because a shrinking sample is not a trend', () => {
  // One station out of hundreds still reporting: the count would be "1 of 1 dry", which
  // is 100% and means nothing.
  const [a] = listShallowWells();
  const at = new Date(Date.UTC(2026, 7, 12));
  const out = assessDrought({ [a.id]: { value: 372, at: '2026-08-11T06:00:00Z' } },
    { at, document: depthDoc(a.id) });
  assert.equal(out.health.ok, false);
  const thin = out.health.reasons.find((r) => r.code === 'thin');
  assert.ok(thin, 'one comparable station out of hundreds must be flagged as thin');
  assert.ok(thin.comparableShare < HEALTH.minComparableShare);
});

test('health is computable on its own, and says what it checked', () => {
  const at = new Date(Date.UTC(2026, 7, 12));
  const stations = Array.from({ length: 100 }, (_, i) => ({ at: '2026-08-11T06:00:00Z', id: `s${i}` }));
  const h = networkHealth(stations, { ok: 100 }, 100, at);
  assert.equal(h.ok, true);
  assert.equal(h.registered, 100);
  assert.equal(h.comparable, 100);
  assert.ok(h.freshestAt.startsWith('2026-08-11'));
  assert.ok(h.thresholds.quietDays > 0, 'the payload states the bar it was judged against');
});

test('GET /drought carries its own verdict on whether it can be trusted', async () => {
  await withServer(async ({ get }) => {
    const { body } = await get('/api/v1/drought');
    assert.ok(body.health, 'the payload must carry health');
    assert.equal(typeof body.health.ok, 'boolean');
    assert.ok(Array.isArray(body.health.reasons));
    // The fixture is fresh, so it should be healthy - if this ever fails, the fixture
    // has drifted and the watchdog is about to cry wolf in production too.
    assert.equal(body.health.ok, true, JSON.stringify(body.health.reasons));
  });
});
