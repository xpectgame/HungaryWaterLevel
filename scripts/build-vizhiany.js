'use strict';

/**
 * The 85 water-shortage districts' boundaries, into public/vizhiany.json.
 *
 *   node scripts/build-vizhiany.js probe-output/<stamp>--vizhiany-geo.json
 *
 * ONLY the boundaries. The declared grade is fetched live at request time and is
 * deliberately not written here - see src/sources/vizhiany.js. A baked grade would be a
 * screenshot of a legal declaration that moves: it would go on announcing an emergency
 * after it was lifted, or miss one after it was declared, and either is worse than
 * showing nothing.
 *
 * The boundaries are the opposite: administrative districts that change on a timescale of
 * years, several hundred kilobytes of polygon, and pointless to re-fetch on every page
 * load. So the two halves of the same layer are handled in opposite ways, on purpose.
 */

const fs = require('node:fs');
const path = require('node:path');

function attr(row, suffix) {
  for (const key of Object.keys(row)) {
    if (key === suffix || key.endsWith(`.${suffix}`)) return row[key];
  }
  return undefined;
}

function build(source) {
  const raw = JSON.parse(fs.readFileSync(source, 'utf8'));
  const record = Object.values(raw)[0];
  const rows = (record && record.features) || [];
  if (!rows.length) throw new Error(`no polygons in ${source} - was it fetched before the probe learned to reduce them?`);

  const districts = [];
  for (const row of rows) {
    const rings = row.rings || [];
    const name = attr(row, 'VizhianyKorzetNev') || attr(row, 'nev');
    // The join carries one placeholder row with no name and no shape. Keeping it would
    // put an 86th district into a national count of 85.
    if (!name || !rings.length) continue;
    districts.push({
      // The id has to match what the live fetch produces, or nothing joins at runtime.
      id: String(attr(row, 'kod') || attr(row, 'VizhianyKorzetSzam') || name),
      name,
      vizig: attr(row, 'vizig') || null,
      rings,
    });
  }

  return {
    source: 'geoportal.vizugy.hu VIR/Vizhiany_korzetek_VIR_fokozatok/MapServer/0',
    generated: new Date().toISOString().slice(0, 10),
    note: 'Csak a körzethatárok. A fokozat élőben jön, mert változik.',
    count: districts.length,
    districts,
  };
}

if (require.main === module) {
  const source = process.argv[2];
  if (!source) {
    console.error('usage: node scripts/build-vizhiany.js probe-output/<stamp>--vizhiany-geo.json');
    process.exit(2);
  }
  const doc = build(source);
  const dest = path.join(__dirname, '..', 'public', 'vizhiany.json');
  fs.writeFileSync(dest, JSON.stringify(doc));
  const points = doc.districts.reduce((n, d) => n + d.rings.reduce((m, r) => m + r.length, 0), 0);
  console.log(`${doc.count} districts, ${points} points -> ${dest} (${(fs.statSync(dest).size / 1024).toFixed(0)} KB)`);
  console.log(`ids: ${doc.districts.slice(0, 5).map((d) => `${d.id}=${d.name}`).join(', ')} ...`);
}

module.exports = { build };
