#!/usr/bin/env node
'use strict';

/**
 * Turn a committed well scan into the well registry.
 *
 * Run after `npm run probe -- --well-scan --types=2` has committed its output:
 *
 *     node scripts/build-wells.js            # newest scan in probe-output/
 *     node scripts/build-wells.js path.json  # a specific one
 *
 * A script rather than a hand-edit because the registry is 106 entries and the thing
 * being decided - which wells are fresh enough to register - is a threshold, not a
 * judgement about individual wells. A threshold belongs in code where it can be
 * re-run and argued with.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'config', 'wells.json');

/**
 * How stale a well may be and still count as reporting.
 *
 * Thirty days, not seven. Groundwater is not telemetry: much of this network is read on
 * a weekly or fortnightly round, and a level that moves centimetres a month is not stale
 * at three weeks. The difference is not cosmetic - at seven days the scan found 48 wells,
 * two thirds of them in Budapest, and at thirty it finds 106 across nine directorates.
 * A seven-day cut would have published a national groundwater map of the Buda hills.
 */
const MAX_AGE_DAYS = 30;

function slug(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function main() {
  const source = process.argv[2] || newestScan();
  const scan = JSON.parse(fs.readFileSync(source, 'utf8'));

  // 70 x 2 is the only pair that ever returned anything; see src/config/wells.js.
  const block = scan.find((b) => b.adatFajtaKod === 70 && b.adatTipusKod === 2);
  if (!block) throw new Error('no AdatFajtaKod 70 / AdatTipusKod 2 block in the scan');

  const fresh = block.wells.filter((w) => w.ageDays <= MAX_AGE_DAYS && w.npt != null);

  // Names are not unique in this catalogue - two of the Mikepércs piezometers differ only
  // by a suffix, and nothing guarantees the next scan will not collide outright. The
  // Torzsszam is, so a colliding slug gets it appended rather than one well silently
  // overwriting the other in the keyed document.
  const seen = new Map();
  for (const w of fresh) seen.set(slug(w.name), (seen.get(slug(w.name)) || 0) + 1);

  const wells = fresh
    .map((w) => ({
      id: seen.get(slug(w.name)) > 1 ? `${slug(w.name)}-${w.tsz}` : slug(w.name),
      tsz: w.tsz,
      name: w.name.replace(/\s+/g, ' ').trim(),
      settlement: w.telepules || null,
      vizig: w.vizig,
      lat: round(w.lat, 5),
      lon: round(w.lon, 5),
      // Metres above the Baltic. The datum the series is measured against, kept so a
      // reading can be turned back into an elevation and checked against the terrain -
      // which is the only reason we know the units differ between wells at all.
      nptM: round(w.npt, 2),
    }))
    .sort((a, b) => a.id.localeCompare(b.id, 'hu'));

  const ids = new Set(wells.map((w) => w.id));
  if (ids.size !== wells.length) throw new Error('duplicate well ids after disambiguation');

  fs.writeFileSync(OUT, `${JSON.stringify(wells, null, 0)}\n`);

  const byVizig = new Map();
  for (const w of wells) byVizig.set(w.vizig, (byVizig.get(w.vizig) || 0) + 1);
  console.log(`${path.relative(ROOT, source)} -> ${path.relative(ROOT, OUT)}`);
  console.log(`  ${block.wells.length} answered, ${wells.length} within ${MAX_AGE_DAYS} days`);
  console.log(`  directorates: ${[...byVizig.entries()].sort((a, b) => a[0] - b[0])
    .map(([v, n]) => `${v}:${n}`).join(' ')}`);
}

function newestScan() {
  const dir = path.join(ROOT, 'probe-output');
  const hits = fs.readdirSync(dir).filter((f) => f.endsWith('--well-scan.json')).sort();
  if (!hits.length) throw new Error(`no *--well-scan.json in ${dir}`);
  return path.join(dir, hits[hits.length - 1]);
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

main();
