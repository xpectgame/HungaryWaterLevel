#!/usr/bin/env node
'use strict';

/**
 * Turn a committed vmoType-12 scan into the shallow water-table registry.
 *
 *     node scripts/build-shallow.js            # newest well-scan-12 in probe-output/
 *     node scripts/build-shallow.js path.json
 *
 * Separate from build-wells.js rather than a shared function with a flag, because the two
 * networks agree on almost nothing. The confined-aquifer wells report in three different
 * conventions and cannot be compared with each other at all; these report in one, cover
 * every directorate, and read six times a day. Merging them would mean every consumer
 * asking which kind it had before it could interpret a number.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'config', 'shallow-wells.json');

/**
 * Freshness bar, and why it is not the same as the deep wells'.
 *
 * These are telemetered - roughly six readings a day - so thirty days is generous rather
 * than necessary, and it buys coverage: 525 stations reported inside a week, 771 inside a
 * month. The extra 246 are spread across the directorates that have fewest stations, so
 * the looser bar makes the map more national rather than less current.
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

  const block = scan.find((b) => b.adatFajtaKod === 69);
  if (!block) throw new Error('no AdatFajtaKod 69 block in the scan');

  const fresh = block.wells.filter((w) => w.ageDays <= MAX_AGE_DAYS && w.npt != null);

  const seen = new Map();
  for (const w of fresh) seen.set(slug(w.name), (seen.get(slug(w.name)) || 0) + 1);

  const wells = fresh
    .map((w) => ({
      id: seen.get(slug(w.name)) > 1 ? `${slug(w.name)}-${w.tsz}` : slug(w.name),
      tsz: w.tsz,
      name: String(w.name).replace(/\s+/g, ' ').trim(),
      settlement: w.telepules || null,
      vizig: w.vizig,
      lat: round(w.lat, 5),
      lon: round(w.lon, 5),
      nptM: round(w.npt, 2),
    }))
    .sort((a, b) => a.id.localeCompare(b.id, 'hu'));

  if (new Set(wells.map((w) => w.id)).size !== wells.length) {
    throw new Error('duplicate ids after disambiguation');
  }

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
  const hits = fs.readdirSync(dir).filter((f) => f.endsWith('--well-scan-12.json')).sort();
  if (!hits.length) throw new Error(`no *--well-scan-12.json in ${dir}`);
  return path.join(dir, hits[hits.length - 1]);
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

main();
