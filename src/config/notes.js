'use strict';

/**
 * Editorial notes: the things a person knows and the gauges do not.
 *
 * The events feed is derived entirely from our own measurements, and it is deliberately
 * incapable of saying why anything happened outside the country. It can report that
 * every section fed from Austria is at 70% of normal; it cannot report that the Alps had
 * no snow, because we do not measure the Alps.
 *
 * That kind of context is real and worth having, so this file exists to carry it - with
 * three requirements that keep it from becoming rumour:
 *
 *   1. `source` is mandatory and must be a link a reader can follow. A claim about
 *      Austria with no source is a claim the site cannot stand behind.
 *   2. `from` is mandatory. A note about last August must not read as current.
 *   3. Notes render in their own style, labelled as written by a person. A reader must
 *      never have to guess whether a line came from a gauge or from an author.
 *
 * `until` is optional; a note without one stays current until it is removed. Keep them
 * short - this is context for a number on the page, not an article.
 *
 * Example of the shape, kept commented so the file is empty rather than pre-populated
 * with something nobody checked:
 *
 *   {
 *     id: 'paks-2026-blokk-karbantartas',
 *     from: '2026-08-01',
 *     until: '2026-09-15',
 *     title: 'Paks: tervezett blokkleállás',
 *     body: 'A 3. blokk éves karbantartása miatt áll, ezért esett vissza az atomerőművi '
 *       + 'termelés és vele a Duna hűtővíz-kivétele.',
 *     source: { label: 'MVM Paksi Atomerőmű közlemény', url: 'https://...' },
 *     topics: ['paks'],
 *   }
 *
 * `topics` is free-form and only used to sort a note next to what it is about:
 * 'duna', 'tisza', 'drava', 'balaton', 'paks', 'idojaras'.
 */

const NOTES = [];

/** Notes in force at `at`, newest first. */
function activeNotes(at = Date.now()) {
  const t = typeof at === 'number' ? at : Date.parse(at);
  return NOTES.filter((note) => {
    const from = Date.parse(note.from);
    const until = note.until ? Date.parse(note.until) : Infinity;
    // A note with an unparseable date is a bug in the note, not a note about nothing -
    // show it rather than dropping it silently.
    if (Number.isNaN(from)) return true;
    return t >= from && t <= until;
  }).sort((a, b) => Date.parse(b.from) - Date.parse(a.from));
}

/**
 * Every note must carry a source and a start date.
 *
 * Enforced in code and covered by a test, because the rule matters most exactly when
 * someone is in a hurry to publish something.
 */
function validateNotes(notes = NOTES) {
  const problems = [];
  for (const note of notes) {
    if (!note.id) problems.push(`a note has no id: ${JSON.stringify(note).slice(0, 60)}`);
    if (!note.from || Number.isNaN(Date.parse(note.from))) problems.push(`${note.id}: 'from' is missing or unparseable`);
    if (!note.title) problems.push(`${note.id}: no title`);
    if (!note.source || !note.source.url) problems.push(`${note.id}: no source link`);
    if (note.until && Date.parse(note.until) < Date.parse(note.from)) problems.push(`${note.id}: 'until' precedes 'from'`);
  }
  return problems;
}

module.exports = { NOTES, activeNotes, validateNotes };
