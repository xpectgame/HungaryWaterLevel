'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { build, CLASSES } = require('../scripts/build-ecology');

/** A reduced-polyline document in the shape probeLayer writes. */
function probeFile(features, extra = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oko-')), 'okologia.json');
  fs.writeFileSync(file, JSON.stringify({
    'https://geoportal.vizugy.hu/arcgis/rest/services/VGT_1/05_01_05/MapServer/3':
      { features, ...extra },
  }));
  return file;
}

const BODY = {
  name: 'Zagyva alsó',
  type: 'vizfolyas',
  km: 42.1,
  'VGT_oko_vegeredmeny.VOR': 'AEP123',
  'VGT_oko_vegeredmeny.integralt': 4,
  'VGT_oko_vegeredmeny.Biol_minosit': 4,
  'VGT_oko_vegeredmeny.Fizkem_minosit': 3,
  'VGT_oko_vegeredmeny.hidromorf_minosit': 5,
  'VGT_oko_vegeredmeny.HAL_minosit': 3,
  'VGT_oko_vegeredmeny.kategoria': 'természetes',
  'VTFE_RWBody.TIPLEIRAS': 'síkvidéki, meszes, közepes folyó',
  'VTFE_RWBody.HOSSZ_MERT': 41.8,
  pts: [[19.9, 47.5], [20.0, 47.6]],
};

test('the qualified column names are stripped down to fields', () => {
  const doc = build(probeFile([BODY]));
  const b = doc.features[0];
  assert.equal(b.vor, 'AEP123');
  assert.equal(b.integralt, 4);
  assert.equal(b.hidromorfologiai, 5);
  assert.equal(b.type, 'síkvidéki, meszes, közepes folyó');
  assert.equal(b.category, 'természetes');
  assert.deepEqual(b.pts, BODY.pts);
});

test('a value outside the WFD 1-5 scale stops the build instead of being labelled', () => {
  // The whole point of the guard. The status columns are bare Doubles with no legend in
  // the layer; if they ever turn out to be 0-4, or a percentage, mapping them onto five
  // Hungarian words would colour good rivers red and nothing would say so.
  assert.throws(
    () => build(probeFile([{ ...BODY, 'VGT_oko_vegeredmeny.integralt': 7 }])),
    /outside the WFD 1-5 scale: 7/,
  );
});

test('a null status is carried as null, not as a class', () => {
  const doc = build(probeFile([{ ...BODY, 'VGT_oko_vegeredmeny.HAL_minosit': null }]));
  assert.equal(doc.features[0].hal, null);
  // and an unassessed element must not stop the build
  assert.equal(doc.count, 1);
});

test('classes are counted, never averaged', () => {
  const doc = build(probeFile([
    { ...BODY, 'VGT_oko_vegeredmeny.integralt': 2 },
    { ...BODY, 'VGT_oko_vegeredmeny.integralt': 4 },
    { ...BODY, 'VGT_oko_vegeredmeny.integralt': 4 },
  ]));
  assert.equal(doc.byClass.good, 1);
  assert.equal(doc.byClass.poor, 2);
  assert.equal(doc.byClass.moderate, 0);
  assert.equal(doc.gradedCount, 3);
  // No mean anywhere in the document - these are ordinal steps in a legal assessment.
  assert.ok(!('meanClass' in doc));
});

test('the directive pass mark counts high and good only', () => {
  const doc = build(probeFile([1, 2, 3, 4, 5].map((v) => ({
    ...BODY, 'VGT_oko_vegeredmeny.integralt': v,
  }))));
  assert.equal(doc.atOrAboveGood, 2);
});

test('a body with no integrated class is kept but not counted as graded', () => {
  const doc = build(probeFile([{ ...BODY, 'VGT_oko_vegeredmeny.integralt': null }]));
  assert.equal(doc.count, 1);
  assert.equal(doc.gradedCount, 0);
});

test('the vintage and the scale travel with the document', () => {
  const doc = build(probeFile([BODY]));
  assert.match(doc.vintage, /2009/);
  assert.deepEqual(doc.scale, CLASSES);
  assert.equal(doc.scale[1].hu, 'kiváló');
  assert.equal(doc.scale[5].order, 5);
});

test('a probe that recorded an error is not silently built into an empty map', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oko-')), 'err.json');
  fs.writeFileSync(file, JSON.stringify({ url: { error: 'Timeout after 90000ms' } }));
  assert.throws(() => build(file), /the probe recorded an error/);
});
