'use strict';

const { STATIONS } = require('../config/stations');

/**
 * Matches the portal's station catalogue against this project's registry.
 *
 * The portal's bundle assembles `${vraQueryApiBaseUrl}Vra/InternetVmo/${vmoType}/false`
 * and maps the result with:
 *
 *   {tsz: t.Tsz, name: t.Nev, lat: t.Lat, lon: t.Lon, directorate: t.Vizig,
 *    fkm: t.Fkm, water: t.Mdr, LKV: t.LKV, LNV: t.LNV, zeropoint: t.Npt}
 *
 * `Tsz` - törzsszám - is the identifier every other call takes, so this is what fills
 * EXTERNAL_IDS. Getting one wrong does not fail loudly; it silently reports a different
 * river under a station's name, and the balance stays plausible while being wrong. So
 * matching is done on two independent signals and both are printed:
 *
 *   - the name, accent- and case-folded, plus the watercourse
 *   - the distance between the catalogue's coordinates and the registry's
 *
 * A name match that sits 40 km from where the station should be is not a match, and
 * that is exactly the case a name-only comparison would accept.
 */

// Gauges on the same river a few km apart are common; beyond this it is a different
// place with a similar name.
const CONFIDENT_KM = 5;
const PLAUSIBLE_KM = 25;

/** Fold accents and case so "Őrtilos" and "ORTILOS" compare equal. */
function fold(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Split "Duna – Rajka (Ant)" into its river and its place.
 *
 * The registry writes both into one display name; the catalogue keeps them in separate
 * fields, so they have to be taken apart to be compared.
 */
function splitName(name) {
  // The separator must be surrounded by whitespace. Splitting on a bare hyphen turned
  // "Fekete-Körös – Sarkad" into river "fekete", place "koros" - a compound river name
  // is spelled with a hyphen and there are five of them in the registry.
  const [river, place] = String(name).split(/\s+[–—-]\s+/);
  return {
    river: fold(river),
    place: fold((place || '').replace(/\(.*?\)/g, '')),
  };
}

/** Great-circle distance in km. */
function distanceKm(a, b) {
  // `Number(null)` is 0, and 0 is finite - so a missing coordinate would pass a bare
  // isFinite check and be silently treated as a point in the Gulf of Guinea.
  const coords = [a.lat, a.lon, b.lat, b.lon];
  if (coords.some((v) => v === null || v === undefined || v === '')) return null;
  if (!coords.every((v) => Number.isFinite(Number(v)))) return null;
  const toRad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Normalise one catalogue record, whichever casing the service used. */
function normalizeRecord(row) {
  const pick = (...keys) => {
    for (const key of keys) {
      if (row[key] !== undefined && row[key] !== null) return row[key];
    }
    return null;
  };
  return {
    tsz: pick('Tsz', 'tsz'),
    name: pick('Nev', 'nev', 'name'),
    lat: Number(pick('Lat', 'lat')),
    lon: Number(pick('Lon', 'lon')),
    water: pick('Mdr', 'mdr', 'water'),
    riverKm: pick('Fkm', 'fkm'),
    directorate: pick('Vizig', 'vizig'),
    raw: row,
  };
}

/**
 * Score one catalogue entry against one registry station.
 *
 * Returns null when nothing lines up at all, so the caller can distinguish "no
 * candidate" from "a candidate I am unsure about".
 */
function score(station, record) {
  const wanted = splitName(station.name);
  const gotPlace = fold(record.name);
  const gotWater = fold(record.water);

  const placeMatches = gotPlace === wanted.place || gotPlace.includes(wanted.place) || wanted.place.includes(gotPlace);
  const riverMatches = Boolean(wanted.river && gotWater && (gotWater === wanted.river || gotWater.includes(wanted.river)));
  const km = distanceKm(station, record);

  if (!placeMatches && !(riverMatches && km !== null && km < CONFIDENT_KM)) return null;

  // Both rivers known and different: the coordinates may still line up, but the entry
  // is on another watercourse and must never be adopted silently.
  const riverConflict = Boolean(wanted.river && gotWater && !riverMatches);

  // The point of using two signals is that they can contradict each other. 'high' means
  // they agree - the name AND the position. River plus position with the wrong name is
  // how a downstream gauge on the same river gets adopted for an upstream one, which is
  // precisely the double-counting this project spends a config file avoiding.
  let confidence;
  if (km === null) confidence = placeMatches && riverMatches ? 'name-only' : 'weak';
  else if (km > PLAUSIBLE_KM) confidence = 'rejected';
  else if (placeMatches && km <= CONFIDENT_KM && !riverConflict) confidence = 'high';
  else confidence = 'plausible';

  return { record, km, placeMatches, riverMatches, riverConflict, confidence };
}

/**
 * @param {object[]} catalogue raw rows from Vra/InternetVmo/{vmoType}/false
 * @param {object[]} [registry]
 */
function matchStations(catalogue, registry = STATIONS) {
  const records = catalogue.map(normalizeRecord);

  return registry.map((station) => {
    const scored = records
      .map((record) => score(station, record))
      .filter((s) => s && s.confidence !== 'rejected')
      .sort((a, b) => {
        const rank = { high: 0, plausible: 1, 'name-only': 2, weak: 3 };
        if (rank[a.confidence] !== rank[b.confidence]) return rank[a.confidence] - rank[b.confidence];
        return (a.km ?? Infinity) - (b.km ?? Infinity);
      });

    return { station, best: scored[0] || null, alternatives: scored.slice(1, 4) };
  });
}

/** Render the match table and a paste-ready EXTERNAL_IDS block. */
function report(matches) {
  const lines = [];
  const resolved = [];
  const unresolved = [];

  for (const { station, best, alternatives } of matches) {
    if (!best) {
      lines.push(`  MISSING   ${station.id.padEnd(28)} ${station.name}`);
      unresolved.push(station);
      continue;
    }

    const km = best.km === null ? 'no coords' : `${best.km.toFixed(1)} km`;
    lines.push(
      `  ${best.confidence.padEnd(9)} ${station.id.padEnd(28)} Tsz=${String(best.record.tsz).padEnd(10)}` +
        ` ${String(best.record.water || '?').padEnd(14)} ${String(best.record.name || '?').padEnd(22)} ${km}`,
    );

    // An ambiguous match is worse than none: it looks resolved. Show what it beat.
    if (best.confidence !== 'high') {
      for (const alt of alternatives) {
        lines.push(
          `              also: Tsz=${String(alt.record.tsz).padEnd(10)} ${String(alt.record.water || '?').padEnd(14)}` +
            ` ${alt.record.name} (${alt.km === null ? '?' : `${alt.km.toFixed(1)} km`})`,
        );
      }
    }

    if (best.confidence === 'high') resolved.push({ station, record: best.record });
    else unresolved.push(station);
  }

  lines.push('');
  lines.push(`${resolved.length} confident, ${unresolved.length} needing a look.`);
  lines.push('');
  lines.push('Paste into EXTERNAL_IDS in src/sources/vizugy.js (confident matches only):');
  lines.push('');
  for (const { station, record } of resolved) {
    lines.push(`  '${station.id}': '${record.tsz}',   // ${record.water} ${record.name}`);
  }

  return lines;
}

module.exports = { matchStations, report, normalizeRecord, splitName, fold, distanceKm, score };
