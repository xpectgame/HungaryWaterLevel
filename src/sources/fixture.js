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

/** Paks refuels one unit at a time, mostly outside the winter peak. */
function seasonalOutage(at) {
  const month = at.getMonth();
  return month >= 4 && month <= 8 && Math.abs(noise(Math.floor(at.getTime() / DAY_MS))) > 0.75;
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

module.exports = { fetchAll, fetchGeneration, stationFlow, seasonalFactor };
