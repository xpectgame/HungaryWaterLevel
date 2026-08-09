'use strict';

const { LAKES, volumePerCm } = require('../config/lakes');
const { describeStage } = require('./stage');

/**
 * The state of Hungary's standing water.
 *
 * A lake level in centimetres is even less legible than a river's: nobody has a feel for
 * whether 108 cm on the Balaton is a lot. Three things fix that, and this module is all
 * three:
 *
 * 1. Where the level sits between the lowest and highest ever recorded there - the same
 *    treatment the river gauges get, reusing the same code.
 * 2. Which way it is going, and how fast, over a day and over a week.
 * 3. What that change is in water. One centimetre on the Balaton is 5.9 million cubic
 *    metres; on the Velencei-tó it is 0.24. "Négy centit apadt" is a number nobody can
 *    weigh; "24 millió köbméterrel kevesebb, mint egy hete" is the same fact with its
 *    size attached, and it is the one that answers how the country's water is doing.
 *
 * Nothing here models anything. The level is measured, the area is a published constant,
 * and the volume change is one multiplication that is stated as an estimate because a
 * lake is not a cylinder.
 */

const DAY_MS = 24 * 3600 * 1000;

/**
 * Change over a window, or null when the history does not reach back that far.
 *
 * Null rather than a smaller window silently substituted: "-4 cm in 7 days" and "-4 cm
 * in the 6 hours we happen to have" are very different statements, and a serverless
 * instance that has been alive for twenty minutes can only make the second one.
 */
function changeOver(history, nowCm, ms, toleranceMs = 6 * 3600 * 1000) {
  if (!history || history.length === 0 || !Number.isFinite(nowCm)) return null;
  const target = Date.now() - ms;

  let best = null;
  let bestDistance = Infinity;
  for (const row of history) {
    const t = Date.parse(row.timestamp);
    if (Number.isNaN(t) || !Number.isFinite(row.waterLevelCm)) continue;
    const distance = Math.abs(t - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = row;
    }
  }
  if (!best || bestDistance > toleranceMs) return null;

  return {
    cm: round(nowCm - best.waterLevelCm, 1),
    from: best.timestamp,
    fromCm: best.waterLevelCm,
  };
}

/** A change in centimetres, priced in water. */
function asVolume(lake, changeCm) {
  const perCm = volumePerCm(lake);
  if (perCm === null || changeCm === null) return null;
  return round(changeCm.cm * perCm, 2);
}

/**
 * Build the lake view.
 *
 * `readings` is the same map the stations use - lakes share the readings table, keyed by
 * lake id. `historyFor` is optional and asynchronous, so a caller with no history (or no
 * appetite for four extra queries) simply gets nulls for the trends.
 */
function buildLakes(readings, historyByLake = {}) {
  const lakes = LAKES.map((lake) => {
    const reading = readings[lake.id] || null;
    const levelCm = reading && Number.isFinite(reading.waterLevelCm) ? reading.waterLevelCm : null;
    const history = historyByLake[lake.id] || [];

    const day = changeOver(history, levelCm, DAY_MS);
    const week = changeOver(history, levelCm, 7 * DAY_MS, DAY_MS);
    const perCm = volumePerCm(lake);

    return {
      id: lake.id,
      name: lake.name,
      location: { lat: lake.lat, lon: lake.lon },
      gauge: lake.gauge,
      measured: !!lake.gaugeTsz,
      surface: {
        areaKm2: lake.areaKm2,
        hungarianAreaKm2: lake.hungarianAreaKm2 ?? null,
        volumeMm3: lake.volumeMm3,
        meanDepthM: lake.meanDepthM,
        catchmentKm2: lake.catchmentKm2 ?? null,
        outflow: lake.outflow,
        // The conversion everything below leans on, published so a reader can check it.
        millionM3PerCm: perCm === null ? null : round(perCm, 3),
      },
      current: reading
        ? {
            levelCm,
            timestamp: reading.timestamp,
            quality: reading.quality,
            source: reading.source,
            // Same records, same arithmetic, same code as a river gauge.
            stage: describeStage(levelCm, lake.id),
          }
        : null,
      trend: {
        day: day && { ...day, volumeMm3: asVolume(lake, day) },
        week: week && { ...week, volumeMm3: asVolume(lake, week) },
      },
      note: lake.note,
      unavailableReason: lake.gaugeTsz
        ? null
        : 'A szolgálat nem tesz közzé vízszintet erre a tóra: a Tisza-tó szintje a kiskörei duzzasztó felvize, ' +
          'és arra a szelvényre nincs nyilvános adatsor.',
    };
  });

  return {
    count: lakes.length,
    measuredCount: lakes.filter((l) => l.current).length,
    // The one national figure this section can honestly produce: how much water the
    // measured lakes have gained or lost this week, added up.
    weeklyVolumeChangeMm3: sumOrNull(lakes.map((l) => l.trend.week && l.trend.week.volumeMm3)),
    lakes,
  };
}

/** Null unless at least one term is real, so "no data" never renders as zero change. */
function sumOrNull(values) {
  const known = values.filter((v) => Number.isFinite(v));
  return known.length === 0 ? null : round(known.reduce((a, b) => a + b, 0), 2);
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

module.exports = { buildLakes, changeOver, volumePerCm };
