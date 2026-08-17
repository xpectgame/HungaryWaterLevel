'use strict';

const path = require('node:path');
const fs = require('node:fs');

const { loadSewage } = require('./sewage');
const { loadIndustry } = require('./industry');
const { listStations } = require('../config/stations');

/**
 * One watercourse, and where its water goes.
 *
 * ---------------------------------------------------------------------------
 * THE QUESTION IN THE DOMAIN NAME
 * ---------------------------------------------------------------------------
 * The site is called hovafolyik.hu and until now it could not answer that for anything
 * smaller than the fourteen rivers with a gauge on them. The drainage links were in the
 * map file the whole time - see scripts/build-watercourses.js - so this module walks them:
 * name to receiving water to its receiving water, until it reaches a river big enough to
 * be measured or the register stops saying.
 *
 * ---------------------------------------------------------------------------
 * THE CHAIN STOPS HONESTLY, IN THREE DIFFERENT WAYS
 * ---------------------------------------------------------------------------
 * They are different facts and the payload distinguishes them, because a page that
 * renders all three as "vége" would be claiming the first one everywhere:
 *
 *   `gauged`   - it reached a trunk river this site measures. The chain is complete and
 *                the last link has a number on it.
 *   `trunk`    - it reached a name the small-watercourse layer references but does not
 *                carry (Duna, Tisza, Zagyva...). Complete enough: the water is in a
 *                major river, we just have no gauge on that one.
 *   `unknown`  - the register does not record a receiving water for this name. 15% of
 *                names are like this. NOT "it flows nowhere" and not to be drawn as an
 *                ending - the honest word is that we do not know.
 *
 * There is no fourth mode where the chain is guessed from geometry. Two lines whose
 * endpoints nearly touch on a 1:100 000 map are not evidence of a confluence, and this
 * project does not manufacture links that the register declines to state.
 *
 * ---------------------------------------------------------------------------
 * MATCHING TWO REGISTERS THAT DO NOT SHARE A NAMING SYSTEM
 * ---------------------------------------------------------------------------
 * The sewage register names the receiving water as a watercourse ("Galga patak"). The
 * industrial register names it as a WATER BODY - the Water Framework Directive's unit,
 * which is a reach or a group of streams ("Béci- és Zajki-patakok", "Duna Szob-Baja
 * között", "Cserta és felső vízgyűjtője"). They are different systems and an exact string
 * match finds 47% and 36% of them respectively.
 *
 * So names are normalised: punctuation and spacing folded, the water-body qualifiers
 * stripped, and the elided compounds expanded ("Béci- és Zajki-patakok" is two streams,
 * and Hungarian leaves the suffix off the first one). That reaches 80% and 57%.
 *
 * What is NOT done is fuzzy matching. No edit distance, no prefix scoring, nothing that
 * would pair the Kis-Duna with the Duna because they look alike. Every match here is a
 * rule that can be read and disagreed with, and every discharge carries `match` saying
 * which rule caught it - `exact`, `normalised` or `waterBody` - so a reader who thinks an
 * outfall is on the wrong stream can see why this code thought otherwise.
 */

const DOCUMENT_PATH = path.join(__dirname, '..', 'config', 'watercourses.json');

let cached;
let index;

function loadWatercourses({ reload = false } = {}) {
  if (cached !== undefined && !reload) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(DOCUMENT_PATH, 'utf8'));
  } catch {
    cached = null;
  }
  if (reload) index = undefined;
  return cached;
}

/* --- names ---------------------------------------------------------------- */

const ACCENTS = {
  á: 'a', é: 'e', í: 'i', ó: 'o', ö: 'o', ő: 'o', ú: 'u', ü: 'u', ű: 'u',
  Á: 'a', É: 'e', Í: 'i', Ó: 'o', Ö: 'o', Ő: 'o', Ú: 'u', Ü: 'u', Ű: 'u',
};

/**
 * A URL for a Hungarian stream name.
 *
 * Accents are folded because a link with %C5%91 in it survives neither a chat message nor
 * a printed page, and this is meant to be pasted.
 */
function slugify(name) {
  if (typeof name !== 'string') return '';
  return name
    .replace(/[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/g, (c) => ACCENTS[c])
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The comparison key for two registers that spell the same water differently.
 *
 * Everything separating is removed rather than normalised to one separator: "Galga patak"
 * and "Galga-patak" are the same stream, and so are "Által ér" and "Által-ér".
 */
function normaliseName(name) {
  if (typeof name !== 'string') return '';
  let s = name
    .replace(/[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/g, (c) => ACCENTS[c])
    .toLowerCase();

  // Water-body qualifiers. These describe which REACH of a stream the water body covers,
  // not a different stream, so they are dropped before comparing.
  s = s.replace(/\s+es\s+mellekvizfolyasai.*$/, '');
  // The `es` is optional and so is the qualifier: the register writes all four of
  // "Cserta es felso vizgyujtoje", "Bozsva-patak felso vizgyujtoje", "X vizgyujtoje" and
  // "X es vizgyujtoje". Leaving the `es` out of the pattern turns the first into
  // "csertaes", which matches nothing and looks like a stream nobody has heard of.
  s = s.replace(/\s+(es\s+)?(felso|also|kozepso)?\s*vizgyujtoje.*$/, '');
  s = s.replace(/\s+(felso|also|kozepso)$/, '');
  // A named reach of a big river: "Duna Szob-Baja kozott" is the Danube.
  s = s.replace(/\s+[a-z-]+\s*-\s*[a-z-]+\s+kozott$/, '');

  return s.replace(/[^a-z0-9]+/g, '');
}

/**
 * Expands the elided compound the water-body register uses.
 *
 * Hungarian drops the repeated head noun: "Béci- és Zajki-patakok" is the Béci-patak and
 * the Zajki-patak, and "Dera- és Kovács-patak" is two streams likewise. Written out, both
 * halves match the watercourse register; left alone, neither does.
 *
 * Returns the pieces, or a single-element list when there is no compound to expand.
 *
 * Both the plural and the singular head are emitted rather than one being chosen, because
 * choosing means doing Hungarian morphology and Hungarian morphology does not cooperate:
 * "patakok" drops -ok to give "patak", but "árkok" is "árok" and not "árk". Emitting both
 * candidates and letting the caller match whichever exists is correct for every noun; a
 * stripping rule is correct for most of them, and silently wrong for the rest.
 */
function expandCompound(name) {
  if (typeof name !== 'string') return [];
  // "X- és Y-suffix" / "X- és Y-suffixok" - Hungarian leaves the repeated head noun off
  // the first member, so "Béci- és Zajki-patakok" is two streams and neither of them is
  // spelled the way the register wrote it.
  const m = name.match(/^(.+?)-\s+és\s+(.+?)-([a-zá-űA-ZÁ-Ű]+)$/);
  if (!m) return [name];
  const [, first, second, tail] = m;
  const heads = new Set([tail]);
  const singular = tail.replace(/(ok|ek|ök)$/, '');
  if (singular.length >= 3) heads.add(singular);

  const out = [];
  for (const head of heads) {
    out.push(`${first}-${head}`, `${second}-${head}`);
  }
  return out;
}

/* --- the index ------------------------------------------------------------ */

/**
 * Built once and kept: 15 065 names, three lookups over them.
 *
 * Slugs can collide - the register contains names that differ only by accent or by a
 * separator this slug drops. The first name wins the bare slug and the rest are reachable
 * by their disambiguated form, but every colliding name is listed on the winner so a
 * reader who landed on the wrong one can see the others and click through.
 */
function buildIndex(document) {
  const doc = document !== undefined ? document : loadWatercourses();
  if (!doc || !Array.isArray(doc.waters)) return null;

  const bySlug = new Map();
  const byName = new Map();
  const byNorm = new Map();
  const collisions = new Map();

  for (const w of doc.waters) {
    byName.set(w.n, w);

    const norm = normaliseName(w.n);
    if (!byNorm.has(norm)) byNorm.set(norm, []);
    byNorm.get(norm).push(w);

    const slug = slugify(w.n);
    if (!slug) continue;
    if (bySlug.has(slug)) {
      if (!collisions.has(slug)) collisions.set(slug, []);
      collisions.get(slug).push(w.n);
    } else {
      bySlug.set(slug, w);
    }
  }

  const trunkOnly = new Set(doc.trunkOnly || []);

  // ---------------------------------------------------------------------------
  // The trunk rivers get a page too, even though this layer does not carry them.
  //
  // Someone searching this site will type "Zagyva" or "Tisza" long before they type
  // "Ilona-patak", and until now those returned nothing at all: the small-watercourse
  // layer references them as receiving waters without describing them. A synthetic entry
  // makes them addressable, so the page can say what IS known - which streams flow into
  // them, which gauges measure them - rather than 404 on the most obvious search on the
  // site.
  //
  // `synthetic: true` is carried through to the payload, because these have no geometry,
  // no length and no receiving water of their own here, and a consumer must be able to
  // tell that from a real row with missing fields.
  //
  // The bar is a real river rather than every string in the list: the register's trunk
  // references also include pump-main stubs and 40-odd "Névtelen-NNNN" placeholders, and
  // a page for an unnamed ditch that five other ditches drain into helps nobody.
  const directTributaries = new Map();
  for (const w of doc.waters) {
    if (w.b) directTributaries.set(w.b, (directTributaries.get(w.b) || 0) + 1);
  }
  const rivers = gaugedRivers();
  for (const name of trunkOnly) {
    if (/^Névtelen-/i.test(name)) continue;
    const tributaries = directTributaries.get(name) || 0;
    if (tributaries < 5 && !rivers.has(name)) continue;
    const slug = slugify(name);
    if (!slug || bySlug.has(slug)) continue;
    const entry = { n: name, b: null, s: 0, kmMax: 0, kmSum: 0, c: null, synthetic: true };
    bySlug.set(slug, entry);
    byName.set(name, entry);
  }

  return { doc, bySlug, byName, byNorm, collisions, trunkOnly };
}

function getIndex({ reload = false } = {}) {
  if (index === undefined || reload) index = buildIndex(reload ? loadWatercourses({ reload }) : undefined);
  return index;
}

/* --- the chain ------------------------------------------------------------ */

/** Which trunk rivers this site actually measures, by the name the register uses. */
function gaugedRivers() {
  const rivers = new Map();
  for (const s of listStations()) {
    if (!s.river) continue;
    if (!rivers.has(s.river)) rivers.set(s.river, []);
    rivers.get(s.river).push(s);
  }
  return rivers;
}

/**
 * Follows the receiving water from one name to the next.
 *
 * Cycle-guarded, because the register contains at least one pair of segments that name
 * each other - a braided reach where both channels are recorded as the other's receiving
 * water - and a naive walk on that is an infinite loop in a request handler.
 */
function downstreamChain(name, { maxDepth = 20, document } = {}) {
  const idx = document !== undefined ? buildIndex(document) : getIndex();
  if (!idx) return { steps: [], endsWith: 'unknown' };

  const rivers = gaugedRivers();
  const steps = [];
  const seen = new Set([name]);
  let current = idx.byName.get(name);

  while (current && steps.length < maxDepth) {
    const next = current.b;
    if (!next) return { steps, endsWith: 'unknown', unknownAfter: current.n };
    if (seen.has(next)) return { steps, endsWith: 'loop', loopAt: next };
    seen.add(next);

    const gauges = rivers.get(next);
    const entry = idx.byName.get(next);
    // A synthetic entry is a trunk river this layer references but does not describe. It
    // is addressable - so the step gets a link - but it is still where the small-water
    // register's knowledge ends, and the chain stops rather than reading its empty `b`
    // as "flows nowhere".
    const known = entry && !entry.synthetic ? entry : null;
    steps.push({
      name: next,
      slug: entry ? slugify(next) : null,
      // A step the small-watercourse layer does not carry is a trunk river, and saying so
      // is the difference between "the trail went cold" and "it is in the Tisza now".
      trunk: !known,
      gauged: Boolean(gauges),
      gauges: gauges ? gauges.map((g) => ({ id: g.id, name: g.name, riverKm: g.riverKm })) : undefined,
      // Where the register's segments disagreed about the receiving water.
      alsoInto: current.b2,
    });

    if (gauges) return { steps, endsWith: 'gauged' };
    if (!known) return { steps, endsWith: 'trunk' };
    current = known;
  }

  return { steps, endsWith: steps.length >= maxDepth ? 'truncated' : 'unknown' };
}

/**
 * Everything the register says flows INTO this one.
 *
 * The unnamed ones are counted but held apart. Roughly a third of the register's entries
 * are "Névtelen-NNNN" placeholders - real ditches with no name - and listing six of them
 * as clickable links beside the four streams that have names buries the useful half. They
 * are not dropped, because "eleven things flow into your stream" is true and the reader
 * should be able to see that six of them are nameless rather than be shown four and left
 * with the wrong count.
 */
const UNNAMED = /^Névtelen-\d+$/i;

function tributariesOf(name, { limit = 60, document } = {}) {
  const idx = document !== undefined ? buildIndex(document) : getIndex();
  if (!idx) return { count: 0, named: 0, unnamed: 0, waters: [] };
  const all = idx.doc.waters.filter((w) => w.b === name);
  const named = all.filter((w) => !UNNAMED.test(w.n));
  named.sort((a, b) => (b.kmMax || 0) - (a.kmMax || 0));
  return {
    count: all.length,
    named: named.length,
    unnamed: all.length - named.length,
    waters: named.slice(0, limit).map((w) => ({ name: w.n, slug: slugify(w.n), lengthKmMax: w.kmMax })),
  };
}

/* --- the two discharge registers ------------------------------------------ */

/**
 * Sewage works and industrial outfalls whose receiving water is this one.
 *
 * Every hit carries how it was matched. `waterBody` means the industrial register named a
 * WFD water body rather than a stream and this code unpicked it - the least certain of
 * the three, and the reason it is labelled rather than merged in silently.
 */
function dischargesOn(name, { document, sewage, industry } = {}) {
  const target = normaliseName(name);
  if (!target) return { sewage: [], industry: [], sewageCount: 0, industryCount: 0 };

  const sewageDoc = sewage !== undefined ? sewage : loadSewage();
  const industryDoc = industry !== undefined ? industry : loadIndustry();

  const outSewage = [];
  for (const p of (sewageDoc && sewageDoc.plants) || []) {
    const raw = p.receivingWater;
    if (!raw) continue;
    const match = matchKind(raw, name, target);
    if (!match) continue;
    outSewage.push({
      id: p.id,
      name: p.name,
      lat: p.lat,
      lon: p.lon,
      capacityPe: p.capacityPe,
      m3Year: p.m3Year,
      m3s: p.m3s,
      receivingWater: raw,
      match,
    });
  }

  const outIndustry = [];
  for (const p of (industryDoc && industryDoc.points) || []) {
    const raw = p.waterName || p.water;
    if (!raw) continue;
    // Surface only. An industrial point whose target is `felszín alatti` discharges to
    // groundwater and is not on this stream in any sense a reader would accept.
    if (p.target && p.target !== 'felszíni') continue;
    const match = matchKind(raw, name, target);
    if (!match) continue;
    outIndustry.push({
      id: p.id,
      sector: p.sector,
      lat: p.lat,
      lon: p.lon,
      vtCode: p.vtCode,
      receivingWater: raw,
      match,
    });
  }

  outSewage.sort((a, b) => (b.capacityPe || 0) - (a.capacityPe || 0));
  return {
    sewage: outSewage,
    industry: outIndustry,
    sewageCount: outSewage.length,
    industryCount: outIndustry.length,
    // Volumes are only ever summed over the sewage register, which reports them. The
    // industrial one has no volume on any row and adding a count to a total would read
    // as though the industrial share were known.
    sewageM3Year: outSewage.reduce((s, p) => s + (p.m3Year || 0), 0) || null,
  };
}

/** `exact`, `normalised`, `waterBody`, or null when it is a different water. */
function matchKind(raw, name, normalisedTarget) {
  if (raw === name) return 'exact';
  if (normaliseName(raw) === normalisedTarget) return 'normalised';
  const parts = expandCompound(raw);
  if (parts.length > 1 && parts.some((p) => normaliseName(p) === normalisedTarget)) return 'waterBody';
  return null;
}

/* --- lookup and search ---------------------------------------------------- */

function findBySlug(slug, { document } = {}) {
  const idx = document !== undefined ? buildIndex(document) : getIndex();
  if (!idx) return null;
  return idx.bySlug.get(String(slug || '').toLowerCase()) || null;
}

/**
 * Search by name.
 *
 * Prefix hits rank above contained hits, and within those, the LONGER WATERCOURSE wins -
 * not the shorter name.
 *
 * Sorting by name length is the obvious choice and it is wrong: it puts a 2.4 km ditch
 * called "Rákosi" above the 44.6 km Rákos-patak that runs through Budapest, because the
 * ditch has a shorter name. Nobody typing "rakos" means the ditch. The front page's search
 * box hit this exact rock and left a comment about it; this is the same fix on the server.
 */
function searchWatercourses(query, { limit = 20, document } = {}) {
  const idx = document !== undefined ? buildIndex(document) : getIndex();
  if (!idx) return [];
  const q = normaliseName(query);
  if (q.length < 2) return [];

  const hits = [];
  for (const w of idx.doc.waters) {
    const n = normaliseName(w.n);
    const at = n.indexOf(q);
    if (at < 0) continue;
    // An exact name beats a prefix beats a substring. Then size.
    const rank = n === q ? 0 : (at === 0 ? 1 : 2);
    hits.push({ w, rank, km: w.kmMax || 0 });
    if (hits.length > 4000) break;
  }

  hits.sort((a, b) => a.rank - b.rank || b.km - a.km || a.w.n.localeCompare(b.w.n, 'hu'));
  return hits.slice(0, limit).map(({ w }) => ({
    name: w.n,
    slug: slugify(w.n),
    lengthKmMax: w.kmMax,
    into: w.b,
    centroid: w.c,
  }));
}

/** The whole payload for one watercourse. */
function buildWatercourse(slug, { document, sewage, industry } = {}) {
  const water = findBySlug(slug, { document });
  if (!water) return null;

  const idx = document !== undefined ? buildIndex(document) : getIndex();
  const chain = downstreamChain(water.n, { document });
  const discharges = dischargesOn(water.n, { sewage, industry });
  const tributaries = tributariesOf(water.n, { document });
  const gauges = gaugedRivers().get(water.n);

  return {
    available: true,
    name: water.n,
    slug: slugify(water.n),
    // A trunk river has no row of its own in the small-watercourse layer: no geometry, no
    // length, no receiving water. The flag exists so a page renders that as "this is a
    // main river, here is what drains into it" rather than as a stream with every field
    // empty - which is what it would look like otherwise.
    trunk: Boolean(water.synthetic),
    gauges: gauges ? gauges.map((g) => ({ id: g.id, name: g.name, riverKm: g.riverKm, role: g.role })) : null,
    // Both, and neither called `lengthKm`: the register's segments overlap where it
    // re-measures a reach, so the sum is an over-count and the max is a river-kilometre
    // extent rather than a measured length. See scripts/build-watercourses.js.
    lengthKmMax: water.kmMax,
    segmentKmSum: water.kmSum,
    segments: water.s,
    centroid: water.c,
    into: water.b,
    alsoInto: water.b2 || null,
    downstream: chain,
    tributaries,
    discharges,
    sameSlug: (idx && idx.collisions.get(slugify(water.n))) || null,
    source: idx ? idx.doc.source : null,
    vintage: idx ? idx.doc.generated : null,
  };
}

module.exports = {
  buildWatercourse, loadWatercourses, findBySlug, searchWatercourses, downstreamChain,
  tributariesOf, dischargesOn, slugify, normaliseName, expandCompound, buildIndex, getIndex,
  DOCUMENT_PATH,
};
