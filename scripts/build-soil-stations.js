'use strict';

/**
 * Turns a well-scan document into the soil-moisture station registry.
 *
 *   node scripts/build-soil-stations.js probe-output/<stamp>--well-scan-14.json
 *
 * Source: the vraquery meteorological network (vmoType 14), AdatFajtaKod 299
 * "Talajnedvesség", %, AdatTipusKod 100 (operatív).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHAT IT OVERTURNS
 * ---------------------------------------------------------------------------
 * This project has said in writing, more than once, that soil moisture is not obtainable
 * and that the drought section therefore ranks shallow WELL LEVELS instead. That was
 * wrong, and it was wrong for a mechanical reason worth recording: the probe that listed
 * the data-type catalogue printed only its first 60 entries, and the catalogue is 68 long
 * and alphabetical. `Talajnedvesség` sits at entry 65.
 *
 * It is measured, hourly, and it was reporting this morning.
 *
 * ---------------------------------------------------------------------------
 * WHERE THEY ARE, WHICH IS MOST OF WHAT THEY MEAN
 * ---------------------------------------------------------------------------
 * All 23 are in the south-east: Csongrád-Csanád, Békés and the southern half of
 * Bács-Kiskun. That is not a national network and this file must not let anyone mistake
 * it for one - but it is the corner of the country the drought is worst in, so a reader
 * asking "how dry is the ground" is asking about exactly these fields.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE PERCENTAGE DOES NOT SAY
 * ---------------------------------------------------------------------------
 * The register publishes a percentage and nothing else - no sensor depth, no soil type,
 * no wilting point. Without those, 26% is not "26% of the water this soil can hold": it
 * is a number that is comparable with ITSELF over time, and only roughly between
 * stations, because sand and clay at the same reading hold different amounts of water a
 * plant can reach. The flags below are carried into the document so no consumer has to
 * infer that from silence.
 */

const fs = require('node:fs');
const path = require('node:path');

/** AdatFajtaKod 299 on vmoType 14, the only combination that answered. */
const KIND = Object.freeze({
  vmoType: 14,
  adatFajtaKod: 299,
  adatTipusKod: 100,
  unit: '%',
  label: 'talajnedvesség',
});

function build(source) {
  const raw = JSON.parse(fs.readFileSync(source, 'utf8'));
  const entries = Array.isArray(raw) ? raw : Object.values(raw)[0];
  const list = Array.isArray(entries) ? entries : [entries];
  const found = list.find((e) => e && e.adatFajtaKod === KIND.adatFajtaKod);
  if (!found || !Array.isArray(found.wells) || !found.wells.length) {
    throw new Error(`no AdatFajtaKod ${KIND.adatFajtaKod} stations in ${source}`);
  }

  const stations = [];
  let dropped = 0;
  for (const w of found.wells) {
    if (!Number.isFinite(w.lat) || !Number.isFinite(w.lon)) { dropped += 1; continue; }
    stations.push({
      // The registry key is the portal's own station number, so a reading can always be
      // traced back to the row it came from.
      id: `talaj-${w.tsz}`,
      tsz: w.tsz,
      name: w.name || w.telepules || String(w.tsz),
      settlement: w.telepules || null,
      lat: round(w.lat, 5),
      lon: round(w.lon, 5),
      vizig: w.vizig ?? null,
      // How long this station's record is, in hourly samples, as observed by the scan.
      // Carried because it decides what can honestly be said about a reading: a year of
      // record cannot produce a ten-year normal, and the page has to know that.
      samplesSeen: w.samples ?? null,
    });
  }

  stations.sort((a, b) => a.name.localeCompare(b.name, 'hu'));

  return {
    source: 'vraquery vmoType 14, AdatFajtaKod 299 (Talajnedvesség), AdatTipusKod 100',
    generated: new Date().toISOString().slice(0, 10),
    kind: KIND,
    count: stations.length,
    droppedRows: dropped,
    // Announced, not left to be noticed. These three absences decide how the number may
    // be presented, and every one of them is a property of the source.
    hasSensorDepth: false,
    hasSoilType: false,
    hasWiltingPoint: false,
    // Not a national network. Stated in the document so a map cannot imply otherwise.
    coverage: 'A mérőállomások Csongrád-Csanád, Békés és Bács-Kiskun megyében állnak — az ország délkeleti sarkában. Ez nem országos hálózat.',
    stations,
  };
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

if (require.main === module) {
  const source = process.argv[2];
  if (!source) {
    console.error('usage: node scripts/build-soil-stations.js probe-output/<stamp>--well-scan-14.json');
    process.exit(2);
  }
  const doc = build(source);
  const dest = path.join(__dirname, '..', 'src', 'config', 'soil-stations.json');
  fs.writeFileSync(dest, JSON.stringify(doc, null, 1));
  console.log(`${doc.count} stations -> ${dest}, ${doc.droppedRows} dropped`);
  for (const s of doc.stations) {
    console.log(`  ${String(s.tsz).padStart(5)}  ${s.name.padEnd(20)} ${s.lat}, ${s.lon}  ${s.samplesSeen} samples`);
  }
}

module.exports = { build, KIND };
