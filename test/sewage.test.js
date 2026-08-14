'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildSewage, byReceivingWater, shareOfFlow, loadSewage } = require('../src/domain/sewage');
const { DEAD } = require('../scripts/build-sewage');
const { gaugeFor } = require('../src/routes/sewage');

// ---------------------------------------------------------------------------
// The filter that nearly lost Budapest
// ---------------------------------------------------------------------------

test('a plant with no status recorded is kept, not dropped', () => {
  // The bug this exists to prevent. All three Budapest plants - including Csepel, the
  // largest in the country at 1.6 million LE - have a NULL status in the register,
  // because they sit in a part of the layer where the operational columns did not join.
  // Keeping only rows that say "üzemelő" removes the capital's entire sewage system from
  // a national map of the country's sewage, and the result looks entirely plausible.
  assert.strictEqual(DEAD.test(''), false, 'an empty status is not a dead plant');
  assert.strictEqual(DEAD.test('üzemelő (üzemelési engedéllyel)'), false);
  assert.strictEqual(DEAD.test('üzemelő (próbaüzem)'), false);
});

test('a plant that is closed, unbuilt or virtual is dropped', () => {
  for (const status of ['bezárt', 'nem megvalósuló', 'üzemen kívül', 'virtuális', 'építés alatt']) {
    assert.strictEqual(DEAD.test(status), true, status);
  }
});

test('the real register still contains Csepel, and it is the largest', () => {
  const doc = loadSewage();
  if (!doc) return; // not baked in this checkout
  const csepel = doc.plants.find((p) => /Csepel/i.test(p.name));
  assert.ok(csepel, 'Budapest Csepel is present');
  assert.strictEqual(doc.plants[0].id, csepel.id, 'and it is the biggest by capacity');
  assert.ok(csepel.capacityPe > 1e6);
});

// ---------------------------------------------------------------------------
// Saying what is missing
// ---------------------------------------------------------------------------

test('the volume total is reported with the share of capacity behind it', () => {
  const doc = loadSewage();
  if (!doc) return;
  const out = buildSewage();
  assert.ok(out.volumeCapacityShare > 0 && out.volumeCapacityShare < 1,
    'some capacity reports no volume, and the share says how much');
  assert.ok(out.volumeMissingLargest.length, 'and names the biggest omissions');
  assert.ok(out.volumeMissingLargest.some((p) => /Budapest/.test(p.name)),
    'Budapest is the omission that matters');
});

test('an unbaked register is unavailable, not an exception', () => {
  const out = buildSewage({ document: null });
  assert.strictEqual(out.available, false);
  assert.ok(out.reason);
});

// ---------------------------------------------------------------------------
// Grouping by what receives the water
// ---------------------------------------------------------------------------

const PLANTS = [
  { id: 'a', name: 'A', capacityPe: 1000, m3s: 0.1, receivingWater: 'Séd' },
  { id: 'b', name: 'B', capacityPe: 3000, m3s: 0.3, receivingWater: 'Séd' },
  { id: 'c', name: 'C', capacityPe: 9000, m3s: 0.9, receivingWater: 'Tisza' },
  { id: 'd', name: 'D', capacityPe: 5000, m3s: 0.5, receivingWater: null },
];

test('plants are grouped and summed by the water they name', () => {
  const g = byReceivingWater(PLANTS);
  const sed = g.find((x) => x.water === 'Séd');
  assert.strictEqual(sed.plants, 2);
  assert.strictEqual(sed.capacityPe, 4000);
  assert.strictEqual(sed.m3s, 0.4);
});

test('a plant with no named receiving water is not assigned to one', () => {
  // Attaching each outfall to the nearest line in the hydrography would usually be right,
  // and the cases it got wrong would be exactly the ones nobody could check.
  const g = byReceivingWater(PLANTS);
  assert.strictEqual(g.reduce((s, x) => s + x.plants, 0), 3, 'the fourth plant is in no group');
});

test('groups come back biggest first', () => {
  assert.deepStrictEqual(byReceivingWater(PLANTS).map((g) => g.water), ['Tisza', 'Séd']);
});

// ---------------------------------------------------------------------------
// The ratio
// ---------------------------------------------------------------------------

test('a share of flow is the ratio of two measurements', () => {
  assert.strictEqual(shareOfFlow(0.5, 50), 0.01);
});

test('a river with no flow reading yields no ratio, never infinity', () => {
  // Dividing by zero here prints "the entire river is sewage", which is the most
  // defamatory thing this page could say about a watercourse.
  assert.strictEqual(shareOfFlow(0.5, 0), null);
  assert.strictEqual(shareOfFlow(0.5, null), null);
  assert.strictEqual(shareOfFlow(0.5, -3), null);
  assert.strictEqual(shareOfFlow(null, 50), null);
});

// ---------------------------------------------------------------------------
// Which cross-section the comparison is against
// ---------------------------------------------------------------------------

test('a river with several gauges is compared at its outflow, not its inflow', () => {
  // Eight plants discharge into the Tisza. Taking the first matching gauge picked
  // Tiszabecs - the inflow at the Ukrainian border, upstream of every one of them - and
  // produced a ratio that was arithmetically fine and physically meaningless.
  const tisza = gaugeFor('Tisza');
  assert.ok(tisza, 'the Tisza is gauged on this site');
  assert.strictEqual(tisza.role, 'outflow');
  const duna = gaugeFor('Duna');
  assert.strictEqual(duna.role, 'outflow');
});

test('an ungauged watercourse gets no gauge rather than a nearby one', () => {
  // The Tócó-csatorna receives the largest single discharge in the country and this
  // project has no gauge on it. That is reported as no comparison, not as a comparison
  // with something else.
  assert.strictEqual(gaugeFor('Tócó-csatorna'), null);
  assert.strictEqual(gaugeFor(''), null);
  assert.strictEqual(gaugeFor(null), null);
});
