'use strict';

/**
 * Hungary's standing water.
 *
 * The balance is built out of rivers, because rivers are what crosses a border. But
 * "how is the country's water doing" is a question most people answer by looking at the
 * Balaton, and a site that could not say what the Balaton is doing would be answering a
 * different question from the one being asked.
 *
 * A lake is measured differently from a river. There is no discharge to speak of - the
 * Sió carries the Balaton's outflow and it is a gate, not a river regime - so the series
 * that matters is level, in centimetres above the gauge's own zero. What makes that
 * number mean something is:
 *
 *   - its own recorded extremes (LKV/LNV), same as for a river gauge, and
 *   - the surface area, which converts a centimetre into a volume.
 *
 * The second is the reason this file carries areas. One centimetre on the Balaton is
 * 5.9 million cubic metres; on the Velencei-tó it is 240 thousand. Reporting "4 cm-t
 * apadt a héten" tells a reader almost nothing, and "24 millió köbméterrel kevesebb
 * víz van benne, mint egy hete" tells them the size of the thing they are looking at.
 *
 * `gaugeTsz` is the törzsszám in the vizugy catalogue. For the Balaton it is deliberately
 * the "Balaton átlag" series rather than Siófok: a 78 km long lake tilts several
 * centimetres in a strong wind, and the lake-average is the number the water authority
 * itself reports as "the level of the Balaton".
 *
 * Areas and volumes are the standard published figures, good to about two significant
 * figures, and they are reference constants rather than measurements - a lake's area
 * changes with its level, which is exactly the effect being estimated. They are used only
 * to turn a centimetre into an order of magnitude, never to state a volume as measured.
 */

const LAKES = [
  {
    id: 'balaton',
    name: 'Balaton',
    gauge: 'Balaton átlag',
    gaugeTsz: 142300,
    lat: 46.8838,
    lon: 17.8154,
    areaKm2: 594,
    volumeMm3: 1900,
    meanDepthM: 3.3,
    catchmentKm2: 5775,
    outflow: 'Sió-csatorna',
    note:
      'Közép-Európa legnagyobb tava. A vízszintjét a siófoki zsilipen keresztül, a Sió-csatornával szabályozzák. ' +
      'A tó 78 km hosszú, ezért erős szélben több centit is dőlhet — a hivatalos érték ezért a tóátlag, nem egyetlen mérce.',
  },
  {
    id: 'velencei-to',
    name: 'Velencei-tó',
    gauge: 'Agárd',
    gaugeTsz: 818,
    lat: 47.19,
    lon: 18.5829,
    areaKm2: 24.2,
    volumeMm3: 41,
    meanDepthM: 1.6,
    catchmentKm2: 602,
    outflow: 'Dinnyés-Kajtori-csatorna',
    note:
      'Sekély, erősen párolgásfüggő tó: a felszínének körülbelül a harmada nádas. ' +
      'Kis térfogata miatt egy száraz nyáron arányaiban sokkal többet veszít, mint a Balaton.',
  },
  {
    id: 'ferto',
    name: 'Fertő tó',
    gauge: 'Fertőrákos',
    gaugeTsz: 52,
    lat: 47.7205,
    lon: 16.6934,
    // The lake straddles the border; roughly a quarter of the surface is in Hungary.
    areaKm2: 315,
    hungarianAreaKm2: 75,
    volumeMm3: 300,
    meanDepthM: 1.0,
    catchmentKm2: 1120,
    outflow: 'Hansági-főcsatorna',
    note:
      'Európa legnyugatibb sztyepptava, és az egyik legsekélyebb: az átlagmélysége egy méter körüli. ' +
      'A területének nagyjából a negyede van Magyarországon, a többi Ausztriában.',
  },
  {
    id: 'tisza-to',
    name: 'Tisza-tó',
    // No live level. The published catalogue files exactly one gauge under "Tisza-tó",
    // and it is a seepage canal on the right bank - a different body of water. The
    // reservoir's own level is the upper pool at the Kisköre barrage, and no Kisköre
    // gauge appears in the internet-published subset at all. Rather than substitute the
    // nearest Tisza gauge and call it the lake, this stays unmeasured and says so.
    gauge: null,
    gaugeTsz: null,
    lat: 47.6,
    lon: 20.62,
    areaKm2: 127,
    volumeMm3: 250,
    meanDepthM: 1.3,
    outflow: 'Tisza (Kiskörei duzzasztó)',
    note:
      'Nem természetes tó, hanem a kiskörei duzzasztóval visszatartott Tisza — a vízszintjét ezért ' +
      'nem a csapadék, hanem a duzzasztó üzemrendje szabja meg: nyáron feltöltik, télen leeresztik.',
  },
];

const byId = new Map(LAKES.map((l) => [l.id, l]));

function getLake(id) {
  return byId.get(id) || null;
}

/** Lakes with a gauge we can actually read. */
function gaugedLakes() {
  return LAKES.filter((l) => l.gaugeTsz);
}

/**
 * Million cubic metres per centimetre of level.
 *
 * Straight area times depth: a lake is not a cylinder, and near the shore a centimetre
 * covers more ground than this assumes. At these depths the error is a few per cent,
 * which is far inside the precision anyone reads such a number to.
 */
function volumePerCm(lake) {
  return lake.areaKm2 ? (lake.areaKm2 * 1e6 * 0.01) / 1e6 : null;
}

module.exports = { LAKES, getLake, gaugedLakes, volumePerCm };
