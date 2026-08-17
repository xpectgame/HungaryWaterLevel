'use strict';

/**
 * What a household actually spends water on, in units a person can count.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A PIE CHART OF NATIONAL AVERAGES
 * ---------------------------------------------------------------------------
 * The obvious way to answer "what does a person use water for" is the familiar wedge
 * diagram: 30% shower, 25% toilet, and so on. This project will not publish that, for the
 * same reason it will not publish a forecast: nobody measures it in Hungary. Those
 * percentages come from foreign household studies, they are copied between articles
 * without their source, and presented as a national figure they are an invented
 * measurement.
 *
 * What IS solid is the per-unit physics. A shower head passes six to fifteen litres a
 * minute; a cistern holds six; a washing machine takes forty-five. Those are engineering
 * facts with narrow, checkable ranges, and every one of them is published on the appliance
 * itself. So the model here is per-unit rates, and the QUANTITIES come from the reader:
 * how long they shower, how many loads they wash. The result is their household's water
 * use rather than an average nobody's household matches - and the assumption is visible,
 * because they are the one who set it.
 *
 * ---------------------------------------------------------------------------
 * EVERY RATE CARRIES ITS RANGE
 * ---------------------------------------------------------------------------
 * `range` is not decoration. A shower is the largest single item in most households, and
 * whether it is 6 or 15 litres a minute changes the answer by a factor of two - which is
 * the difference between an old head and a modern one, not measurement noise. The page
 * shows the range and lets it be set, so a reader who knows their own fittings gets their
 * own number and one who does not can see how much the answer depends on it.
 */

/**
 * The things that dominate household use, in the units people count them in.
 *
 * Deliberately short. Ten items with plausible defaults produce a precise-looking total
 * that is mostly made of guesses about the small ones; five items the reader actually
 * knows produce a rougher total they can stand behind.
 */
const USES = Object.freeze([
  {
    id: 'shower',
    hu: 'Zuhanyzás',
    unit: 'perc',
    unitHu: 'perc naponta, összesen a háztartásban',
    litresPerUnit: 9,
    range: [6, 15],
    rangeNote: 'Régi zuhanyfej 12–15 l/perc, átlagos 9, víztakarékos 6.',
    defaultQuantity: 12,
  },
  {
    id: 'toilet',
    hu: 'WC-öblítés',
    unit: 'öblítés',
    unitHu: 'öblítés naponta, összesen a háztartásban',
    litresPerUnit: 6,
    range: [3, 9],
    rangeNote: 'Régi tartály 9 l, mai 6 l, kétgombos kis öblítés 3 l.',
    defaultQuantity: 10,
  },
  {
    id: 'tap',
    hu: 'Csapvíz (mosogatás, kézmosás, fogmosás, főzés)',
    unit: 'perc',
    unitHu: 'perc folyó víz naponta, összesen',
    litresPerUnit: 7,
    range: [5, 10],
    rangeNote: 'Egy nyitott konyhai csap 5–10 l/perc. Perlátorral a kisebb érték.',
    defaultQuantity: 10,
  },
  {
    id: 'washing',
    hu: 'Mosógép',
    unit: 'mosás',
    unitHu: 'mosás hetente',
    litresPerUnit: 50,
    range: [40, 70],
    rangeNote: 'Mai A-osztályú gép 40–50 l, tíz évnél régebbi 60–70 l mosásonként.',
    defaultQuantity: 4,
    perWeek: true,
  },
  {
    id: 'garden',
    hu: 'Kert, autómosás',
    unit: 'perc',
    unitHu: 'perc locsolás naponta (nyáron)',
    litresPerUnit: 14,
    range: [10, 18],
    rangeNote: 'Egy kerti tömlő 10–18 l/perc. Ez a tétel nyáron sokszor mindent visz.',
    defaultQuantity: 0,
  },
]);

/**
 * Changes worth making, each expressed as a change to the model above.
 *
 * No litre figures are written here. Every saving is computed from the reader's own
 * numbers, because "spórolj 30 litert" is meaningless to someone who does not shower and
 * enormous to someone who showers twice a day - and a fixed figure would be the same
 * invented average this file exists to avoid.
 *
 * `apply` is a description, not code: the page reads `use` and the new value and does the
 * arithmetic, so the whole model stays in one place and is testable here.
 */
const SAVINGS = Object.freeze([
  {
    id: 'shorter-shower',
    hu: 'Három perccel rövidebb zuhany',
    use: 'shower',
    quantityDelta: -3,
    note: 'A legnagyobb egyetlen tétel a legtöbb háztartásban. Nem kell hideg vízzel mosakodni hozzá.',
  },
  {
    id: 'saving-head',
    hu: 'Víztakarékos zuhanyfej',
    use: 'shower',
    rateTo: 6,
    note: 'Néhány ezer forint, öt perc felszerelni. A vízsugár erősebbnek érződik, mert levegőt kever bele.',
  },
  {
    id: 'dual-flush',
    hu: 'Kétgombos öblítés, kis gombbal',
    use: 'toilet',
    rateTo: 4,
    note: 'Ha már van kétgombos tartály, ez ingyen van: a kis gomb fele annyi.',
  },
  {
    id: 'tap-off',
    hu: 'Elzárt csap fogmosás és beszappanozás közben',
    use: 'tap',
    quantityDelta: -4,
    note: 'Négy perc folyó víz naponta — ennyivel kevesebb, ha a csap nem megy közben.',
  },
  {
    id: 'full-loads',
    hu: 'Csak tele mosógéppel',
    use: 'washing',
    quantityDelta: -1,
    note: 'A gép ugyanannyi vizet használ félig telve is. Heti eggyel kevesebb mosás ennyit hoz.',
  },
  {
    id: 'rain-barrel',
    hu: 'Esővízgyűjtő a locsoláshoz',
    use: 'garden',
    quantityTo: 0,
    note: 'A kert nem igényel ivóvíz-minőségű vizet. Egy 200 literes hordó egy nyári zápor alatt megtelik.',
  },
]);

module.exports = { USES, SAVINGS };
