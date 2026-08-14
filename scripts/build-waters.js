'use strict';

/**
 * Every watercourse in the country, into public/waters.json.
 *
 *   node scripts/build-waters.js probe-output/<stamp>--vizfolyas-fo.json \
 *                                probe-output/<stamp>--vizfolyas-kis.json
 *
 * Source: geoportal.vizugy.hu Honlap/Vizitura_alapterkep, layer 2 "Fontosabb vizfolyasok"
 * (109) and layer 3 "Kisebb vizfolyasok" (15 919). Sixteen thousand named watercourses,
 * each with the one it flows into.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FILE FROM geo.json
 * ---------------------------------------------------------------------------
 * geo.json is 63 KB and every visitor downloads it before the map can draw. This is 5.8
 * MB, 1.6 MB over the wire compressed. Merging them would make the first paint of the
 * map twenty-five times heavier for every reader, including the ones who never zoom in
 * far enough to see a single one of these lines.
 *
 * So it is fetched on demand - when the detail layer is switched on, or when zooming past
 * the point where the big rivers alone stop being an answer - and once fetched it stays.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BIG RIVERS ARE EXCLUDED
 * ---------------------------------------------------------------------------
 * The Danube, the Tisza and thirty-four others are already in geo.json, drawn from
 * Natural Earth with the moving dashes that show which way the water goes. Including them
 * here as well would draw each one twice from two different sources, at slightly
 * different positions, and the seam would be visible exactly where the map is most
 * looked at. The names in geo.json win; this file carries everything else.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Length in km below which an unnamed fragment is not worth its bytes. */
const MIN_KM = 0.3;

function build(sources) {
  const seen = new Set();
  const features = [];

  for (const source of sources) {
    const raw = JSON.parse(fs.readFileSync(source, 'utf8'));
    for (const record of Object.values(raw)) {
      for (const f of record.features || []) {
        if (!Array.isArray(f.pts) || f.pts.length < 2) continue;
        if (f.km < MIN_KM) continue;
        // The major-watercourse layer and the minor one overlap on a handful of names;
        // whichever arrives first wins, and the caller passes the better source first.
        const key = `${f.name || ''}|${f.pts[0].join(',')}|${f.pts[f.pts.length - 1].join(',')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        features.push({
          n: f.name || null,
          // Where it flows to. The field that makes this a network rather than a
          // pile of blue lines - a reader can follow their creek to the sea.
          b: f.BEF_NEV || null,
          km: f.km,
          p: f.pts,
        });
      }
    }
  }

  // Longest first, so a consumer drawing only part of the file draws the part that
  // matters. The zoom threshold on the map relies on this order.
  features.sort((a, b) => b.km - a.km);
  return {
    source: 'geoportal.vizugy.hu Honlap/Vizitura_alapterkep (2, 3)',
    generated: new Date().toISOString().slice(0, 10),
    count: features.length,
    features,
  };
}

if (require.main === module) {
  const sources = process.argv.slice(2);
  if (!sources.length) {
    console.error('usage: node scripts/build-waters.js <probe json> [<probe json> ...]');
    process.exit(2);
  }

  // Names already drawn from Natural Earth in geo.json, excluded here - see the header.
  let excluded = new Set();
  try {
    const geo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'geo.json'), 'utf8'));
    excluded = new Set((geo.rivers || []).map((r) => r.name).filter(Boolean));
  } catch {
    console.warn('geo.json not readable; keeping every watercourse');
  }

  const doc = build(sources);
  const before = doc.features.length;
  doc.features = doc.features.filter((f) => !excluded.has(f.n));
  doc.count = doc.features.length;

  const dest = path.join(__dirname, '..', 'public', 'waters.json');
  fs.writeFileSync(dest, JSON.stringify(doc));
  const bytes = fs.statSync(dest).size;
  console.log(`${before} watercourses, ${before - doc.count} already in geo.json -> ${doc.count}`);
  console.log(`${dest}  ${(bytes / 1048576).toFixed(2)} MB`);
  console.log(`named: ${doc.features.filter((f) => f.n).length}, with a receiving water: ${doc.features.filter((f) => f.b).length}`);
  for (const t of [50, 20, 10, 5, 2, 0]) {
    console.log(`  km >= ${String(t).padStart(3)}: ${doc.features.filter((f) => f.km >= t).length}`);
  }
}

module.exports = { build, MIN_KM };
