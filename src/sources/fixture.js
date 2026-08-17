'use strict';

const { pollableStations } = require('../config/stations');
const { getThresholds } = require('../config/stage-thresholds');
const { gaugedLakes } = require('../config/lakes');

/**
 * Synthetic but physically plausible data source.
 *
 * This exists so the API is fully runnable and testable without reaching either
 * upstream service - useful for development, for CI, and for the period before the
 * live endpoint shapes have been confirmed. It is deterministic for a given
 * timestamp, so tests can assert exact numbers.
 *
 * Everything it emits is clearly marked `source: 'fixture'` and `synthetic: true`,
 * and the server refuses to start in production with this provider unless explicitly
 * forced. Synthetic hydrology must never quietly reach a user believing it is real.
 */

const DAY_MS = 86400000;

/** Deterministic pseudo-random in [-1, 1] from an integer seed. */
function noise(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/**
 * Seasonal shape of Hungarian rivers: high water in spring from Alpine and Carpathian
 * snowmelt, low water in late summer and autumn. Peak around early April.
 */
function seasonalFactor(date) {
  const dayOfYear = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / DAY_MS);
  const phase = ((dayOfYear - 95) / 365) * 2 * Math.PI;
  return 1 + 0.35 * Math.cos(phase);
}

/** Slow, correlated departure from the seasonal mean - the passage of weather. */
function weatherFactor(date, stationSeed) {
  const days = Math.floor(date.getTime() / DAY_MS);
  const slow = noise(days * 0.7 + stationSeed);
  const slower = noise(Math.floor(days / 7) * 1.3 + stationSeed);
  return 1 + 0.18 * slow + 0.25 * slower;
}

function seedFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 100000;
  return hash;
}

function stationFlow(station, at) {
  const seed = seedFor(station.id);
  const raw = station.meanFlow * seasonalFactor(at) * weatherFactor(at, seed);
  // Rivers cannot run backwards and rarely drop below ~25% of mean.
  return Math.max(station.meanFlow * 0.25, raw);
}

/**
 * A stage to go with the synthetic discharge.
 *
 * Not a rating curve - there is no rating curve here to invert. It places the gauge on
 * its own recorded LKV..LNV range as a concave function of how the flow compares to the
 * long-term mean, which gets the shape right: mean water sits low on a scale whose top
 * is a record flood, and it takes several times the mean flow to climb near it.
 *
 * Returns null where the reference table has nothing, so the fixture reproduces the real
 * gap at Tiszabecs rather than papering over it. Without this, the entire stage display
 * would be untestable and invisible in local development, which is how a feature ships
 * broken.
 */
function stationStage(station, flow) {
  const thresholds = getThresholds(station.id);
  if (!thresholds || !Number.isFinite(thresholds.lkv) || !Number.isFinite(thresholds.lnv)) return null;
  if (!(station.meanFlow > 0)) return null;

  const position = Math.min(0.95, Math.max(0.03, 0.05 + 0.25 * Math.sqrt(flow / station.meanFlow)));
  return Math.round(thresholds.lkv + position * (thresholds.lnv - thresholds.lkv));
}

/**
 * A synthetic lake level.
 *
 * Lakes behave nothing like rivers: they integrate weather rather than reflecting it, so
 * the level wanders slowly and seasonally - high after the spring melt, falling through
 * an evaporating summer - instead of spiking with each front. Anchored to the middle of
 * the gauge's own recorded range so the number is always inside what has really happened
 * there.
 */
function lakeLevel(lake, at) {
  const thresholds = getThresholds(lake.id);
  if (!thresholds || !Number.isFinite(thresholds.lkv) || !Number.isFinite(thresholds.lnv)) return null;

  const seed = seedFor(lake.id);
  const days = Math.floor(at.getTime() / DAY_MS);
  const season = seasonalFactor(at) - 1; // roughly -0.35 .. +0.35, peaking in spring
  const drift = 0.08 * noise(Math.floor(days / 5) * 1.7 + seed);

  // Around 40% of the way up the recorded range - a lake spends most of its life well
  // below a record high, which was set by one flood year.
  const position = Math.min(0.9, Math.max(0.1, 0.4 + season * 0.25 + drift));
  return Math.round(thresholds.lkv + (thresholds.lnv - thresholds.lkv) * position);
}

async function fetchAll(env = process.env, at = new Date()) {
  const readings = {};

  for (const lake of gaugedLakes()) {
    const level = lakeLevel(lake, at);
    if (level === null) continue;
    readings[lake.id] = {
      stationId: lake.id,
      flowM3s: null,
      waterLevelCm: level,
      timestamp: at.toISOString(),
      source: 'fixture',
      quality: 'synthetic',
      synthetic: true,
    };
  }

  for (const station of pollableStations()) {
    const flow = round(stationFlow(station, at), 2);
    readings[station.id] = {
      stationId: station.id,
      flowM3s: flow,
      waterLevelCm: stationStage(station, flow),
      // A plausible seasonal water temperature, so the fixture exercises the same code
      // path the live feed does. Without it the whole temperature branch is dead in
      // every local run and in CI, and would first be exercised in production.
      waterTempC: round(
        12 + 10 * Math.sin(((at.getUTCMonth() + at.getUTCDate() / 30) / 12) * 2 * Math.PI - Math.PI / 2)
          + Math.sin(at.getUTCHours() / 24 * 2 * Math.PI) * 1.5,
        1,
      ),
      timestamp: at.toISOString(),
      source: 'fixture',
      quality: 'synthetic',
      synthetic: true,
    };
  }

  return {
    source: 'fixture',
    fetchedAt: at.toISOString(),
    readings,
    errors: [],
    synthetic: true,
  };
}

/**
 * Generation mix with a realistic daily shape: nuclear flat at baseload, PV following
 * the sun, gas filling the evening peak.
 */
async function fetchGeneration(env = process.env, at = new Date()) {
  const hour = at.getHours() + at.getMinutes() / 60;
  const seed = Math.floor(at.getTime() / (15 * 60 * 1000));

  // Paks I: baseload, occasionally one of four units is out for refuelling.
  const unitsOnline = seasonalOutage(at) ? 3 : 4;
  const nuclear = unitsOnline * 500 * (0.97 + 0.02 * noise(seed));

  // PV: zero at night, peak at solar noon, seasonally scaled.
  const solarElevation = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI));
  const pv = 3000 * solarElevation * seasonalFactor(at) * 0.7;

  // Load: morning ramp, evening peak.
  const load = 4800 + 900 * Math.sin(((hour - 8) / 24) * 2 * Math.PI) + 600 * Math.exp(-((hour - 19) ** 2) / 6);

  const wind = Math.max(0, 300 * (0.5 + 0.5 * noise(seed * 3)));
  const coal = 500 * (0.6 + 0.3 * noise(seed * 5));
  const biomass = 180;
  const hydro = 55;

  // Gas is the balancing item, and imports cover whatever is left.
  const nonGas = nuclear + pv + wind + coal + biomass + hydro;
  const naturalGas = Math.max(200, Math.min(2400, load * 0.55 - pv * 0.4));
  const netImport = load - (nonGas + naturalGas);

  return {
    source: 'fixture',
    synthetic: true,
    fetchedAt: at.toISOString(),
    timestamp: at.toISOString(),
    generationMw: {
      nuclear: round(nuclear, 1),
      naturalGas: round(naturalGas, 1),
      coal: round(coal, 1),
      pv: round(pv, 1),
      wind: round(wind, 1),
      biomass,
      hydro,
      load: round(load, 1),
      netImport: round(netImport, 1),
    },
  };
}

/**
 * Synthetic rainfall, shaped like the real thing rather than uniform.
 *
 * Rain is the least uniform quantity in this project: most days at most gauges are zero,
 * and a month's total is a handful of events. A fixture that sprinkles a little rain
 * everywhere every day would make every consumer look correct while hiding the two cases
 * that matter - a gauge with a genuine zero, and a run of dry days. So this generates
 * discrete wet days from the same deterministic noise the rivers use.
 */
async function fetchRainfall({ days = 30, now = new Date() } = {}) {
  const { listRainGauges, normalForWindow } = require('../config/rain-gauges');
  const to = now instanceof Date ? now : new Date(now);
  const from = new Date(to.getTime() - days * DAY_MS);
  const gauges = {};

  for (const gauge of listRainGauges()) {
    const seed = seedFor(gauge.id);
    // Aim the synthetic total at a fraction of this gauge's own normal, so the fixture
    // exercises the deficit arithmetic instead of hovering at exactly normal.
    const normal = normalForWindow(gauge.id, from.toISOString(), to.toISOString()) || 45;
    const aim = normal * (0.15 + 0.85 * ((noise(seed) + 1) / 2));

    const daily = [];
    let total = 0;
    for (let dayIndex = 0; dayIndex < days; dayIndex += 1) {
      const at = new Date(from.getTime() + dayIndex * DAY_MS);
      const roll = noise(Math.floor(at.getTime() / DAY_MS) * 3.1 + seed);
      // About one day in five is wet; the rest are honest zeroes.
      const mm = roll > 0.6 ? round((aim / 6) * (1 + roll), 1) : 0;
      total += mm;
      daily.push({ date: at.toISOString().slice(0, 10), mm });
    }

    const wet = daily.filter((d) => d.mm > 0);
    gauges[gauge.id] = {
      totalMm: round(total, 1),
      samples: days,
      wetDays: wet.length,
      firstAt: from.toISOString(),
      lastAt: new Date(to.getTime() - 6 * 3600 * 1000).toISOString(),
      lastRainAt: wet.length ? new Date(`${wet[wet.length - 1].date}T05:00:00Z`).toISOString() : null,
      daily,
    };
  }

  return {
    source: 'fixture',
    fetchedAt: to.toISOString(),
    windowDays: days,
    from: from.toISOString(),
    to: to.toISOString(),
    gauges,
    errors: [],
  };
}

/**
 * Synthetic groundwater, anchored to each well's own baked record.
 *
 * Anchored rather than invented, because the consumer's whole job is to rank a reading
 * against that well's history and refuse it when the two are not the same measurement.
 * A fixture that emitted round numbers would be refused as incommensurable at every well
 * - so the entire groundwater feature would be dead in local development and in CI, and
 * would first be exercised in production. The values here are that well's own median for
 * the month, walked a little, which is what a working feed looks like.
 *
 * The walk is deliberately biased downward. A synthetic network sitting exactly at its
 * median would leave every "is it low" branch untested.
 */
async function fetchWells({ days = 40, now = new Date(), env = process.env } = {}) {
  const { listWells } = require('../config/wells');
  const { loadWellHistory } = require('../domain/flow-history');
  const history = loadWellHistory() || {};
  const month = now.getUTCMonth();
  const wells = {};
  const errors = [];

  for (const well of listWells()) {
    const record = history[well.id] && history[well.id].months && history[well.id].months[month];
    if (!record) {
      errors.push({ wellId: well.id, error: 'no groundwater samples in the requested window' });
      continue;
    }
    const seed = seedFor(well.id);
    const span = Math.max(Math.abs(record.p[6] - record.p[0]), 0.05);
    // Between about a quarter-span above the median and a full span below it.
    const offset = (noise(seed + Math.floor(now.getTime() / DAY_MS)) - 0.6) * span * 0.8;
    wells[well.id] = {
      value: round(record.p[3] + offset, 2),
      // Spread the reading ages across the window so the staleness branch is exercised
      // rather than every well looking like it was read this morning.
      at: new Date(now.getTime() - Math.abs(seed % 9) * DAY_MS).toISOString(),
      samples: 40,
      firstAt: new Date(now.getTime() - days * DAY_MS).toISOString(),
    };
  }

  return {
    source: 'fixture',
    kind: 'rétegvízszint',
    synthetic: true,
    fetchedAt: now.toISOString(),
    windowDays: days,
    wells,
    errors,
  };
}

/**
 * Synthetic shallow water table, anchored to each station's own baked record.
 *
 * Same reasoning as the well fixture: a reading that is not commensurable with the
 * station's own decade is refused, so round invented numbers would leave the entire
 * drought feature dead in CI and first exercised in production. Biased toward the dry
 * end, because a synthetic network sitting at its median would never exercise the branch
 * the section exists for.
 */
async function fetchShallowWells({ days = 10, now = new Date(), env = process.env } = {}) {
  const { listShallowWells } = require('../config/shallow-wells');
  const { loadShallowHistory } = require('../domain/flow-history');
  const history = loadShallowHistory() || {};
  const month = now.getUTCMonth();
  const wells = {};
  const errors = [];

  for (const well of listShallowWells()) {
    const record = history[well.id] && history[well.id].months && history[well.id].months[month];
    if (!record) { errors.push({ wellId: well.id, error: 'no samples in the requested window' }); continue; }
    const seed = seedFor(well.id);
    const span = Math.max(Math.abs(record.p[6] - record.p[0]), 1);
    // Positive offset is DEEPER here, so the bias runs the other way from the wells.
    const offset = (noise(seed + Math.floor(now.getTime() / DAY_MS)) + 0.55) * span * 0.7;
    wells[well.id] = {
      value: round(record.p[3] + offset, 1),
      at: new Date(now.getTime() - Math.abs(seed % 4) * DAY_MS).toISOString(),
      samples: 40,
      firstAt: new Date(now.getTime() - days * DAY_MS).toISOString(),
    };
  }

  return { source: 'fixture', kind: 'talajvízállás', synthetic: true,
    fetchedAt: now.toISOString(), windowDays: days, wells, errors };
}

/**
 * Synthetic unit availability, anchored to each unit's own baked hourly baseline.
 *
 * Fixture mode used to return an empty availability record, which meant the whole
 * per-unit branch - how many machines are running, what each is producing, how that
 * compares with its own recent behaviour - was dead in local development and in CI, and
 * would first have been exercised in production. That is the failure this file exists to
 * prevent, so the fixture now produces units shaped like the real ones.
 *
 * One unit per plant is deliberately held at zero: a plant with everything running is the
 * easy case, and the interesting rendering is the one with a machine down.
 */
async function fetchAvailability(env = process.env, at = new Date()) {
  const { listPlants } = require('../config/powerplants');
  const { loadUnitHistory } = require('../domain/unit-baseline');
  const history = loadUnitHistory() || {};
  const hour = at.getUTCHours();
  const availability = {};

  for (const plant of listPlants('operating')) {
    if (!plant.entsoeUnitPattern) continue;
    const matcher = new RegExp(plant.entsoeUnitPattern, 'i');
    const names = Object.keys(history).filter((n) => matcher.test(n)).sort();
    if (!names.length) continue;

    const units = names.map((name, index) => {
      const entry = history[name];
      const base = entry.hourlyMeanMw[hour] || entry.meanMw || 0;
      const jitter = 1 + 0.18 * noise(seedFor(name) + Math.floor(at.getTime() / (15 * 60 * 1000)));
      // The last unit of a plant with more than one is shut, so the "down" branch is
      // rendered somewhere on every run.
      const down = names.length > 1 && index === names.length - 1;
      return {
        unitName: name,
        powerMw: down ? 0 : round(Math.max(0, base * jitter), 1),
        sourceType: entry.sourceType,
        at: at.toISOString(),
      };
    });

    const running = units.filter((u) => u.powerMw > 0).length;
    availability[plant.id] = {
      unitsOnline: Math.max(1, Math.round((running / units.length) * (plant.unitCount || units.length))),
      unitCount: plant.unitCount,
      source: 'fixture',
      basis: 'generation',
      measuredMw: round(units.reduce((sum, u) => sum + u.powerMw, 0), 1),
      declaredOnline: null,
      units,
      synthetic: true,
    };
  }

  return { source: 'fixture', configured: true, synthetic: true, fetchedAt: at.toISOString(), availability };
}

/** Paks refuels one unit at a time, mostly outside the winter peak. */
function seasonalOutage(at) {
  const month = at.getMonth();
  return month >= 4 && month <= 8 && Math.abs(noise(Math.floor(at.getTime() / DAY_MS))) > 0.75;
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}


/**
 * Declared water-shortage grades, synthesised from the baked district list.
 *
 * Anchored to the real districts rather than invented names, and deliberately NOT all at
 * one grade: a fixture where every district is identical would let a renderer that
 * ignores the grade entirely pass every test. The spread here is arbitrary but fixed, so
 * the same district gets the same grade on every run.
 */
/**
 * Synthetic soil moisture, drawn from each station's own baked record.
 *
 * Same reasoning as the wells: a number invented out of thin air would not be
 * commensurable with the station's record, so the ranking branch - the whole point of the
 * section - would never run in CI and would first be exercised in production. Biased
 * toward the dry end for the same reason, and clamped to 0-100 because a percentage that
 * left its own range would be a fixture bug wearing a data bug's clothes.
 */
// 8, matching the live source. A fixture with a different window makes the trend three
// days long in development and a week long in production, and only one of them is tested.
async function fetchSoilMoisture({ days = 8, now = new Date() } = {}) {
  const registry = require('../config/soil-stations.json');
  const { loadSoilHistory } = require('../domain/soil');
  const history = (loadSoilHistory() || {}).stations || {};
  const month = now.getUTCMonth();
  const wells = {};
  const errors = [];

  for (const station of registry.stations) {
    const entry = history[station.id];
    const record = entry && entry.months && entry.months[month];
    if (!record) {
      errors.push({ wellId: station.id, error: 'no talajnedvesség samples in the requested window' });
      continue;
    }
    const seed = seedFor(station.id);
    const span = Math.max(record.max - record.min, 1);
    const offset = (noise(seed + Math.floor(now.getTime() / DAY_MS)) - 0.55) * span * 0.7;
    const value = round(Math.min(100, Math.max(0, record.p[2] + offset)), 2);
    wells[station.id] = {
      value,
      at: new Date(now.getTime() - (Math.abs(seed) % 3) * 3600 * 1000).toISOString(),
      samples: 72,
      firstAt: new Date(now.getTime() - days * DAY_MS).toISOString(),
      // A week ago, drawn from the same record and biased WET, so the synthetic network
      // is drying. Without a firstValue the trend branch would never run in CI and would
      // first be exercised in production, which is the whole reason this fixture reads
      // the baked record instead of inventing round numbers.
      firstValue: round(Math.min(100, Math.max(0, value + Math.abs(offset) * 0.4 + 0.3)), 2),
    };
  }

  return {
    source: 'fixture',
    kind: registry.kind.label,
    fetchedAt: now.toISOString(),
    windowDays: days,
    wells,
    errors,
  };
}

async function fetchVizhiany({ now = new Date() } = {}) {
  let districts = [];
  try {
    districts = require('../../public/vizhiany.json').districts || [];
  } catch {
    districts = [];
  }

  const CODES = [724, 724, 724, 723, 722, 720];
  const LABELS = { 720: null, 722: 'II. fok', 723: 'III. fok', 724: 'rendkívüli vízhiány' };
  const ORDER = { 720: 0, 721: 1, 722: 2, 723: 3, 724: 4 };

  return {
    source: 'fixture',
    synthetic: true,
    fetchedAt: now.toISOString(),
    districts: districts.map((d, i) => {
      const code = CODES[Math.abs(seedFor(d.id || String(i))) % CODES.length];
      const prev = code === 720 ? 720 : code - 1;
      return {
        id: d.id,
        name: d.name,
        vizig: d.vizig || null,
        gradeCode: code,
        grade: ['none', 'i', 'ii', 'iii', 'extraordinary'][ORDER[code]],
        gradeOrder: ORDER[code],
        gradeLabel: LABELS[code],
        previousCode: prev,
        previousOrder: ORDER[prev] ?? null,
        declaredAt: new Date(now.getTime() - (i % 9) * DAY_MS).toISOString(),
        updatedAt: new Date(now.getTime() - (i % 5) * DAY_MS).toISOString(),
      };
    }),
  };
}

module.exports = {
  fetchAll, fetchVizhiany, fetchGeneration, fetchRainfall, fetchWells, fetchShallowWells,
  fetchSoilMoisture, fetchAvailability, stationFlow, seasonalFactor,
};
