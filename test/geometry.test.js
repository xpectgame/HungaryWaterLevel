'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { chainWays, simplify, reduceWays, lengthKm } = require('../scripts/geometry');

// ---------------------------------------------------------------------------
// Chaining
// ---------------------------------------------------------------------------

test('two ways sharing an endpoint become one run', () => {
  const runs = chainWays([[[0, 0], [1, 1]], [[1, 1], [2, 2]]]);
  assert.strictEqual(runs.length, 1);
  assert.deepStrictEqual(runs[0], [[0, 0], [1, 1], [2, 2]]);
});

test('the shared node appears once, not twice', () => {
  // Pushing the whole second way would duplicate the join. On a drawn line that is
  // invisible; in a length calculation it is a zero-length segment, and in a simplified
  // output it is a point that can never be removed.
  const runs = chainWays([[[0, 0], [1, 0]], [[1, 0], [2, 0]], [[2, 0], [3, 0]]]);
  assert.deepStrictEqual(runs[0], [[0, 0], [1, 0], [2, 0], [3, 0]]);
});

test('a way pointing the wrong way round is flipped, not dropped', () => {
  // OSM way direction follows the digitiser, not the current. Half the segments of a
  // river routinely point upstream.
  const runs = chainWays([[[0, 0], [1, 0]], [[2, 0], [1, 0]]]);
  assert.strictEqual(runs.length, 1);
  assert.deepStrictEqual(runs[0], [[0, 0], [1, 0], [2, 0]]);
});

test('a chain extends backwards from the way it started with', () => {
  // The first way handed in is the middle one, so a forwards-only implementation would
  // leave the head as a separate run and quietly halve the length of every watercourse
  // whose segments arrive out of order - which is how they arrive.
  const runs = chainWays([[[1, 0], [2, 0]], [[0, 0], [1, 0]], [[2, 0], [3, 0]]]);
  assert.strictEqual(runs.length, 1, 'all three belong to one run');
  assert.deepStrictEqual(runs[0], [[0, 0], [1, 0], [2, 0], [3, 0]]);
});

test('disconnected ways stay disconnected', () => {
  const runs = chainWays([[[0, 0], [1, 0]], [[5, 5], [6, 5]]]);
  assert.strictEqual(runs.length, 2);
});

test('a closed loop terminates', () => {
  const runs = chainWays([[[0, 0], [1, 0], [1, 1], [0, 0]]]);
  assert.strictEqual(runs.length, 1);
  assert.strictEqual(runs[0].length, 4);
});

test('every input point survives chaining', () => {
  // The property that matters: chaining reorders and reverses, it never loses geometry.
  const ways = [[[0, 0], [1, 0]], [[1, 0], [1, 1]], [[3, 3], [4, 4]], [[1, 1], [2, 1]]];
  const runs = chainWays(ways);
  const nodes = new Set();
  for (const run of runs) for (const p of run) nodes.add(p.join(','));
  for (const w of ways) for (const p of w) assert.ok(nodes.has(p.join(',')), `${p} survived`);
});

// ---------------------------------------------------------------------------
// Simplification
// ---------------------------------------------------------------------------

test('a straight line collapses to its endpoints', () => {
  const line = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]];
  assert.deepStrictEqual(simplify(line, 0.001), [[0, 0], [4, 0]]);
});

test('a real bend is kept', () => {
  const line = [[0, 0], [1, 1], [2, 0]];
  assert.strictEqual(simplify(line, 0.001).length, 3);
});

test('endpoints are never removed', () => {
  const line = [[0, 0], [0.5, 0.0001], [1, 0]];
  const out = simplify(line, 1);
  assert.deepStrictEqual(out, [[0, 0], [1, 0]]);
});

// ---------------------------------------------------------------------------
// The whole reduction
// ---------------------------------------------------------------------------

function way(name, waterway, coords, extra = {}) {
  return { tags: { name, waterway, ...extra }, geometry: coords.map(([lon, lat]) => ({ lon, lat })) };
}

test('segments of one named stream become one feature', () => {
  const out = reduceWays([
    way('Rákos-patak', 'stream', [[19.0, 47.5], [19.1, 47.5]]),
    way('Rákos-patak', 'stream', [[19.1, 47.5], [19.2, 47.5]]),
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'Rákos-patak');
  assert.ok(out[0].km > 10, 'the length is the whole run, not one segment');
});

test('a name shared by two different waterway types is not welded together', () => {
  // A river and a canal both called "Sió" that happen to touch are two objects. Grouping
  // on name alone would draw one line through both and report a length neither has.
  const out = reduceWays([
    way('Sió', 'river', [[18.0, 46.9], [18.1, 46.9]]),
    way('Sió', 'canal', [[18.1, 46.9], [18.2, 46.9]]),
  ]);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out.map((f) => f.type).sort(), ['canal', 'river']);
});

test('two unconnected streams sharing a name stay two features', () => {
  const out = reduceWays([
    way('Malom-patak', 'stream', [[19.0, 47.5], [19.1, 47.5]]),
    way('Malom-patak', 'stream', [[21.0, 46.5], [21.1, 46.5]]),
  ]);
  assert.strictEqual(out.length, 2, 'same name, different counties');
});

test('short unnamed fragments are dropped, named ones are not', () => {
  const tiny = [[19.0, 47.5], [19.001, 47.5]]; // ~75 m
  const out = reduceWays([
    { tags: { waterway: 'ditch' }, geometry: tiny.map(([lon, lat]) => ({ lon, lat })) },
    way('Kis-patak', 'stream', tiny),
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'Kis-patak');
});

test('an intermittent segment marks the whole watercourse', () => {
  const out = reduceWays([
    way('Száraz-ér', 'stream', [[20.0, 46.5], [20.1, 46.5]], { intermittent: 'yes' }),
    way('Száraz-ér', 'stream', [[20.1, 46.5], [20.2, 46.5]]),
  ]);
  assert.strictEqual(out[0].intermittent, 1);
});

test('features come back longest first', () => {
  const out = reduceWays([
    way('Kicsi', 'stream', [[19.0, 47.5], [19.05, 47.5]]),
    way('Nagy', 'river', [[19.0, 46.0], [20.0, 46.0]]),
  ]);
  assert.deepStrictEqual(out.map((f) => f.name), ['Nagy', 'Kicsi']);
});

test('a way with too few usable nodes is skipped rather than emitted broken', () => {
  const out = reduceWays([
    { tags: { name: 'Rossz', waterway: 'stream' }, geometry: [{ lon: 19, lat: null }] },
    { tags: { name: 'Jó', waterway: 'stream' }, geometry: [{ lon: 19, lat: 47 }, { lon: 19.2, lat: 47 }] },
  ]);
  assert.deepStrictEqual(out.map((f) => f.name), ['Jó']);
});

test('coordinates are rounded to the requested precision', () => {
  const out = reduceWays([way('X', 'river', [[19.123456, 47.123456], [19.9, 47.9]])], { decimals: 4 });
  assert.deepStrictEqual(out[0].pts[0], [19.1235, 47.1235]);
});

test('lengthKm is right to within a few per cent of a known distance', () => {
  // One degree of latitude is 111 km by definition of the constant used.
  assert.ok(Math.abs(lengthKm([[19, 46], [19, 47]]) - 111) < 1);
  // A degree of longitude at 47N is about 76 km.
  const east = lengthKm([[19, 47], [20, 47]]);
  assert.ok(east > 70 && east < 80, `${east} km`);
});
