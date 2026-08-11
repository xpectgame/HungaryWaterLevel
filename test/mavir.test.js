'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseSheet, foldToSourceTypes, resolveSourceType, DEFAULTS } = require('../src/sources/mavir');

/**
 * The live chart 9404 export, copied verbatim from a probe run.
 *
 * Every column name here is MAVIR's, not a guess. The previous fixture in this project
 * invented plant names that agreed with the bug, and the bug survived because of it.
 */
const HEADER = ['Időpont', 'Hazai termelés (erőművi szumma)', 'Nukleáris erőművek',
  'Barnakőszén-lignit erőművek', 'Gáz (fosszilis) erőművek', 'Feketekőszén erőművek',
  'Olaj (fosszilis) erőművek', 'Szárazföldi szélerőművek', 'Biomassza erőművek', 'Ipari PV',
  'Szemétégető erőművek', 'Folyóvizes erőművek', 'Víztározós vízerőművek',
  'Egyéb megújuló erőművek', 'Egyéb erőművek'];

const ROW = ['2026.08.11 11:36:58 +0200', 4834.0, 409.9, 200.3, 245.9, 0.0, -0.1, 73.3,
  110.4, 3640.9, 13.8, 4.3, 4.6, 13.7, 116.9];

const SHEET_TOTAL = 4834.0;

function fold() {
  const { byPlant } = parseSheet([HEADER, ROW]);
  return foldToSourceTypes(byPlant);
}

test('the fuel chart is configured, not the national-totals one', () => {
  // 4401 is "Erőművi termelés" and returns four national totals with no fuel breakdown,
  // so nothing in it resolves to a source type and every plant goes dark. The site ran
  // that way in production while returning 200 on every endpoint.
  assert.strictEqual(DEFAULTS.chartId, '9404');
});

test('every column MAVIR publishes resolves to a source type', () => {
  // An unmapped column is not an error anywhere - it is silently dropped, and the source
  // type it belonged to just reads low. That is why this asserts on the whole header
  // rather than on a couple of examples.
  const { unmapped } = fold();
  assert.deepStrictEqual(unmapped, [], `unmapped columns: ${JSON.stringify(unmapped)}`);
});

test('the folded types add up to the sheet\'s own total', () => {
  // The strongest check available, and it catches both failure directions at once:
  // a dropped column makes this fall short, and the total column leaking in as though it
  // were a fuel doubles it.
  const { generationMw } = fold();
  const sum = Object.values(generationMw).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - SHEET_TOTAL) < 1,
    `mapped types sum to ${sum.toFixed(1)} MW against a sheet total of ${SHEET_TOTAL} MW`);
});

test('the total column is never treated as a fuel', () => {
  const { generationMw } = fold();
  // If "Hazai termelés (erőművi szumma)" were folded in, some type would carry ~4834.
  for (const [type, mw] of Object.entries(generationMw)) {
    assert.ok(mw < SHEET_TOTAL * 0.95, `${type} carries ${mw} MW, which is the national total`);
  }
});

test('two columns of one type are summed, not overwritten', () => {
  // 9404 splits hydro into "Folyóvizes" and "Víztározós", and other into "Egyéb" and
  // "Egyéb megújuló". Assigning instead of adding keeps whichever came last and loses
  // the other without a trace.
  const { generationMw } = fold();
  assert.ok(Math.abs(generationMw.hydro - (4.3 + 4.6)) < 0.01,
    `hydro should be both hydro columns, got ${generationMw.hydro}`);
  assert.ok(Math.abs(generationMw.other - (13.7 + 116.9)) < 0.01,
    `other should be both 'egyéb' columns, got ${generationMw.other}`);
  assert.ok(Math.abs(generationMw.coal - (200.3 + 0.0)) < 0.01,
    'both coal columns count');
});

test('the source types the cooling model needs are all present', () => {
  // These four carry every plant in the registry. If any is missing the plant that
  // depends on it reports `unavailable` and its cooling water vanishes from the balance.
  const { generationMw } = fold();
  for (const type of ['nuclear', 'coal', 'naturalGas']) {
    assert.ok(Number.isFinite(generationMw[type]), `${type} missing from the fold`);
  }
  assert.ok(generationMw.nuclear > 0, 'Paks must have a figure');
});

test('the waste column is matched by the name the sheet actually uses', () => {
  // 'hulladek' was the only alias and matches nothing MAVIR publishes; the column is
  // called "Szemétégető erőművek" and was being dropped.
  assert.strictEqual(resolveSourceType('Szemétégető erőművek'), 'waste');
});

test('accents and suffixes do not defeat the match', () => {
  assert.strictEqual(resolveSourceType('Nukleáris erőművek'), 'nuclear');
  assert.strictEqual(resolveSourceType('Barnakőszén-lignit erőművek'), 'coal');
  assert.strictEqual(resolveSourceType('Feketekőszén erőművek'), 'coal');
  assert.strictEqual(resolveSourceType('Gáz (fosszilis) erőművek'), 'naturalGas');
  assert.strictEqual(resolveSourceType('Ipari PV'), 'pv');
});

test('a renamed column is reported rather than silently dropped', () => {
  const { unmapped } = foldToSourceTypes({ 'Fúziós erőművek': 12, 'Nukleáris erőművek': 400 });
  assert.deepStrictEqual(unmapped, ['Fúziós erőművek']);
});
