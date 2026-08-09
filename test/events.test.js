'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildEvents, regionSummary, stepChange, lowRun, gradeCrossing, nuclearStep } = require('../src/domain/events');
const { getStation } = require('../src/config/stations');
const { NOTES, activeNotes, validateNotes } = require('../src/config/notes');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-08-09T12:00:00Z');

/** An ascending series ending at NOW, one sample an hour. */
function series(values, { key = 'flowM3s', step = HOUR } = {}) {
  return values.map((v, i) => ({
    timestamp: new Date(NOW - (values.length - 1 - i) * step).toISOString(),
    [key]: v,
  }));
}

test('a day-on-day step is measured against a day ago, not against the oldest row held', () => {
  // The trap: an instance holding six hours of history reporting a six-hour change as a
  // daily one. Twenty-five hourly samples, flat for a day and then a jump.
  const komarom = getStation('duna-komarom');
  const flat = new Array(25).fill(2000);
  flat[flat.length - 1] = 2600;

  const event = stepChange(komarom, series(flat), NOW);
  assert.ok(event);
  assert.strictEqual(event.kind, 'rise');
  assert.strictEqual(event.evidence.fromM3s, 2000);
  assert.strictEqual(event.evidence.toM3s, 2600);
  assert.strictEqual(event.evidence.changePct, 30);
});

test('a short series cannot produce a daily change at all', () => {
  const komarom = getStation('duna-komarom');
  // Six hours of history: there is no reading near 24 hours ago to compare against.
  assert.strictEqual(stepChange(komarom, series([2000, 2100, 2200, 2300, 2400, 2600]), NOW), null);
});

test('a small wobble is not news', () => {
  const komarom = getStation('duna-komarom');
  const values = new Array(25).fill(2000);
  values[values.length - 1] = 2100; // 5%
  assert.strictEqual(stepChange(komarom, series(values), NOW), null);
});

test('a low run counts only unbroken days', () => {
  const komarom = getStation('duna-komarom'); // mean 2050, threshold 1230
  // Four days low, but a recovery three days ago breaks the run: only three days count.
  const values = [];
  for (let i = 0; i < 96; i += 1) values.push(i === 20 ? 1900 : 1000);

  const event = lowRun(komarom, series(values), NOW);
  assert.ok(event, 'a run should be reported');
  assert.strictEqual(event.evidence.days, 3);
  assert.ok(event.title.includes('3 napja'));
  assert.strictEqual(event.evidence.lowestM3s, 1000);
});

test('a run shorter than two days is not reported', () => {
  const komarom = getStation('duna-komarom');
  assert.strictEqual(lowRun(komarom, series(new Array(24).fill(1000)), NOW), null);
});

test('a station above its threshold produces no run', () => {
  const komarom = getStation('duna-komarom');
  assert.strictEqual(lowRun(komarom, series(new Array(96).fill(1800)), NOW), null);
});

test('crossing a flood grade is reported with the levels that crossed it', () => {
  // Budapest: grade I at 620 cm.
  const event = gradeCrossing(getStation('duna-budapest'), series([610, 640], { key: 'waterLevelCm' }));
  assert.ok(event);
  assert.strictEqual(event.severity, 3);
  assert.strictEqual(event.evidence.grade, 1);
  assert.match(event.title, /I\. fokú/);

  // ...and so is falling back out of one.
  const back = gradeCrossing(getStation('duna-budapest'), series([640, 610], { key: 'waterLevelCm' }));
  assert.ok(back);
  assert.match(back.title, /megszűnt/);
});

test('staying inside the same grade is not an event', () => {
  assert.strictEqual(gradeCrossing(getStation('duna-budapest'), series([640, 660], { key: 'waterLevelCm' })), null);
});

test('a nuclear step is attributed to Paks but never to a block', () => {
  const gen = [
    { timestamp: new Date(NOW - HOUR).toISOString(), generationMw: { nuclear: 1900 } },
    { timestamp: new Date(NOW).toISOString(), generationMw: { nuclear: 1430 } },
  ];
  const event = nuclearStep(gen);
  assert.ok(event);
  assert.strictEqual(event.plantId, 'paks');
  assert.strictEqual(event.evidence.approxUnits, 1);
  // The published mix is national. Which reactor it was is not in this data, and the
  // text must not pretend otherwise.
  assert.ok(!/\b[1-4]\.\s*blokk\b/.test(event.title + event.detail), 'must not name a reactor');
  assert.match(event.detail, /nem derül ki/);
});

test('load-following is not a reactor trip', () => {
  const gen = [
    { timestamp: new Date(NOW - HOUR).toISOString(), generationMw: { nuclear: 1900 } },
    { timestamp: new Date(NOW).toISOString(), generationMw: { nuclear: 1750 } },
  ];
  assert.strictEqual(nuclearStep(gen), null);
});

test('the region summary explains a shortage only by where the water enters', () => {
  const readings = {};
  // Everything from the west at half its mean, everything from the east at its mean.
  for (const station of require('../src/config/stations').listStations('inflow')) {
    const west = /AT/.test(station.country || '');
    readings[station.id] = { flowM3s: station.meanFlow * (west ? 0.5 : 1) };
  }

  const regions = regionSummary(readings);
  assert.ok(regions.length >= 3);
  // Sorted driest first, so the answer to "where is the water short" is the top row.
  assert.ok(regions[0].ratioToMean < 0.6);
  for (const region of regions) {
    assert.ok(region.longTermMeanM3s > 0);
    assert.ok(region.stationCount > 0);
  }
});

test('one flow story per station: a run swallows the wobble inside it', () => {
  const values = new Array(96).fill(1000);
  values[values.length - 1] = 700; // a 30% fall, inside a four-day low run
  const built = buildEvents({ historyByStation: { 'duna-komarom': series(values) }, now: NOW });

  const komaromEvents = built.events.filter((e) => e.stationId === 'duna-komarom');
  assert.strictEqual(komaromEvents.length, 1);
  assert.strictEqual(komaromEvents[0].kind, 'low-run');
});

test('no history means no events, and says so rather than showing an empty page', () => {
  const built = buildEvents({ readings: {}, now: NOW });
  assert.strictEqual(built.count, 0);
  assert.ok(built.note.length > 0);
  assert.ok(Array.isArray(built.regions));
});

test('every event carries the numbers it was derived from', () => {
  const built = buildEvents({
    historyByStation: { 'duna-komarom': series(new Array(96).fill(900)) },
    now: NOW,
  });
  assert.ok(built.events.length > 0);
  for (const event of built.events) {
    assert.ok(event.evidence && Object.keys(event.evidence).length > 0, `${event.kind} has no evidence`);
    assert.ok(event.at && !Number.isNaN(Date.parse(event.at)));
    assert.ok(event.title && event.detail);
  }
});

test('editorial notes must carry a source and a date', () => {
  // The rule matters most when someone is in a hurry, so it is enforced rather than
  // documented. Empty today; this guards whatever is added later.
  assert.deepStrictEqual(validateNotes(), []);

  assert.deepStrictEqual(
    validateNotes([{ id: 'x', from: '2026-08-01', title: 'Valami történt' }]),
    ['x: no source link'],
  );
  assert.deepStrictEqual(
    validateNotes([{ id: 'y', title: 'Nincs dátum', source: { url: 'https://example.hu' } }]),
    ["y: 'from' is missing or unparseable"],
  );
});

test('a note outside its window is not current', () => {
  const notes = [
    { id: 'past', from: '2026-01-01', until: '2026-02-01', title: 'Régi', source: { url: 'https://e.hu' } },
    { id: 'now', from: '2026-08-01', title: 'Mostani', source: { url: 'https://e.hu' } },
  ];
  const saved = NOTES.splice(0, NOTES.length, ...notes);
  try {
    const active = activeNotes(NOW).map((n) => n.id);
    assert.deepStrictEqual(active, ['now']);
  } finally {
    NOTES.splice(0, NOTES.length, ...saved);
  }
});

test('the neighbouring country is named by which way the water crosses', () => {
  const values = new Array(25).fill(2000);
  values[values.length - 1] = 1400;

  // An inflow section: the water arrives from there.
  const komarom = stepChange(getStation('duna-komarom'), series(values), NOW);
  assert.match(komarom.detail, /Szlovákia felől érkezik/);

  // An outflow section tagged RS is where the water LEAVES. Reading `country` as
  // "upstream" for every role reported that the Tisza at Szeged arrives from Serbia.
  const szeged = stepChange(getStation('tisza-szeged'), series(values.map((v) => v / 4)), NOW);
  assert.doesNotMatch(szeged.detail, /Szerbia felől érkezik/);
  assert.match(szeged.detail, /hagyja el az országot, Szerbia felé/);

  // An interior gauge has no neighbour to name.
  const szolnok = stepChange(getStation('tisza-szolnok'), series(values.map((v) => v / 4)), NOW);
  assert.doesNotMatch(szolnok.detail, /felől|felé/);
});
