'use strict';

const { getStation, listStations } = require('../config/stations');
const { getLake, volumePerCm } = require('../config/lakes');
const { describeStage } = require('./stage');

/**
 * What is happening, and - only where the data actually says so - why.
 *
 * The hard rule in this file: every entry states a fact we measured, and carries the
 * numbers it was derived from. Nothing here explains a low river by something it did not
 * observe. "The Danube is low because of a dry spell in Bavaria" may well be true, but we
 * do not measure Bavaria, and a hydrology site that guesses at causes is worse than one
 * that reports levels.
 *
 * What we CAN say about causes is narrower and real:
 *
 *   - Where the water comes from. Every inflow section is tagged with the country
 *     upstream of it, so "the Danube is low" can be sharpened into "everything arriving
 *     from Austria and Slovakia is at about 70% of normal, and everything from Ukraine
 *     and Romania is at about 80%" - which is an observation, not a theory.
 *   - Structural mechanisms already documented in the registry, like Rajka sitting below
 *     the Cunovo diversion. Those are properties of the river system, not events.
 *   - Arithmetic on our own series: a step change, a run of days under a threshold, a
 *     flood grade crossed, a lake's weekly volume.
 *
 * Anything beyond that belongs in config/notes.js, which is written by a person and
 * carries a source link. The two are rendered differently on purpose.
 */

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** A change worth mentioning, as a fraction of the previous value. */
const STEP_CHANGE = 0.2;
/** Below this share of the long-term mean, a station is "running low" for the run detector. */
const LOW_RATIO = 0.6;
/** A run has to last at least this long before it is news rather than noise. */
const MIN_RUN_MS = 2 * DAY;

/** Upstream regions, so "where is the water short" has an answer bigger than one gauge. */
const REGIONS = {
  'AT': 'Ausztria',
  'SK': 'Szlovákia',
  'SK/AT': 'Ausztria és Szlovákia',
  'SK/UA': 'Szlovákia és Ukrajna',
  'UA': 'Ukrajna',
  'RO': 'Románia',
  'HR': 'Horvátország',
  'HR/SI': 'Horvátország és Szlovénia',
  'RS': 'Szerbia',
};

function round(v, digits = 1) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Latest usable sample at or before `at`, from an ascending series. */
function sampleNear(series, at, toleranceMs = 4 * HOUR) {
  let best = null;
  let bestDistance = Infinity;
  for (const row of series) {
    if (!Number.isFinite(row.flowM3s) && !Number.isFinite(row.waterLevelCm)) continue;
    const t = Date.parse(row.timestamp);
    if (Number.isNaN(t)) continue;
    const distance = Math.abs(t - at);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = row;
    }
  }
  return bestDistance <= toleranceMs ? best : null;
}

/**
 * Which side of the border the neighbouring country is on.
 *
 * `country` means different things by role, and reading it as one thing produced a false
 * sentence: Szeged is an outflow section tagged RS, and the feed reported "the water
 * arrives from Serbia" about a gauge where the water leaves towards Serbia. An interior
 * gauge has no neighbour at all and gets no clause.
 */
function neighbourClause(station) {
  const name = REGIONS[station.country] || station.country;
  if (!name) return '';
  if (station.role === 'inflow') return ` A víz ${name} felől érkezik.`;
  if (station.role === 'outflow') return ` Itt hagyja el az országot, ${name} felé.`;
  return '';
}

/**
 * A step change in discharge over a day.
 *
 * Compared against the reading closest to 24 hours ago rather than the first row in the
 * window: a series that only reaches back six hours would otherwise report a six-hour
 * change as a daily one, and understate every rise.
 */
function stepChange(station, series, now) {
  const latest = series[series.length - 1];
  const before = sampleNear(series, now - DAY, 5 * HOUR);
  if (!latest || !before || !Number.isFinite(latest.flowM3s) || !Number.isFinite(before.flowM3s)) return null;
  if (before.flowM3s <= 0) return null;

  const change = (latest.flowM3s - before.flowM3s) / before.flowM3s;
  if (Math.abs(change) < STEP_CHANGE) return null;

  const rising = change > 0;
  return {
    kind: rising ? 'rise' : 'fall',
    at: latest.timestamp,
    severity: Math.abs(change) > 0.5 ? 2 : 1,
    stationId: station.id,
    title: `${station.name}: ${rising ? 'áradás' : 'apadás'} — egy nap alatt ${change > 0 ? '+' : ''}${Math.round(change * 100)}%`,
    detail:
      `${round(before.flowM3s)} m³/s-ról ${round(latest.flowM3s)} m³/s-ra ` +
      `${rising ? 'nőtt' : 'csökkent'} a vízhozam.` + neighbourClause(station),
    evidence: {
      from: before.timestamp,
      fromM3s: round(before.flowM3s),
      toM3s: round(latest.flowM3s),
      changePct: Math.round(change * 100),
    },
  };
}

/**
 * How long a station has been running below LOW_RATIO of its mean.
 *
 * Walks back from the newest sample and stops at the first one that was not low, so a
 * single hour of recovery ends the run. That is the honest reading: "five days below
 * 60%" has to mean five unbroken days.
 */
function lowRun(station, series, now) {
  if (!(station.meanFlow > 0)) return null;
  const threshold = station.meanFlow * LOW_RATIO;

  let startedAt = null;
  let lowest = Infinity;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const row = series[i];
    if (!Number.isFinite(row.flowM3s)) continue;
    if (row.flowM3s >= threshold) break;
    startedAt = Date.parse(row.timestamp);
    lowest = Math.min(lowest, row.flowM3s);
  }
  if (startedAt === null) return null;

  const runMs = now - startedAt;
  if (runMs < MIN_RUN_MS) return null;

  const latest = series[series.length - 1];
  const days = Math.floor(runMs / DAY);
  return {
    kind: 'low-run',
    at: latest.timestamp,
    // A run this long on a section the balance actually counts is the bigger story.
    severity: station.role === 'inflow' || station.role === 'outflow' ? 2 : 1,
    stationId: station.id,
    title: `${station.name}: ${days} napja a sokéves átlag ${Math.round(LOW_RATIO * 100)}%-a alatt`,
    detail:
      `Most ${round(latest.flowM3s)} m³/s, az átlag ${station.meanFlow}. ` +
      `A mélypont ebben az időszakban ${round(lowest)} m³/s volt.`,
    evidence: {
      sinceMs: startedAt,
      days,
      currentM3s: round(latest.flowM3s),
      meanM3s: station.meanFlow,
      lowestM3s: round(lowest),
    },
  };
}

/** A flood readiness grade crossed since the previous reading. */
function gradeCrossing(station, series) {
  if (series.length < 2) return null;
  const latest = series[series.length - 1];
  const previous = series[series.length - 2];
  if (!Number.isFinite(latest.waterLevelCm) || !Number.isFinite(previous.waterLevelCm)) return null;

  const now = describeStage(latest.waterLevelCm, station.id);
  const before = describeStage(previous.waterLevelCm, station.id);
  if (!now || !before || now.grade === before.grade) return null;

  const rising = (now.grade || 0) > (before.grade || 0);
  return {
    kind: 'flood-grade',
    at: latest.timestamp,
    severity: 3,
    stationId: station.id,
    title: rising
      ? `${station.name}: elérte a(z) ${now.gradeName}et`
      : `${station.name}: ${before.gradeName} megszűnt`,
    detail: `A vízállás ${round(previous.waterLevelCm, 0)} cm-ről ${round(latest.waterLevelCm, 0)} cm-re változott.`,
    evidence: { fromCm: previous.waterLevelCm, toCm: latest.waterLevelCm, grade: now.grade },
  };
}

/** A lake's weekly volume change, priced in cubic metres. */
function lakeChange(lake, series, now) {
  const latest = series[series.length - 1];
  const before = sampleNear(series, now - 7 * DAY, DAY);
  if (!latest || !before) return null;
  if (!Number.isFinite(latest.waterLevelCm) || !Number.isFinite(before.waterLevelCm)) return null;

  const cm = latest.waterLevelCm - before.waterLevelCm;
  const perCm = volumePerCm(lake);
  if (Math.abs(cm) < 2 || perCm === null) return null;

  const volume = cm * perCm;
  return {
    kind: 'lake',
    at: latest.timestamp,
    severity: Math.abs(cm) >= 6 ? 2 : 1,
    lakeId: lake.id,
    title: `${lake.name}: egy hét alatt ${cm > 0 ? '+' : ''}${round(cm, 0)} cm`,
    detail:
      `${Math.abs(round(volume, 0))} millió m³-rel ${cm > 0 ? 'több' : 'kevesebb'} víz van benne, ` +
      `mint hét napja. Mostani vízszint ${round(latest.waterLevelCm, 0)} cm.`,
    evidence: { cm: round(cm, 1), volumeMm3: round(volume, 1), levelCm: latest.waterLevelCm },
  };
}

/**
 * A step down in nuclear output large enough to be a unit coming off.
 *
 * The published mix is national, not per-plant, so this says "about one unit's worth"
 * and never names a block - which one it was is not in this data. Paks is the only
 * nuclear plant in the country, so attributing the change to Paks is safe; attributing
 * it to a particular reactor would not be.
 */
function nuclearStep(generationSeries) {
  if (!generationSeries || generationSeries.length < 2) return null;
  const latest = generationSeries[generationSeries.length - 1];
  const previous = generationSeries[generationSeries.length - 2];
  const now = latest && latest.generationMw && latest.generationMw.nuclear;
  const before = previous && previous.generationMw && previous.generationMw.nuclear;
  if (!Number.isFinite(now) || !Number.isFinite(before)) return null;

  const change = now - before;
  // A Paks unit is ~470 MW; 300 is comfortably past load-following and ramping noise.
  if (Math.abs(change) < 300) return null;

  const units = Math.max(1, Math.round(Math.abs(change) / 470));
  return {
    kind: 'nuclear',
    at: latest.timestamp,
    severity: 2,
    plantId: 'paks',
    title: change < 0
      ? `Paks: az atomerőművi termelés ${Math.round(Math.abs(change))} MW-tal esett`
      : `Paks: az atomerőművi termelés ${Math.round(change)} MW-tal nőtt`,
    detail:
      `${Math.round(before)} MW-ról ${Math.round(now)} MW-ra. Ez nagyjából ${units} blokknyi ` +
      `változás — hogy melyik blokkról van szó, az ebből az adatból nem derül ki. ` +
      `A hűtővíz-kivétel ezzel arányosan változik.`,
    evidence: { fromMw: Math.round(before), toMw: Math.round(now), approxUnits: units },
  };
}

/**
 * Where the shortage is, by the country the water arrives from.
 *
 * This is the closest thing to a "why" that the measurements support. It cannot say what
 * the weather did in the Alps, but it can say that every section fed from that direction
 * is carrying two thirds of its normal flow while the eastern ones are carrying four
 * fifths - and that is the shape of the answer people are actually asking for.
 */
function regionSummary(readings) {
  const buckets = new Map();

  for (const station of listStations('inflow')) {
    const name = REGIONS[station.country] || station.country;
    if (!name || !(station.meanFlow > 0)) continue;
    const reading = readings[station.id];
    if (!reading || !Number.isFinite(reading.flowM3s)) continue;

    const bucket = buckets.get(name) || { region: name, flow: 0, mean: 0, stations: [] };
    bucket.flow += reading.flowM3s;
    bucket.mean += station.meanFlow;
    bucket.stations.push(station.name);
    buckets.set(name, bucket);
  }

  return [...buckets.values()]
    .map((b) => ({
      region: b.region,
      stationCount: b.stations.length,
      flowM3s: round(b.flow),
      longTermMeanM3s: round(b.mean),
      ratioToMean: b.mean > 0 ? round(b.flow / b.mean, 3) : null,
      // How much water is actually absent, in m3/s. The ratio alone ranks a small
      // creek at 55% above a major system at 82%, which answers "which gauge looks
      // worst" rather than "where is the country's missing water" - and it is the
      // second question that explains a low Danube.
      shortfallM3s: round(b.mean - b.flow),
    }))
    .sort((a, b) => b.shortfallM3s - a.shortfallM3s);
}

/**
 * Assemble the feed.
 *
 * `historyByStation` and `lakeHistory` are maps of id -> ascending series. A caller with
 * no history gets the region summary and nothing else, which is the correct answer for a
 * fresh instance rather than an empty page with no explanation.
 */
function buildEvents({ readings = {}, historyByStation = {}, lakeHistory = {}, generationSeries = [], now = Date.now() } = {}) {
  const events = [];

  for (const [stationId, series] of Object.entries(historyByStation)) {
    const station = getStation(stationId);
    if (!station || !series || series.length === 0) continue;

    const run = lowRun(station, series, now);
    const step = stepChange(station, series, now);
    // A long dry run and a 20% wobble inside it are the same story; the run is the one
    // worth telling, so a station contributes at most one flow event.
    if (run) events.push(run);
    else if (step) events.push(step);

    const grade = gradeCrossing(station, series);
    if (grade) events.push(grade);
  }

  for (const [lakeId, series] of Object.entries(lakeHistory)) {
    const lake = getLake(lakeId);
    if (!lake || !series || series.length === 0) continue;
    const change = lakeChange(lake, series, now);
    if (change) events.push(change);
  }

  const nuclear = nuclearStep(generationSeries);
  if (nuclear) events.push(nuclear);

  events.sort((a, b) => b.severity - a.severity || Date.parse(b.at) - Date.parse(a.at));

  return {
    generatedAt: new Date(now).toISOString(),
    count: events.length,
    events,
    regions: regionSummary(readings),
    note:
      'Minden tétel a saját méréseinkből származik, és a hozzá tartozó számokat is közli. ' +
      'Az oldal nem következtet olyan okra, amit nem mért — a külső magyarázatok a szerkesztői jegyzetek között vannak, forrással.',
  };
}

module.exports = {
  buildEvents,
  regionSummary,
  stepChange,
  lowRun,
  gradeCrossing,
  lakeChange,
  nuclearStep,
  REGIONS,
  LOW_RATIO,
};
