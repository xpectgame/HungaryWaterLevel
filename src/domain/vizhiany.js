'use strict';

/**
 * The national picture from the declared water-shortage grades.
 *
 * Counts, never averages. "The average grade is 3.9" is a number describing nothing:
 * grades are ordinal steps in a legal process, not a scale with a meaningful midpoint,
 * and the honest summary of 80 districts at the top step and one at none is those two
 * numbers, not their mean.
 *
 * The escalation is the other half. Each district carries the grade it replaced, so the
 * document can say how many went up and how many came down since the last change -
 * which is what turns a snapshot into news.
 */

const ORDER = ['none', 'i', 'ii', 'iii', 'extraordinary'];

function assessVizhiany(raw) {
  const districts = (raw && raw.districts) || [];
  const graded = districts.filter((d) => d.gradeOrder !== null);

  const byGrade = {};
  for (const code of ORDER) byGrade[code] = 0;
  for (const d of graded) byGrade[d.grade] = (byGrade[d.grade] || 0) + 1;

  let raised = 0;
  let lowered = 0;
  let unchanged = 0;
  for (const d of graded) {
    if (d.previousOrder === null) continue;
    if (d.gradeOrder > d.previousOrder) raised += 1;
    else if (d.gradeOrder < d.previousOrder) lowered += 1;
    else unchanged += 1;
  }

  const timestamps = districts.map((d) => d.updatedAt).filter(Boolean).sort();
  const worst = graded.reduce((a, b) => (b.gradeOrder > (a ? a.gradeOrder : -1) ? b : a), null);

  return {
    available: districts.length > 0,
    source: raw && raw.source,
    fetchedAt: raw && raw.fetchedAt,
    districts: districts
      .slice()
      .sort((a, b) => (b.gradeOrder ?? -1) - (a.gradeOrder ?? -1) || String(a.name).localeCompare(String(b.name), 'hu')),
    summary: {
      total: districts.length,
      graded: graded.length,
      byGrade,
      // The headline this supports, and the only one it supports: how many districts sit
      // at the top step. Not a percentage of area - the districts are not equal in size
      // and this layer's areas are not what a reader would mean by "the country".
      atExtraordinary: byGrade.extraordinary || 0,
      atOrAboveThird: (byGrade.iii || 0) + (byGrade.extraordinary || 0),
      raised,
      lowered,
      unchanged,
      newestUpdate: timestamps.length ? timestamps[timestamps.length - 1] : null,
      oldestUpdate: timestamps.length ? timestamps[0] : null,
      worstName: worst ? worst.name : null,
    },
  };
}

module.exports = { assessVizhiany, ORDER };
