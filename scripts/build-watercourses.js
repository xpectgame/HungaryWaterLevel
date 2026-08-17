'use strict';

/**
 * Turns public/waters.json into src/config/watercourses.json - the drainage index.
 *
 *   node scripts/build-watercourses.js
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS ALREADY IN THE FILE, UNUSED
 * ---------------------------------------------------------------------------
 * public/waters.json was baked for the map: 15 566 line segments so that every stream in
 * the country could be drawn, not just the fourteen big rivers. It carries four fields
 * per segment, and the site had been using two of them - the name and the geometry.
 *
 * The third is `b`, the BEFOGADÓ: the water this one flows into. 13 249 of the 15 566
 * segments name it, and 85% of the distinct names have it on at least one segment. That
 * is a drainage graph, and it has been sitting in the map file since it was baked.
 *
 * It is worth saying plainly what that makes possible, because it is the question this
 * site is named after and has never answered: given a stream, follow `b` from one name to
 * the next and you get the route the water takes out of the country. Ilona-patak flows
 * into the Parádi-Tarna, which flows into the Tarna, which flows into the Zagyva. Nobody
 * had to be asked; the register says so.
 *
 * ---------------------------------------------------------------------------
 * WHY AN INDEX RATHER THAN READING waters.json
 * ---------------------------------------------------------------------------
 * waters.json is 4.9 MB, and 97% of that is coordinates. The API needs the names, the
 * links and the lengths; the map needs the coordinates. Parsing five megabytes of
 * polyline on a serverless cold start to answer "what does the Gaja flow into" is the
 * kind of waste that shows up as a slow first request forever after.
 *
 * So this drops the geometry and keeps one centroid per name, which is enough to say
 * roughly where a stream is and to sort search results by distance from a reader.
 *
 * ---------------------------------------------------------------------------
 * SEGMENTS ARE MERGED BY NAME, AND THE LENGTHS ARE ADDED WITH CARE
 * ---------------------------------------------------------------------------
 * The register splits a watercourse into segments - the Rákos-patak is three rows of
 * 44.6, 10 and 3.6 km. Those are NOT three streams and they are not one 58 km stream
 * either: `km` in this register is the river-kilometre extent of the segment, and the
 * segments of one name overlap where the register re-measures a reach.
 *
 * Taking the maximum rather than the sum is the honest reading - it is the furthest
 * upstream point that the register places on this name - and the field is called
 * `lengthKmMax` rather than `lengthKm` so that nobody downstream of here reads it as a
 * measured length. Both the max and the sum are published, along with the segment count,
 * so a consumer that disagrees can compute its own.
 */

const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, '..', 'public', 'waters.json');
const DEST = path.join(__dirname, '..', 'src', 'config', 'watercourses.json');

function main() {
  const raw = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
  const features = raw.features || [];
  if (!features.length) {
    console.error('no features in waters.json - nothing to index');
    process.exitCode = 2;
    return;
  }

  /** name -> accumulator */
  const byName = new Map();

  for (const f of features) {
    const name = typeof f.n === 'string' ? f.n.trim() : '';
    if (!name) continue;

    let acc = byName.get(name);
    if (!acc) {
      acc = { name, receiving: new Map(), segments: 0, kmMax: 0, kmSum: 0, sx: 0, sy: 0, sn: 0 };
      byName.set(name, acc);
    }

    acc.segments += 1;
    if (Number.isFinite(f.km)) {
      acc.kmMax = Math.max(acc.kmMax, f.km);
      acc.kmSum += f.km;
    }

    // The receiving water is voted on rather than taken from the first segment. Where
    // segments disagree - a stream that the register splits at a confluence - the
    // majority is the one that describes most of its length.
    const b = typeof f.b === 'string' ? f.b.trim() : '';
    if (b && b !== name) acc.receiving.set(b, (acc.receiving.get(b) || 0) + 1);

    // One centroid per name, from the segment vertices. Not a channel midpoint and not
    // claimed to be: it is where to put the map when someone searches for this name.
    const pts = Array.isArray(f.p) ? f.p : [];
    for (const pt of pts) {
      if (!Array.isArray(pt) || pt.length < 2) continue;
      const [lon, lat] = pt;
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      acc.sx += lon; acc.sy += lat; acc.sn += 1;
    }
  }

  const waters = [];
  for (const acc of byName.values()) {
    const votes = [...acc.receiving.entries()].sort((a, b) => b[1] - a[1]);
    waters.push({
      n: acc.name,
      // Null rather than omitted: "the register does not say" is a fact about this
      // watercourse, and a consumer must be able to tell it from a missing key.
      b: votes.length ? votes[0][0] : null,
      // Kept when the segments disagree, because a stream with two named receiving
      // waters is usually a stream the register splits at a confluence - and that is
      // worth showing rather than silently resolving.
      b2: votes.length > 1 ? votes.slice(1).map((v) => v[0]) : undefined,
      s: acc.segments,
      kmMax: round(acc.kmMax, 1),
      kmSum: round(acc.kmSum, 1),
      c: acc.sn ? [round(acc.sx / acc.sn, 4), round(acc.sy / acc.sn, 4)] : null,
    });
  }

  waters.sort((a, b) => a.n.localeCompare(b.n, 'hu'));

  // The set of names that appear only as a receiving water. These are the trunk rivers -
  // Duna, Tisza, Zagyva, Rába, Sió - which this layer does not carry as features at all,
  // because it is the small-watercourse layer. A chain that ends on one of them has not
  // failed; it has reached a river big enough to have its own gauge on this site.
  const known = new Set(waters.map((w) => w.n));
  const trunkOnly = [...new Set(waters.map((w) => w.b).filter((b) => b && !known.has(b)))].sort(
    (a, b) => a.localeCompare(b, 'hu'),
  );

  const withReceiving = waters.filter((w) => w.b).length;

  const doc = {
    source: raw.source || 'geoportal.vizugy.hu Vizitura_alapterkep',
    generated: new Date().toISOString().slice(0, 10),
    segmentCount: features.length,
    count: waters.length,
    withReceiving,
    receivingShare: round(withReceiving / waters.length, 3),
    // Named so that a consumer cannot mistake them for gauged rivers on this site: they
    // are names this layer references but does not describe.
    trunkOnly,
    trunkOnlyCount: trunkOnly.length,
    waters,
  };

  fs.writeFileSync(DEST, `${JSON.stringify(doc)}\n`);
  console.log(`${waters.length} watercourses from ${features.length} segments`);
  console.log(`  receiving water known for ${withReceiving} (${Math.round(100 * withReceiving / waters.length)}%)`);
  console.log(`  ${trunkOnly.length} names referenced as receiving water but not carried as features`);
  console.log(`  wrote ${DEST} (${fs.statSync(DEST).size} bytes)`);
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

if (require.main === module) main();

module.exports = { main };
