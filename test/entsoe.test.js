'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseOutages, activeAt, unitsOnlineFor, buildUrl, formatPeriod, config } = require('../src/sources/entsoe');
const { getPlant } = require('../src/config/powerplants');

/**
 * MAVIR says how much nuclear power Hungary is generating; it does not say how many
 * units are running. Those differ: pumps belong to a unit, not to its output, so two
 * units at 40% move twice the water of one unit at 80% for the same megawatts.
 */

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<Unavailability_MarketDocument>
  <TimeSeries>
    <production_RegisteredResource.name>Paks 2</production_RegisteredResource.name>
    <production_RegisteredResource.pSRType.powerSystemResources.nominalP>500</production_RegisteredResource.pSRType.powerSystemResources.nominalP>
    <available_Period>
      <timeInterval>
        <start>2026-08-01T00:00Z</start>
        <end>2026-09-01T00:00Z</end>
      </timeInterval>
      <Point><position>1</position><quantity>0</quantity></Point>
    </available_Period>
  </TimeSeries>
  <TimeSeries>
    <production_RegisteredResource.name>Paks 3</production_RegisteredResource.name>
    <production_RegisteredResource.pSRType.powerSystemResources.nominalP>500</production_RegisteredResource.pSRType.powerSystemResources.nominalP>
    <available_Period>
      <timeInterval>
        <start>2026-08-01T00:00Z</start>
        <end>2026-09-01T00:00Z</end>
      </timeInterval>
      <Point><position>1</position><quantity>250</quantity></Point>
    </available_Period>
  </TimeSeries>
  <TimeSeries>
    <production_RegisteredResource.name>Paks 4</production_RegisteredResource.name>
    <available_Period>
      <timeInterval>
        <start>2026-01-01T00:00Z</start>
        <end>2026-02-01T00:00Z</end>
      </timeInterval>
      <Point><position>1</position><quantity>0</quantity></Point>
    </available_Period>
  </TimeSeries>
</Unavailability_MarketDocument>`;

const DURING = Date.parse('2026-08-15T12:00Z');

test('outages are read out of the response', () => {
  const outages = parseOutages(SAMPLE);
  assert.strictEqual(outages.length, 3);

  const paks2 = outages.find((o) => o.unitName === 'Paks 2');
  assert.strictEqual(paks2.nominalMw, 500);
  assert.strictEqual(paks2.availableMw, 0);
  assert.strictEqual(paks2.start, '2026-08-01T00:00:00.000Z');
});

test('only outages in force right now count', () => {
  // A published outage that has ended, or has not started, is not an outage.
  const active = activeAt(parseOutages(SAMPLE), DURING);
  assert.strictEqual(active.length, 2);
  assert.ok(!active.some((o) => o.unitName === 'Paks 4'), 'the January outage is over');
});

test('a fully unavailable unit reduces the count, a derated one does not', () => {
  // Paks 2 is out entirely. Paks 3 is at half capacity - still online, pumps running,
  // which is what the water model cares about.
  const online = unitsOnlineFor(getPlant('paks-1'), parseOutages(SAMPLE), DURING);
  assert.strictEqual(online, 3);
});

test('duplicate messages for one unit are not counted twice', () => {
  const doubled = SAMPLE.replace('</Unavailability_MarketDocument>', `
  <TimeSeries>
    <production_RegisteredResource.name>Paks 2</production_RegisteredResource.name>
    <available_Period>
      <timeInterval><start>2026-08-02T00:00Z</start><end>2026-09-01T00:00Z</end></timeInterval>
      <Point><position>1</position><quantity>0</quantity></Point>
    </available_Period>
  </TimeSeries>
</Unavailability_MarketDocument>`);

  assert.strictEqual(unitsOnlineFor(getPlant('paks-1'), parseOutages(doubled), DURING), 3);
});

test('no outages means every unit is available', () => {
  assert.strictEqual(unitsOnlineFor(getPlant('paks-1'), [], DURING), 4);
});

test('a plant with no unit pattern yields no opinion rather than a wrong one', () => {
  // Better to fall back to inference than to claim knowledge about a plant whose units
  // this source cannot identify.
  assert.strictEqual(unitsOnlineFor(getPlant('gonyu'), parseOutages(SAMPLE), DURING), null);
});

test('another plant is not matched by Paks unit names', () => {
  const matra = { ...getPlant('matra'), unitCount: 5, entsoeUnitPattern: '^m(á|a)tra' };
  assert.strictEqual(unitsOnlineFor(matra, parseOutages(SAMPLE), DURING), 5);
});

test('malformed XML yields no outages rather than throwing', () => {
  assert.deepStrictEqual(parseOutages('<html>not a document</html>'), []);
  assert.deepStrictEqual(parseOutages(''), []);
});

test('the period format is the platform s yyyyMMddHHmm in UTC', () => {
  assert.strictEqual(formatPeriod(new Date('2026-08-04T07:05:00Z')), '202608040705');
});

test('the request carries the token, domain and window', () => {
  const url = buildUrl({ ...config({ ENTSOE_TOKEN: 'secret' }), token: 'secret' }, {
    from: new Date('2026-08-01T00:00Z'),
    to: new Date('2026-08-08T00:00Z'),
  });

  assert.match(url, /securityToken=secret/);
  assert.match(url, /biddingZone_Domain=10YHU-MAVIR----U/);
  assert.match(url, /periodStart=202608010000/);
  assert.match(url, /periodEnd=202608080000/);
});
