'use strict';

const { listStations, UNGAUGED_INFLOW } = require('../config/stations');
const { monthlyMedian } = require('./flow-history');

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
  // The same warnings, tagged. Prose is fine for an API that is entirely in English;
  // it is not fine as the only form, because the frontend was printing these sentences
  // verbatim into a Hungarian page. A code lets a consumer say it in its own words.
  const notes = [];
  let effectiveMethod = method;

  if (method === 'lagged' && typeof opts.historyLookup !== 'function') {
    effectiveMethod = 'instant';
    warnings.push('method=lagged requested but no history is available yet; fell back to instant comparison.');
    notes.push({ code: 'lagged-no-history' });
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
      notes.push({ code: 'lagged-no-history' });
    } else if (inflow.laggedCount < inflow.stationCount) {
      warnings.push(
        `Only ${inflow.laggedCount} of ${inflow.stationCount} inflow stations had history at their travel time; ` +
          'the rest used their current reading.',
      );
      notes.push({ code: 'lagged-partial', lagged: inflow.laggedCount, total: inflow.stationCount });
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

  // The long-term normal for each side. The ungauged term is included on the inflow so
  // the reference is comparable with the total it is drawn against - leaving it out
  // would make every reading look ~260 m3/s wetter than normal for free.
  const inflowNormal = inflow.climatologyM3s + (includeUngauged ? UNGAUGED_INFLOW.meanFlow : 0);
  const outflowNormal = outflow.climatologyM3s;

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
      longTermMeanM3s: round(inflowNormal, 1),
      ratioToMean: inflowNormal > 0 ? round(inflowTotal / inflowNormal, 3) : null,
      ...seasonal(inflow),
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
      longTermMeanM3s: round(outflowNormal, 1),
      ratioToMean: outflowNormal > 0 ? round(outflowTotal / outflowNormal, 3) : null,
      ...seasonal(outflow),
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
      // The gauges behind those warnings, as data rather than prose, so a consumer can
      // write its own sentence in its own language instead of printing a raw station id.
      substituted: inflow.substituted.concat(outflow.substituted),
      notes,
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
  let seasonalNormal = 0;
  let seasonalActual = 0;
  let seasonalCount = 0;
  let measuredCount = 0;
  let estimatedCount = 0;
  let laggedCount = 0;
  const warnings = [];
  const substituted = [];
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
      // The same fact, structured. `warnings` is prose in English because the whole API
      // is, and the frontend was printing it verbatim into a Hungarian page - complete
      // with the raw station id, which names nothing to a reader. A consumer that wants
      // to write its own sentence needs the parts, not the sentence.
      substituted.push({
        id: station.id,
        name: station.name,
        river: station.river,
        meanFlowM3s: station.meanFlow,
      });
    }

    const sigma = (flow * station.uncertaintyPct) / 100;
    total += flow;
    variance += sigma * sigma;
    climatologyTotal += station.meanFlow;

    // The seasonal reference, accumulated station by station so the comparison stays
    // like-for-like: a station with no record for this month contributes to NEITHER the
    // normal nor the total it is measured against. Summing all the current flows against
    // a normal that is missing a gauge would invent a shortfall the size of that gauge.
    const median = monthlyMedian(station.id, monthOf(now));
    if (median !== null) {
      seasonalNormal += median;
      seasonalActual += flow;
      seasonalCount += 1;
    }

    detail.push({
      id: station.id,
      name: station.name,
      river: station.river,
      flowM3s: round(flow, 2),
      uncertaintyM3s: round(sigma, 2),
      // What this section normally carries, and where today sits against it. Carried on
      // every row because a discharge without it is unreadable: 411 m3/s at Rajka is
      // either a drought or a Tuesday, and only the ratio says which.
      longTermMeanM3s: station.meanFlow,
      ratioToMean: station.meanFlow > 0 ? round(flow / station.meanFlow, 3) : null,
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
    // What this side of the balance carries in an average year. The reference every
    // chart needs to draw a "normal" line against.
    climatologyM3s: climatologyTotal,
    // How wet the network is versus its long-term average - used to scale ungauged inflow.
    climatologyRatio: climatologyTotal > 0 ? total / climatologyTotal : 1,
    // What this side normally carries IN THIS CALENDAR MONTH, and the total of the same
    // stations right now. Both restricted to gauges with a ten-year record for the month.
    seasonalNormalM3s: seasonalNormal,
    seasonalActualM3s: seasonalActual,
    seasonalCount,
    stationCount: stations.length,
    measuredCount,
    estimatedCount,
    laggedCount,
    warnings,
    substituted,
    stations: detail,
  };
}

/** UTC month index, so the comparison uses the same calendar the archive was bucketed by. */
function monthOf(now) {
  return new Date(now).getUTCMonth();
}

/**
 * The seasonal block of a side's response.
 *
 * Reported next to `ratioToMean` rather than replacing it, because they answer different
 * questions and both are worth asking - but the seasonal one is what a headline should
 * use. Hungary's rivers run at roughly two thirds of their annual mean in August, so a
 * perfectly ordinary late summer already reads as "68% of normal" against the year. A
 * genuinely dry August then reads as 36%, which sounds like most of the water has gone
 * when the honest figure against the season is nearer 56%. The first number is not
 * wrong; it is answering "compared with the year" while the reader hears "compared with
 * what should be there now".
 *
 * `ratioToSeasonal` divides two sums over the SAME stations, so it is a like-for-like
 * comparison even where the archive is incomplete - and `seasonalCount` says how many
 * gauges it rests on, so a consumer can decline to use it if that is too few.
 */
function seasonal(side) {
  const covered = side.seasonalCount > 0;
  return {
    seasonalNormalM3s: covered ? round(side.seasonalNormalM3s, 1) : null,
    ratioToSeasonal: covered && side.seasonalNormalM3s > 0
      ? round(side.seasonalActualM3s / side.seasonalNormalM3s, 3)
      : null,
    seasonalStationCount: side.seasonalCount,
    seasonalBasis: covered
      ? 'median daily discharge for this calendar month over ten years, gauged stations with a record only'
      : null,
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
