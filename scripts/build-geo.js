'use strict';

/**
 * Builds the map's geometry from Natural Earth, once, into public/geo.json.
 *
 * The map used to be a 27-point hand-drawn outline. It was legible and it was wrong:
 * the border did not follow the Danube where the Danube is the border, the Balaton was
 * missing entirely, and no reader could place a gauge relative to anywhere they had
 * been. This downloads the real thing.
 *
 *   node scripts/build-geo.js            fetch, simplify, write public/geo.json
 *   node scripts/build-geo.js --inspect  print what the source files actually contain
 *
 * It runs at build time and its output is committed. Nothing here executes at runtime:
 * the page fetches one same-origin JSON file and never touches a tile server, which is
 * what keeps the map working when a CDN does not, and keeps the reader untracked.
 *
 * Source: Natural Earth (public domain), via the pre-split GeoJSON mirror at
 * github.com/martynafford/natural-earth-geojson. Downloads are cached under
 * .geo-cache/ so re-running is free.
 */

const fs = require('fs');
const path = require('path');

const BASE = 'https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/10m';
const SOURCES = {
  countries: `${BASE}/cultural/ne_10m_admin_0_countries.json`,
  rivers: `${BASE}/physical/ne_10m_rivers_europe.json`,
  riversGlobal: `${BASE}/physical/ne_10m_rivers_lake_centerlines.json`,
  lakes: `${BASE}/physical/ne_10m_lakes_europe.json`,
  lakesGlobal: `${BASE}/physical/ne_10m_lakes.json`,
  places: `${BASE}/cultural/ne_10m_populated_places.json`,
};

/**
 * What the map shows, in degrees.
 *
 * Wider than Hungary on every side: a country drawn with nothing around it reads as a
 * shape rather than a place, and the whole point of this map is that the water comes
 * from somewhere.
 */
const VIEW = { west: 15.7, east: 23.3, south: 45.55, north: 48.85 };
/** Data is kept a little past the view, so a clipped edge never shows a seam. */
const CLIP = { west: 15.2, east: 23.8, south: 45.1, north: 49.3 };

/**
 * The seven neighbours, plus the two countries that fill the corners of the frame.
 *
 * Keyed by the exact ADMIN string Natural Earth uses, which is not always the short
 * name - Serbia is "Republic of Serbia" there, and looking it up as "Serbia" silently
 * left a country-shaped hole in the south-east.
 */
const NEIGHBOURS = [
  ['Austria', 'Ausztria'],
  ['Slovakia', 'Szlovákia'],
  ['Ukraine', 'Ukrajna'],
  ['Romania', 'Románia'],
  ['Republic of Serbia', 'Szerbia'],
  ['Croatia', 'Horvátország'],
  ['Slovenia', 'Szlovénia'],
  ['Bosnia and Herzegovina', 'Bosznia-Hercegovina'],
  ['Czechia', 'Csehország'],
  ['Poland', 'Lengyelország'],
];

const CACHE = path.join(__dirname, '..', '.geo-cache');

async function load(key) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${key}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));

  process.stderr.write(`fetching ${key}... `);
  const res = await fetch(SOURCES[key]);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${SOURCES[key]}`);
  const text = await res.text();
  fs.writeFileSync(file, text);
  process.stderr.write(`${(text.length / 1e6).toFixed(1)} MB\n`);
  return JSON.parse(text);
}

// --- geometry helpers ------------------------------------------------------

function inside(p, edge) {
  if (edge === 'west') return p[0] >= CLIP.west;
  if (edge === 'east') return p[0] <= CLIP.east;
  if (edge === 'south') return p[1] >= CLIP.south;
  return p[1] <= CLIP.north;
}

function intersect(a, b, edge) {
  const vertical = edge === 'west' || edge === 'east';
  const bound = CLIP[edge];
  if (vertical) {
    const t = (bound - a[0]) / (b[0] - a[0]);
    return [bound, a[1] + t * (b[1] - a[1])];
  }
  const t = (bound - a[1]) / (b[1] - a[1]);
  return [a[0] + t * (b[0] - a[0]), bound];
}

/** Sutherland-Hodgman against the clip rectangle. Valid because a rectangle is convex. */
function clipRing(ring) {
  let out = ring;
  for (const edge of ['west', 'east', 'south', 'north']) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i += 1) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const curIn = inside(cur, edge);
      const prevIn = inside(prev, edge);
      if (curIn) {
        if (!prevIn) out.push(intersect(prev, cur, edge));
        out.push(cur);
      } else if (prevIn) {
        out.push(intersect(prev, cur, edge));
      }
    }
    if (out.length === 0) return [];
  }
  return out;
}

/**
 * Split a line into the runs that fall inside the clip box.
 *
 * A river is not a closed shape, so it cannot be clipped like one: cutting it with a
 * polygon algorithm would join the Danube's entry and exit points into a shortcut
 * across the country.
 */
function clipLine(line) {
  const runs = [];
  let run = [];
  const within = (p) => p[0] >= CLIP.west && p[0] <= CLIP.east && p[1] >= CLIP.south && p[1] <= CLIP.north;

  for (let i = 0; i < line.length; i += 1) {
    if (within(line[i])) {
      // Carry one point from outside so the line reaches the edge rather than
      // stopping short of it.
      if (run.length === 0 && i > 0) run.push(line[i - 1]);
      run.push(line[i]);
    } else if (run.length) {
      run.push(line[i]);
      runs.push(run);
      run = [];
    }
  }
  if (run.length > 1) runs.push(run);
  return runs.filter((r) => r.length > 1);
}

/** Perpendicular distance from p to the segment ab, in degrees. */
function segmentDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas-Peucker. Iterative, because a Carpathian river bank recurses very deep. */
function simplify(points, tolerance) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];

  while (stack.length) {
    const [first, last] = stack.pop();
    let worst = 0;
    let index = -1;
    for (let i = first + 1; i < last; i += 1) {
      const d = segmentDistance(points[i], points[first], points[last]);
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (index !== -1 && worst > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Coordinates rounded to ~80 m. The map is 800 units across 7.6 degrees: 0.001 deg is a tenth of a unit. */
function round(points) {
  return points.map((p) => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000]);
}

function polygons(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function lines(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

/** Outer rings only, clipped and simplified. Holes are not worth the bytes at this scale. */
function shapeOf(feature, tolerance) {
  const out = [];
  for (const poly of polygons(feature.geometry)) {
    const clipped = clipRing(poly[0]);
    if (clipped.length < 4) continue;
    const simplified = simplify(clipped, tolerance);
    if (simplified.length >= 4) out.push(round(simplified));
  }
  return out;
}

/**
 * Match names across the two river files, which do not agree with each other.
 *
 * ne_10m_rivers_europe writes the Sajó as "Slana" and the Rába as "Raab"; the global
 * file writes "Slaná" and "Raab". Romanian places arrive with two different code points
 * for the same comma-below s. Folding to unaccented lower case makes one table serve
 * both instead of listing every spelling twice and still missing one.
 */
function fold(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u02bc\u2019'`]/g, '')
    .toLowerCase()
    .trim();
}

function lookup(table, raw) {
  if (raw == null) return null;
  if (table[raw]) return table[raw];
  const folded = fold(raw);
  for (const key of Object.keys(table)) {
    if (fold(key) === folded) return table[key];
  }
  return null;
}

function prop(feature, ...names) {
  for (const name of names) {
    const value = feature.properties[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

// --- build -----------------------------------------------------------------

/**
 * Hungarian names for the watercourses Natural Earth labels internationally.
 *
 * Only rivers whose Hungarian name is unambiguous appear here. Anything else keeps the
 * source's own label rather than being guessed at, because a wrong river name on a
 * hydrology site is worse than a foreign one.
 */
const RIVER_NAMES = {
  // The Danube arrives under two labels in the same file - "Donau" above Vienna,
  // "Danube" below - and dropping either leaves the river starting nowhere.
  Danube: 'Duna',
  Donau: 'Duna',
  Tisa: 'Tisza',
  Tisza: 'Tisza',
  Drava: 'Dráva',
  Drau: 'Dráva',
  Mura: 'Mura',
  Mur: 'Mura',
  Raab: 'Rába',
  Sava: 'Száva',
  Save: 'Száva',
  Morava: 'Morva',
  Hornad: 'Hernád',
  Slana: 'Sajó',
  Bodrog: 'Bodrog',
  Latorytsya: 'Latorca',
  Ipel: 'Ipoly',
  Zagyva: 'Zagyva',
  Zala: 'Zala',
  Sio: 'Sió',
  Kapos: 'Kapos',
  Mures: 'Maros',
  'Sebes Koros': 'Sebes-Körös',
  'Crisul Repede': 'Sebes-Körös',
  Vah: 'Vág',
  Hron: 'Garam',
  Nitra: 'Nyitra',
  'Mosoni-Duna': 'Mosoni-Duna',
  'Soroksari Duna': 'Ráckevei-Duna',
};

/**
 * Rivers Natural Earth carries without a usable name, keyed by its own `rivernum`.
 *
 * The Tisza is the one that matters: 348 vertices from the Carpathians to the Danube,
 * `name: null`. Matching on names alone silently left the country's second river off the
 * map while drawing the Zagyva that flows into it. The others are mislabelled rather
 * than unlabelled - #405111 is the Szamos main stem filed under a headwater's name, and
 * #406279 is the whole Körös chain filed under the Fehér-Körös, so it is drawn as
 * "Körös", which is what the Hungarian reach is actually called.
 */
const RIVER_BY_NUM = {
  330: 'Tisza',
  402997: 'Bodrog',
  405111: 'Szamos',
  406279: 'Körös',
  409089: 'Berettyó',
};

/**
 * One Natural Earth feature, two rivers.
 *
 * #208 is digitised as a single line from the Austrian Alps to the Danube and carries
 * `name: "Mur", name_alt: "Drava"` - because below Legrád it is the Dráva. Taking the
 * name at face value drew Hungary's south-western border river as the Mura and left the
 * Dráva as a stub, so the gauged animation ran on 11 km of river instead of 200.
 */
const RIVER_SPLIT = {
  Mur: { at: [16.85, 46.30], before: 'Mura', after: 'Dráva' },
};

function splitLine(line, rule) {
  let best = -1;
  let bestDistance = Infinity;
  line.forEach((p, i) => {
    const d = Math.hypot(p[0] - rule.at[0], p[1] - rule.at[1]);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  });
  // A run that never comes near the junction belongs wholly to one side of it.
  if (bestDistance > 0.15) {
    const mid = line[Math.floor(line.length / 2)];
    return [[mid[0] < rule.at[0] ? rule.before : rule.after, line]];
  }
  return [
    [rule.before, line.slice(0, best + 1)],
    [rule.after, line.slice(best)],
  ].filter(([, part]) => part.length >= 2);
}

/**
 * How prominently each watercourse is drawn.
 *
 * 1 carries a live gauge and is animated at the speed the water is actually moving;
 * 2 is a river a reader would name; 3 is context. Anything absent from this table
 * defaults to 3, so adding a river to RIVER_NAMES never accidentally makes it a headline.
 */
const RIVER_RANK = {
  Duna: 1, Tisza: 1, Dráva: 1,
  Mura: 2, Rába: 2, Maros: 2, Sajó: 2, Hernád: 2, Ipoly: 2, Száva: 2, Vág: 2, Garam: 2,
  Szamos: 2, Bodrog: 2, Körös: 2, 'Sebes-Körös': 2,
};

/**
 * Rivers that are not in Natural Earth at this scale, recorded so the gap is known
 * rather than rediscovered: the Szamos - the third largest inflow the balance counts -
 * the Bodrog, Kraszna, Berettyó, Túr, Bódva, Pinka, Répce and Marcal. Their gauges are
 * still on the map, placed by coordinate; only the channel they sit on is missing.
 */

const LAKE_NAMES = {
  'Lake Balaton': 'Balaton',
  'Neusiedler See': 'Fertő',
  // Natural Earth carries Lake Tisza as one of its sub-basins rather than by name.
  'Middle of Poroszl basin': 'Tisza-tó',
};

/**
 * Places worth a dot on a hydrology map.
 *
 * Not the twenty largest towns: the ones that let a reader locate themselves and the
 * ones that sit on a river the map is about. A gauge at "Felsőberecki" means nothing
 * until Miskolc and Nyíregyháza are on the same picture.
 */
const PLACES = new Set([
  'Budapest', 'Debrecen', 'Szeged', 'Miskolc', 'Pécs', 'Győr', 'Nyíregyháza', 'Kecskemét',
  'Székesfehérvár', 'Szombathely', 'Szolnok', 'Kaposvár', 'Békéscsaba', 'Veszprém',
  'Zalaegerszeg', 'Eger', 'Sopron', 'Dunaújváros', 'Nagykanizsa', 'Baja',
  // Just outside, for orientation - and because the water comes from there.
  'Wien', 'Vienna', 'Bratislava', 'Zagreb', 'Beograd', 'Belgrade', 'Novi Sad',
  'Timişoara', 'Timisoara', 'Oradea', 'Arad', 'Cluj-Napoca', 'Kosice', 'Košice', 'Uzhgorod', 'Uzhhorod',
]);

/** The Hungarian exonyms, for the ones the map shows across the border. */
const PLACE_NAMES = {
  Wien: 'Bécs', Vienna: 'Bécs', Bratislava: 'Pozsony', Zagreb: 'Zágráb',
  Beograd: 'Belgrád', Belgrade: 'Belgrád', 'Novi Sad': 'Újvidék',
  Timişoara: 'Temesvár', Timisoara: 'Temesvár', Oradea: 'Nagyvárad', Arad: 'Arad',
  'Cluj-Napoca': 'Kolozsvár', Kosice: 'Kassa', 'Košice': 'Kassa',
  Uzhgorod: 'Ungvár', Uzhhorod: 'Ungvár',
};

/** Both river files, merged. Neither has the whole picture on its own. */
async function allRivers() {
  const out = [];
  for (const key of ['rivers', 'riversGlobal']) {
    const data = await load(key);
    for (const f of data.features) {
      out.push({
        source: key,
        name: prop(f, 'name', 'name_en', 'NAME'),
        rivernum: prop(f, 'rivernum', 'RIVERNUM'),
        geometry: f.geometry,
      });
    }
  }
  return out;
}

function centroid(ring) {
  const lon = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  return `${lon.toFixed(3)}, ${lat.toFixed(3)}`;
}

async function inspect() {
  const names = new Map();
  for (const f of await allRivers()) {
    if (!f.name) continue;
    for (const line of lines(f.geometry)) {
      if (line.some((p) => p[0] >= CLIP.west && p[0] <= CLIP.east && p[1] >= CLIP.south && p[1] <= CLIP.north)) {
        const key = `${f.name}  [${f.source}]`;
        names.set(key, (names.get(key) || 0) + line.length);
      }
    }
  }
  console.log('\nRivers inside the view, by vertex count:');
  for (const [key, n] of [...names].sort((a, b) => b[1] - a[1])) {
    const raw = key.split('  [')[0];
    console.log(`  ${String(n).padStart(6)}  ${key}${lookup(RIVER_NAMES, raw) ? ` -> ${lookup(RIVER_NAMES, raw)}` : '   (UNMAPPED)'}`);
  }

  for (const key of ['lakes', 'lakesGlobal']) {
    const lakes = await load(key);
    console.log(`\nLakes in ${key}:`);
    for (const f of lakes.features) {
      const name = prop(f, 'name', 'name_en', 'NAME');
      const ring = polygons(f.geometry)[0];
      if (!ring) continue;
      if (!ring[0].some((p) => p[0] >= CLIP.west && p[0] <= CLIP.east && p[1] >= CLIP.south && p[1] <= CLIP.north)) continue;
      console.log(`  ${String(ring[0].length).padStart(6)}  at ${centroid(ring[0])}  ${name || '(unnamed)'}`);
    }
  }

  const places = await load('places');
  console.log('\nPlaces inside the view, by population:');
  const rows = places.features
    .filter((f) => {
      const [lon, lat] = f.geometry.coordinates;
      return lon >= CLIP.west && lon <= CLIP.east && lat >= CLIP.south && lat <= CLIP.north;
    })
    .map((f) => [prop(f, 'NAME', 'name'), prop(f, 'POP_MAX', 'pop_max') || 0, prop(f, 'ADM0NAME', 'adm0name')])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40);
  for (const [name, pop, country] of rows) {
    console.log(`  ${String(pop).padStart(9)}  ${name} (${country})${PLACES.has(name) ? '' : '   (not selected)'}`);
  }
}

async function build() {
  const countries = await load('countries');
  const out = { generated: new Date().toISOString().slice(0, 10), view: VIEW };

  const hungary = countries.features.find((f) => prop(f, 'ADMIN', 'admin', 'NAME') === 'Hungary');
  if (!hungary) throw new Error('Hungary not found in the countries file');
  // The border is the one line on this map that has to be right, so it is simplified
  // an order of magnitude less than everything else.
  out.hungary = shapeOf(hungary, 0.0008);

  out.neighbours = [];
  for (const [admin, name] of NEIGHBOURS) {
    const f = countries.features.find((c) => prop(c, 'ADMIN', 'admin', 'NAME') === admin);
    if (!f) throw new Error(`${admin} not found in the countries file - check the ADMIN spelling`);
    const shapes = shapeOf(f, 0.004);
    if (shapes.length) out.neighbours.push({ name, shapes });
  }

  out.rivers = [];
  const emit = (name, run) => {
    const rank = RIVER_RANK[name] || 3;
    // A main stem is worth more vertices than a tributary drawn one pixel wide.
    const simplified = simplify(run, rank === 1 ? 0.0015 : 0.004);
    if (simplified.length >= 2) out.rivers.push({ name, rank, pts: round(simplified) });
  };

  for (const f of await allRivers()) {
    const split = f.name && RIVER_SPLIT[f.name];
    const name = lookup(RIVER_NAMES, f.name) || RIVER_BY_NUM[f.rivernum];
    if (!name && !split) continue;

    for (const line of lines(f.geometry)) {
      for (const run of clipLine(line)) {
        if (split) {
          for (const [part, pts] of splitLine(run, split)) emit(part, pts);
        } else {
          emit(name, run);
        }
      }
    }
  }
  out.rivers.sort((a, b) => b.rank - a.rank); // context first, main stems painted over it

  out.lakes = [];
  for (const key of ['lakes', 'lakesGlobal']) {
    const lakeData = await load(key);
    for (const f of lakeData.features) {
      const raw = prop(f, 'name', 'name_en', 'NAME');
      const name = lookup(LAKE_NAMES, raw)
        || (raw && Object.entries(LAKE_NAMES).find(([k]) => fold(raw).includes(fold(k)))?.[1]);
      if (!name) continue;
      if (out.lakes.some((l) => l.name === name)) continue;
      const shapes = shapeOf(f, 0.0015);
      if (shapes.length) out.lakes.push({ name, shapes });
    }
  }

  const placeData = await load('places');
  // Folded, because the source writes Timișoara with U+0219 and the list below with
  // U+015F - two different commas under the same s, and an exact match finds neither.
  const wanted = new Map([...PLACES].map((n) => [fold(n), n]));
  out.places = [];
  for (const f of placeData.features) {
    const raw = prop(f, 'NAME', 'name');
    if (!wanted.has(fold(raw))) continue;
    const [lon, lat] = f.geometry.coordinates;
    if (lon < CLIP.west || lon > CLIP.east || lat < CLIP.south || lat > CLIP.north) continue;
    const name = lookup(PLACE_NAMES, raw) || raw;
    if (out.places.some((p) => p.name === name)) continue;
    out.places.push({
      name,
      lon: Math.round(lon * 1000) / 1000,
      lat: Math.round(lat * 1000) / 1000,
      pop: prop(f, 'POP_MAX', 'pop_max') || 0,
      abroad: prop(f, 'ADM0NAME', 'adm0name') !== 'Hungary',
    });
  }
  out.places.sort((a, b) => b.pop - a.pop);

  const file = path.join(__dirname, '..', 'public', 'geo.json');
  fs.writeFileSync(file, JSON.stringify(out));
  const size = fs.statSync(file).size;

  console.log(`wrote public/geo.json  ${(size / 1024).toFixed(0)} KB`);
  console.log(`  border      ${out.hungary.reduce((n, r) => n + r.length, 0)} points in ${out.hungary.length} ring(s)`);
  console.log(`  neighbours  ${out.neighbours.length} countries, ${out.neighbours.reduce((n, c) => n + c.shapes.reduce((m, r) => m + r.length, 0), 0)} points`);
  console.log(`  rivers      ${out.rivers.length} segments, ${out.rivers.reduce((n, r) => n + r.pts.length, 0)} points`);
  console.log(`  lakes       ${out.lakes.map((l) => l.name).join(', ') || 'none'}`);
  console.log(`  places      ${out.places.length}`);
}

const main = process.argv.includes('--inspect') ? inspect : build;
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
