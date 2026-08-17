'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  buildWatercourse, findBySlug, searchWatercourses, downstreamChain, tributariesOf,
  dischargesOn, slugify, normaliseName, expandCompound, buildIndex, loadWatercourses,
} = require('../src/domain/watercourse');

/* A hand-built register, so the shape tests do not depend on what the real one contains
   this month. The real one is exercised separately, further down. */
const FIXTURE = {
  source: 'test',
  generated: '2026-01-01',
  count: 6,
  trunkOnly: ['Tisza', 'Névtelen-0042', 'Kis-nyomóág'],
  waters: [
    { n: 'Ilona-patak', b: 'Parádi-Tarna', s: 1, kmMax: 7.7, kmSum: 7.7, c: [20.1, 47.9] },
    { n: 'Parádi-Tarna', b: 'Tarna', s: 2, kmMax: 21.3, kmSum: 24, c: [20.2, 47.8] },
    { n: 'Tarna', b: 'Tisza', s: 4, kmMax: 88.4, kmSum: 91, c: [20.3, 47.7] },
    { n: 'Magányos-ér', b: null, s: 1, kmMax: 3.1, kmSum: 3.1, c: [19, 47] },
    { n: 'Oda-ág', b: 'Vissza-ág', s: 1, kmMax: 2, kmSum: 2, c: [19, 47] },
    { n: 'Vissza-ág', b: 'Oda-ág', s: 1, kmMax: 2, kmSum: 2, c: [19, 47] },
  ],
};

/* --- names ---------------------------------------------------------------- */

test('a slug folds the Hungarian vowels, because a link gets pasted', () => {
  assert.equal(slugify('Hosszúréti-patak'), 'hosszureti-patak');
  assert.equal(slugify('Ős-Gaja'), 'os-gaja');
  assert.equal(slugify('Sződrákosi-patak'), 'szodrakosi-patak');
  // No leading or trailing hyphen, whatever the punctuation was.
  assert.equal(slugify('1.sz. csatorna'), '1-sz-csatorna');
});

test('every name in the real register produces a usable slug', () => {
  const doc = loadWatercourses();
  assert.ok(doc, 'the register should be baked');
  for (const w of doc.waters) {
    const s = slugify(w.n);
    assert.ok(s.length > 0, `${w.n} slugs to nothing`);
    assert.match(s, /^[a-z0-9-]+$/, `${w.n} -> ${s} is not URL-safe`);
  }
});

test('two registers spelling the same water differently compare equal', () => {
  assert.equal(normaliseName('Galga patak'), normaliseName('Galga-patak'));
  assert.equal(normaliseName('Által ér'), normaliseName('Által-ér'));
  // Water-body qualifiers name a reach of a stream, not a different stream.
  assert.equal(normaliseName('Által-ér felső'), normaliseName('Által-ér'));
  assert.equal(normaliseName('Cserta és felső vízgyűjtője'), normaliseName('Cserta'));
  assert.equal(normaliseName('Bózsva-patak felső vízgyűjtője'), normaliseName('Bózsva-patak'));
  assert.equal(normaliseName('Duna Szob-Baja között'), normaliseName('Duna'));
});

test('normalising does not collapse two genuinely different waters', () => {
  // The whole risk of a normalising match is that it over-reaches. These must stay apart.
  assert.notEqual(normaliseName('Duna'), normaliseName('Kis-Duna'));
  assert.notEqual(normaliseName('Tisza'), normaliseName('Holt-Tisza'));
  assert.notEqual(normaliseName('Rákos-patak'), normaliseName('Rákosi'));
});

test('the elided Hungarian compound is expanded into its members', () => {
  // Both the plural and the singular head come back, because picking one means doing
  // Hungarian morphology: "patakok" drops -ok to give "patak", but "árkok" is "árok".
  // The caller matches whichever exists in the register.
  const beci = expandCompound('Béci- és Zajki-patakok');
  assert.ok(beci.includes('Béci-patak'), `no Béci-patak in ${beci.join(', ')}`);
  assert.ok(beci.includes('Zajki-patak'), `no Zajki-patak in ${beci.join(', ')}`);

  // Nothing to strip here, so exactly the two members and no invented third form.
  assert.deepEqual(expandCompound('Dera- és Kovács-patak'), ['Dera-patak', 'Kovács-patak']);

  // A plain name is returned unchanged rather than mangled.
  assert.deepEqual(expandCompound('Rákos-patak'), ['Rákos-patak']);
});

/* --- the chain ------------------------------------------------------------ */

test('the chain follows the register from one name to the next', () => {
  const chain = downstreamChain('Ilona-patak', { document: FIXTURE });
  assert.deepEqual(chain.steps.map((s) => s.name), ['Parádi-Tarna', 'Tarna', 'Tisza']);
});

test('a chain that reaches a measured river says so and carries the gauges', () => {
  const chain = downstreamChain('Ilona-patak', { document: FIXTURE });
  assert.equal(chain.endsWith, 'gauged');
  const last = chain.steps[chain.steps.length - 1];
  assert.equal(last.gauged, true);
  assert.ok(last.gauges.length > 0, 'the Tisza is gauged by this site');
});

test('a name with no receiving water reports unknown, not an ending', () => {
  // "We do not know" and "it flows nowhere" are different claims, and only one is true.
  const chain = downstreamChain('Magányos-ér', { document: FIXTURE });
  assert.equal(chain.endsWith, 'unknown');
  assert.equal(chain.steps.length, 0);
  assert.equal(chain.unknownAfter, 'Magányos-ér');
});

test('two segments naming each other do not hang the request', () => {
  // The register contains braided reaches recorded as each other's receiving water. A
  // naive walk on that is an infinite loop inside a route handler.
  const chain = downstreamChain('Oda-ág', { document: FIXTURE });
  assert.equal(chain.endsWith, 'loop');
  assert.ok(chain.steps.length <= 2);
});

test('the real register resolves a real stream all the way to a trunk river', () => {
  const chain = downstreamChain('Ilona-patak');
  assert.deepEqual(chain.steps.map((s) => s.name), ['Parádi-Tarna', 'Tarna', 'Zagyva']);
  assert.equal(chain.endsWith, 'trunk');
});

/* --- trunk rivers --------------------------------------------------------- */

test('a trunk river is addressable and flagged, not a stream with empty fields', () => {
  const w = buildWatercourse('tisza');
  assert.ok(w, 'the Tisza should have a page');
  assert.equal(w.trunk, true);
  assert.equal(w.segments, 0);
  assert.ok(w.tributaries.count > 10, `only ${w.tributaries.count} tributaries`);
  assert.ok(w.gauges && w.gauges.length > 0, 'and this site measures it');
});

test('an unnamed placeholder does not get a page', () => {
  // The register's trunk references include 40-odd "Névtelen-NNNN" and some pump-main
  // stubs. A page for an unnamed ditch helps nobody.
  const idx = buildIndex(FIXTURE);
  assert.equal(idx.bySlug.has('nevtelen-0042'), false);
  assert.equal(idx.bySlug.has('kis-nyomoag'), false, 'a 0-tributary stub is not a river');
});

test('a synthetic trunk entry stops the chain rather than reading its empty receiving water', () => {
  const chain = downstreamChain('Tarna', { document: FIXTURE });
  assert.equal(chain.endsWith, 'gauged');
  assert.equal(chain.steps.length, 1);
});

/* --- the two discharge registers ------------------------------------------ */

const SEWAGE = {
  plants: [
    { id: 'a', name: 'Egyik telep', receivingWater: 'Rákos-patak', capacityPe: 1000, m3Year: 50000 },
    { id: 'b', name: 'Másik telep', receivingWater: 'Rákos patak', capacityPe: 4000, m3Year: 90000 },
    { id: 'c', name: 'Harmadik', receivingWater: 'Duna', capacityPe: 9000, m3Year: 1000 },
    { id: 'd', name: 'Névtelen befogadó', receivingWater: null, capacityPe: 10 },
  ],
};

const INDUSTRY = {
  points: [
    { id: '1', sector: 'Bányászat', waterName: 'Rákos-patak', target: 'felszíni' },
    { id: '2', sector: 'Élelmiszer', waterName: 'Rákos- és Szilas-patakok', target: 'felszíni' },
    { id: '3', sector: 'Vegyipar', waterName: 'Rákos-patak', target: 'felszín alatti' },
    { id: '4', sector: 'Gépipar', waterName: 'Duna', target: 'felszíni' },
  ],
};

test('an outfall is matched by exact name, by normalising, or by water body - and it is labelled', () => {
  const d = dischargesOn('Rákos-patak', { sewage: SEWAGE, industry: INDUSTRY });
  assert.equal(d.sewageCount, 2);
  assert.deepEqual(d.sewage.map((p) => p.match).sort(), ['exact', 'normalised']);
  const industryMatches = d.industry.map((p) => p.match).sort();
  assert.deepEqual(industryMatches, ['exact', 'waterBody']);
});

test('an industrial point that discharges to groundwater is not on the stream', () => {
  const d = dischargesOn('Rákos-patak', { sewage: SEWAGE, industry: INDUSTRY });
  assert.ok(!d.industry.some((p) => p.id === '3'), 'the felszín alatti point must be excluded');
});

test('the volume total comes only from the register that reports volumes', () => {
  // The industrial register has no volume on any row. A total that mixed a count into it
  // would read as though the industrial share were known.
  const d = dischargesOn('Rákos-patak', { sewage: SEWAGE, industry: INDUSTRY });
  assert.equal(d.sewageM3Year, 140000);
});

test('the largest works is listed first', () => {
  const d = dischargesOn('Rákos-patak', { sewage: SEWAGE, industry: INDUSTRY });
  assert.equal(d.sewage[0].capacityPe, 4000);
});

test('a different water gets none of them', () => {
  const d = dischargesOn('Zagyva', { sewage: SEWAGE, industry: INDUSTRY });
  assert.equal(d.sewageCount, 0);
  assert.equal(d.industryCount, 0);
});

/* --- lookup and search ---------------------------------------------------- */

test('search puts the stream the reader meant above the ditch with the shorter name', () => {
  const hits = searchWatercourses('rakos', { limit: 10 });
  const names = hits.map((h) => h.name);
  assert.ok(names.includes('Rákos-patak'), `Rákos-patak missing from ${names.join(', ')}`);
  const patak = names.indexOf('Rákos-patak');
  const rakosi = names.indexOf('Rákosi');
  if (rakosi >= 0) assert.ok(patak < rakosi, 'the 44 km stream must outrank the ditch');
});

test('search finds a stream the reader spells without its suffix', () => {
  // Somebody types "Gaja"; the register calls it "Gaja-patak".
  const hits = searchWatercourses('gaja', { limit: 5 });
  assert.equal(hits[0].name, 'Gaja-patak');
});

test('a one-character query returns nothing rather than a fifteen-thousand-row scan', () => {
  assert.deepEqual(searchWatercourses('a'), []);
  assert.deepEqual(searchWatercourses(''), []);
});

test('an unknown slug is null, so the route can 404 with suggestions', () => {
  assert.equal(findBySlug('nincs-ilyen-viz-sehol'), null);
  assert.equal(buildWatercourse('nincs-ilyen-viz-sehol'), null);
});

test('tributaries come back longest first', () => {
  const t = tributariesOf('Parádi-Tarna', { document: FIXTURE });
  assert.equal(t.count, 1);
  assert.equal(t.waters[0].name, 'Ilona-patak');
  assert.equal(t.waters[0].slug, 'ilona-patak');
});

test('nameless tributaries are counted but not listed as links', () => {
  // A third of the register is "Névtelen-NNNN" placeholders. Listing six of them beside
  // four real names buries the useful half; dropping them silently gives a wrong count.
  const doc = {
    ...FIXTURE,
    waters: [
      ...FIXTURE.waters,
      { n: 'Névtelen-0799', b: 'Ilona-patak', s: 1, kmMax: 1, kmSum: 1, c: null },
      { n: 'Névtelen-0753', b: 'Ilona-patak', s: 1, kmMax: 1, kmSum: 1, c: null },
      { n: 'Valódi-ér', b: 'Ilona-patak', s: 1, kmMax: 4, kmSum: 4, c: null },
    ],
  };
  const t = tributariesOf('Ilona-patak', { document: doc });
  assert.equal(t.count, 3, 'the count includes the nameless ones');
  assert.equal(t.named, 1);
  assert.equal(t.unnamed, 2);
  assert.deepEqual(t.waters.map((x) => x.name), ['Valódi-ér']);
});

/* --- the payload ---------------------------------------------------------- */

test('the payload publishes both length readings and calls neither of them the length', () => {
  // The register's segments overlap where it re-measures a reach, so the sum is an
  // over-count and the max is a river-kilometre extent. A field called `lengthKm` would
  // be read as a measured channel length, which neither of them is.
  const w = buildWatercourse('ilona-patak');
  assert.ok(w);
  assert.equal('lengthKm' in w, false);
  assert.ok(Number.isFinite(w.lengthKmMax));
  assert.ok(Number.isFinite(w.segmentKmSum));
});

test('the payload carries its vintage and its source', () => {
  const w = buildWatercourse('ilona-patak');
  assert.ok(w.source, 'no source on the payload');
  assert.ok(w.vintage, 'no vintage on the payload');
});
