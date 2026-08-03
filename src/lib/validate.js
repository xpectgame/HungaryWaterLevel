'use strict';

const { getStation } = require('../config/stations');

/**
 * Plausibility screening for incoming gauge readings.
 *
 * Upstream open data occasionally emits sentinel values (-9999), unit slips (cm of
 * stage where m3/s of discharge was expected) and stuck sensors. None of those look
 * like errors to a JSON parser, but all of them would silently poison a balance that
 * subtracts two numbers near 3600 m3/s. Screening happens before storage so bad values
 * never enter the history that the lagged balance later reads back.
 *
 * The thresholds are deliberately loose. Hungarian rivers really do swing an order of
 * magnitude between drought and flood - the upper Tisza can go from 60 to 3000 m3/s -
 * so this rejects the physically impossible, not the merely unusual.
 */

const MAX_RATIO_ABOVE_MEAN = 25;
const MIN_RATIO_BELOW_MEAN = 0.03;

function validateReading(reading) {
  const station = getStation(reading.stationId);
  if (!station) {
    return { ok: false, reason: `unknown station ${reading.stationId}` };
  }

  const flow = reading.flowM3s;

  if (!Number.isFinite(flow)) {
    return { ok: false, reason: 'discharge is not a finite number' };
  }

  // Common sentinels for "no data" in hydrological exports.
  if (flow <= -900) {
    return { ok: false, reason: `sentinel no-data value (${flow})` };
  }

  if (flow < 0) {
    // Genuine reverse flow happens on the lower Tisza when the Danube backs it up, but
    // not at the border sections in this registry.
    return { ok: false, reason: `negative discharge (${flow} m3/s)` };
  }

  if (flow > station.meanFlow * MAX_RATIO_ABOVE_MEAN) {
    return {
      ok: false,
      reason: `implausibly high: ${flow} m3/s is over ${MAX_RATIO_ABOVE_MEAN}x the long-term mean (${station.meanFlow})`,
    };
  }

  if (flow > 0 && flow < station.meanFlow * MIN_RATIO_BELOW_MEAN) {
    return {
      ok: false,
      reason: `implausibly low: ${flow} m3/s is under ${MIN_RATIO_BELOW_MEAN * 100}% of the long-term mean (${station.meanFlow})`,
    };
  }

  const ts = Date.parse(reading.timestamp);
  if (Number.isNaN(ts)) {
    return { ok: false, reason: 'unparseable timestamp' };
  }
  // A gauge reporting from the future means a clock or timezone problem upstream;
  // storing it would put a reading beyond "now" and break the lagged lookup.
  if (ts > Date.now() + 2 * 3600 * 1000) {
    return { ok: false, reason: `timestamp is in the future (${reading.timestamp})` };
  }

  return { ok: true };
}

/** Screen a whole batch, returning the survivors and a list of what was dropped. */
function validateBatch(readings) {
  const accepted = {};
  const rejected = [];

  for (const [stationId, reading] of Object.entries(readings || {})) {
    const result = validateReading({ ...reading, stationId });
    if (result.ok) {
      accepted[stationId] = reading;
    } else {
      rejected.push({ stationId, reason: result.reason, value: reading.flowM3s });
    }
  }

  return { accepted, rejected };
}

module.exports = { validateReading, validateBatch };
