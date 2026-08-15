'use strict';

const path = require('node:path');
const fs = require('node:fs');

/**
 * How dry the ground actually is - measured, not inferred.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACES, AND WHY IT IS NOT A REPLACEMENT
 * ---------------------------------------------------------------------------
 * The drought section on this site ranks 770 shallow WELL LEVELS, because for a long time
 * this project believed soil moisture was not published. It is: 23 stations report it
 * hourly. But the two are not substitutes and this module does not treat them as one.
 *
 * A well level says how much water is in the ground under the field. Soil moisture says
 * how much is in the top of it, where roots are. In a drought they move together
 * eventually and apart for weeks at a time - a thunderstorm wets the soil and does not
 * reach the water table; a dry autumn drains the water table while the surface stays
 * damp. The 770 wells are the national picture; these 23 are the one that answers "can a
 * plant drink today", and only in the south-east.
 *
 * ---------------------------------------------------------------------------
 * WHY A PERCENTAGE STILL NEEDS A RECORD BEHIND IT
 * ---------------------------------------------------------------------------
 * 26% sounds interpretable and is not. The register publishes no sensor depth, no soil
 * type and no wilting point, and without those the same reading means different things in
 * sand and in clay - the number is comparable with ITSELF over time, and only roughly
 * between stations. So every value here is placed in what that station has measured
 * before, exactly as a river discharge is.
 *
 * With one difference that is stated everywhere it could matter: the record is ONE YEAR.
 * The rivers get "the driest August in ten"; this can only get "drier than four fifths of
 * the hours this station recorded last August", and `years` travels with every band so a
 * consumer cannot render the second in the words of the first.
 */

const HISTORY_PATH = path.join(__dirname, '..', 'config', 'soil-history.json');

let cachedHistory;

function loadSoilHistory({ reload = false } = {}) {
  if (cachedHistory !== undefined && !reload) return cachedHistory;
  try {
    cachedHistory = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  } catch {
    cachedHistory = null;
  }
  return cachedHistory;
}

/**
 * The bands, coarsest first, and none of them says "normal".
 *
 * A one-year record cannot support the word: "normal" is a claim about what usually
 * happens, and one year has no "usually" in it. Each label describes the comparison being
 * made and nothing more.
 */
const BANDS = Object.freeze([
  { code: 'record-low', hu: 'a mért rekord alatt', order: 0 },
  { code: 'very-low', hu: 'a mért értékek alsó ötödében', order: 1 },
  { code: 'low', hu: 'az alsó negyedben', order: 2 },
  { code: 'middle', hu: 'a mért tartomány közepén', order: 3 },
  { code: 'high', hu: 'a felső negyedben', order: 4 },
  { code: 'record-high', hu: 'a mért rekord fölött', order: 5 },
]);

const BY_CODE = Object.fromEntries(BANDS.map((b) => [b.code, b]));

/**
 * Where a reading sits in that station's record for this calendar month.
 *
 * Null - never a band - when the month has no usable record. A station that started
 * reporting in March has no February, and inventing one from its March would be the
 * quietest possible way to be wrong.
 */
function rankSoil(stationId, value, { at = new Date(), document } = {}) {
  if (!Number.isFinite(value)) return null;
  const doc = document !== undefined ? document : loadSoilHistory();
  const entry = doc && doc.stations && doc.stations[stationId];
  if (!entry || !Array.isArray(entry.months)) return null;

  const month = new Date(at).getUTCMonth();
  const record = entry.months[month];
  if (!record || !Array.isArray(record.p)) return null;

  const [p5, p25, p50, p75, p95] = record.p;
  let band;
  if (value < record.min) band = 'record-low';
  else if (value > record.max) band = 'record-high';
  else if (value <= p5) band = 'very-low';
  else if (value <= p25) band = 'low';
  else if (value >= p75) band = 'high';
  else band = 'middle';

  return {
    band,
    bandHu: BY_CODE[band].hu,
    bandOrder: BY_CODE[band].order,
    // The record itself, so a reader can check the placement rather than take it.
    min: record.min,
    max: record.max,
    median: p50,
    p: record.p,
    quantiles: (doc && doc.quantiles) || [5, 25, 50, 75, 95],
    days: record.days,
    // ONE, on this network. Carried into every ranking for the reason in the header.
    years: record.years,
    monthsOfRecord: entry.months.filter(Boolean).length,
  };
}

/**
 * The soil-moisture view.
 *
 * @param readings  { [stationId]: { value, at, samples } } from the source
 */
function buildSoil(readings = {}, { registry, document, now = new Date() } = {}) {
  const reg = registry || require('../config/soil-stations.json');
  const stations = reg.stations.map((s) => {
    const reading = readings[s.id] || null;
    const value = reading && Number.isFinite(reading.value) ? reading.value : null;
    const ageMin = reading && reading.at
      ? Math.round((now - Date.parse(reading.at)) / 60000)
      : null;
    return {
      id: s.id,
      name: s.name,
      settlement: s.settlement,
      location: { lat: s.lat, lon: s.lon },
      current: reading
        ? {
            percent: value,
            at: reading.at,
            // Minutes, not a boolean "fresh". These stations report hourly, so 70 minutes
            // is fine and 700 is a station that has stopped - and only the number can
            // tell those apart without a threshold nobody agreed on.
            ageMinutes: ageMin,
            history: rankSoil(s.id, value, { at: reading.at ? new Date(reading.at) : now, document }),
          }
        : null,
      unavailableReason: reading ? null : 'ez az állomás nem jelentett a lekérdezett ablakban',
    };
  });

  const measured = stations.filter((s) => s.current && Number.isFinite(s.current.percent));
  const ranked = measured.filter((s) => s.current.history);
  const dry = ranked.filter((s) => s.current.history.bandOrder <= 2);

  return {
    available: true,
    source: reg.source,
    kind: reg.kind,
    // Repeated in the response, not only in the registry: a consumer that renders this
    // as a national drought map is making a claim the network cannot support.
    coverage: reg.coverage,
    hasSensorDepth: reg.hasSensorDepth,
    hasSoilType: reg.hasSoilType,
    count: stations.length,
    measuredCount: measured.length,
    rankedCount: ranked.length,
    // Counted, never averaged. A mean of 23 percentages from unknown soils at unknown
    // depths is a number with no referent - it would move when a station broke.
    dryCount: dry.length,
    recordLowCount: ranked.filter((s) => s.current.history.band === 'record-low').length,
    driest: measured.length
      ? measured.slice().sort((a, b) => a.current.percent - b.current.percent)[0]
      : null,
    wettest: measured.length
      ? measured.slice().sort((a, b) => b.current.percent - a.current.percent)[0]
      : null,
    // How long the record behind every ranking is. One year, on this network.
    recordYears: maxYears(document !== undefined ? document : loadSoilHistory()),
    stations,
  };
}

/** The longest record any station has, in years, or null when nothing is baked. */
function maxYears(doc) {
  if (!doc || !doc.stations) return null;
  let best = null;
  for (const entry of Object.values(doc.stations)) {
    for (const month of entry.months || []) {
      if (month && Number.isFinite(month.years)) best = Math.max(best ?? 0, month.years);
    }
  }
  return best;
}

module.exports = { buildSoil, rankSoil, loadSoilHistory, BANDS, HISTORY_PATH };
