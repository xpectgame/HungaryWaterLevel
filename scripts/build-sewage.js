'use strict';

/**
 * Turns the geoportal's treatment-plant layer into src/config/sewage.json.
 *
 *   node scripts/build-sewage.js probe-output/<stamp>--szennyviz.json
 *
 * Source: geoportal.vizugy.hu Honlap/Vizikozmu layer 0, "Szennyviztisztito telepek
 * kapacitasa (LE)". Official, and it carries the two things OpenStreetMap did not have on
 * a single one of its 662 objects: the plant's capacity in population equivalent, and the
 * volume of sewage arriving at it.
 *
 * ---------------------------------------------------------------------------
 * THE FILTER, AND WHY IT IS NOT THE OBVIOUS ONE
 * ---------------------------------------------------------------------------
 * The layer has a status column and the obvious rule - keep the rows that say "uzemelo" -
 * is WRONG here, in a way that would have been invisible on the finished map.
 *
 * All three Budapest plants, including Csepel at 1 633 333 LE which is by a wide margin
 * the largest in the country, have a NULL status. They sit in a part of the layer where
 * the operational columns did not join. Keeping only explicit "uzemelo" rows drops the
 * capital's entire sewage system from a national map of the country's sewage, and the
 * result looks completely plausible: 665 plants, sensible totals, nothing obviously
 * missing unless you go looking for Budapest.
 *
 * So the rule is inverted. Drop only what is explicitly dead - closed, out of service,
 * never built, under construction, or the literal "virtualis" - and keep everything else,
 * including rows the register simply did not fill in. Six rows go, 732 stay.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT FILLED IN
 * ---------------------------------------------------------------------------
 * Two gaps are carried through as gaps rather than papered over:
 *
 *   - VOLUME. 715 of 732 plants report one, and the ones that do not include Budapest -
 *     so the national total covers 79% of the installed capacity and UNDERSTATES the
 *     real figure. The coverage share is written into the document so the page can say
 *     so out loud instead of quoting a total that looks complete.
 *   - RECEIVING WATER. Only 133 plants name the watercourse they discharge into. The
 *     rest are left null. It would be easy to attach each outfall to the nearest line in
 *     the hydrography layer and it would usually be right, but "usually right" invented
 *     data is worse than an honest blank, and the ones it got wrong would be exactly the
 *     ones nobody could check.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Explicitly not a working plant. Everything else is kept - see the header. */
const DEAD = /^(bezárt|nem megvalósuló|üzemen kívül|virtuális|építés alatt)$/;

/** The register writes an unknown string as a bare hyphen, which is not a name. */
function real(v) {
  return v !== null && v !== undefined && v !== '' && v !== '-' && v !== 0;
}

function pick(row, fields) {
  for (const f of fields) if (real(row[f])) return row[f];
  return null;
}

function build(source) {
  const raw = JSON.parse(fs.readFileSync(source, 'utf8'));
  const layer = Object.values(raw)[0];
  const rows = (layer && layer.points) || [];
  if (!rows.length) throw new Error(`no points in ${source}`);

  const plants = [];
  let dropped = 0;
  for (const row of rows) {
    if (DEAD.test(row.SzvttAllapotKodNev || '')) { dropped += 1; continue; }
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) { dropped += 1; continue; }

    // Csepel's name is only in Nev_1; the other name columns are null on exactly the
    // rows that matter most, which is the same join gap the status filter fell into.
    const name = pick(row, ['NevT', 'Nev_1', 'Nev', 'NEV0']);
    if (!name) { dropped += 1; continue; }

    const m3Year = real(row.SzTBeSzvizM3) ? row.SzTBeSzvizM3 : null;
    plants.push({
      id: String(row.Rendszam_1 || row.Rendszam || row.OBJECTID),
      name: String(name).replace(/\s*-\s*Szennyvíztisztító Telep$/i, '').trim(),
      lat: row.lat,
      lon: row.lon,
      county: real(row.MEGYE_NEV) ? row.MEGYE_NEV : null,
      // Design capacity: what the works is built for.
      capacityPe: real(row.SzTLEKap) ? row.SzTLEKap : null,
      // What actually arrives, as measured organic load. Different number, different
      // meaning - a plant at half its design capacity is not the same story as one over.
      loadPe: real(row.SzvtTAtlBOIterhLE) ? row.SzvtTAtlBOIterhLE : null,
      m3Year,
      // The same volume per second, which is the only form comparable with a river.
      // 365 days, not 365.25: this is a reported annual figure, not an astronomical one.
      //
      // Six decimals, not four. A village works handling 1 000 m3 a year is 0.000032
      // m3/s, which rounds to zero at four - and a zero here is not merely imprecise,
      // it is falsy, so it silently dropped thirteen small plants out of the national
      // volume the first time this ran.
      m3s: m3Year ? round(m3Year / 365 / 86400, 6) : null,
      connectedResidents: real(row.SzevATelRBekotLakos) ? row.SzevATelRBekotLakos : null,
      receivingWater: real(row.SzevATelRMederVOANev) ? row.SzevATelRMederVOANev : null,
      status: real(row.SzvttAllapotKodNev) ? row.SzvttAllapotKodNev : null,
    });
  }

  plants.sort((a, b) => (b.capacityPe || 0) - (a.capacityPe || 0));

  // Filtered on the reported annual figure rather than the derived per-second one:
  // presence of data is a property of the source, not of how small the number is.
  const withVolume = plants.filter((p) => p.m3Year);
  const totalCapacity = sum(plants.map((p) => p.capacityPe));
  const coveredCapacity = sum(withVolume.map((p) => p.capacityPe));

  return {
    source: 'geoportal.vizugy.hu Honlap/Vizikozmu/MapServer/0',
    generated: new Date().toISOString().slice(0, 10),
    count: plants.length,
    droppedRows: dropped,
    totalCapacityPe: totalCapacity,
    totalM3Year: sum(withVolume.map((p) => p.m3Year)),
    totalM3s: round(sum(withVolume.map((p) => p.m3s)), 2),
    // The honesty fields. A total built from 79% of the capacity is an underestimate and
    // the page has to be able to say which 79%.
    volumeReportedCount: withVolume.length,
    volumeCapacityShare: round(coveredCapacity / totalCapacity, 3),
    volumeMissingLargest: plants
      .filter((p) => !p.m3Year && p.capacityPe)
      .slice(0, 4)
      .map((p) => ({ name: p.name, capacityPe: p.capacityPe })),
    receivingWaterCount: plants.filter((p) => p.receivingWater).length,
    plants,
  };
}

function sum(values) {
  return values.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

if (require.main === module) {
  const source = process.argv[2];
  if (!source) {
    console.error('usage: node scripts/build-sewage.js probe-output/<stamp>--szennyviz.json');
    process.exit(2);
  }
  const doc = build(source);
  const dest = path.join(__dirname, '..', 'src', 'config', 'sewage.json');
  fs.writeFileSync(dest, JSON.stringify(doc));
  console.log(`${doc.count} plants -> ${dest} (${fs.statSync(dest).size} bytes), ${doc.droppedRows} rows dropped`);
  console.log(`capacity ${doc.totalCapacityPe.toLocaleString('hu-HU')} LE`);
  console.log(`volume   ${doc.totalM3s} m3/s from ${doc.volumeReportedCount} plants ` +
    `(${(doc.volumeCapacityShare * 100).toFixed(1)}% of capacity)`);
  console.log(`missing volume: ${doc.volumeMissingLargest.map((p) => `${p.name} (${p.capacityPe})`).join(', ')}`);
  console.log(`receiving water named for ${doc.receivingWaterCount}`);
}

module.exports = { build, DEAD };
