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
    <production_RegisteredResource.name>PA_gép3</production_RegisteredResource.name>
    <production_RegisteredResource.pSRType.powerSystemResources.nominalP>220</production_RegisteredResource.pSRType.powerSystemResources.nominalP>
    <available_Period>
      <timeInterval>
        <start>2026-08-01T00:00Z</start>
        <end>2026-09-01T00:00Z</end>
      </timeInterval>
      <Point><position>1</position><quantity>0</quantity></Point>
    </available_Period>
  </TimeSeries>
  <TimeSeries>
    <production_RegisteredResource.name>PA_gép4</production_RegisteredResource.name>
    <production_RegisteredResource.pSRType.powerSystemResources.nominalP>220</production_RegisteredResource.pSRType.powerSystemResources.nominalP>
    <available_Period>
      <timeInterval>
        <start>2026-08-01T00:00Z</start>
        <end>2026-09-01T00:00Z</end>
      </timeInterval>
      <Point><position>1</position><quantity>0</quantity></Point>
    </available_Period>
  </TimeSeries>
  <TimeSeries>
    <production_RegisteredResource.name>PA_gép5</production_RegisteredResource.name>
    <production_RegisteredResource.pSRType.powerSystemResources.nominalP>220</production_RegisteredResource.pSRType.powerSystemResources.nominalP>
    <available_Period>
      <timeInterval>
        <start>2026-08-01T00:00Z</start>
        <end>2026-09-01T00:00Z</end>
      </timeInterval>
      <Point><position>1</position><quantity>110</quantity></Point>
    </available_Period>
  </TimeSeries>
  <TimeSeries>
    <production_RegisteredResource.name>PA_gép7</production_RegisteredResource.name>
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
  assert.strictEqual(outages.length, 4);

  const generator = outages.find((o) => o.unitName === 'PA_gép3');
  assert.strictEqual(generator.nominalMw, 220);
  assert.strictEqual(generator.availableMw, 0);
  assert.strictEqual(generator.start, '2026-08-01T00:00:00.000Z');
});

test('only outages in force right now count', () => {
  // A published outage that has ended, or has not started, is not an outage.
  const active = activeAt(parseOutages(SAMPLE), DURING);
  assert.strictEqual(active.length, 3);
  assert.ok(!active.some((o) => o.unitName === 'PA_gép7'), 'the January outage is over');
});

test('a fully unavailable unit reduces the count, a derated one does not', () => {
  // Block 2 is out entirely - BOTH its generators, PA_gép3 and PA_gép4, at zero.
  // PA_gép5 is at half capacity: still online, pumps running, which is what the water
  // model cares about.
  const online = unitsOnlineFor(getPlant('paks-1'), parseOutages(SAMPLE), DURING);
  assert.strictEqual(online, 3);
});

test('duplicate messages for one unit are not counted twice', () => {
  const doubled = SAMPLE.replace('</Unavailability_MarketDocument>', `
  <TimeSeries>
    <production_RegisteredResource.name>PA_gép3</production_RegisteredResource.name>
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

// ---------------------------------------------------------------------------
// Generation documents - the MAVIR replacement
// ---------------------------------------------------------------------------

const {
  parseGeneration,
  parseUnitGeneration,
  lastPoint,
  buildUrl: buildEntsoeUrl,
  config: entsoeConfig,
} = require('../src/sources/entsoe');

// Shaped like a real A75 response: nuclear plus a pumped-storage series that reports
// both directions, which is the trap in this document.
const A75 = `<GL_MarketDocument>
  <TimeSeries>
    <inBiddingZone_Domain.mRID>10YHU-MAVIR----U</inBiddingZone_Domain.mRID>
    <MktPSRType><psrType>B14</psrType></MktPSRType>
    <Period>
      <timeInterval><start>2026-08-08T10:00Z</start><end>2026-08-08T11:00Z</end></timeInterval>
      <start>2026-08-08T10:00Z</start>
      <resolution>PT15M</resolution>
      <Point><position>1</position><quantity>1800</quantity></Point>
      <Point><position>2</position><quantity>1850</quantity></Point>
      <Point><position>3</position><quantity>1902</quantity></Point>
    </Period>
  </TimeSeries>
  <TimeSeries>
    <inBiddingZone_Domain.mRID>10YHU-MAVIR----U</inBiddingZone_Domain.mRID>
    <MktPSRType><psrType>B04</psrType></MktPSRType>
    <Period>
      <start>2026-08-08T10:00Z</start>
      <resolution>PT15M</resolution>
      <Point><position>1</position><quantity>1200</quantity></Point>
      <Point><position>3</position><quantity>1310</quantity></Point>
    </Period>
  </TimeSeries>
  <TimeSeries>
    <outBiddingZone_Domain.mRID>10YHU-MAVIR----U</outBiddingZone_Domain.mRID>
    <MktPSRType><psrType>B10</psrType></MktPSRType>
    <Period>
      <start>2026-08-08T10:00Z</start>
      <resolution>PT15M</resolution>
      <Point><position>3</position><quantity>400</quantity></Point>
    </Period>
  </TimeSeries>
</GL_MarketDocument>`;

test('A75 gives the same generation mix MAVIR publishes, without the portal', () => {
  const parsed = parseGeneration(A75);

  assert.strictEqual(parsed.generationMw.nuclear, 1902, 'nuclear is Paks I and nothing else');
  assert.strictEqual(parsed.generationMw.naturalGas, 1310);
});

test('the newest published point wins, not the last position the resolution implies', () => {
  // The platform omits trailing positions that have no value yet, and gas here skips
  // position 2 entirely. Counting slots rather than reading positions misdates the value.
  const parsed = parseGeneration(A75);
  assert.strictEqual(parsed.timestamp, '2026-08-08T10:30:00.000Z', 'position 3 of PT15M from 10:00');
});

test('the pumping leg of a pumped-storage series is not counted as generation', () => {
  // The platform reports pumped storage in both directions. Adding the consumption leg
  // would inflate the mix by the amount being consumed.
  const parsed = parseGeneration(A75);
  assert.strictEqual(parsed.generationMw.hydroPumped, undefined);
});

test('a document with no usable series returns nothing rather than an empty mix', () => {
  assert.strictEqual(parseGeneration('<Acknowledgement_MarketDocument/>'), null);
  assert.strictEqual(lastPoint('<Period><start>2026-08-08T10:00Z</start></Period>'), null);
});

test('A73 names each unit, which is what the units cooling model needs', () => {
  // MAVIR publishes nuclear as one number. Two units at 40% and one at 80% are the same
  // megawatts and very different cooling water, because pumps belong to a unit.
  const units = parseUnitGeneration(`<GL_MarketDocument>
    <TimeSeries>
      <MktPSRType>
        <psrType>B14</psrType>
        <PowerSystemResources><name>PA_gép1</name><nominalP>220</nominalP></PowerSystemResources>
      </MktPSRType>
      <Period><start>2026-08-08T10:00Z</start><resolution>PT60M</resolution>
        <Point><position>1</position><quantity>473</quantity></Point></Period>
    </TimeSeries>
    <TimeSeries>
      <MktPSRType>
        <psrType>B14</psrType>
        <PowerSystemResources><name>PA_gép2</name><nominalP>220</nominalP></PowerSystemResources>
      </MktPSRType>
      <Period><start>2026-08-08T10:00Z</start><resolution>PT60M</resolution>
        <Point><position>1</position><quantity>0</quantity></Point></Period>
    </TimeSeries>
  </GL_MarketDocument>`);

  assert.strictEqual(units.length, 2);
  assert.deepStrictEqual(
    units.map((u) => [u.unitName, u.powerMw]),
    [['PA_gép1', 473], ['PA_gép2', 0]],
  );
  assert.strictEqual(units[0].sourceType, 'nuclear');
  assert.strictEqual(units[0].nominalMw, 220);
});

test('generation queries use in_Domain and a process type; outage queries do not', () => {
  // Without processType the platform answers with a "no matching data" acknowledgement
  // rather than an error - a failure that reads as an idle grid.
  const cfg = { ...entsoeConfig({}), token: 'x' };
  const window = { from: new Date('2026-08-08T00:00Z'), to: new Date('2026-08-08T12:00Z') };

  const generation = buildEntsoeUrl(cfg, { ...window, documentType: 'A75', processType: 'A16', domainParam: 'in_Domain' });
  assert.match(generation, /in_Domain=10YHU-MAVIR----U/);
  assert.match(generation, /processType=A16/);
  assert.match(generation, /periodStart=202608080000/);

  const outages = buildEntsoeUrl(cfg, window);
  assert.match(outages, /biddingZone_Domain=/);
  assert.doesNotMatch(outages, /processType/);
});

// ---------------------------------------------------------------------------
// The token, and what a bad paste does to it
// ---------------------------------------------------------------------------

test('a token pasted with its surrounding YAML is rejected by name, not by 401', () => {
  // This happened. A repository secret was set to the token plus a newline and the
  // workflow line that references it, and all three documents came back HTTP 401 - a
  // message that says "wrong credentials" while the credentials were perfectly correct.
  const { cleanToken } = require('../src/sources/entsoe');
  const pasted = '10b93e88-0000-0000-0000-000000000000\n  ENTSOE_TOKEN: ${{ secrets.ENTSOE_TOKEN }}';

  const result = cleanToken(pasted);
  assert.strictEqual(result.token, null, 'a value with whitespace inside must not be sent');
  assert.match(result.error, /whitespace/);
  assert.match(result.error, /one line/);
});

test('a trailing newline or a stray quote is fixed rather than reported', () => {
  // Paste artefacts, not decisions: a text field that adds a newline should not cost
  // anyone an afternoon.
  const { cleanToken } = require('../src/sources/entsoe');
  const bare = '10b93e88-0000-0000-0000-000000000000';

  assert.strictEqual(cleanToken(`${bare}\n`).token, bare);
  assert.strictEqual(cleanToken(`  ${bare}  `).token, bare);
  assert.strictEqual(cleanToken(`"${bare}"`).token, bare);
  assert.strictEqual(cleanToken(`'${bare}'`).token, bare);
  assert.strictEqual(cleanToken(bare).error, undefined);
});

test('a missing token stays a missing token, not an error', () => {
  // Absent is a supported state - the units model falls back to inference and says so.
  const { cleanToken } = require('../src/sources/entsoe');
  for (const value of [undefined, null, '', '   ']) {
    const result = cleanToken(value);
    assert.strictEqual(result.token, null);
    assert.strictEqual(result.error, undefined, `${JSON.stringify(value)} must not be an error`);
  }
});

test('a malformed token is reported everywhere the token is required', () => {
  const { config: entsoeCfg, fetchGeneration } = require('../src/sources/entsoe');
  const env = { ENTSOE_TOKEN: 'abc def' };

  assert.strictEqual(entsoeCfg(env).token, null);
  assert.match(entsoeCfg(env).tokenError, /whitespace/);

  // And the thrown error names the real problem rather than claiming nothing is set.
  return assert.rejects(() => fetchGeneration(env), /whitespace/);
});

test('each document is requested inside the window the platform allows', () => {
  // Both limits came back as HTTP 400 with the platform naming them exactly:
  //   A73 "must not span more than 1 day"
  //   A80 "The number of instances (320) exceeds the allowed maximum (200)"
  // Encoded here so a future widening of either window fails a test rather than a poll.
  const { config: entsoeCfg } = require('../src/sources/entsoe');
  const cfg = { ...entsoeCfg({}), token: 'x' };
  const spanHours = (url) => {
    const q = new URL(url).searchParams;
    const parse = (s) =>
      Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}Z`);
    return (parse(q.get('periodEnd')) - parse(q.get('periodStart'))) / 3600000;
  };
  const now = new Date('2026-08-10T08:10:00Z');

  const a73 = buildEntsoeUrl(cfg, {
    from: new Date(now.getTime() - 23 * 3600 * 1000),
    to: new Date(now.getTime() + 3600 * 1000),
    documentType: 'A73',
  });
  assert.ok(spanHours(a73) <= 24, `A73 window is ${spanHours(a73)} h, the platform allows 24`);

  const a80 = buildEntsoeUrl(cfg, {
    from: new Date(now.getTime() - 86400000),
    to: new Date(now.getTime() + 86400000),
  });
  assert.ok(spanHours(a80) <= 96, `A80 window is ${spanHours(a80)} h; nine days returned 320 of a 200 cap`);
});

// ---------------------------------------------------------------------------
// Paks is eight generators, not four blocks
// ---------------------------------------------------------------------------

test('the Paks pattern matches the names the platform actually uses', () => {
  // '^paks' was written from expectation and matched nothing. A pattern that matches
  // nothing never errors - it silently reports every unit available, forever.
  const paks = getPlant('paks-1');
  const matcher = new RegExp(paks.entsoeUnitPattern, 'i');

  for (let n = 1; n <= 8; n += 1) assert.ok(matcher.test(`PA_gép${n}`), `PA_gép${n} must match`);
  // ...and does not sweep up the other plants in the same document.
  for (const other of ['MÁ2_gép4', 'DG3_gép8', 'GÖNYÜ_gép1', 'CSP_GT1', 'Litér_GT']) {
    assert.ok(!matcher.test(other), `${other} must not match the Paks pattern`);
  }
});

test('two generators out of one block is not a block out', () => {
  // A VVER-440 block carries two turbogenerators. One turbine down still leaves the
  // block's circulating pumps running for the other, and pumps are what the water model
  // counts. Only a block with both generators out has stopped drawing cooling water.
  const paks = getPlant('paks-1');
  const now = Date.parse('2026-08-10T08:00:00Z');
  const out = (unitName) => ({
    unitName,
    availableMw: 0,
    start: new Date(now - 3600000).toISOString(),
    end: new Date(now + 3600000).toISOString(),
  });

  // Both generators of block 1 (gép1, gép2): one block down, three left.
  assert.strictEqual(unitsOnlineFor(paks, [out('PA_gép1'), out('PA_gép2')], now), 3);
  // One generator each from two different blocks: neither block has stopped.
  assert.strictEqual(unitsOnlineFor(paks, [out('PA_gép1'), out('PA_gép3')], now), 4);
  // Everything out: no blocks left, and crucially not a negative clamped to zero by
  // accident - eight names against four blocks used to produce exactly this by mistake.
  const allOut = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => out(`PA_gép${n}`));
  assert.strictEqual(unitsOnlineFor(paks, allOut, now), 0);
  // Nothing out: all four.
  assert.strictEqual(unitsOnlineFor(paks, [], now), 4);
});
