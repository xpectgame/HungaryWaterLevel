'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  computeUse, computeSavings, measuredAnchor, litresPerDay, buildWaterUse, USES, SAVINGS,
} = require('../src/domain/water-use');

test('a weekly item is divided by seven, not asked for per day', () => {
  // Nobody knows how many loads of washing they do per day; everybody knows how many per
  // week. The model takes the unit the reader can answer in.
  const washing = USES.find((u) => u.id === 'washing');
  assert.equal(washing.perWeek, true);
  assert.equal(litresPerDay(washing, 7, 50), 50);
});

test('a daily item is not divided', () => {
  const shower = USES.find((u) => u.id === 'shower');
  assert.ok(!shower.perWeek);
  assert.equal(litresPerDay(shower, 10, 9), 90);
});

test('a missing input falls back to the default rather than to zero', () => {
  const all = computeUse({});
  const partial = computeUse({ shower: { quantity: 12 } });
  assert.equal(all.litresPerDay, partial.litresPerDay);
  assert.ok(all.litresPerDay > 0);
});

test('a negative or unreadable input contributes nothing instead of a negative', () => {
  const out = computeUse({ shower: { quantity: -5 } });
  const line = out.lines.find((l) => l.id === 'shower');
  assert.equal(line.litresPerDay, 0);
  assert.ok(out.litresPerDay >= 0);
});

test('the shares are a pie chart of THIS household, and they sum to one', () => {
  const out = computeUse({ shower: { quantity: 20 }, garden: { quantity: 30 } });
  const total = out.shares.reduce((s, x) => s + x.share, 0);
  assert.ok(Math.abs(total - 1) < 0.005, `shares sum to ${total}`);
  // Largest first, so a reader sees what to change before what to feel guilty about.
  assert.ok(out.shares[0].share >= out.shares[out.shares.length - 1].share);
});

test('a household that waters nothing has no garden share at all', () => {
  const out = computeUse({ garden: { quantity: 0 } });
  assert.ok(!out.shares.some((s) => s.id === 'garden'));
});

test('savings are computed from the reader own numbers, not published as constants', () => {
  const small = computeSavings({ shower: { quantity: 5 } });
  const large = computeSavings({ shower: { quantity: 30 } });
  const s = (list) => list.find((x) => x.id === 'shorter-shower').litresPerDay;
  assert.ok(s(large) >= s(small), 'a longer shower must not save less by shortening it');
  // And no litre figure is hard-coded anywhere in the config.
  for (const saving of SAVINGS) {
    assert.ok(!('litresPerDay' in saving), `${saving.id} publishes a fixed saving`);
  }
});

test('a change that cannot help reports zero rather than a fictional saving', () => {
  // Someone who already has a 6 l/min head gains nothing from being sold one. Telling
  // them otherwise is the kind of small lie that costs a page its credibility.
  const out = computeSavings({ shower: { quantity: 12, rate: 6 } });
  const head = out.find((x) => x.id === 'saving-head');
  assert.equal(head.litresPerDay, 0);
  assert.equal(head.applicable, false);
});

test('an inapplicable saving is still listed, not hidden', () => {
  const out = computeSavings({ garden: { quantity: 0 } });
  const barrel = out.find((x) => x.id === 'rain-barrel');
  assert.ok(barrel, 'the row must exist');
  assert.equal(barrel.litresPerDay, 0);
});

test('shortening a shower can never save more than the shower costs', () => {
  const inputs = { shower: { quantity: 2, rate: 9 } };
  const total = computeUse(inputs).lines.find((l) => l.id === 'shower').litresPerDay;
  const saved = computeSavings(inputs).find((x) => x.id === 'shorter-shower').litresPerDay;
  assert.ok(saved <= total + 0.001, `saved ${saved} from a shower costing ${total}`);
});

test('every rate carries a range that contains it', () => {
  // The range is not decoration: a shower head is 6 to 15 litres a minute, which changes
  // the answer by a factor of two, and the page has to be able to show that.
  for (const use of USES) {
    assert.ok(Array.isArray(use.range) && use.range.length === 2, `${use.id} has no range`);
    const [lo, hi] = use.range;
    assert.ok(lo < hi, `${use.id} range is not ordered`);
    assert.ok(use.litresPerUnit >= lo && use.litresPerUnit <= hi,
      `${use.id} default ${use.litresPerUnit} is outside ${lo}-${hi}`);
    assert.ok(use.rangeNote && use.rangeNote.length > 10, `${use.id} does not explain its range`);
  }
});

test('every saving points at a use that exists', () => {
  for (const saving of SAVINGS) {
    assert.ok(USES.some((u) => u.id === saving.use), `${saving.id} points at ${saving.use}`);
    assert.ok(saving.note, `${saving.id} has no explanation`);
  }
});

/* --- the measured anchor -------------------------------------------------- */

test('the anchor is derived from the register, and says what it is not', () => {
  const a = measuredAnchor();
  assert.ok(a, 'the sewage register should be loaded');
  assert.ok(a.plants > 500, `only ${a.plants} plants report both figures`);
  assert.ok(a.litresPerResidentPerDay > 100 && a.litresPerResidentPerDay < 400,
    `${a.litresPerResidentPerDay} l/person/day is not a plausible sewer load`);
  assert.equal(a.isUpperBound, true);
  assert.match(a.whatItIsNot, /nem a háztartási vízfogyasztás/);
});

test('the anchor only uses plants that report BOTH figures', () => {
  const a = measuredAnchor({
    source: 'test',
    plants: [
      { connectedResidents: 1000, m3Year: 36500 },
      { connectedResidents: 5000, m3Year: null },
      { connectedResidents: 0, m3Year: 100000 },
    ],
  });
  assert.equal(a.plants, 1);
  assert.equal(a.connectedResidents, 1000);
  // 36 500 m3 / 1000 people / 365 days = 100 litres
  assert.equal(a.litresPerResidentPerDay, 100);
});

test('an unloadable register gives null, never a substituted constant', () => {
  // The point of this number is that it comes from a register we can show you. A
  // fallback would quietly turn it into a remembered statistic.
  assert.equal(measuredAnchor(null), null);
  assert.equal(measuredAnchor({ plants: [] }), null);
});

test('the payload carries the model, the anchor and a worked example', () => {
  const body = buildWaterUse({});
  assert.equal(body.available, true);
  assert.equal(body.uses.length, USES.length);
  assert.ok(body.measured.litresPerResidentPerDay > 0);
  assert.ok(body.example.litresPerDay > 0);
  assert.ok(body.exampleSavings.length > 0);
});
