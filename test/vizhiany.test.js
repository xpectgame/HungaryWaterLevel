'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { assessVizhiany } = require('../src/domain/vizhiany');

function district(name, gradeOrder, previousOrder, extra = {}) {
  const grades = ['none', 'i', 'ii', 'iii', 'extraordinary'];
  return {
    id: name,
    name,
    gradeOrder,
    grade: gradeOrder === null ? null : grades[gradeOrder],
    previousOrder,
    updatedAt: '2026-08-14T10:06:15.000Z',
    ...extra,
  };
}

const RAW = {
  source: 'test',
  districts: [
    district('A', 4, 3),
    district('B', 4, 3),
    district('C', 4, 2),
    district('D', 3, 2),
    district('E', 2, 3),          // came down
    district('F', 0, 0),          // unchanged
    district('G', null, null),    // no grade recorded at all
  ],
};

test('districts are counted by grade, never averaged', () => {
  // These are ordinal steps in a legal process. An average of them describes nothing:
  // there is no district at "grade 3.4" and no meaning to the midpoint between II. fok
  // and an extraordinary declaration.
  const out = assessVizhiany(RAW);
  assert.strictEqual(out.summary.byGrade.extraordinary, 3);
  assert.strictEqual(out.summary.byGrade.iii, 1);
  assert.strictEqual(out.summary.byGrade.ii, 1);
  assert.strictEqual(out.summary.byGrade.none, 1);
  assert.ok(!('mean' in out.summary) && !('averageGrade' in out.summary));
});

test('a district with no grade recorded is counted as ungraded, not as no drought', () => {
  // "No declaration on file" and "declared to be fine" are opposite statements.
  const out = assessVizhiany(RAW);
  assert.strictEqual(out.summary.total, 7);
  assert.strictEqual(out.summary.graded, 6);
  assert.strictEqual(out.summary.byGrade.none, 1, 'only the district explicitly at grade 0');
});

test('escalation is reported in both directions', () => {
  const out = assessVizhiany(RAW);
  assert.strictEqual(out.summary.raised, 4, 'A, B, C and D all went up');
  assert.strictEqual(out.summary.lowered, 1, 'E came down');
  assert.strictEqual(out.summary.unchanged, 1, 'F stayed');
});

test('the worst-affected districts come first', () => {
  const out = assessVizhiany(RAW);
  assert.strictEqual(out.districts[0].gradeOrder, 4);
  assert.strictEqual(out.districts[out.districts.length - 1].gradeOrder, null);
});

test('the headline count is the top step, not a share of area', () => {
  // The districts are not equal in size and this layer's areas are not what a reader
  // would mean by "of the country", so a percentage would be a different claim than the
  // one the data supports.
  const out = assessVizhiany(RAW);
  assert.strictEqual(out.summary.atExtraordinary, 3);
  assert.strictEqual(out.summary.atOrAboveThird, 4);
  assert.ok(!('areaShare' in out.summary));
});

test('the freshest and stalest declaration timestamps are both reported', () => {
  const out = assessVizhiany({
    districts: [
      district('A', 4, 3, { updatedAt: '2026-08-14T10:06:15.000Z' }),
      district('B', 0, 0, { updatedAt: '2024-09-12T00:00:00.000Z' }),
    ],
  });
  assert.strictEqual(out.summary.newestUpdate, '2026-08-14T10:06:15.000Z');
  // The stale one matters: a district whose grade has not been touched in two years is
  // not necessarily a district that is fine.
  assert.strictEqual(out.summary.oldestUpdate, '2024-09-12T00:00:00.000Z');
});

test('nothing available reports unavailable rather than an all-clear', () => {
  const out = assessVizhiany({ districts: [] });
  assert.strictEqual(out.available, false);
  assert.strictEqual(out.summary.atExtraordinary, 0);
  assert.strictEqual(out.summary.graded, 0);
});

test('a district whose previous grade is unknown is not counted as unchanged', () => {
  const out = assessVizhiany({ districts: [district('X', 4, null)] });
  assert.strictEqual(out.summary.raised, 0);
  assert.strictEqual(out.summary.lowered, 0);
  assert.strictEqual(out.summary.unchanged, 0);
  assert.strictEqual(out.summary.atExtraordinary, 1);
});
