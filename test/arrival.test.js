'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildArrivals, dailyChange, PAIRS, CELERITY_KMH } = require('../src/domain/arrival');
const { getStation } = require('../src/config/stations');

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-08-10T12:00:00Z');

/** Hourly series ending at NOW. */
function series(values) {
  return values.map((flowM3s, i) => ({
    timestamp: new Date(NOW - (values.length - 1 - i) * HOUR).toISOString(),
    flowM3s,
  }));
}

// ---------------------------------------------------------------------------
// The pairs themselves
// ---------------------------------------------------------------------------

test('every pair names two real stations on the same river, upstream first', () => {
  for (const pair of PAIRS) {
    const from = getStation(pair.from);
    const to = getStation(pair.to);
    assert.ok(from, `${pair.from} is not a station`);
    assert.ok(to, `${pair.to} is not a station`);
    assert.strictEqual(from.river, to.river, `${pair.from} and ${pair.to} are on different rivers`);

    // River kilometres count DOWN towards the mouth, so the upstream gauge has the
    // larger figure. Getting this backwards would announce that Mohács is about to
    // reach Budapest.
    if (Number.isFinite(from.riverKm) && Number.isFinite(to.riverKm)) {
      assert.ok(
        from.riverKm > to.riverKm,
        `${pair.from} (${from.riverKm} fkm) must be upstream of ${pair.to} (${to.riverKm} fkm)`,
      );
    }
  }
});

test('travel times are ranges, ordered, and match the distance they came from', () => {
  for (const pair of PAIRS) {
    const [min, max] = pair.hours;
    assert.ok(min > 0 && max > min, `${pair.from}->${pair.to} has a bad range`);
    assert.ok(max <= 7 * 24, `${pair.from}->${pair.to} claims over a week`);

    const from = getStation(pair.from);
    assert.strictEqual(pair.km, from.riverKm - getStation(pair.to).riverKm);

    // The hours are derived from the distance and the river's celerity band, so the
    // implied speed must land back inside that band. This is what stops a hand-edited
    // figure from quietly disagreeing with the geometry: rounding is the only slack.
    const [slow, fast] = CELERITY_KMH[from.river];
    assert.ok(
      pair.km / max >= slow * 0.9 && pair.km / min <= fast * 1.1,
      `${pair.from}->${pair.to}: ${pair.km} km in ${min}-${max} h implies ` +
        `${(pair.km / max).toFixed(1)}-${(pair.km / min).toFixed(1)} km/h, band is ${slow}-${fast}`,
    );
  }
});

test('no pair spans a major confluence', () => {
  // 410 km from Tiszabecs to Szolnok takes in the Szamos, the Bodrog, the Sajó and the
  // Hernád. That is not the same water arriving later, and a travel time across it
  // would be a fiction dressed as arithmetic.
  for (const pair of PAIRS) {
    assert.ok(pair.km < 200, `${pair.from}->${pair.to} spans ${pair.km} km`);
  }
});

// ---------------------------------------------------------------------------
// Measuring the change that is travelling
// ---------------------------------------------------------------------------

test('a daily change is measured against a day ago, not the oldest row held', () => {
  const flat = new Array(25).fill(2000);
  flat[flat.length - 1] = 2600;

  const change = dailyChange(series(flat));
  assert.ok(change);
  assert.strictEqual(change.fromValue, 2000);
  assert.strictEqual(change.toValue, 2600);
  assert.strictEqual(change.changePct, 30);
  assert.strictEqual(change.overHours, 24);
});

test('six hours of history cannot produce a daily change', () => {
  assert.strictEqual(dailyChange(series([2000, 2100, 2200, 2300, 2400, 2600])), null);
});

test('a gap around the 24-hour mark is not silently filled with a nearer sample', () => {
  // Samples at -48h and now: the nearest to "a day ago" is 24 hours away from it, which
  // makes any change computed from it a two-day change wearing a daily label.
  const gapped = [
    { timestamp: new Date(NOW - 48 * HOUR).toISOString(), flowM3s: 2000 },
    { timestamp: new Date(NOW).toISOString(), flowM3s: 2600 },
  ];
  assert.strictEqual(dailyChange(gapped), null);
});

// ---------------------------------------------------------------------------
// What is on its way
// ---------------------------------------------------------------------------

test('a rise upstream is reported as arriving downstream, with the clock started at the reading', () => {
  const rising = new Array(25).fill(2000);
  rising[rising.length - 1] = 2600;

  const built = buildArrivals({ historyByStation: { 'duna-komarom': series(rising) }, now: NOW });
  const nagymaros = built.arrivals.find((a) => a.downstream.id === 'duna-nagymaros');

  assert.ok(nagymaros);
  assert.strictEqual(nagymaros.direction, 'rising');
  assert.strictEqual(nagymaros.notable, true);
  assert.match(nagymaros.text, /Komárom/);
  assert.match(nagymaros.text, /emelkedő/);

  // The window runs from the moment the upstream reading was taken, not from now: water
  // measured three hours ago has already been travelling for three hours.
  const pair = PAIRS.find((p) => p.from === 'duna-komarom' && p.to === 'duna-nagymaros');
  const measured = Date.parse(nagymaros.change.measuredAt);
  assert.strictEqual(Date.parse(nagymaros.arrivesFrom), measured + pair.hours[0] * HOUR);
  assert.strictEqual(Date.parse(nagymaros.arrivesUntil), measured + pair.hours[1] * HOUR);
});

test('a fall is reported as a fall rather than dressed up as a rise', () => {
  const falling = new Array(25).fill(2000);
  falling[falling.length - 1] = 1500;

  const built = buildArrivals({ historyByStation: { 'duna-komarom': series(falling) }, now: NOW });
  const arrival = built.arrivals.find((a) => a.downstream.id === 'duna-nagymaros');

  assert.strictEqual(arrival.direction, 'falling');
  assert.match(arrival.text, /apadó/);
  assert.ok(arrival.change.pct < 0);
});

test('a wobble is carried but marked as nothing to expect', () => {
  const steady = new Array(25).fill(2000);
  steady[steady.length - 1] = 2050; // 2.5%

  const built = buildArrivals({ historyByStation: { 'duna-komarom': series(steady) }, now: NOW });
  const arrival = built.arrivals.find((a) => a.downstream.id === 'duna-nagymaros');

  assert.strictEqual(arrival.notable, false);
  assert.match(arrival.text, /nem érkezik érdemi változás/);
  assert.strictEqual(built.notable, 0);
});

test('a pair with no upstream history produces nothing rather than a guess', () => {
  const built = buildArrivals({ historyByStation: {}, now: NOW });
  assert.strictEqual(built.count, 0);
  assert.deepStrictEqual(built.arrivals, []);
});

test('the biggest change is first, because that is what "what is coming" means', () => {
  const small = new Array(25).fill(1000);
  small[small.length - 1] = 1100;
  const big = new Array(25).fill(500);
  big[big.length - 1] = 900;

  const built = buildArrivals({
    historyByStation: { 'duna-komarom': series(small), 'tisza-szolnok': series(big) },
    now: NOW,
  });

  assert.ok(Math.abs(built.arrivals[0].change.pct) >= Math.abs(built.arrivals[1].change.pct));
});

test('the payload refuses to be read as an official forecast', () => {
  // The service catalogues a forecast series and returns HTTP 500 for it at every
  // station. This is a travel time between two gauges, and the moment it reads as a
  // prediction of rain it becomes the most misleading thing on the site.
  const values = new Array(25).fill(2000);
  values[values.length - 1] = 2600;
  const built = buildArrivals({ historyByStation: { 'duna-komarom': series(values) }, now: NOW });

  assert.match(built.disclaimer, /nem hivatalos előrejelzés/);
  assert.match(built.disclaimer, /hidroinfo/);
  assert.ok(built.method.length > 0);
  for (const arrival of built.arrivals) {
    assert.doesNotMatch(arrival.text, /előrejelzés|várható eső|esni fog/);
  }
});

test('an arrival whose window has passed says so instead of promising the past', () => {
  const values = new Array(25).fill(2000);
  values[values.length - 1] = 2600;
  const history = series(values);

  const pair = PAIRS.find((p) => p.from === 'duna-komarom');
  const wellAfter = NOW + (pair.hours[1] + 6) * HOUR;

  const built = buildArrivals({ historyByStation: { 'duna-komarom': history }, now: wellAfter });
  const arrival = built.arrivals.find((a) => a.downstream.id === pair.to);
  assert.strictEqual(arrival.alreadyArrived, true);
  assert.strictEqual(built.notable, 0, 'water that has already passed is not still coming');
});
