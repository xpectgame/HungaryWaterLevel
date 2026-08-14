'use strict';

/**
 * Turns the geoportal's industrial-outfall layer into src/config/industry.json.
 *
 *   node scripts/build-industry.js probe-output/<stamp>--ipari-pontok.json
 *
 * Source: geoportal.vizugy.hu VGT_1/02_00/MapServer/1, "Ipari és egyéb szennyvíz".
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * The sewage register next door answers "how much treated municipal effluent goes into
 * which river". This answers a narrower question and a different one: WHERE does water
 * used by industry re-enter the surface water network, and WHAT KIND of industry used it.
 *
 * That is the whole of it. The layer carries no volume, no pollutant load, no permit
 * limit and - this is the one people ask about - no company name. Every field in the
 * source is either a location, a code, or the sector string. So this file reports a
 * location and a sector and stops, rather than reaching for a plausible-looking number.
 *
 * In particular it cannot show what any one factory does with its water. The published
 * water registers name receiving watercourses, not operators; the battery plants that
 * get asked about were built a decade after this survey and are not in it under any
 * name. Saying "here are 23 metallurgy and metal-processing outfalls" is true. Naming
 * one of them Samsung would not be.
 *
 * ---------------------------------------------------------------------------
 * VINTAGE, WHICH MATTERS MORE HERE THAN ANYWHERE ELSE ON THIS SITE
 * ---------------------------------------------------------------------------
 * This is the FIRST river basin management plan (VGT1), surveyed around 2009. Everything
 * else on this site is either live or a ten-year archive; this is a fifteen-year-old
 * snapshot, and it is kept because there is no newer public equivalent with per-outfall
 * geometry, not because it is current. The vintage travels with the document so no
 * consumer can render it without it.
 *
 * ---------------------------------------------------------------------------
 * THE ONE BAD ROW
 * ---------------------------------------------------------------------------
 * One of the 425 points projects to 11.55E 49.70N - Bavaria - while naming a Somogy
 * county stream. Its EOV coordinates in the source are simply wrong. It is dropped, and
 * the count of dropped rows is published, because a single dot in Germany on a map of
 * Hungarian outfalls is the kind of error that makes a reader distrust the other 424.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Hungary, generously. Not a clipping mask - a sanity check. Anything outside this is a
 * broken coordinate rather than a discharge point somewhere interesting.
 */
const HU = { lonMin: 15.8, lonMax: 23.2, latMin: 45.6, latMax: 48.7 };

/**
 * A VGT groundwater body code sitting in the receiving-water column.
 *
 * 112 of the 424 outfalls name no watercourse at all. They name `sp.2.4.1` or `pt.2.1` -
 * the basin plans' codes for a shallow porous, or porous thermal, GROUNDWATER body. Those
 * discharges do not go into a river; they go into the ground. On a map of river pollution
 * that is a different fact, and drawing them on a river would be a wrong one.
 *
 * The classification is made from this naming convention and nothing else. The layer has
 * no surface/subsurface flag, and the obvious-looking alternative - the second letter of
 * the VT_VOR code, which separates the sp-coded rows perfectly - does not survive
 * contact with the data: the same prefix also carries the Balaton and the Ráckevei-
 * Soroksári Dunaág. A pattern that works on 110 rows and is wrong on 21 is worse than no
 * classification, so the readable code is the one that decides.
 *
 * Anchored on a digit so it cannot eat a canal. "XXXI. Apaji-csatorna (Átok-csatorna)
 * alsó" is a surface watercourse whose name begins with a Roman numeral and a full stop.
 */
const GROUNDWATER_BODY = /^(sp|sh|p|pt|k|kt|h)\.\d/i;

/** The register writes an unknown string as a single space. */
function real(v) {
  return v !== null && v !== undefined && String(v).trim() !== '' && String(v).trim() !== '-';
}

function build(source) {
  const raw = JSON.parse(fs.readFileSync(source, 'utf8'));
  const layer = Object.values(raw)[0];
  const rows = (layer && layer.points) || [];
  if (!rows.length) throw new Error(`no points in ${source}`);

  const points = [];
  let dropped = 0;
  for (const row of rows) {
    const { lat, lon } = row;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { dropped += 1; continue; }
    if (lon < HU.lonMin || lon > HU.lonMax || lat < HU.latMin || lat > HU.latMax) {
      dropped += 1;
      continue;
    }
    // NAME is the receiving water body, not the name of anything industrial. It is
    // renamed `water` here because that is what it holds, and because leaving it called
    // NAME is how it gets rendered as a factory name by the next person who reads it.
    const water = real(row.NAME) ? String(row.NAME).trim() : null;
    const underground = !!water && GROUNDWATER_BODY.test(water);

    points.push({
      id: String(row.OBJECTID),
      // The sector that used the water. The only substantive field in the layer.
      sector: real(row['Szennyvíz']) ? String(row['Szennyvíz']).trim() : null,
      water,
      // 'felszíni' goes into a watercourse or a lake; 'felszín alatti' goes into the
      // ground. See GROUNDWATER_BODY - derived from the receiving body's code, because
      // the layer records no such flag.
      target: underground ? 'felszín alatti' : 'felszíni',
      // Nothing to show on a river for a discharge that never reaches one, and the
      // groundwater body code is not a place name a reader can use.
      waterName: underground ? null : water,
      // The water body the outfall discharges into, in the planning code the basin plans
      // use. Kept because it is the join key to every other VGT layer.
      vtCode: real(row.VT_VOR) ? String(row.VT_VOR).trim() : null,
      subUnit: real(row['Alegység']) ? String(row['Alegység']).trim() : null,
      lat: round(lat, 4),
      lon: round(lon, 4),
    });
  }

  const sectors = countBy(points.map((p) => p.sector));
  const surface = points.filter((p) => p.target === 'felszíni');
  const waters = countBy(surface.map((p) => p.waterName));

  return {
    source: 'geoportal.vizugy.hu VGT_1/02_00/MapServer/1',
    sourceName: 'Ipari és egyéb szennyvíz',
    // Not a date field on the rows - a property of the survey, written in once here so
    // that no page can show a dot from this layer without being able to date it.
    vintage: 'VGT első ciklus (2009-2010 körüli felmérés)',
    generated: new Date().toISOString().slice(0, 10),
    count: points.length,
    droppedRows: dropped,
    // Explicit, so a consumer does not have to infer the absence of a field from its
    // absence. These four are the questions this layer will be asked and cannot answer.
    hasVolume: false,
    hasLoad: false,
    hasOperator: false,
    hasPermitLimit: false,
    sectorCount: sectors.length,
    sectors,
    surfaceCount: surface.length,
    groundwaterCount: points.length - surface.length,
    // Which sectors put their water into the ground rather than into a river. Worth
    // publishing separately because it is not evenly spread: it is one sector's story.
    groundwaterSectors: countBy(
      points.filter((p) => p.target !== 'felszíni').map((p) => p.sector),
    ),
    waterCount: waters.length,
    // The receiving waters taking the most outfalls. Not a pollution ranking - a count of
    // entry points, which is a different and much weaker statement, and the field name
    // says so.
    topWatersByOutfallCount: waters.slice(0, 12),
    points,
  };
}

/** [{ name, count }], commonest first, nulls excluded. */
function countBy(values) {
  const tally = new Map();
  for (const v of values) {
    if (!v) continue;
    tally.set(v, (tally.get(v) || 0) + 1);
  }
  return [...tally.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'hu'));
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

if (require.main === module) {
  const source = process.argv[2];
  if (!source) {
    console.error('usage: node scripts/build-industry.js probe-output/<stamp>--ipari-pontok.json');
    process.exit(2);
  }
  const doc = build(source);
  const dest = path.join(__dirname, '..', 'src', 'config', 'industry.json');
  fs.writeFileSync(dest, JSON.stringify(doc));
  console.log(`${doc.count} outfalls -> ${dest} (${fs.statSync(dest).size} bytes), ${doc.droppedRows} dropped`);
  for (const s of doc.sectors) console.log(`  ${String(s.count).padStart(4)}  ${s.name}`);
  console.log(`${doc.waterCount} distinct receiving waters; most outfalls: ` +
    doc.topWatersByOutfallCount.slice(0, 5).map((w) => `${w.name} (${w.count})`).join(', '));
}

module.exports = { build, HU };
