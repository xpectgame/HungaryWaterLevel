'use strict';

/**
 * Reference stage levels for each gauge, in centimetres.
 *
 * Discharge in m3/s is the honest unit for a water balance, and it is also the unit
 * nobody has any feel for. Stage is the opposite: 412 cm means nothing on its own, but
 * "38 cm below the highest level ever recorded here" means something immediately. These
 * are the numbers that turn one into the other.
 *
 *   lkv    Legkisebb vízállás - the lowest stage ever recorded at this gauge.
 *   lnv    Legnagyobb vízállás - the highest ever recorded.
 *   kf1..3 I., II. and III. fokú árvízvédelmi készültség - the stages at which each
 *          flood-defence readiness grade is declared. These are administrative
 *          decisions, not natural marks: they are set per reach by the water directorate
 *          and revised when the levee system changes.
 *   datum  Nullpont - the gauge zero, in metres above Baltic sea level. Stage is measured
 *          from it, so the absolute water surface is datum + cm/100. Two gauges' stages
 *          are never comparable to each other; only each to its own history.
 *
 * Fetched from the vizugy InternetVmo catalogue on 2026-08-09 and frozen here. They are
 * reference values that change only when a record is broken or a grade is revised, so
 * spending an upstream request per poll on them would be paying for static data. Refresh
 * with `npm run probe -- --thresholds`, which prints exactly this block.
 *
 * Cross-checked against the published record floods: Budapest 891 cm and Paks 891 cm are
 * June 2013, Szeged 1009 cm is April 2006, and Budapest's 620/700/800 grades are the ones
 * the city announces. The table agrees with all of them.
 *
 * A null grade is not a gauge without flood risk - it is a gauge for which the catalogue
 * publishes no grade, usually because the reach is barrage-controlled (Rajka) or the
 * section is administered from the other bank. It is left null rather than guessed.
 *
 * Two mapped stations are absent entirely: Tiszabecs, which the InternetVmo catalogue
 * does not carry, and Mosonmagyaróvár on the Lajta, which has no törzsszám mapped at all.
 * Both simply have no stage context; nothing downstream may invent one.
 */

const STAGE_THRESHOLDS = {
  // --- Danube system -------------------------------------------------------
  'duna-rajka': { lkv: -325, lnv: 648, kf1: null, kf2: null, kf3: null, datum: 122.58 },
  'duna-komarom': { lkv: -12, lnv: 845, kf1: 500, kf2: 620, kf3: 680, datum: 103.88 },
  'duna-nagymaros': { lkv: -73, lnv: 751, kf1: 470, kf2: 570, kf3: 650, datum: 99.43 },
  'duna-budapest': { lkv: 33, lnv: 891, kf1: 620, kf2: 700, kf3: 800, datum: 94.97 },
  // The one gauge where grade III (900) sits above the record high (891): the readiness
  // levels come from the levee system, not from the observed record, and in 2013 the
  // Danube stopped 9 cm short of the top grade here.
  'duna-paks': { lkv: -97, lnv: 891, kf1: 650, kf2: 800, kf3: 900, datum: 85.38 },
  'duna-mohacs': { lkv: 50, lnv: 984, kf1: 700, kf2: 850, kf3: 950, datum: 79.195 },
  'ipoly-ipolytarnoc': { lkv: 19, lnv: 432, kf1: null, kf2: null, kf3: null, datum: 160.31 },
  'raba-szentgotthard': { lkv: -116, lnv: 491, kf1: 270, kf2: 330, kf3: 370, datum: 215.15 },
  'pinka-felsocsatar': { lkv: 1, lnv: 506, kf1: null, kf2: null, kf3: null, datum: 232.27 },
  'repce-zsira': { lkv: -19, lnv: 470, kf1: null, kf2: null, kf3: null, datum: 187.19 },

  // --- Tisza system --------------------------------------------------------
  'tur-garbolc': { lkv: -145, lnv: 646, kf1: 300, kf2: 400, kf3: 450, datum: 116.5 },
  'szamos-csenger': { lkv: -159, lnv: 902, kf1: 500, kf2: 650, kf3: 700, datum: 113.56 },
  'kraszna-agerdomajor': { lkv: -26, lnv: 651, kf1: 470, kf2: 550, kf3: 580, datum: 110.39 },
  'bodrog-felsoberecki': { lkv: 12, lnv: 795, kf1: 550, kf2: 650, kf3: 700, datum: 92.15 },
  'sajo-sajopuspoki': { lkv: 2, lnv: 416, kf1: 200, kf2: 250, kf3: 300, datum: 148.4 },
  'bodva-hidvegardo': { lkv: -62, lnv: 333, kf1: null, kf2: null, kf3: null, datum: 165.37 },
  'hernad-hidasnemeti': { lkv: -139, lnv: 503, kf1: 200, kf2: 250, kf3: 300, datum: 151.26 },
  'tisza-szolnok': { lkv: -301, lnv: 1041, kf1: 650, kf2: 750, kf3: 800, datum: 78.78 },
  'tisza-szeged': { lkv: -250, lnv: 1009, kf1: 650, kf2: 750, kf3: 850, datum: 73.7 },
  'tisza-tiszasziget': { lkv: 50, lnv: 982, kf1: null, kf2: null, kf3: null, datum: 73.61 },

  // --- Körös / Maros -------------------------------------------------------
  'sebes-koros-korosszakal': { lkv: -212, lnv: 518, kf1: 250, kf2: 350, kf3: 400, datum: 92.15 },
  'berettyo-pocsaj': { lkv: -77, lnv: 542, kf1: 400, kf2: 450, kf3: 500, datum: 94.64 },
  'fekete-koros-sarkad': { lkv: -99, lnv: 952, kf1: null, kf2: null, kf3: null, datum: 84.5 },
  'feher-koros-gyula': { lkv: -210, lnv: 786, kf1: 350, kf2: 450, kf3: 550, datum: 84.62 },
  'maros-mako': { lkv: -127, lnv: 625, kf1: 400, kf2: 450, kf3: 500, datum: 79.5 },

  // --- Dráva / Mura --------------------------------------------------------
  'drava-ortilos': { lkv: -185, lnv: 493, kf1: null, kf2: null, kf3: null, datum: 125.94 },
  'drava-dravaszabolcs': { lkv: -55, lnv: 596, kf1: 430, kf2: 480, kf3: 520, datum: 86.76 },
  'mura-letenye': { lkv: 43, lnv: 554, kf1: 330, kf2: 380, kf3: 430, datum: 137.86 },
};

/** The date the table above was read from the catalogue. Shown with the values. */
const FETCHED_AT = '2026-08-09';

function getThresholds(stationId) {
  return STAGE_THRESHOLDS[stationId] || null;
}

module.exports = { STAGE_THRESHOLDS, FETCHED_AT, getThresholds };
