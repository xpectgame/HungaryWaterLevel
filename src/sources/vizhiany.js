'use strict';

const { fetchJson } = require('../lib/http');

/**
 * The water-shortage grade the authority has actually declared, district by district.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ONE MATTERS MORE THAN ANYTHING ELSE ON THIS SITE
 * ---------------------------------------------------------------------------
 * Everything else here is a measurement this project ranks itself. That is defensible and
 * it is what the drought section does - 770 wells, each against its own ten-year record -
 * but it is still our arithmetic on someone else's numbers, and a reader is entitled to
 * ask who says so.
 *
 * This is not that. These are the 85 vizhiany korzetek and the grade the water directorate
 * has DECLARED for each one, with the timestamp of the declaration and the grade it
 * replaced. Nobody has to take our word for any of it, and when it says most of the
 * country is under an extraordinary water-shortage declaration, that is a fact about what
 * the authority has decided rather than a conclusion we drew.
 *
 * ---------------------------------------------------------------------------
 * LIVE, NOT BAKED - AND THE GEOMETRY THE OTHER WAY ROUND
 * ---------------------------------------------------------------------------
 * The grades move. The observed record shows twelve distinct update timestamps across the
 * 85 districts, the freshest of them the same morning it was read, and the previous-grade
 * column shows most of the country stepping up from II. and III. fok. A baked copy would
 * be a screenshot of a moving thing, and a stale drought declaration is worse than none:
 * it would say the emergency is over when it is not, or announce one that has been lifted.
 *
 * The district BOUNDARIES do not move, so those are baked into public/vizhiany.json and
 * only the grades are fetched. That keeps this request to attributes alone - eighty-five
 * short rows - instead of several megabytes of polygon on every cache miss.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT PAGED
 * ---------------------------------------------------------------------------
 * This is a joined MapServer view, and it answers a query carrying resultOffset with an
 * empty feature set - no error, just nothing, while returnCountOnly cheerfully reports 85.
 * Asked plainly it returns all 85. There is no paging here on purpose.
 */

const LAYER = 'https://geoportal.vizugy.hu/arcgis/rest/services'
  + '/VIR/Vizhiany_korzetek_VIR_fokozatok/MapServer/0';

/**
 * The declared grades, as codes.
 *
 * Observed: 720 for no grade, 722 for II. fok, 723 for III. fok, 724 for the
 * extraordinary declaration. 721 appears only in the previous-grade column, which is
 * where I. fok lives - no district was at I. fok when this was written, so the label for
 * it comes from the sequence rather than from having been seen, and it is the one entry
 * here that is inferred rather than observed. The register's own label string is carried
 * through alongside, so a consumer can prefer it and this table only has to fill gaps.
 */
const GRADES = Object.freeze({
  720: { code: 'none', order: 0, hu: 'nincs fokozat' },
  721: { code: 'i', order: 1, hu: 'I. fokú vízhiány' },
  722: { code: 'ii', order: 2, hu: 'II. fokú vízhiány' },
  723: { code: 'iii', order: 3, hu: 'III. fokú vízhiány' },
  724: { code: 'extraordinary', order: 4, hu: 'rendkívüli vízhiány' },
});

/** Field names arrive fully qualified by the joined view; match on the tail. */
function attr(row, suffix) {
  for (const key of Object.keys(row)) {
    if (key === suffix || key.endsWith(`.${suffix}`)) return row[key];
  }
  return undefined;
}

/**
 * @param timeoutMs 12 seconds, halved from 25.
 *
 * With one retry behind it, 25 seconds meant a failing geoportal held the request for
 * nearly a minute before answering - measured at 51 seconds against production - which is
 * long enough to hit a serverless function's own ceiling and turn a clean 503 into a
 * platform timeout. The declaration is cached for an hour once it arrives, so the cost of
 * giving up early is one more attempt a minute later, and the cost of giving up late is
 * the page hanging.
 */
async function fetchVizhiany({ timeoutMs = 12000 } = {}) {
  const url = `${LAYER}/query?where=1%3D1&outFields=*&returnGeometry=false&f=json`;
  const body = await fetchJson(url, { timeoutMs, retries: 1 });
  const rows = body.features || [];

  const districts = [];
  for (const feature of rows) {
    const row = feature.attributes || {};
    const code = attr(row, 'FokozatKod');
    const name = attr(row, 'VizhianyKorzetNev') || attr(row, 'nev');
    // A row with no district name and no grade is a placeholder in the join, not a
    // district with nothing declared. Counting it would put an 86th district in a
    // national total of 85.
    if (!name && code == null) continue;

    const previous = attr(row, 'FokozatKodElozo');
    const grade = GRADES[code] || null;
    districts.push({
      id: String(attr(row, 'kod') || attr(row, 'VizhianyKorzetSzam') || name),
      name: name || null,
      vizig: attr(row, 'vizig') || null,
      gradeCode: Number.isFinite(code) ? code : null,
      grade: grade ? grade.code : null,
      gradeOrder: grade ? grade.order : null,
      // The register's own label wins over the table above wherever it has one.
      gradeLabel: cleanLabel(attr(row, 'Fokozat')) || (grade ? grade.hu : null),
      previousCode: Number.isFinite(previous) ? previous : null,
      previousOrder: GRADES[previous] ? GRADES[previous].order : null,
      declaredAt: iso(attr(row, 'Idopont')),
      updatedAt: iso(attr(row, 'UtolsoFrissitesIdopont')),
    });
  }

  return {
    source: LAYER,
    fetchedAt: new Date().toISOString(),
    districts,
  };
}

/**
 * The register truncates its own labels - the extraordinary grade arrives as "Rendk!" -
 * and a bare hyphen means no grade rather than a grade called "-".
 */
function cleanLabel(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '-') return null;
  if (/^rendk/i.test(trimmed)) return 'rendkívüli vízhiány';
  return trimmed;
}

function iso(value) {
  if (!Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}

module.exports = { fetchVizhiany, GRADES, LAYER };
