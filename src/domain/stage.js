'use strict';

const { getThresholds, FETCHED_AT } = require('../config/stage-thresholds');

/**
 * Puts a stage reading in context.
 *
 * The whole point of carrying stage alongside discharge is this function. A reading of
 * 412 cm is uninterpretable; "412 cm, 39 cm above the lowest ever recorded here" is a
 * sentence. Everything below is arithmetic against the reference table - no modelling,
 * no thresholds of my own invention.
 *
 * Two rules it keeps:
 *
 * 1. A gauge with no published thresholds still gets its centimetres back, with every
 *    derived field null. Tiszabecs is not in the catalogue, and a page that silently
 *    dropped the Upper Tisza's level because it lacked context would be worse than one
 *    that shows the number and says nothing more about it.
 * 2. Nothing here interpolates a band that the source does not define. The flood grades
 *    are administrative decisions with exact values; "low water" is not among them, so
 *    it is not returned. The drought signal lives on the discharge side, as the ratio to
 *    the long-term mean, where it is actually measured.
 */

/** Official names of the three flood-defence readiness grades. */
const GRADES = [
  { level: 1, hu: 'I. fokú árvízvédelmi készültség', en: 'flood readiness grade I' },
  { level: 2, hu: 'II. fokú árvízvédelmi készültség', en: 'flood readiness grade II' },
  { level: 3, hu: 'III. fokú árvízvédelmi készültség', en: 'flood readiness grade III' },
];

function num(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * Which readiness grade the stage has reached, or null.
 *
 * Walks downward so the highest grade wins, and tolerates a table where only some grades
 * are published - a gauge with kf1 but no kf3 is answered on the strength of what exists.
 */
function gradeFor(cm, thresholds) {
  for (const grade of [3, 2, 1]) {
    const level = num(thresholds[`kf${grade}`]);
    if (level !== null && cm >= level) return GRADES[grade - 1];
  }
  return null;
}

/**
 * Where the stage sits on its own historical range, 0 at the record low and 1 at the
 * record high. Unclamped on purpose: a value outside [0, 1] is a new record, which is
 * exactly the case a display must not quietly flatten.
 */
function positionOnRange(cm, lkv, lnv) {
  if (lkv === null || lnv === null || lnv <= lkv) return null;
  return round((cm - lkv) / (lnv - lkv), 4);
}

function describeStage(stageCm, stationId) {
  const cm = num(stageCm);
  if (cm === null) return null;

  const thresholds = getThresholds(stationId);
  if (!thresholds) {
    return {
      cm,
      datumMasl: null,
      surfaceMasl: null,
      recordLowCm: null,
      recordHighCm: null,
      aboveRecordLowCm: null,
      belowRecordHighCm: null,
      position: null,
      grade: null,
      gradeName: null,
      gradeNameEn: null,
      band: 'unknown',
      thresholds: null,
      referenceDate: null,
      note: 'No reference levels are published for this gauge.',
    };
  }

  const lkv = num(thresholds.lkv);
  const lnv = num(thresholds.lnv);
  const datum = num(thresholds.datum);
  const grade = gradeFor(cm, thresholds);

  return {
    cm,
    datumMasl: datum,
    // The absolute elevation of the water surface. The one number that IS comparable
    // between gauges, and the reason the datum is carried at all.
    surfaceMasl: datum === null ? null : round(datum + cm / 100, 3),
    recordLowCm: lkv,
    recordHighCm: lnv,
    aboveRecordLowCm: lkv === null ? null : round(cm - lkv, 1),
    belowRecordHighCm: lnv === null ? null : round(lnv - cm, 1),
    position: positionOnRange(cm, lkv, lnv),
    grade: grade ? grade.level : null,
    gradeName: grade ? grade.hu : null,
    gradeNameEn: grade ? grade.en : null,
    band: bandFor(cm, lkv, lnv, grade),
    thresholds: {
      lkv,
      lnv,
      kf1: num(thresholds.kf1),
      kf2: num(thresholds.kf2),
      kf3: num(thresholds.kf3),
      gradesPublished: [thresholds.kf1, thresholds.kf2, thresholds.kf3].some((v) => num(v) !== null),
    },
    referenceDate: FETCHED_AT,
    note: null,
  };
}

/**
 * A single word for the display to colour by.
 *
 * Beating a record outranks the flood grade: at Szeged in 2006 the stage passed grade III
 * long before it passed the old record, and by the time it did, "III. fokú" was no longer
 * the most important thing true about it.
 */
function bandFor(cm, lkv, lnv, grade) {
  if (lnv !== null && cm >= lnv) return 'record-high';
  if (lkv !== null && cm <= lkv) return 'record-low';
  if (grade) return `grade-${grade.level}`;
  return 'normal';
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

module.exports = { describeStage, gradeFor, positionOnRange, GRADES };
