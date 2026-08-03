'use strict';

const { listStations, UNGAUGED_INFLOW } = require('../config/stations');

/**
 * Hungary's instantaneous surface water balance.
 *
 *     dQ = sum(Q_in) - sum(Q_out)
 *
 * Simple to write, easy to get wrong. Three things this module refuses to hide:
 *
 * 1. IT IS A DIFFERENCE OF TWO LARGE, UNCERTAIN NUMBERS.
 *    Inflow and outflow are both around 3600 m3/s and their true difference is on the
 *    order of -100 m3/s. Each gauge carries 5-10% rating-curve uncertainty, so the
 *    combined error band is roughly +-200 m3/s - wider than the quantity being
 *    measured. Every response therefore ships an explicit uncertainty and a
 *    `significant` flag, and the flag is usually false. That is the honest answer, not
 *    a defect.
 *
 * 2. THE TWO SUMS ARE NOT SIMULTANEOUS.
 *    Water measured at Rajka today leaves at Mohács about four days later. Comparing
 *    same-timestamp readings is fine on a flat hydrograph and badly wrong on a rising
 *    one - a flood wave entering the country shows up as a huge fake "gain" until it
 *    exits. method='lagged' shifts each inflow back by its travel time.
 *
 * 3. NOT ALL INFLOW IS GAUGED.
 *    The listed stations capture ~93% of the long-term mean inflow; the rest arrives
 *    through minor watercourses. That missing ~260 m3/s is larger than the signal, so
 *    it is added as a named term rather than quietly ignored or quietly folded in.
 */

const SECONDS_PER_DAY = 86400;

/**
 * @param {Map<string, object>|object} readings  stationId -> { flowM3s, timestamp, source, ... }
 * @param {object} [opts]
 * @param {'instant'|'lagged'} [opts.method='instant']
 * @param {boolean} [opts.includeUngauged=true]
 * @param {(stationId: string, atMs: number) => object|null} [opts.historyLookup]
 *        Required for method='lagged'. Returns the reading closest to `atMs`.
 * @param {number} [opts.now=Date.now()]
 */
function computeBalance(readings, opts = {}) {
  const method = opts.method === 'lagged' ? 'lagged' : 'instant';
  const includeUngauged = opts.includeUngauged !== false;
  const now = opts.now || Date.now();
  const get = normaliseReadings(readings);

  const warnings = [];
  let effectiveMethod = method;

  if (method === 'lagged' && typeof opts.historyLookup !== 'function') {
    effectiveMethod = 'instant';
    warnings.push('method=lagged requested but no history is available yet; fell back to instant comparison.');
  }

  const inflow = sumSide(listStations('inflow'), {
    get,
    now,
    method: effectiveMethod,
    historyLookup: opts.historyLookup,
  });
  const outflow = sumSide(listStations('outflow'), {
    get,
    now,
    // Outflow stations are the reference point in time - they are never shifted.
    method: 'instant',
    historyLookup: opts.historyLookup,
  });

  // Asking for lagged and getting nothing lagged is the case that matters: a store with
  // no history hands back null for every lookup, each station quietly falls back to its
  // current reading, and the result is an instant comparison wearing a lagged label.
  // Report what actually happened rather than what was requested.
  if (effectiveMethod === 'lagged') {
    if (inflow.laggedCount === 0) {
      effectiveMethod = 'instant';
      warnings.push(
        'method=lagged requested but no station had history at its travel time; this is an instant comparison.',
      );
    } else if (inflow.laggedCount < inflow.stationCount) {
      warnings.push(
        `Only ${inflow.laggedCount} of ${inflow.stationCount} inflow stations had history at their travel time; ` +
          'the rest used their current reading.',
      );
    }
  }

  // --- ungauged inflow ------------------------------------------------------
  // Scaled with how wet the gauged network currently is, so it grows in flood and
  // shrinks in drought instead of sitting at a constant.
  let ungaugedM3s = 0;
  let ungaugedSigma = 0;
  if (includeUngauged) {
    const wetness = inflow.climatologyRatio || 1;
    ungaugedM3s = UNGAUGED_INFLOW.meanFlow * wetness;
    ungaugedSigma = (ungaugedM3s * UNGAUGED_INFLOW.uncertaintyPct) / 100;
  }

  const inflowTotal = inflow.totalM3s + ungaugedM3s;
  const inflowSigma = Math.hypot(inflow.sigmaM3s, ungaugedSigma);
  const outflowTotal = outflow.totalM3s;
  const outflowSigma = outflow.sigmaM3s;

  const netM3s = inflowTotal - outflowTotal;
  const netSigma = Math.hypot(inflowSigma, outflowSigma);

  // Two sigma is the line between "the rivers are telling us something" and "this is
  // rating-curve noise". Most of the time it is the latter.
  const significant = Math.abs(netM3s) > 2 * netSigma;

  return {
    timestamp: new Date(now).toISOString(),
    method: effectiveMethod,
    requestedMethod: method,
    inflow: {
      totalM3s: round(inflowTotal, 1),
      gaugedM3s: round(inflow.totalM3s, 1),
      ungaugedM3s: round(ungaugedM3s, 1),
      uncertaintyM3s: round(inflowSigma, 1),
      dailyM3: Math.round(inflowTotal * SECONDS_PER_DAY),
      stationCount: inflow.stationCount,
      measuredCount: inflow.measuredCount,
      estimatedCount: inflow.estimatedCount,
      laggedCount: inflow.laggedCount,
      stations: inflow.stations,
    },
    outflow: {
      totalM3s: round(outflowTotal, 1),
      uncertaintyM3s: round(outflowSigma, 1),
      dailyM3: Math.round(outflowTotal * SECONDS_PER_DAY),
      stationCount: outflow.stationCount,
      measuredCount: outflow.measuredCount,
      estimatedCount: outflow.estimatedCount,
      stations: outflow.stations,
    },
    net: {
      m3s: round(netM3s, 1),
      uncertaintyM3s: round(netSigma, 1),
      dailyM3: Math.round(netM3s * SECONDS_PER_DAY),
      significant,
      direction: netM3s > 0 ? 'accumulating' : 'draining',
      interpretation: significant
        ? netM3s > 0
          ? 'More water is entering the country than leaving it right now.'
          : 'More water is leaving the country than entering it right now.'
        : 'The net difference is within measurement uncertainty - it cannot be distinguished from zero.',
    },
    dataQuality: {
      // What share of the balance rests on a live reading rather than a fallback.
      measuredShare: round(measuredShare(inflow, outflow), 3),
      ungaugedShareOfInflow: inflowTotal > 0 ? round(ungaugedM3s / inflowTotal, 3) : 0,
      warnings: warnings.concat(inflow.warnings, outflow.warnings),
    },
  };
}

/**
 * Sum one side of the balance, propagating uncertainty and tracking data provenance.
 */
function sumSide(stations, { get, now, method, historyLookup }) {
  let total = 0;
  let variance = 0;
  let climatologyTotal = 0;
  let measuredCount = 0;
  let estimatedCount = 0;
  let laggedCount = 0;
  const warnings = [];
  const detail = [];

  for (const station of stations) {
    let reading = null;
    let lagHours = 0;

    if (method === 'lagged' && station.travelTimeHours) {
      lagHours = station.travelTimeHours;
      reading = historyLookup(station.id, now - lagHours * 3600 * 1000);
      if (reading) {
        laggedCount += 1;
      } else {
        // History does not reach back far enough for this station yet.
        reading = get(station.id);
        lagHours = 0;
      }
    } else {
      reading = get(station.id);
    }

    let flow;
    let quality;

    if (reading && Number.isFinite(reading.flowM3s)) {
      flow = reading.flowM3s;
      quality = 'measured';
      measuredCount += 1;
    } else {
      // Falling back to the long-term mean keeps the sum from collapsing when one
      // gauge is down, but it must never be presented as a measurement.
      flow = station.meanFlow;
      quality = 'climatology';
      estimatedCount += 1;
      warnings.push(`${station.id}: no live reading, substituted long-term mean (${station.meanFlow} m3/s).`);
    }

    const sigma = (flow * station.uncertaintyPct) / 100;
    total += flow;
    variance += sigma * sigma;
    climatologyTotal += station.meanFlow;

    detail.push({
      id: station.id,
      name: station.name,
      river: station.river,
      flowM3s: round(flow, 2),
      uncertaintyM3s: round(sigma, 2),
      quality,
      lagHours,
      shareOfSide: 0, // filled in below
      timestamp: reading && reading.timestamp ? reading.timestamp : null,
    });
  }

  for (const d of detail) {
    d.shareOfSide = total > 0 ? round(d.flowM3s / total, 4) : 0;
  }

  return {
    totalM3s: total,
    sigmaM3s: Math.sqrt(variance),
    // How wet the network is versus its long-term average - used to scale ungauged inflow.
    climatologyRatio: climatologyTotal > 0 ? total / climatologyTotal : 1,
    stationCount: stations.length,
    measuredCount,
    estimatedCount,
    laggedCount,
    warnings,
    stations: detail,
  };
}

function measuredShare(inflow, outflow) {
  const total = inflow.stationCount + outflow.stationCount;
  if (total === 0) return 0;
  return (inflow.measuredCount + outflow.measuredCount) / total;
}

/** Accepts a Map or a plain object and returns a uniform lookup function. */
function normaliseReadings(readings) {
  if (readings instanceof Map) return (id) => readings.get(id) || null;
  if (readings && typeof readings === 'object') return (id) => readings[id] || null;
  return () => null;
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

module.exports = { computeBalance };
