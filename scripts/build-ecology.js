'use strict';

/**
 * Turns the VGT ecological-status layer into public/okologia.json.
 *
 *   node scripts/build-ecology.js probe-output/<stamp>--okologia.json
 *
 * Source: geoportal.vizugy.hu VGT_1/05_01_05/MapServer/3, "Felszíni folyóvíztest" - the
 * river water bodies of the river basin management plan, joined to the assessment that
 * plan concluded with.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FINALLY ANSWERS
 * ---------------------------------------------------------------------------
 * Every other layer on this site says how much water there is. This is the first one that
 * says what STATE it is in - per water body, in the five classes the Water Framework
 * Directive defines, from an assessment with a signature behind it rather than arithmetic
 * of ours.
 *
 * `integralt` is the integrated result and it is the one to draw: under the directive a
 * water body is only as good as its worst element, so the integrated class is not an
 * average of the others but the floor of them. The components are carried alongside
 * because they say WHY - a river can be biologically fine and hydromorphologically
 * wrecked, and those call for opposite responses.
 *
 * ---------------------------------------------------------------------------
 * THE VINTAGE, WHICH IS THE FIRST THING TO SAY ABOUT IT
 * ---------------------------------------------------------------------------
 * This is the FIRST planning cycle - the assessment published around 2009-2010. There
 * have been two cycles since; their per-water-body results are not on this geoportal in a
 * form that can be fetched. So this is a baseline, not a current condition, and every
 * consumer gets `vintage` in the document and cannot render a class without it.
 *
 * It is worth publishing anyway, and clearly dated, for one reason: it is the only
 * per-water-body ecological assessment of Hungarian rivers that is publicly retrievable
 * at all. A fifteen-year-old class on the Zagyva is a real, checkable fact about the
 * Zagyva. Nothing here is presented as today's.
 *
 * ---------------------------------------------------------------------------
 * THE CLASS SCALE IS VERIFIED, NOT ASSUMED
 * ---------------------------------------------------------------------------
 * The status columns are Doubles with no legend in the layer. They SHOULD be the WFD's
 * 1-5, and they almost certainly are - but "almost certainly" is how a map ends up
 * colouring good rivers red. So the build checks the observed values against the expected
 * set and REFUSES to write labels if they do not match, rather than mapping whatever it
 * found onto five Hungarian words.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * The Water Framework Directive's five classes, in the order the directive puts them.
 *
 * `order` ascends with damage, so a consumer can compare and sort without knowing the
 * Hungarian. `hu` is the term the plans themselves use.
 */
const CLASSES = Object.freeze({
  1: { code: 'high', order: 1, hu: 'kiváló' },
  2: { code: 'good', order: 2, hu: 'jó' },
  3: { code: 'moderate', order: 3, hu: 'mérsékelt' },
  4: { code: 'poor', order: 4, hu: 'gyenge' },
  5: { code: 'bad', order: 5, hu: 'rossz' },
});

/** The assessed elements, keyed by the source column, in the order they are reported. */
const ELEMENTS = [
  ['integralt', 'integralt'],
  ['Biol_minosit', 'biologiai'],
  ['Fizkem_minosit', 'fizikaiKemiai'],
  ['hidromorf_minosit', 'hidromorfologiai'],
  ['HAL_minosit', 'hal'],
];

/** Probe props arrive fully qualified; the table prefix is noise downstream. */
function unqualify(key) {
  const dot = key.lastIndexOf('.');
  return dot === -1 ? key : key.slice(dot + 1);
}

function build(source) {
  const raw = JSON.parse(fs.readFileSync(source, 'utf8'));
  const layer = Object.values(raw)[0];
  if (layer && layer.error) throw new Error(`the probe recorded an error: ${layer.error}`);
  const rows = (layer && layer.features) || [];
  if (!rows.length) throw new Error(`no reduced features in ${source}`);

  // Every distinct value seen in any status column, so the scale can be checked before a
  // single label is written.
  const seen = new Set();
  const bodies = [];

  for (const row of rows) {
    const props = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === 'pts' || key === 'name' || key === 'type' || key === 'km') continue;
      props[unqualify(key)] = value;
    }

    const status = {};
    for (const [column, field] of ELEMENTS) {
      const value = props[column];
      if (value === undefined || value === null || value === '') { status[field] = null; continue; }
      const n = Number(value);
      if (!Number.isFinite(n)) { status[field] = null; continue; }
      seen.add(n);
      status[field] = n;
    }

    bodies.push({
      vor: props.VOR || props.RENDSZAM || null,
      name: row.name || null,
      km: row.km,
      // The plan's own type description, e.g. "síkvidéki, meszes, közepes folyó". It is
      // what makes a class comparable: "moderate" means different things on a mountain
      // stream and on a lowland canal, and the directive assesses each against its own
      // type-specific reference.
      type: props.TIPLEIRAS || null,
      lengthKm: Number.isFinite(Number(props.HOSSZ_MERT)) ? Number(props.HOSSZ_MERT) : null,
      category: props.kategoria || null,
      ...status,
      pts: row.pts,
    });
  }

  // THE GUARD. If the columns are not the 1-5 the directive defines, this stops rather
  // than inventing a legend for whatever it found.
  const unexpected = [...seen].filter((v) => !CLASSES[v]).sort((a, b) => a - b);
  if (unexpected.length) {
    throw new Error(
      `status columns carry values outside the WFD 1-5 scale: ${unexpected.join(', ')}. ` +
      'Refusing to label them. Check the source legend before changing CLASSES.',
    );
  }

  const graded = bodies.filter((b) => CLASSES[b.integralt]);
  const byClass = {};
  for (const c of Object.values(CLASSES)) byClass[c.code] = 0;
  for (const b of graded) byClass[CLASSES[b.integralt].code] += 1;

  return {
    source: 'geoportal.vizugy.hu VGT_1/05_01_05/MapServer/3',
    sourceName: 'Felszíni folyóvíztest - ökológiai állapot',
    vintage: 'VGT első ciklus (2009-2010 körüli minősítés)',
    generated: new Date().toISOString().slice(0, 10),
    scale: CLASSES,
    count: bodies.length,
    gradedCount: graded.length,
    // Counted, never averaged. These are ordinal classes in a legal assessment: there is
    // no water body at "class 2.7" and no meaning to the midpoint between good and
    // moderate - the same rule the declared water-shortage grades follow.
    byClass,
    // The directive's own pass mark: high or good is the objective, everything else is a
    // water body the plan is required to do something about.
    atOrAboveGood: graded.filter((b) => b.integralt <= 2).length,
    features: bodies,
  };
}

if (require.main === module) {
  const source = process.argv[2];
  if (!source) {
    console.error('usage: node scripts/build-ecology.js probe-output/<stamp>--okologia.json');
    process.exit(2);
  }
  const doc = build(source);
  const dest = path.join(__dirname, '..', 'public', 'okologia.json');
  fs.writeFileSync(dest, JSON.stringify(doc));
  const mb = (fs.statSync(dest).size / 1048576).toFixed(2);
  console.log(`${doc.count} water bodies -> ${dest} (${mb} MB)`);
  console.log(`graded: ${doc.gradedCount}, at or above good: ${doc.atOrAboveGood}`);
  for (const [code, n] of Object.entries(doc.byClass)) console.log(`  ${String(n).padStart(4)}  ${code}`);
}

module.exports = { build, CLASSES, ELEMENTS };
