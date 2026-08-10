'use strict';

/**
 * The rain gauges this project reads, and what a normal month looks like at each.
 *
 * ---------------------------------------------------------------------------
 * WHY RAINFALL IS HERE AT ALL
 * ---------------------------------------------------------------------------
 * A discharge figure answers "how much water is in the river". It does not answer "why",
 * and during a drought that is the only question anyone is actually asking. Rainfall is
 * the input to the whole system: the Danube at Budapest is Alpine snowmelt and Bavarian
 * rain from a week ago, but the Körös catchment, the Homokhátság and every reservoir in
 * between are fed by what fell locally, and that is measurable here.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SERVICE ACTUALLY PUBLISHES
 * ---------------------------------------------------------------------------
 * AdatFajtaKod 71 (csapadékösszeg, mm) on vmoType 14, the meteorological network -
 * 441 published stations, of which 262 reported within three days when this registry was
 * built (2026-08-10). Confirmed by `npm run probe -- --rain-scan`.
 *
 * Each sample is an INCREMENT over the interval since the previous one, not a running
 * total, so a period total is the sum of its samples. That matters because the interval
 * is not the same everywhere: most gauges report once a day at 04:00-06:00 UTC, some
 * twice, and the telemetered ones every 15 minutes. Summing works for all of them;
 * averaging or taking the last value does not.
 *
 * ---------------------------------------------------------------------------
 * THE HOLE IN THE MAP, STATED RATHER THAN HIDDEN
 * ---------------------------------------------------------------------------
 * This network is not national. Directorates 2 (Budapest) and 4 (Székesfehérvár) have no
 * meteorological stations in the catalogue at all, and 5 (Pécs) has 22 of which none
 * reported. Coverage is dense across the Alföld and the north-east - which is exactly
 * where belvíz and aszály are managed - and thin to absent west of the Danube.
 *
 * So this is a rainfall map of the areas that measure rainfall, not of Hungary, and
 * `COVERAGE` below says so in the payload rather than leaving a reader to infer it from
 * a suspiciously empty Transdanubia.
 */

/**
 * Monthly normals, in millimetres, keyed by gauge.
 *
 * Computed from this same gauge's own archive rather than taken from a climate atlas:
 * `npm run probe -- --rain-normals` reads ten calendar years back through the same
 * endpoint the live poll uses, buckets every sample by calendar month, and averages the
 * months that have most of their days present. The archive reaches ten years and stops -
 * twenty years back returns nothing - so ten is the depth, not a preference.
 *
 * A gauge's own history is the right baseline here. A national atlas figure would be
 * interpolated to a grid square and would disagree with the instrument by more than the
 * signal being measured, and the comparison this feeds - "how does this month compare" -
 * is only meaningful against the same rain gauge in the same field.
 *
 * `years` records how many years actually contributed, because a normal from three years
 * is a different claim from one from ten and the payload should not flatten them.
 */
const NORMALS = require('./rain-normals.json');

/**
 * How many years a normal has to rest on before it is allowed to be one.
 *
 * Érsekcsanád came back with a single year of usable record. One year is not a normal,
 * it is that year, and comparing this August against one previous August would produce a
 * confident-looking ratio built on a coin toss. Below this bar the gauge still reports
 * its rainfall - the measurement is fine - it just gets no baseline to be judged against.
 */
const MIN_YEARS = 3;

/**
 * Below this, a monthly "normal" is a gauge that was not measuring, not a dry month.
 *
 * Répcevis averages 0.0 mm in January, 0.0 in February and 0.1 in December across ten
 * full years - and 96 mm in May. That is not the driest winter in Europe, it is an
 * unheated gauge: a standard tipping-bucket does not register snow, so the months when
 * precipitation falls as snow read as nothing. Nowhere in Hungary averages under about
 * 20 mm in any month, so anything in single digits is an instrument limitation.
 *
 * Those months get no normal, which means a window touching them gets no comparison
 * either. That is the right outcome: the alternative is telling somebody that the 30 mm
 * of snow-melt they are standing in is three hundred percent of normal.
 */
const MIN_PLAUSIBLE_MONTHLY_MM = 8;

/**
 * A caveat that belongs next to every number this produces.
 *
 * The archive reaches ten years, so these are averages of roughly 2016-2025 rather than
 * a 30-year climatological normal. That decade was itself dry in Hungary, so a deficit
 * measured against it is SMALLER than the same deficit measured against a 1991-2020
 * normal. The bias runs one way only, towards understating how unusual a dry spell is,
 * which is the right direction for a number that must never overstate a drought.
 */
const BASELINE_NOTE =
  'A "szokásos" érték az adott mérőállomás saját, körülbelül tízéves archívumából ' +
  'számolt átlag, nem harmincéves klimatológiai normál. Ez a tíz év Magyarországon ' +
  'száraz volt, így a hiány ehhez mérve inkább kisebbnek látszik a valóságosnál.';

/**
 * The gauges, chosen for coverage rather than completeness.
 *
 * Picked from the 262 that were reporting, one to a few per water directorate, spread to
 * put a gauge within reach of every major catchment that has any. Near-duplicates were
 * dropped: Kiskunfélegyháza appears twice in the catalogue under two networks 1.5 km
 * apart, and two dots that always agree only make the map look busier.
 */
const RAIN_GAUGES = Object.freeze([
  // --- Kisalföld, Fertő, Nyugat-Dunántúl -----------------------------------
  { id: 'fertorakos', tsz: '336', name: 'Fertőrákos', region: 'Fertő és Kisalföld', lat: 47.715, lon: 16.666 },
  { id: 'gyorsovenyhaz', tsz: '4347', name: 'Győrsövényház', region: 'Fertő és Kisalföld', lat: 47.706, lon: 17.362 },
  { id: 'csorna', tsz: '4348', name: 'Csorna', region: 'Fertő és Kisalföld', lat: 47.603, lon: 17.249 },
  { id: 'repcevis', tsz: '166054', name: 'Répcevis', region: 'Nyugat-Dunántúl', lat: 47.443, lon: 16.68 },

  // --- Alsó-Duna-völgy ------------------------------------------------------
  { id: 'ersekcsanad', tsz: '130288', name: 'Érsekcsanád', region: 'Alsó-Duna-völgy', lat: 46.252, lon: 18.919 },
  { id: 'kunbaja', tsz: '4484', name: 'Kunbaja', region: 'Alsó-Duna-völgy', lat: 46.091, lon: 19.417 },

  // --- Felső-Tisza-vidék ----------------------------------------------------
  { id: 'agerdomajor', tsz: '174142', name: 'Ágerdőmajor', region: 'Felső-Tisza-vidék', lat: 47.763, lon: 22.42 },
  { id: 'csaszarszallas', tsz: '174143', name: 'Császárszállás', region: 'Felső-Tisza-vidék', lat: 47.866, lon: 21.696 },
  { id: 'dombrad', tsz: '174145', name: 'Dombrád', region: 'Felső-Tisza-vidék', lat: 48.238, lon: 21.924 },
  { id: 'kantorjanosi', tsz: '174147', name: 'Kántorjánosi', region: 'Felső-Tisza-vidék', lat: 47.933, lon: 22.149 },
  { id: 'kocsord', tsz: '174148', name: 'Kocsord', region: 'Felső-Tisza-vidék', lat: 47.943, lon: 22.359 },
  { id: 'kotaj', tsz: '174149', name: 'Kótaj', region: 'Felső-Tisza-vidék', lat: 48.054, lon: 21.71 },

  // --- Bodrogköz és Zemplén -------------------------------------------------
  { id: 'felsoberecki', tsz: '4401', name: 'Felsőberecki', region: 'Bodrogköz és Zemplén', lat: 48.359, lon: 21.694 },
  { id: 'sarospatak', tsz: '192200', name: 'Sárospatak', region: 'Bodrogköz és Zemplén', lat: 48.32, lon: 21.58 },
  { id: 'cigand', tsz: '192202', name: 'Cigánd', region: 'Bodrogköz és Zemplén', lat: 48.26, lon: 21.885 },
  { id: 'toroker', tsz: '192203', name: 'Törökér', region: 'Bodrogköz és Zemplén', lat: 48.243, lon: 21.515 },
  { id: 'kenezlo', tsz: '192204', name: 'Kenézlő', region: 'Bodrogköz és Zemplén', lat: 48.189, lon: 21.562 },
  { id: 'revleanyvar', tsz: '192809', name: 'Révleányvár', region: 'Bodrogköz és Zemplén', lat: 48.317, lon: 22.045 },

  // --- Hortobágy és Hajdúság ------------------------------------------------
  { id: 'balmazujvaros', tsz: '4496', name: 'Balmazújváros', region: 'Hortobágy és Hajdúság', lat: 47.633, lon: 21.374 },
  { id: 'debrecen-bank', tsz: '4497', name: 'Debrecen-Bánk', region: 'Hortobágy és Hajdúság', lat: 47.477, lon: 21.723 },
  { id: 'apavara', tsz: '4498', name: 'Apavára', region: 'Hortobágy és Hajdúság', lat: 47.316, lon: 21.027 },
  { id: 'bakonszeg', tsz: '180037', name: 'Bakonszeg', region: 'Hortobágy és Hajdúság', lat: 47.188, lon: 21.456 },
  { id: 'nyirabrany', tsz: '3739', name: 'Nyírábrány', region: 'Hortobágy és Hajdúság', lat: 47.548, lon: 22.022 },
  { id: 'folyas', tsz: '180000', name: 'Folyás', region: 'Hortobágy és Hajdúság', lat: 47.803, lon: 21.138 },

  // --- Közép-Tisza-vidék ----------------------------------------------------
  { id: 'karcag', tsz: '201018', name: 'Karcag', region: 'Közép-Tisza-vidék', lat: 47.318, lon: 20.929 },
  { id: 'kunhegyes', tsz: '201020', name: 'Kunhegyes', region: 'Közép-Tisza-vidék', lat: 47.365, lon: 20.626 },
  { id: 'mezotur', tsz: '201036', name: 'Mezőtúr', region: 'Közép-Tisza-vidék', lat: 47.038, lon: 20.675 },
  { id: 'szolnok', tsz: '201042', name: 'Szolnok-Szandaszöllős', region: 'Közép-Tisza-vidék', lat: 47.13, lon: 20.227 },
  { id: 'koszkore', tsz: '201068', name: 'Kisköre', region: 'Közép-Tisza-vidék', lat: 47.497, lon: 20.515 },
  { id: 'kunszentmarton', tsz: '201073', name: 'Kunszentmárton', region: 'Közép-Tisza-vidék', lat: 46.846, lon: 20.265 },

  // --- Homokhátság és Alsó-Tisza -------------------------------------------
  { id: 'pusztamerges', tsz: '210031', name: 'Pusztamérges', region: 'Homokhátság', lat: 46.329, lon: 19.686 },
  { id: 'bordany', tsz: '210030', name: 'Bordány', region: 'Homokhátság', lat: 46.319, lon: 19.937 },
  { id: 'jaszszentlaszlo', tsz: '4445', name: 'Jászszentlászló', region: 'Homokhátság', lat: 46.573, lon: 19.749 },
  { id: 'kelebia', tsz: '4446', name: 'Kelebia', region: 'Homokhátság', lat: 46.224, lon: 19.604 },
  { id: 'kiskunfelegyhaza', tsz: '4447', name: 'Kiskunfélegyháza', region: 'Homokhátság', lat: 46.727, lon: 19.869 },
  { id: 'kiskunhalas', tsz: '6977', name: 'Kiskunhalas', region: 'Homokhátság', lat: 46.386, lon: 19.472 },
  { id: 'kisszallas', tsz: '6978', name: 'Kisszállás', region: 'Homokhátság', lat: 46.272, lon: 19.566 },
  { id: 'ruzsa', tsz: '6981', name: 'Ruzsa', region: 'Homokhátság', lat: 46.263, lon: 19.768 },
  { id: 'sandorfalva', tsz: '6974', name: 'Sándorfalva', region: 'Alsó-Tisza-vidék', lat: 46.402, lon: 20.103 },
  { id: 'mako', tsz: '4449', name: 'Makó', region: 'Alsó-Tisza-vidék', lat: 46.206, lon: 20.466 },
  { id: 'csanadpalota', tsz: '6971', name: 'Csanádpalota', region: 'Alsó-Tisza-vidék', lat: 46.232, lon: 20.723 },

  // --- Körös-vidék ----------------------------------------------------------
  { id: 'szarvas', tsz: '2882', name: 'Szarvas-Kákafok', region: 'Körös-vidék', lat: 46.823, lon: 20.531 },
  { id: 'gyoma', tsz: '4458', name: 'Gyoma', region: 'Körös-vidék', lat: 46.939, lon: 20.847 },
  { id: 'toviskes', tsz: '4459', name: 'Töviskes', region: 'Körös-vidék', lat: 47.09, lon: 21.09 },
  { id: 'korosszakal', tsz: '4460', name: 'Körösszakál', region: 'Körös-vidék', lat: 47.011, lon: 21.608 },
  { id: 'nemetzug', tsz: '4462', name: 'Németzug', region: 'Körös-vidék', lat: 46.953, lon: 20.826 },
  { id: 'szeghalom', tsz: '4465', name: 'Szeghalom', region: 'Körös-vidék', lat: 47.037, lon: 21.196 },
]);

/**
 * What the network does and does not see, carried in the payload.
 *
 * A reader looking at an empty Transdanubia should be told it is unmeasured rather than
 * dry. This is the one piece of context that cannot be derived from the readings.
 */
const COVERAGE = Object.freeze({
  network: 'OVF vmoType 14 (meteorológiai állomások), AdatFajtaKod 71',
  covered: ['Alföld', 'Felső-Tisza-vidék', 'Körös-vidék', 'Homokhátság', 'Kisalföld'],
  sparse: ['Dunántúl'],
  note:
    'A csapadékmérő hálózat nem országos. A Közép-Duna-völgyi és a Közép-dunántúli ' +
    'igazgatóság területén nincs közzétett meteorológiai állomás, a Dél-dunántúlin ' +
    'pedig egyik sem jelentett. A Dunántúlon tehát a térkép nem azt mutatja, hogy ' +
    'nem esett - hanem azt, hogy nem mérik itt.',
});

const BY_ID = new Map(RAIN_GAUGES.map((gauge) => [gauge.id, gauge]));
const BY_TSZ = new Map(RAIN_GAUGES.map((gauge) => [String(gauge.tsz), gauge]));

function listRainGauges() {
  return RAIN_GAUGES;
}

function getRainGauge(id) {
  return BY_ID.get(id) || null;
}

function getRainGaugeByTsz(tsz) {
  return BY_TSZ.get(String(tsz)) || null;
}

/** The normal for one gauge in one calendar month (1-12), or null if it has none. */
function monthlyNormal(gaugeId, month) {
  const entry = NORMALS[gaugeId];
  if (!entry || !Array.isArray(entry.mm)) return null;
  if (!Number.isFinite(entry.years) || entry.years < MIN_YEARS) return null;
  const value = entry.mm[month - 1];
  if (!Number.isFinite(value) || value < MIN_PLAUSIBLE_MONTHLY_MM) return null;
  return value;
}

/**
 * The normal rainfall over an arbitrary window, blended from the calendar months it spans.
 *
 * A trailing 30-day window almost never lines up with a calendar month, and comparing
 * "the last 30 days" against "the normal for August" would be wrong by however much
 * July and August differ. So each day in the window contributes its own month's daily
 * rate, which is the same arithmetic a climatologist does by hand and needs no data
 * beyond the twelve monthly figures already held.
 */
const DAYS_IN_MONTH = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function normalForWindow(gaugeId, from, to) {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;

  let total = 0;
  let daysCounted = 0;

  // Walk the window a day at a time. A month is at most 31 steps and a window is weeks,
  // so this is a few dozen iterations - cheaper than the date arithmetic to avoid it.
  for (let day = new Date(start); day < end; day.setUTCDate(day.getUTCDate() + 1)) {
    const month = day.getUTCMonth();
    const monthly = monthlyNormal(gaugeId, month + 1);
    if (monthly === null) return null;
    total += monthly / DAYS_IN_MONTH[month];
    daysCounted += 1;
  }

  if (daysCounted === 0) return null;
  return Math.round(total * 10) / 10;
}

/** How many years of archive the normal for this gauge rests on. */
function normalYears(gaugeId) {
  const entry = NORMALS[gaugeId];
  return entry && Number.isFinite(entry.years) ? entry.years : 0;
}

module.exports = {
  RAIN_GAUGES,
  COVERAGE,
  NORMALS,
  MIN_YEARS,
  MIN_PLAUSIBLE_MONTHLY_MM,
  BASELINE_NOTE,
  listRainGauges,
  getRainGauge,
  getRainGaugeByTsz,
  monthlyNormal,
  normalForWindow,
  normalYears,
};
