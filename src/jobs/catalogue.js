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
// The registry's coordinates are approximate - they name the settlement, not the
// gauge's cross-section - so distance is a coarse filter, not a fine one. Fkm is what
// resolves the last few kilometres when both sides have it.
const CONFIDENT_KM = 15;
const PLAUSIBLE_KM = 25;
const CONFIDENT_FKM = 5;

// Generic watercourse-type suffixes. The catalogue writes "Bodva-patak" where the
// registry writes "Bodva"; stripping the type word makes those compare equal without
// letting "Mosoni-Duna" pass as "Duna", which is a genuinely different river.
const WATERCOURSE_SUFFIXES = /\s+(patak|csatorna|focsatorna|fo csatorna|er|folyo|holtag|ag)$/;

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
 * A watercourse name reduced to what identifies it.
 *
 * Only a trailing type word is removed. A qualifier in front - "Mosoni-Duna", "Sebes-
 * Koros" - names a different watercourse and has to survive, which is why this is not
 * a substring comparison: Rajka has gauges on both the Duna and the Mosoni-Duna, a
 * kilometre apart, and one of them is a lock.
 */
function riverBase(name) {
  return fold(name).replace(WATERCOURSE_SUFFIXES, '');
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

  // Mdr is a GUID identifying the watercourse; MdrNev is its name. Folding the GUID
  // meant the river never matched anything, which downgraded every single station to
  // "plausible" and let a lock-gate gauge outrank the real one on distance alone.
  const water = pick('MdrNev', 'mdrNev', 'water');

  return {
    tsz: pick('Tsz', 'tsz'),
    name: pick('Nev', 'nev', 'name'),
    lat: Number(pick('Lat', 'lat')),
    lon: Number(pick('Lon', 'lon')),
    water: isGuid(water) ? null : water,
    waterId: pick('Mdr', 'mdr'),
    riverKm: pick('Fkm', 'fkm'),
    settlement: pick('Telepules', 'telepules'),
    directorate: pick('Vizig', 'vizig'),
    active: pick('Uzem', 'uzem'),
    raw: row,
  };
}

function isGuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Compare a catalogue entry's name with the place we are looking for.
 *
 * The catalogue writes the same station several ways: bare ("Rajka"), river-prefixed
 * ("Duna Mohacs"), or qualified ("Rajka 2. zsilip, alvíz"). The first two are the same
 * station under two spellings; the third is a different structure a kilometre away. So
 * an exact match - after stripping a leading river name - is kept distinct from a mere
 * substring hit, because that distinction is what separates the gauge from the lock.
 */
function comparePlace(recordName, wanted) {
  const got = fold(recordName);
  if (!got) return { exact: false, contains: false };

  const stripped = wanted.river && got.startsWith(`${wanted.river} `) ? got.slice(wanted.river.length + 1) : got;

  return {
    exact: stripped === wanted.place || got === wanted.place,
    contains: stripped.includes(wanted.place) || wanted.place.includes(stripped),
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
  const place = comparePlace(record.name, wanted);
  const gotWater = riverBase(record.water);
  const wantedRiver = riverBase(wanted.river);

  const riverExact = Boolean(wantedRiver && gotWater && gotWater === wantedRiver);
  const riverConflict = Boolean(wantedRiver && gotWater && !riverExact);

  const km = distanceKm(station, record);

  // River kilometre: an independent measurement of position along the watercourse, and
  // the one signal that separates two gauges a few hundred metres apart. Rajka is 1848
  // in the registry and 1848.31 in the catalogue.
  const fkmDelta =
    Number.isFinite(Number(station.riverKm)) && Number.isFinite(Number(record.riverKm))
      ? Math.abs(Number(station.riverKm) - Number(record.riverKm))
      : null;

  if (riverConflict) return null;
  if (!place.contains && !(riverExact && km !== null && km < CONFIDENT_KM)) return null;

  // Fkm outranks distance when both are available: it is measured along the watercourse
  // and the registry's coordinates are only settlement-accurate. A station 5.4 km from
  // where the registry puts it, but 0.3 river-km from where the registry says it sits
  // along the Danube, is the same station - that was Paks.
  const positionAgrees = fkmDelta === null ? km !== null && km <= CONFIDENT_KM : fkmDelta <= CONFIDENT_FKM;

  let confidence;
  if (km !== null && km > PLAUSIBLE_KM) confidence = 'rejected';
  else if (fkmDelta !== null && fkmDelta > 15) confidence = 'rejected';
  else if (place.exact && riverExact && positionAgrees) confidence = 'high';
  else confidence = 'plausible';

  return { record, km, fkmDelta, place, riverExact, confidence };
}

/**
 * Principal gauges carry a short törzsszám; auxiliary structures carry a long one.
 *
 * The main hydrological network is numbered in the low thousands - Körösszakál 2736,
 * Gyula 2747, Sarkad-Malomfok 2745 - while pumping stations, sluice gauges and flood
 * markers sit in six-digit blocks: 224205 "Malomfoki Szivattyútelep alsó". Around
 * Sarkad the six-digit gauges are nearer to the registry's coordinates than the real
 * one, so distance alone picks a pumping station over the river gauge.
 */
const PRINCIPAL_TSZ_MAX = 100000;

function isPrincipal(record) {
  const tsz = Number(record.tsz);
  return Number.isFinite(tsz) && tsz < PRINCIPAL_TSZ_MAX;
}

/** Rank candidates: agreement first, then the sharpest positional evidence. */
function compareCandidates(a, b) {
  const tier = (s) => (s.place.exact ? 0 : 2) + (s.riverExact ? 0 : 1);
  if (tier(a) !== tier(b)) return tier(a) - tier(b);

  // A principal gauge outranks an auxiliary structure even when the structure is nearer.
  const principal = (s) => (isPrincipal(s.record) ? 0 : 1);
  if (principal(a) !== principal(b)) return principal(a) - principal(b);

  if (a.fkmDelta !== null && b.fkmDelta !== null && a.fkmDelta !== b.fkmDelta) return a.fkmDelta - b.fkmDelta;
  return (a.km ?? Infinity) - (b.km ?? Infinity);
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
      .sort(compareCandidates);

    // When nothing matched, what is actually useful is what the catalogue does have
    // nearby - a station may simply be spelled differently there.
    const nearby =
      scored.length > 0
        ? []
        : records
            .map((record) => ({ record, km: distanceKm(station, record) }))
            .filter((n) => n.km !== null && n.km <= PLAUSIBLE_KM)
            .sort((a, b) => a.km - b.km)
            .slice(0, 4);

    return { station, best: scored[0] || null, alternatives: scored.slice(1, 4), nearby };
  });
}

/** One candidate as a single readable line. */
function describeCandidate(candidate) {
  const km = candidate.km === null ? 'no coords' : `${candidate.km.toFixed(1)} km`;
  const fkm = candidate.fkmDelta === null ? '' : `  fkm±${candidate.fkmDelta.toFixed(1)}`;
  return (
    `Tsz=${String(candidate.record.tsz).padEnd(8)} ${String(candidate.record.water || '?').padEnd(16)}` +
    ` ${String(candidate.record.name || '?').padEnd(38)} ${km}${fkm}`
  );
}

/** Render the match table and a paste-ready EXTERNAL_IDS block. */
function report(matches) {
  const lines = [];
  const resolved = [];
  const unresolved = [];

  for (const { station, best, alternatives, nearby } of matches) {
    if (!best) {
      lines.push(`  MISSING   ${station.id.padEnd(26)} ${station.name}`);
      // "MISSING" on its own is not actionable. The catalogue names a station several
      // ways, so what is needed is what it does have at those coordinates.
      for (const near of nearby || []) {
        lines.push(
          `              nearby: Tsz=${String(near.record.tsz).padEnd(8)}` +
            ` ${String(near.record.water || '?').padEnd(16)} ${near.record.name} (${near.km.toFixed(1)} km)`,
        );
      }
      unresolved.push(station);
      continue;
    }

    lines.push(`  ${best.confidence.padEnd(9)} ${station.id.padEnd(26)} ${describeCandidate(best)}`);

    // An ambiguous match is worse than none: it looks resolved. Show what it beat.
    if (best.confidence !== 'high') {
      for (const alt of alternatives) lines.push(`              also: ${describeCandidate(alt)}`);
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
    lines.push(`  '${station.id}': '${record.tsz}',   // ${record.water} - ${record.name}`);
  }

  return lines;
}

module.exports = {
  matchStations,
  report,
  normalizeRecord,
  splitName,
  fold,
  riverBase,
  distanceKm,
  score,
  comparePlace,
  isPrincipal,
};
