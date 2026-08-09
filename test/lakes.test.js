'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { LAKES, getLake, gaugedLakes, volumePerCm } = require('../src/config/lakes');
const { buildLakes, changeOver } = require('../src/domain/lakes');
const { validateReading } = require('../src/lib/validate');

const HOUR = 3600 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

test('every lake carries the figures the volume arithmetic needs', () => {
  for (const lake of LAKES) {
    assert.ok(lake.areaKm2 > 0, `${lake.id} has no surface area`);
    assert.ok(lake.volumeMm3 > 0, `${lake.id} has no volume`);
    // Mean depth is the two divided: a lake whose stated depth disagrees with its own
    // area and volume by more than a factor of two has a unit error in one of the three.
    const implied = (lake.volumeMm3 * 1e6) / (lake.areaKm2 * 1e6);
    assert.ok(
      implied / lake.meanDepthM > 0.5 && implied / lake.meanDepthM < 2,
      `${lake.id}: volume/area implies ${implied.toFixed(2)} m but meanDepthM says ${lake.meanDepthM}`,
    );
  }
});

test('one centimetre is the surface area, in the right unit', () => {
  // 594 km2 x 0.01 m = 5.94 million m3. If this ever comes out as 5940 or 0.00594,
  // every volume figure on the page is out by a thousand.
  assert.strictEqual(Math.round(volumePerCm(getLake('balaton')) * 100) / 100, 5.94);
  assert.strictEqual(Math.round(volumePerCm(getLake('velencei-to')) * 1000) / 1000, 0.242);
});

test('the Tisza-tó is listed but not gauged, and says why', () => {
  assert.ok(getLake('tisza-to'));
  assert.strictEqual(getLake('tisza-to').gaugeTsz, null);
  assert.ok(!gaugedLakes().some((l) => l.id === 'tisza-to'));

  const built = buildLakes({});
  const tisza = built.lakes.find((l) => l.id === 'tisza-to');
  assert.strictEqual(tisza.measured, false);
  assert.ok(tisza.unavailableReason, 'an unmeasured lake must explain itself');
});

test('a level becomes a position, a trend and a volume', () => {
  const readings = { balaton: { stationId: 'balaton', waterLevelCm: 89, timestamp: ago(HOUR), quality: 'measured' } };
  const history = {
    balaton: [
      { timestamp: ago(7 * 24 * HOUR), waterLevelCm: 93 },
      { timestamp: ago(24 * HOUR), waterLevelCm: 90 },
      { timestamp: ago(HOUR), waterLevelCm: 89 },
    ],
  };

  const built = buildLakes(readings, history);
  const balaton = built.lakes.find((l) => l.id === 'balaton');

  assert.strictEqual(balaton.current.levelCm, 89);
  assert.strictEqual(balaton.current.stage.recordLowCm, 23);
  assert.ok(balaton.current.stage.position > 0 && balaton.current.stage.position < 1);

  assert.strictEqual(balaton.trend.day.cm, -1);
  assert.strictEqual(balaton.trend.week.cm, -4);
  // -4 cm x 5.94 million m3/cm.
  assert.strictEqual(balaton.trend.week.volumeMm3, -23.76);
  assert.strictEqual(built.weeklyVolumeChangeMm3, -23.76);
});

test('a window the history does not reach is null, not a shorter window', () => {
  // The trap: a serverless instance alive for twenty minutes answering "7 nap: -1 cm".
  const history = [{ timestamp: ago(2 * HOUR), waterLevelCm: 90 }];
  assert.strictEqual(changeOver(history, 89, 7 * 24 * HOUR, 24 * HOUR), null);
  assert.ok(changeOver(history, 89, 3 * HOUR, 6 * HOUR));
});

test('no measured lake means no national total, rather than zero', () => {
  const built = buildLakes({});
  assert.strictEqual(built.measuredCount, 0);
  assert.strictEqual(built.weeklyVolumeChangeMm3, null);
});

test('lake readings are validated on level, not on discharge', () => {
  const base = { stationId: 'balaton', flowM3s: null, timestamp: ago(HOUR) };

  // A river reading with no discharge is rejected; a lake reading with a level is not.
  assert.strictEqual(validateReading({ ...base, waterLevelCm: 95 }).ok, true);
  assert.strictEqual(validateReading({ ...base, waterLevelCm: null }).ok, false);
  assert.strictEqual(validateReading({ ...base, waterLevelCm: -9999 }).ok, false);

  // Records get broken, so just past one is believed...
  assert.strictEqual(validateReading({ ...base, waterLevelCm: 18 }).ok, true);
  // ...but a metre past one is a datum change or a unit slip.
  assert.strictEqual(validateReading({ ...base, waterLevelCm: -120 }).ok, false);
  assert.strictEqual(validateReading({ ...base, waterLevelCm: 400 }).ok, false);
});

test('a lake reading still has to have a sane timestamp', () => {
  assert.strictEqual(
    validateReading({ stationId: 'balaton', waterLevelCm: 95, timestamp: 'not a date' }).ok,
    false,
  );
  assert.strictEqual(
    validateReading({
      stationId: 'balaton',
      waterLevelCm: 95,
      timestamp: new Date(Date.now() + 6 * HOUR).toISOString(),
    }).ok,
    false,
  );
});
