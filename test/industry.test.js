'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildIndustry, loadIndustry, byReceivingWater, outfallsOn } = require('../src/domain/industry');
const { build, HU } = require('../scripts/build-industry');

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** A probe-shaped document, so the build script is tested through its real entry point. */
function probeFile(points) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ipari-')), 'points.json');
  fs.writeFileSync(file, JSON.stringify({
    'https://geoportal.vizugy.hu/arcgis/rest/services/VGT_1/02_00/MapServer/1': { points },
  }));
  return file;
}

const ROW = {
  OBJECTID: 1, NAME: 'Bábony-patak', VT_VOR: 'AEP290', 'Alegység': '2-6',
  'Szennyvíz': 'Hulladékkezelés', lon: 20.708, lat: 48.1631,
};

test('a point inside Hungary survives the build', () => {
  const doc = build(probeFile([ROW]));
  assert.equal(doc.count, 1);
  assert.equal(doc.droppedRows, 0);
  assert.equal(doc.points[0].sector, 'Hulladékkezelés');
});

test('a point projected outside Hungary is dropped, not clamped', () => {
  // The single bad row in the real register lands in Bavaria while naming a Somogy
  // stream. Silently moving it to the nearest border would put a dot somewhere real and
  // wrong, which is worse than one fewer dot.
  const doc = build(probeFile([ROW, { ...ROW, OBJECTID: 2, lon: 11.5535, lat: 49.6963 }]));
  assert.equal(doc.count, 1);
  assert.equal(doc.droppedRows, 1);
});

test('the bad-row count is published, not swallowed', () => {
  const doc = build(probeFile([{ ...ROW, lon: null, lat: null }]));
  assert.equal(doc.count, 0);
  assert.equal(doc.droppedRows, 1);
});

test('a groundwater body code is classified as subsurface and gets no water name', () => {
  const doc = build(probeFile([{ ...ROW, NAME: 'sp.2.4.1', VT_VOR: 'AIQ100' }]));
  assert.equal(doc.points[0].target, 'felszín alatti');
  assert.equal(doc.points[0].waterName, null);
  // The raw value is still carried, so the classification can be checked.
  assert.equal(doc.points[0].water, 'sp.2.4.1');
  assert.equal(doc.groundwaterCount, 1);
  assert.equal(doc.surfaceCount, 0);
});

test('a canal whose name starts with a Roman numeral is surface water', () => {
  // "XXXI. Apaji-csatorna (Átok-csatorna) alsó" is a real watercourse. A pattern that
  // matched letters-then-full-stop would file it under groundwater.
  const doc = build(probeFile([{ ...ROW, NAME: 'XXXI. Apaji-csatorna (Átok-csatorna) alsó' }]));
  assert.equal(doc.points[0].target, 'felszíni');
  assert.equal(doc.points[0].waterName, 'XXXI. Apaji-csatorna (Átok-csatorna) alsó');
});

test('every groundwater body prefix in the register is recognised', () => {
  const names = ['sp.1.2.1', 'pt.2.1', 'sh.1.10'];
  const doc = build(probeFile(names.map((NAME, i) => ({ ...ROW, OBJECTID: i + 1, NAME }))));
  assert.equal(doc.groundwaterCount, 3);
});

test('sectors are counted commonest first', () => {
  const doc = build(probeFile([
    { ...ROW, OBJECTID: 1, 'Szennyvíz': 'Halászat' },
    { ...ROW, OBJECTID: 2, 'Szennyvíz': 'Élelmiszeripar' },
    { ...ROW, OBJECTID: 3, 'Szennyvíz': 'Élelmiszeripar' },
  ]));
  assert.deepEqual(doc.sectors, [
    { name: 'Élelmiszeripar', count: 2 },
    { name: 'Halászat', count: 1 },
  ]);
});

test('the receiving-water tally counts surface bodies only', () => {
  const doc = build(probeFile([
    { ...ROW, OBJECTID: 1, NAME: 'Duna Szob-Baja között' },
    { ...ROW, OBJECTID: 2, NAME: 'sp.2.4.1' },
    { ...ROW, OBJECTID: 3, NAME: 'sp.2.4.1' },
  ]));
  assert.equal(doc.waterCount, 1);
  assert.deepEqual(doc.topWatersByOutfallCount, [{ name: 'Duna Szob-Baja között', count: 1 }]);
});

test('the document announces the four things it does not have', () => {
  const doc = build(probeFile([ROW]));
  assert.equal(doc.hasVolume, false);
  assert.equal(doc.hasLoad, false);
  assert.equal(doc.hasOperator, false);
  assert.equal(doc.hasPermitLimit, false);
});

test('the vintage travels with the document', () => {
  const doc = build(probeFile([ROW]));
  assert.match(doc.vintage, /2009/);
});

test('the baked register is present and reads back', () => {
  const doc = loadIndustry();
  assert.ok(doc, 'src/config/industry.json should be committed');
  assert.equal(doc.count, doc.points.length);
  assert.equal(doc.surfaceCount + doc.groundwaterCount, doc.count);
});

test('every baked point is inside Hungary', () => {
  for (const p of loadIndustry().points) {
    assert.ok(p.lon >= HU.lonMin && p.lon <= HU.lonMax, `lon ${p.lon}`);
    assert.ok(p.lat >= HU.latMin && p.lat <= HU.latMax, `lat ${p.lat}`);
  }
});

test('buildIndustry leads with the vintage and the absent fields', () => {
  const body = buildIndustry({ limit: 1 });
  assert.equal(body.available, true);
  assert.match(body.vintage, /VGT/);
  assert.equal(body.hasVolume, false);
  assert.equal(body.points.length, 1);
  // count stays the register's count, not the page's
  assert.ok(body.count > 1);
});

test('an unloadable register reports unavailable rather than an empty map', () => {
  const body = buildIndustry({ document: null });
  assert.equal(body.available, false);
  assert.match(body.reason, /nincs betöltve/);
});

test('a sector filter matches case-insensitively and reports how many matched', () => {
  const body = buildIndustry({ sector: 'termálvíz, fürdővíz' });
  assert.ok(body.matched > 100, `expected the spa sector to be large, got ${body.matched}`);
  assert.ok(body.points.every((p) => p.sector === 'Termálvíz, fürdővíz'));
});

test('byReceivingWater names the sector that dominates each water', () => {
  const groups = byReceivingWater({
    points: [
      { target: 'felszíni', waterName: 'Kakat-csatorna', sector: 'Élelmiszeripar' },
      { target: 'felszíni', waterName: 'Kakat-csatorna', sector: 'Élelmiszeripar' },
      { target: 'felszíni', waterName: 'Kakat-csatorna', sector: 'Halászat' },
      { target: 'felszín alatti', waterName: null, sector: 'Élelmiszeripar' },
    ],
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 3);
  assert.equal(groups[0].dominantSector, 'Élelmiszeripar');
});

test('outfallsOn does not collapse the six Danube water bodies into one', () => {
  const doc = loadIndustry();
  const plain = outfallsOn('Duna', doc);
  const real = outfallsOn('Duna Szob-Baja között', doc);
  assert.equal(plain.length, 0, 'a bare river name must not match a water body name');
  assert.ok(real.length > 0);
});

test('the whole register is a single national picture, not a per-sector one', () => {
  // Guards the thing most likely to be "fixed" later: summing sector counts must equal
  // the point count, so a sector cannot go missing from the legend unnoticed.
  const doc = loadIndustry();
  const summed = doc.sectors.reduce((s, x) => s + x.count, 0);
  assert.equal(summed, doc.count);
});
