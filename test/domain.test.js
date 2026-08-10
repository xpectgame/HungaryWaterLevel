'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { computeBalance } = require('../src/domain/balance');
const { computePlantWater, computeThermalLoad, condenserDutyMw } = require('../src/domain/cooling');
const { allocateGeneration } = require('../src/domain/allocation');
const { listStations, getStation, STATIONS } = require('../src/config/stations');
const { getPlant } = require('../src/config/powerplants');
const { validateReading } = require('../src/lib/validate');

/** Build a readings map where every station sits exactly at its long-term mean. */
function meanReadings(overrides = {}) {
  const readings = {};
  for (const station of STATIONS) {
    readings[station.id] = {
      stationId: station.id,
      flowM3s: overrides[station.id] ?? station.meanFlow,
      timestamp: new Date().toISOString(),
      source: 'test',
      quality: 'measured',
    };
  }
  return readings;
}

test('station registry excludes redundant gauges from the balance', () => {
  const balanceIds = listStations('inflow').concat(listStations('outflow')).map((s) => s.id);

  // The classic double-counts: a gauge downstream of another inflow gauge, and a
  // tributary already contained in the reading below its confluence.
  assert.ok(!balanceIds.includes('duna-nagymaros'), 'Nagymaros must not count as inflow');
  assert.ok(!balanceIds.includes('duna-budapest'), 'Budapest must not count as inflow');
  assert.ok(!balanceIds.includes('mura-letenye'), 'Mura is already inside the Őrtilos reading');

  // Rajka sits below the Cunovo diversion and carries only the old riverbed - roughly
  // half the Danube at low flow, less in normal flow. Counting it as the Danube inflow
  // is the largest single error available here, so it must never enter the sum.
  assert.ok(!balanceIds.includes('duna-rajka'), 'Rajka is below the diversion, not the inflow section');
  assert.ok(balanceIds.includes('duna-komarom'), 'the Danube inflow is taken at Komárom');
  assert.ok(balanceIds.includes('duna-mohacs'));

  // Tiszasziget is the border section but publishes no discharge, so Szeged carries the
  // term. Exactly one of the pair may be summed.
  assert.ok(balanceIds.includes('tisza-szeged'), 'the Tisza outflow is taken at Szeged');
  assert.ok(!balanceIds.includes('tisza-tiszasziget'), 'Tiszasziget would duplicate Szeged');
});

test('no two summed stations sit on the same river with one below the other', () => {
  // A structural version of the check above: any pair of summed gauges on one river
  // where the upstream reading is contained in the downstream one is a double-count.
  const summed = listStations('inflow').concat(listStations('outflow'));

  for (const station of summed) {
    assert.ok(
      !station.redundantWith,
      `${station.id} is summed but declares itself redundant with ${station.redundantWith}`,
    );
  }
});

test('every redundant station points at a station that exists', () => {
  for (const station of STATIONS) {
    if (!station.redundantWith) continue;
    assert.ok(getStation(station.redundantWith), `${station.id} -> ${station.redundantWith} not found`);
  }
});

test('balance at long-term means lands near the published national figures', () => {
  const balance = computeBalance(meanReadings());

  // Published long-term means: ~114 km3/a in (~3610 m3/s), ~117 km3/a out (~3710 m3/s).
  assert.ok(balance.inflow.totalM3s > 3400, `inflow ${balance.inflow.totalM3s} too low`);
  assert.ok(balance.inflow.totalM3s < 3800, `inflow ${balance.inflow.totalM3s} too high`);
  assert.ok(balance.outflow.totalM3s > 3500 && balance.outflow.totalM3s < 3900);
});

test('net balance is reported as insignificant when it sits inside the error band', () => {
  const balance = computeBalance(meanReadings());
  assert.ok(Math.abs(balance.net.m3s) < 2 * balance.net.uncertaintyM3s);
  assert.strictEqual(balance.net.significant, false);
  assert.match(balance.net.interpretation, /within measurement uncertainty/);
});

test('a large genuine imbalance is reported as significant', () => {
  // Triple the Danube at Komárom - far beyond any plausible rating-curve error.
  const balance = computeBalance(meanReadings({ 'duna-komarom': 6150 }));
  assert.ok(balance.net.m3s > 2000);
  assert.strictEqual(balance.net.significant, true);
  assert.strictEqual(balance.net.direction, 'accumulating');
});

test('uncertainty grows with the flows, never zero', () => {
  const balance = computeBalance(meanReadings());
  assert.ok(balance.net.uncertaintyM3s > 100, 'error band should be O(100) m3/s');
  // Quadrature combination must be smaller than a naive linear sum.
  assert.ok(balance.net.uncertaintyM3s < balance.inflow.uncertaintyM3s + balance.outflow.uncertaintyM3s + 1);
});

test('a missing gauge falls back to climatology and says so', () => {
  const readings = meanReadings();
  delete readings['duna-komarom'];

  const balance = computeBalance(readings);
  assert.strictEqual(balance.inflow.estimatedCount, 1);
  assert.ok(balance.dataQuality.warnings.some((w) => w.includes('duna-komarom')));

  const komarom = balance.inflow.stations.find((s) => s.id === 'duna-komarom');
  assert.strictEqual(komarom.quality, 'climatology');
  assert.strictEqual(komarom.flowM3s, getStation('duna-komarom').meanFlow);
});

test('ungauged inflow is reported separately and can be switched off', () => {
  const withUngauged = computeBalance(meanReadings());
  const without = computeBalance(meanReadings(), { includeUngauged: false });

  assert.ok(withUngauged.inflow.ungaugedM3s > 200);
  assert.strictEqual(without.inflow.ungaugedM3s, 0);
  assert.ok(withUngauged.inflow.totalM3s > without.inflow.totalM3s);
  // The gauged part must be identical either way.
  assert.strictEqual(withUngauged.inflow.gaugedM3s, without.inflow.gaugedM3s);
});

test('every discharge is reported against what is normal there', () => {
  // The whole point: 1671 m3/s at Komárom is either a drought or a Tuesday, and only the
  // ratio says which. A row without it is a number nobody can read.
  const balance = computeBalance(meanReadings());

  for (const side of ['inflow', 'outflow']) {
    for (const row of balance[side].stations) {
      assert.ok(row.longTermMeanM3s > 0, `${row.id} has no long-term mean`);
      assert.ok(Number.isFinite(row.ratioToMean), `${row.id} has no ratio to its mean`);
    }
    assert.ok(balance[side].longTermMeanM3s > 0);
  }

  // Fed exactly the long-term means, everything must read as exactly normal.
  assert.strictEqual(balance.inflow.ratioToMean, 1);
  assert.strictEqual(balance.outflow.ratioToMean, 1);
});

test('the normal for the inflow side includes the ungauged term it is compared against', () => {
  // Both sides of the comparison have to contain the same things. Leaving the ungauged
  // ~260 m3/s out of the reference while keeping it in the total would make every
  // reading look about 8% wetter than normal, for free.
  const withUngauged = computeBalance(meanReadings());
  const without = computeBalance(meanReadings(), { includeUngauged: false });

  assert.ok(withUngauged.inflow.longTermMeanM3s > without.inflow.longTermMeanM3s);
  assert.strictEqual(withUngauged.inflow.ratioToMean, 1);
  assert.strictEqual(without.inflow.ratioToMean, 1);
});

test('a drought reads as a drought in the ratio', () => {
  const half = {};
  for (const [id, reading] of Object.entries(meanReadings())) {
    half[id] = { ...reading, flowM3s: reading.flowM3s * 0.5 };
  }
  const balance = computeBalance(half);

  assert.ok(balance.inflow.ratioToMean < 0.55, `expected about half, got ${balance.inflow.ratioToMean}`);
  assert.ok(balance.inflow.stations.every((s) => Math.abs(s.ratioToMean - 0.5) < 0.01));
});

test('lagged method falls back to instant when no history is available', () => {
  const balance = computeBalance(meanReadings(), { method: 'lagged' });
  assert.strictEqual(balance.requestedMethod, 'lagged');
  assert.strictEqual(balance.method, 'instant');
  assert.ok(balance.dataQuality.warnings.some((w) => w.includes('fell back to instant')));
});

test('lagged method reads history at each station travel time', () => {
  const now = Date.now();
  const seen = [];
  const balance = computeBalance(meanReadings(), {
    method: 'lagged',
    now,
    historyLookup: (stationId, atMs) => {
      seen.push({ stationId, lagHours: Math.round((now - atMs) / 3600000) });
      return { stationId, flowM3s: 1, timestamp: new Date(atMs).toISOString() };
    },
  });

  assert.strictEqual(balance.method, 'lagged');
  const komarom = seen.find((s) => s.stationId === 'duna-komarom');
  assert.strictEqual(komarom.lagHours, getStation('duna-komarom').travelTimeHours);
  // Outflow stations are the time reference and must never be shifted.
  assert.ok(!seen.some((s) => s.stationId === 'duna-mohacs'));
});

// ---------------------------------------------------------------------------
// Cooling models
// ---------------------------------------------------------------------------

test('Paks linear model reproduces the quoted nominal cooling flow', () => {
  const paks = getPlant('paks-1');
  const water = computePlantWater(paks, 2000, { model: 'linear' });
  assert.strictEqual(water.withdrawalM3s, 105);
  assert.strictEqual(water.loadFactor, 1);
});

test('Paks linear and thermal models agree within 10 percent', () => {
  const paks = getPlant('paks-1');
  const linear = computePlantWater(paks, 2000, { model: 'linear' });
  const thermal = computePlantWater(paks, 2000, { model: 'thermal' });

  const difference = Math.abs(linear.withdrawalM3s - thermal.withdrawalM3s) / linear.withdrawalM3s;
  assert.ok(difference < 0.1, `models diverge by ${(difference * 100).toFixed(1)}%`);
});

test('once-through cooling returns over 99 percent of what it withdraws', () => {
  const water = computePlantWater(getPlant('paks-1'), 2000);
  assert.ok(water.dischargeM3s / water.withdrawalM3s > 0.99);
  assert.ok(water.consumptionM3s < 1);
});

test('cooling towers consume most of what they withdraw - the opposite profile', () => {
  const matra = computePlantWater(getPlant('matra'), 950);
  assert.ok(matra.consumptionM3s / matra.withdrawalM3s > 0.7);

  // The headline inversion: Paks withdraws vastly more but consumes comparably little.
  const paks = computePlantWater(getPlant('paks-1'), 2000);
  assert.ok(paks.withdrawalM3s > matra.withdrawalM3s * 100);
  assert.ok(paks.consumptionM3s < matra.consumptionM3s * 2);
});

test('withdrawal never falls below the idle auxiliary flow', () => {
  const water = computePlantWater(getPlant('paks-1'), 0);
  assert.strictEqual(water.withdrawalM3s, getPlant('paks-1').cooling.idleWithdrawalM3s);
  assert.ok(water.notes.some((n) => n.includes('idle')));
});

test('unknown generation yields idle flow, not a fabricated value', () => {
  const water = computePlantWater(getPlant('paks-1'), null);
  assert.strictEqual(water.powerMw, null);
  assert.strictEqual(water.withdrawalM3s, 4);
  assert.ok(water.notes.some((n) => n.includes('No generation figure')));
});

test('pumped storage water use ignores generation entirely', () => {
  const plant = getPlant('matra-pumped-storage');
  const idle = computePlantWater(plant, 0);
  const full = computePlantWater(plant, plant.capacityMw);

  assert.strictEqual(idle.withdrawalM3s, full.withdrawalM3s);
  assert.ok(full.notes.some((n) => n.includes('does not scale with generation')));
});

test('condenser duty is zero at zero output and rises with power', () => {
  const cooling = getPlant('paks-1').cooling;
  assert.strictEqual(condenserDutyMw(0, cooling), 0);
  assert.ok(condenserDutyMw(2000, cooling) > condenserDutyMw(1000, cooling));
});

test('the nominal cooling flow and the abstraction permit are mutually consistent', () => {
  const paks = getPlant('paks-1');
  const water = computePlantWater(paks, 2000, { model: 'linear' });
  const continuousAnnual = water.withdrawalM3s * 31_557_600;

  // Sustained full load for a whole year would breach the permit - 3.31 vs 3.1 billion m3.
  // That is not a modelling error: no nuclear station runs 8760 hours, because each unit
  // comes off for refuelling. The permit is sized for a realistic annual capacity factor,
  // and the two published figures only agree once that is taken into account.
  assert.ok(continuousAnnual > paks.permit.annualM3);

  const impliedCapacityFactor = paks.permit.annualM3 / continuousAnnual;
  assert.ok(
    impliedCapacityFactor > 0.9 && impliedCapacityFactor < 0.98,
    `permit implies a ${(impliedCapacityFactor * 100).toFixed(0)}% capacity factor, which does not look like a ceiling set for real operation`,
  );

  // At the ~90% capacity factor Paks I actually achieves, the permit holds comfortably.
  const realisticAnnual = continuousAnnual * 0.9;
  assert.ok(realisticAnnual < paks.permit.annualM3, `${realisticAnnual} exceeds permit at a realistic load factor`);
});

test('thermal load on the receiving river is a fraction of a degree', () => {
  const paks = getPlant('paks-1');
  const water = computePlantWater(paks, 2000);
  const load = computeThermalLoad(water, 2320, paks.cooling);

  assert.ok(load.mixedRiverRiseK > 0.3 && load.mixedRiverRiseK < 0.6);
  assert.ok(load.abstractionShareOfRiver < 0.06);
});

test('thermal load is not reported for cooling-tower plants', () => {
  const matra = getPlant('matra');
  const water = computePlantWater(matra, 950);
  assert.strictEqual(computeThermalLoad(water, 100, matra.cooling), null);
});

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

test('nuclear aggregate maps to Paks as a measured value', () => {
  const allocations = allocateGeneration({ nuclear: 1980, naturalGas: 1200 });
  const paks = allocations.find((a) => a.plantId === 'paks-1');

  assert.strictEqual(paks.confidence, 'measured');
  assert.strictEqual(paks.powerMw, 1980);
});

test('shared aggregates are split by capacity and flagged as estimates', () => {
  const allocations = allocateGeneration({ naturalGas: 1000 });
  const gas = allocations.filter((a) => a.sourceType === 'naturalGas');

  assert.ok(gas.length > 1);
  assert.ok(gas.every((a) => a.confidence === 'estimated'));
  assert.ok(gas.every((a) => a.caveat));

  const total = gas.reduce((sum, a) => sum + a.powerMw, 0);
  assert.ok(Math.abs(total - 1000) < 1, `allocated ${total}, expected 1000`);
});

test('allocation never exceeds a plant capacity', () => {
  const allocations = allocateGeneration({ naturalGas: 99999, nuclear: 99999 });
  for (const alloc of allocations) {
    const plant = getPlant(alloc.plantId);
    assert.ok(alloc.powerMw <= plant.capacityMw * 1.05, `${alloc.plantId} over capacity`);
  }
});

test('a missing source type yields unavailable, not zero', () => {
  const allocations = allocateGeneration({});
  assert.ok(allocations.every((a) => a.confidence === 'unavailable'));
  assert.ok(allocations.every((a) => a.powerMw === null));
});

test('plants under construction are excluded from live allocation', () => {
  const allocations = allocateGeneration({ nuclear: 1980 });
  assert.ok(!allocations.some((a) => a.plantId === 'paks-2'));
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('validation rejects sentinels, negatives and impossible magnitudes', () => {
  const base = { stationId: 'duna-rajka', timestamp: new Date().toISOString() };

  assert.strictEqual(validateReading({ ...base, flowM3s: 2000 }).ok, true);
  assert.strictEqual(validateReading({ ...base, flowM3s: -9999 }).ok, false);
  assert.strictEqual(validateReading({ ...base, flowM3s: -5 }).ok, false);
  assert.strictEqual(validateReading({ ...base, flowM3s: NaN }).ok, false);
  assert.strictEqual(validateReading({ ...base, flowM3s: 500000 }).ok, false);
  assert.strictEqual(validateReading({ ...base, flowM3s: 1 }).ok, false);
});

test('validation still accepts a genuine extreme flood', () => {
  // The upper Tisza really does reach 3000+ m3/s against a 143 m3/s mean.
  const result = validateReading({
    stationId: 'tisza-tiszabecs',
    flowM3s: 3000,
    timestamp: new Date().toISOString(),
  });
  assert.strictEqual(result.ok, true);
});

test('validation rejects future timestamps', () => {
  const result = validateReading({
    stationId: 'duna-rajka',
    flowM3s: 2000,
    timestamp: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /future/);
});

// ---------------------------------------------------------------------------
// Climatology fallback, at the scale it actually does damage
// ---------------------------------------------------------------------------

test('climatology substituted for a stale gauge can invent a significant imbalance', () => {
  // Not hypothetical. On 2026-08-08 at 14:00 UTC, nine of twenty-eight gauges had last
  // reported between 04:00 and 05:00 - inside a 24 h window, outside a 6 h one. Szeged
  // carries the whole Tisza outflow term, and its long-term mean is seven times what it
  // was actually flowing during the drought.
  const drought = {};
  for (const station of STATIONS) {
    if (!station.meanFlow) continue;
    drought[station.id] = {
      stationId: station.id,
      flowM3s: station.meanFlow * 0.32,
      timestamp: new Date().toISOString(),
      source: 'test',
      quality: 'measured',
    };
  }

  const honest = computeBalance(drought);

  // Drop Szeged the way an age filter would, leaving the balance to fall back on its mean.
  const withStale = { ...drought };
  delete withStale['tisza-szeged'];
  const distorted = computeBalance(withStale);

  const szeged = getStation('tisza-szeged');
  const inflated = distorted.outflow.totalM3s - honest.outflow.totalM3s;

  assert.ok(
    inflated > szeged.meanFlow * 0.6,
    `climatology should visibly inflate the outflow, got ${inflated.toFixed(0)} m3/s`,
  );
  // The whole point: the fabricated term is larger than the error band, so the API would
  // report it as a real, significant imbalance.
  assert.ok(inflated > 2 * honest.net.uncertaintyM3s);
  assert.strictEqual(honest.net.significant, false);
  assert.strictEqual(distorted.net.significant, true);
  assert.ok(distorted.dataQuality.warnings.some((w) => w.includes('tisza-szeged')));
});

test('the staleness window is at least as long as the window the adapter fetches', () => {
  // A shorter acceptance window than the fetch window discards measurements that were
  // just retrieved and replaces them with climatology.
  const { loadConfig } = require('../src/config');
  const config = loadConfig({});
  const vizugyConfig = require('../src/sources/vizugy').config({});

  assert.ok(
    config.maxReadingAgeMs >= vizugyConfig.lookbackHours * 3600 * 1000,
    `maxReadingAgeMs ${config.maxReadingAgeMs} is shorter than the ${vizugyConfig.lookbackHours} h fetch window`,
  );
});

test('a station with no usable upstream series is estimated, not silently zero', () => {
  // The Lajta's only gauges are a river section that publishes nothing and a barrage
  // tailwater that reads 0.0 when the gate is shut. A zero looks like a measurement and
  // would enter the sum as one; an estimate is labelled and counted as estimated.
  const readings = meanReadings();
  delete readings['lajta-mosonmagyarovar'];

  const balance = computeBalance(readings);
  const lajta = balance.inflow.stations.find((s) => s.id === 'lajta-mosonmagyarovar');

  assert.strictEqual(lajta.quality, 'climatology');
  assert.notStrictEqual(lajta.flowM3s, 0, 'an unavailable gauge must never read as zero flow');
  assert.ok(balance.inflow.estimatedCount >= 1);
});

test('a measured unit count survives whichever cooling model is asked for', () => {
  // How many blocks are turning is a fact about the plant, not an artefact of the water
  // model chosen to describe it. It used to appear only under model=units, so the
  // site's default view hid the figure even when ENTSO-E had measured it.
  const { buildPowerWater } = require('../src/domain/snapshot');
  const availability = {
    'paks-1': { unitsOnline: 1, unitCount: 4, source: 'entsoe', basis: 'generation', declaredOnline: 4 },
  };

  for (const coolingModel of ['linear', 'thermal', 'units']) {
    const built = buildPowerWater({ readings: {}, generation: null, coolingModel, availability });
    const paks = built.plants.find((p) => p.id === 'paks-1');
    assert.ok(paks.units, `units missing under model=${coolingModel}`);
    assert.strictEqual(paks.units.online, 1, `under model=${coolingModel}`);
    assert.strictEqual(paks.units.total, 4);
    assert.strictEqual(paks.units.basis, 'generation');
    // The two sources disagreed - outage notices said four, output said one. That gap
    // is the story, so it is carried rather than flattened.
    assert.strictEqual(paks.units.declaredOnline, 4);
  }
});

test('without availability the unit count says it was inferred', () => {
  const { buildPowerWater } = require('../src/domain/snapshot');
  const built = buildPowerWater({
    readings: {},
    generation: { generationMw: { nuclear: 1900 } },
    coolingModel: 'units',
  });
  const paks = built.plants.find((p) => p.id === 'paks-1');
  assert.strictEqual(paks.units.basis, 'inferred');
  assert.strictEqual(paks.units.known, false);
  assert.strictEqual(paks.units.declaredOnline, null);
});

test('a measured plant output replaces its share of the aggregate, and only its own', () => {
  // The gas fleet used to be split by capacity share, which is a guess at merit-order
  // dispatch. A73 publishes three of the four plants' own units, so those stop being
  // guesses - without disturbing the fourth, which publishes nothing.
  const { allocateGeneration } = require('../src/domain/allocation');
  const measuredMw = { gonyu: 1, dunamenti: 158, 'csepel-2': 0 };
  const allocations = allocateGeneration({ nuclear: 168, naturalGas: 900, coal: 184 }, { measuredMw });
  const by = Object.fromEntries(allocations.map((a) => [a.plantId, a]));

  assert.strictEqual(by.gonyu.confidence, 'measured');
  assert.strictEqual(by.gonyu.powerMw, 1);
  assert.strictEqual(by.dunamenti.powerMw, 158);
  assert.strictEqual(by['csepel-2'].powerMw, 0);

  // Tisza II publishes no units and keeps its estimate - the leftover aggregate is not
  // its output either, because the same aggregate carries CHPs this registry omits.
  assert.strictEqual(by['tisza-2'].confidence, 'estimated');
  assert.ok(by['tisza-2'].caveat);

  // Every plant still gets exactly one entry.
  assert.strictEqual(allocations.length, new Set(allocations.map((a) => a.plantId)).size);
});

test('an exclusive plant keeps its aggregate figure even when units are published', () => {
  // A75 read 168 MW for nuclear while the A73 units summed to 260 at the same minute.
  // Both are measurements and they disagree; swapping one for the other on a hunch
  // about gross-versus-net would trade a known number for an unexplained one.
  const { allocateGeneration } = require('../src/domain/allocation');
  const allocations = allocateGeneration({ nuclear: 168 }, { measuredMw: { 'paks-1': 260 } });
  const paks = allocations.find((a) => a.plantId === 'paks-1');

  assert.strictEqual(paks.powerMw, 168);
  assert.match(paks.method, /sole nuclear generator/);
});
