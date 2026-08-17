'use strict';

const { USES, SAVINGS } = require('../config/water-use');
const { loadSewage } = require('./sewage');

/**
 * Household water use: one measured anchor, and a model the reader drives.
 *
 * ---------------------------------------------------------------------------
 * THE ANCHOR IS OURS, AND IT IS NOT WHAT IT LOOKS LIKE
 * ---------------------------------------------------------------------------
 * 623 of the treatment works in the register report both the residents connected to them
 * and the volume of sewage arriving each year. Divided, that is 223 litres per connected
 * resident per day - a real, checkable figure from a Hungarian register rather than a
 * statistic copied from an article.
 *
 * It is NOT household consumption, and the difference is not small. What arrives at a
 * works is household sewage plus everything else in the same sewer: the shops, the school,
 * the industry that discharges to the municipal system, and - in old networks, a large
 * share - groundwater leaking in through cracked pipes, plus rain where the system is
 * combined. So the figure is an upper bound on what people use, published here as exactly
 * that, with the reasons attached. A page that printed it as "ennyit használsz" would be
 * wrong by a factor that nobody could see.
 *
 * ---------------------------------------------------------------------------
 * AND THE MODEL IS THE READER'S
 * ---------------------------------------------------------------------------
 * Everything else is per-unit rates with their ranges - see config/water-use. Quantities
 * come from the reader. This module does the arithmetic and, importantly, computes the
 * savings from the reader's own numbers rather than publishing a fixed "save 30 litres",
 * which is meaningless to someone who does not shower and enormous to someone who showers
 * twice a day.
 */

const DAYS_PER_YEAR = 365;
const WEEKS_PER_YEAR = DAYS_PER_YEAR / 7;

/**
 * Litres a day for one line of the model.
 *
 * `perWeek` items are divided rather than the reader being asked to think in days: nobody
 * knows how many loads of washing they do per day, and everybody knows how many per week.
 */
function litresPerDay(use, quantity, rate) {
  const q = Number.isFinite(quantity) ? quantity : use.defaultQuantity;
  const r = Number.isFinite(rate) ? rate : use.litresPerUnit;
  if (!Number.isFinite(q) || !Number.isFinite(r) || q < 0 || r < 0) return 0;
  return use.perWeek ? (q * r) / 7 : q * r;
}

/**
 * The whole model, for one set of inputs.
 *
 * @param inputs { [useId]: { quantity, rate } } - anything missing falls back to the default
 */
function computeUse(inputs = {}) {
  const lines = USES.map((use) => {
    const given = inputs[use.id] || {};
    const quantity = Number.isFinite(given.quantity) ? given.quantity : use.defaultQuantity;
    const rate = Number.isFinite(given.rate) ? given.rate : use.litresPerUnit;
    const perDay = litresPerDay(use, quantity, rate);
    return { id: use.id, hu: use.hu, quantity, rate, litresPerDay: round(perDay, 1) };
  });

  const litresDay = lines.reduce((sum, l) => sum + l.litresPerDay, 0);
  return {
    lines,
    litresPerDay: round(litresDay, 1),
    // The two units a bill and a river are measured in. Cubic metres per year is what a
    // water company charges for; litres a day is what a habit changes.
    m3PerYear: round((litresDay * DAYS_PER_YEAR) / 1000, 1),
    // The share each line contributes, computed rather than assumed - this is the honest
    // version of the pie chart, because it is a pie chart of THIS household.
    shares: lines
      .filter((l) => l.litresPerDay > 0)
      .map((l) => ({ id: l.id, hu: l.hu, share: litresDay > 0 ? round(l.litresPerDay / litresDay, 3) : 0 }))
      .sort((a, b) => b.share - a.share),
  };
}

/**
 * What each change would save, given the reader's own numbers.
 *
 * A saving that cannot apply - a rain barrel for a household that waters nothing - comes
 * back as zero rather than being hidden, because "this one is worth nothing to you" is
 * useful information and a missing row is not.
 */
function computeSavings(inputs = {}) {
  const base = computeUse(inputs);
  return SAVINGS.map((saving) => {
    const use = USES.find((u) => u.id === saving.use);
    if (!use) return null;
    const given = inputs[use.id] || {};
    const quantity = Number.isFinite(given.quantity) ? given.quantity : use.defaultQuantity;
    const rate = Number.isFinite(given.rate) ? given.rate : use.litresPerUnit;

    let newQuantity = quantity;
    let newRate = rate;
    if (Number.isFinite(saving.quantityDelta)) newQuantity = Math.max(0, quantity + saving.quantityDelta);
    if (Number.isFinite(saving.quantityTo)) newQuantity = saving.quantityTo;
    // A change that would make things worse is not a saving. Someone who already has a
    // 6 l/min head gains nothing from being sold one, and telling them otherwise is the
    // kind of small lie that costs a page its credibility.
    if (Number.isFinite(saving.rateTo)) newRate = Math.min(rate, saving.rateTo);

    const before = litresPerDay(use, quantity, rate);
    const after = litresPerDay(use, newQuantity, newRate);
    const savedDay = Math.max(0, before - after);

    return {
      id: saving.id,
      hu: saving.hu,
      use: use.id,
      useHu: use.hu,
      note: saving.note,
      litresPerDay: round(savedDay, 1),
      m3PerYear: round((savedDay * DAYS_PER_YEAR) / 1000, 2),
      // Of this household's total, so a reader can see which change is worth doing first
      // rather than which one sounds most virtuous.
      shareOfTotal: base.litresPerDay > 0 ? round(savedDay / base.litresPerDay, 3) : 0,
      applicable: savedDay > 0,
    };
  }).filter(Boolean).sort((a, b) => b.litresPerDay - a.litresPerDay);
}

/**
 * The measured figure from the sewage register, with what it is not.
 *
 * Null when the register is not loaded, rather than a substituted constant: the whole
 * point of this number is that it comes from a Hungarian register this project can show
 * you, and a fallback would quietly turn it into a remembered statistic.
 */
function measuredAnchor(document) {
  const doc = document !== undefined ? document : loadSewage();
  if (!doc || !Array.isArray(doc.plants)) return null;

  const usable = doc.plants.filter((p) => p.connectedResidents > 0 && p.m3Year > 0);
  if (!usable.length) return null;

  const residents = usable.reduce((s, p) => s + p.connectedResidents, 0);
  const m3Year = usable.reduce((s, p) => s + p.m3Year, 0);
  if (!residents) return null;

  return {
    source: doc.source,
    plants: usable.length,
    connectedResidents: residents,
    m3Year,
    litresPerResidentPerDay: round((m3Year * 1000) / residents / DAYS_PER_YEAR, 1),
    m3PerResidentPerYear: round(m3Year / residents, 1),
    // Named `isUpperBound` rather than left to the prose: a consumer that renders this as
    // household consumption is overstating it, and the field says so in the data.
    isUpperBound: true,
    whatItIsNot:
      'Ez a szennyvíztisztító telepre ÉRKEZŐ szennyvíz, nem a háztartási vízfogyasztás. '
      + 'Ugyanabba a csatornába megy a boltok, iskolák és a rákötött üzemek szennyvize is, '
      + 'a régi hálózatokba pedig jelentős mennyiségű talajvíz szivárog be, egyesített '
      + 'rendszerben ráadásul a csapadék is. Felső becslés, nem fogyasztás.',
  };
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** The whole payload: the model's definition, the anchor, and a worked default. */
function buildWaterUse({ inputs, document } = {}) {
  return {
    available: true,
    uses: USES,
    savings: SAVINGS,
    measured: measuredAnchor(document),
    // Computed with the defaults when no inputs are given, so the endpoint is useful on
    // its own and the page has something to render before anyone touches a control.
    example: computeUse(inputs),
    exampleSavings: computeSavings(inputs),
    unit: { litresPerDay: 'l/nap', m3PerYear: 'm³/év' },
  };
}

module.exports = {
  buildWaterUse, computeUse, computeSavings, measuredAnchor, litresPerDay, USES, SAVINGS,
};
