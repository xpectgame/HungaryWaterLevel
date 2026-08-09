'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { describeStage, gradeFor, positionOnRange } = require('../src/domain/stage');
const { STAGE_THRESHOLDS, getThresholds } = require('../src/config/stage-thresholds');
const { listStations } = require('../src/config/stations');
const { LAKES } = require('../src/config/lakes');

/**
 * The reference table is copied output. These check that it was copied correctly and
 * that nothing downstream invents a level the catalogue does not publish.
 */

test('every threshold entry names a gauge that exists', () => {
  const known = new Set([...listStations().map((s) => s.id), ...LAKES.map((l) => l.id)]);
  for (const id of Object.keys(STAGE_THRESHOLDS)) {
    assert.ok(known.has(id), `${id} has thresholds but is in neither registry`);
  }
});

test('no lake shares an id with a station', () => {
  // Lakes are stored in the same readings table, keyed by id. A collision would file a
  // lake level as a river gauge's, and the balance would then read a level in cm as a
  // discharge in m3/s.
  const stations = new Set(listStations().map((s) => s.id));
  for (const lake of LAKES) {
    assert.ok(!stations.has(lake.id), `${lake.id} is both a lake and a station`);
  }
});

test('the reference levels are internally consistent', () => {
  for (const [id, t] of Object.entries(STAGE_THRESHOLDS)) {
    assert.ok(t.lnv > t.lkv, `${id}: record high must exceed record low`);
    assert.ok(t.datum > 0 && t.datum < 400, `${id}: gauge datum ${t.datum} m is not a Hungarian elevation`);

    const grades = [t.kf1, t.kf2, t.kf3].filter((v) => v !== null);
    // Either all three grades are published or none are; a partial set would mean the
    // catalogue changed shape and the table was pasted from a different column layout.
    assert.ok(grades.length === 0 || grades.length === 3, `${id}: ${grades.length} of 3 grades published`);

    if (grades.length === 3) {
      assert.ok(t.kf1 < t.kf2 && t.kf2 < t.kf3, `${id}: grades must ascend`);
      assert.ok(t.kf1 > t.lkv, `${id}: grade I sits below the record low`);
      // Grade III is set from the levee system, not from the observed record, so it may
      // sit slightly above the record high - Paks is 9 cm above it. What it cannot do is
      // land in the lower half of the recorded range, which is what a shifted column
      // would look like.
      assert.ok(t.kf3 > (t.lkv + t.lnv) / 2, `${id}: grade III sits in the lower half of the range`);
      assert.ok(t.kf3 <= t.lnv * 1.1, `${id}: grade III is far above anything ever recorded`);
    }
  }
});

test('known record floods survived the copy', () => {
  // June 2013 on the Danube and April 2006 at Szeged. If a column shifted during the
  // paste, these are the values that would visibly move.
  assert.strictEqual(getThresholds('duna-budapest').lnv, 891);
  assert.strictEqual(getThresholds('tisza-szeged').lnv, 1009);
  // Budapest announces I/II/III at 620/700/800 cm.
  assert.deepStrictEqual(
    [getThresholds('duna-budapest').kf1, getThresholds('duna-budapest').kf2, getThresholds('duna-budapest').kf3],
    [620, 700, 800],
  );
});

test('a stage below every grade is normal water', () => {
  const stage = describeStage(210, 'duna-budapest');
  assert.strictEqual(stage.band, 'normal');
  assert.strictEqual(stage.grade, null);
  assert.strictEqual(stage.aboveRecordLowCm, 177); // 210 - 33
  assert.strictEqual(stage.belowRecordHighCm, 681); // 891 - 210
});

test('the highest grade reached is the one reported', () => {
  assert.strictEqual(describeStage(619, 'duna-budapest').grade, null);
  assert.strictEqual(describeStage(620, 'duna-budapest').grade, 1); // inclusive at the threshold
  assert.strictEqual(describeStage(705, 'duna-budapest').grade, 2);
  assert.strictEqual(describeStage(860, 'duna-budapest').grade, 3);
  assert.strictEqual(describeStage(860, 'duna-budapest').band, 'grade-3');
  assert.strictEqual(describeStage(705, 'duna-budapest').gradeName, 'II. fokú árvízvédelmi készültség');
});

test('beating a record outranks the flood grade', () => {
  // 900 cm at Budapest is past grade III and past the 2013 record. The record is the
  // more important fact, and the band says so.
  assert.strictEqual(describeStage(900, 'duna-budapest').band, 'record-high');
  assert.strictEqual(describeStage(900, 'duna-budapest').grade, 3);
  assert.strictEqual(describeStage(33, 'duna-budapest').band, 'record-low');
  assert.strictEqual(describeStage(20, 'duna-budapest').band, 'record-low');
});

test('a gauge with no published grades never gets one', () => {
  // Rajka sits in a barrage-controlled reach; the catalogue publishes no grades for it.
  const stage = describeStage(600, 'duna-rajka');
  assert.strictEqual(stage.grade, null);
  assert.strictEqual(stage.band, 'normal');
  assert.strictEqual(stage.thresholds.gradesPublished, false);
});

test('a gauge with no reference levels still reports its centimetres', () => {
  // Tiszabecs is not in the InternetVmo catalogue. Losing the Upper Tisza's level over
  // the missing context would be the wrong trade.
  const stage = describeStage(140, 'tisza-tiszabecs');
  assert.strictEqual(stage.cm, 140);
  assert.strictEqual(stage.band, 'unknown');
  assert.strictEqual(stage.recordLowCm, null);
  assert.strictEqual(stage.position, null);
  assert.ok(stage.note);
});

test('a missing stage is not a stage of zero', () => {
  assert.strictEqual(describeStage(null, 'duna-budapest'), null);
  assert.strictEqual(describeStage(undefined, 'duna-budapest'), null);
  assert.strictEqual(describeStage(NaN, 'duna-budapest'), null);
  // ...but a genuine zero reading is a stage.
  assert.strictEqual(describeStage(0, 'duna-budapest').cm, 0);
});

test('surface elevation is the datum plus the stage', () => {
  const stage = describeStage(250, 'duna-budapest');
  assert.strictEqual(stage.datumMasl, 94.97);
  assert.strictEqual(stage.surfaceMasl, 97.47);
});

test('position is not clamped, so a new record reads as one', () => {
  assert.strictEqual(positionOnRange(33, 33, 891), 0);
  assert.strictEqual(positionOnRange(891, 33, 891), 1);
  assert.ok(positionOnRange(950, 33, 891) > 1);
  assert.ok(positionOnRange(0, 33, 891) < 0);
  assert.strictEqual(positionOnRange(100, null, 891), null);
});

test('gradeFor tolerates a partially published grade set', () => {
  assert.strictEqual(gradeFor(500, { kf1: 400, kf2: null, kf3: null }).level, 1);
  assert.strictEqual(gradeFor(500, { kf1: null, kf2: null, kf3: 450 }).level, 3);
  assert.strictEqual(gradeFor(100, { kf1: 400, kf2: 500, kf3: 600 }), null);
});
