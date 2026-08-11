'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildAlerts, identify, recordLow } = require('../src/domain/alerts');
const { toAtom } = require('../src/routes/alerts');
const { getStation } = require('../src/config/stations');

const AUGUST_DOC = {
  'tisza-szeged': {
    months: (() => {
      const m = Array.from({ length: 12 }, () => null);
      m[7] = {
        p: [110, 125, 160, 200, 260, 380, 520],
        min: { value: 115, year: 2025, day: '2025-08-16' },
        max: { value: 900, year: 2019, day: '2019-08-03' },
        days: 310,
        years: 10,
      };
      return m;
    })(),
    unit: 'm3s',
  },
};

// ---------------------------------------------------------------------------
// Stable identity - the whole reason this module exists
// ---------------------------------------------------------------------------

test('a low run keeps one id for as long as it is the same run', () => {
  // The poller runs every fifteen minutes. If the id moved with the clock, a river that
  // has been low for nine days would produce 96 notifications a day about one unchanging
  // fact, and every subscriber would leave. The run's START pins the identity.
  const started = Date.parse('2026-08-01T06:00:00Z');
  const onDayThree = { kind: 'low-run', stationId: 'tisza-szeged', at: '2026-08-04T09:00:00Z', evidence: { sinceMs: started, days: 3 } };
  const onDayNine = { kind: 'low-run', stationId: 'tisza-szeged', at: '2026-08-10T21:00:00Z', evidence: { sinceMs: started, days: 9 } };

  assert.strictEqual(identify(onDayThree), identify(onDayNine));
});

test('a new run after a recovery is a new alert', () => {
  const first = { kind: 'low-run', stationId: 'tisza-szeged', at: '2026-08-04T09:00:00Z', evidence: { sinceMs: Date.parse('2026-08-01T06:00:00Z') } };
  const second = { kind: 'low-run', stationId: 'tisza-szeged', at: '2026-08-20T09:00:00Z', evidence: { sinceMs: Date.parse('2026-08-17T06:00:00Z') } };

  assert.notStrictEqual(identify(first), identify(second));
});

test('being below the record all month is one alert, not one per poll', () => {
  // The condition persists for days. Keyed on the month, it stays one entry; keyed on
  // the reading's timestamp it would be a fresh notification every fifteen minutes for
  // as long as the drought lasted - which is precisely when a reader least wants noise.
  const a = recordLow(getStation('tisza-szeged'), { flowM3s: 100, timestamp: '2026-08-03T04:00:00Z' }, Date.now(), AUGUST_DOC);
  const b = recordLow(getStation('tisza-szeged'), { flowM3s: 98, timestamp: '2026-08-04T19:00:00Z' }, Date.now(), AUGUST_DOC);
  assert.ok(a && b, 'both readings are below the fixture record');
  assert.strictEqual(a.id, b.id);
  assert.strictEqual(a.id, 'record-low:tisza-szeged:2026-08');
});

test('the next month is a new alert', () => {
  const august = recordLow(getStation('tisza-szeged'), { flowM3s: 100, timestamp: '2026-08-30T04:00:00Z' }, Date.now(), AUGUST_DOC);
  const september = recordLow(getStation('tisza-szeged'), { flowM3s: 100, timestamp: '2026-09-01T04:00:00Z' }, Date.now(), AUGUST_DOC);
  // September has no record in the fixture, so there is nothing to be below - which is
  // itself the right answer, and the reason the ids could never collide.
  assert.ok(august);
  assert.strictEqual(september, null);
});

test('a flood grade crossed and uncrossed are two entries', () => {
  const up = { kind: 'flood-grade', stationId: 'duna-budapest', at: '2026-03-04T08:00:00Z', evidence: { grade: 2 } };
  const down = { kind: 'flood-grade', stationId: 'duna-budapest', at: '2026-03-09T08:00:00Z', evidence: { grade: 1 } };
  assert.notStrictEqual(identify(up), identify(down));
});

test('an unknown kind falls back to the hour, not to the millisecond', () => {
  // A new event kind must not spam anyone before someone gives it a rule. Bounded at
  // once an hour is wrong but survivable; keyed on `now` is not.
  const a = identify({ kind: 'brand-new', stationId: 'x', at: '2026-08-10T21:04:00Z' });
  const b = identify({ kind: 'brand-new', stationId: 'x', at: '2026-08-10T21:59:00Z' });
  const c = identify({ kind: 'brand-new', stationId: 'x', at: '2026-08-10T22:01:00Z' });
  assert.strictEqual(a, b);
  assert.notStrictEqual(b, c);
});

// ---------------------------------------------------------------------------
// What gets raised
// ---------------------------------------------------------------------------

test('notices are below the notification threshold by default', () => {
  const built = {
    events: [
      { kind: 'step-change', stationId: 'tisza-szeged', at: '2026-08-10T12:00:00Z', severity: 1, title: 'apró változás', detail: '' },
      { kind: 'low-run', stationId: 'duna-mohacs', at: '2026-08-10T12:00:00Z', severity: 2, title: 'kisvíz', detail: '', evidence: { sinceMs: 1 } },
    ],
  };
  assert.strictEqual(buildAlerts(built, {}).count, 1, 'severity 1 must not reach a subscriber by default');
  assert.strictEqual(buildAlerts(built, {}, { minSeverity: 1 }).count, 2, 'but must be available on request');
});

test('the same fact from two code paths is emitted once', () => {
  const one = { kind: 'low-run', stationId: 'tisza-szeged', at: '2026-08-10T12:00:00Z', severity: 2, title: 'a', detail: '', evidence: { sinceMs: 5 } };
  const doc = buildAlerts({ events: [one, { ...one }] }, {});
  assert.strictEqual(doc.count, 1);
});

test('alerts are ranked by severity, then by recency', () => {
  const built = {
    events: [
      { kind: 'low-run', stationId: 'a', at: '2026-08-10T20:00:00Z', severity: 2, title: 'régi kisvíz', detail: '', evidence: { sinceMs: 1 } },
      { kind: 'flood-grade', stationId: 'b', at: '2026-08-09T20:00:00Z', severity: 3, title: 'árvíz', detail: '', evidence: { grade: 2 } },
    ],
  };
  const doc = buildAlerts(built, {});
  assert.strictEqual(doc.alerts[0].kind, 'flood-grade', 'an older emergency outranks a newer warning');
  assert.strictEqual(doc.alerts[0].level, 'emergency');
  assert.strictEqual(doc.alerts[1].level, 'warning');
});

test('every alert carries the numbers it was derived from', () => {
  // The rule the whole project runs on: no claim without its evidence.
  const built = {
    events: [{
      kind: 'low-run', stationId: 'tisza-szeged', at: '2026-08-10T12:00:00Z', severity: 2,
      title: 'x', detail: 'y', evidence: { sinceMs: 1, days: 9, currentM3s: 130, meanM3s: 815 },
    }],
  };
  const a = buildAlerts(built, {}).alerts[0];
  assert.strictEqual(a.evidence.days, 9);
  assert.strictEqual(a.evidence.currentM3s, 130);
  assert.ok(a.at, 'when it happened');
  assert.ok(a.updated, 'when it was last confirmed');
});

// ---------------------------------------------------------------------------
// Atom
// ---------------------------------------------------------------------------

test('the feed escapes XML, or one ampersand loses the whole document', () => {
  // A feed reader that hits a parse error shows nothing at all - not one broken entry,
  // the entire feed. Station names carry en dashes and accents, and a title with an
  // ampersand in it is one editorial note away.
  const xml = toAtom({
    generatedAt: '2026-08-10T00:00:00Z',
    alerts: [{
      id: 'x:1', kind: 'test', level: 'warning', stationId: 'a&b',
      at: '2026-08-10T00:00:00Z', updated: '2026-08-10T00:00:00Z',
      title: 'Tisza & Duna <össze> "idézet"', detail: "O'Brien & co > 5",
    }],
  });

  assert.ok(!/&(?!(amp|lt|gt|quot|apos);)/.test(xml), 'a bare ampersand survived into the output');
  assert.match(xml, /Tisza &amp; Duna &lt;össze&gt;/);
  assert.match(xml, /szelveny=a%26b/, 'the link target must be URL-encoded as well as XML-escaped');
});

test('an empty feed is still a valid feed', () => {
  // Nothing wrong is the normal state. A reader must get a well-formed document with no
  // entries, not an error and not an empty body.
  const xml = toAtom({ generatedAt: '2026-08-10T00:00:00Z', alerts: [] });
  assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>/);
  assert.match(xml, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/);
  assert.match(xml, /<\/feed>/);
  assert.doesNotMatch(xml, /<entry>/);
});

test('every entry carries a stable tag: id distinct from its link', () => {
  // Atom over RSS 2.0 for exactly this: the id is what a reader deduplicates on, and it
  // must not be a URL, because an alert has no page of its own and an id that looks like
  // a link invites a reader to follow it to a 404.
  const xml = toAtom({
    generatedAt: '2026-08-10T00:00:00Z',
    alerts: [{
      id: 'record-low:tisza-szeged:2026-08', kind: 'record-low', level: 'emergency',
      stationId: 'tisza-szeged', at: '2026-08-10T00:00:00Z', updated: '2026-08-10T06:00:00Z',
      title: 't', detail: 'd',
    }],
  });
  assert.match(xml, /<id>tag:hovafolyik\.hu,2026:alert\/record-low:tisza-szeged:2026-08<\/id>/);
  assert.match(xml, /<published>2026-08-10T00:00:00Z<\/published>/);
  assert.match(xml, /<updated>2026-08-10T06:00:00Z<\/updated>/, 'published and updated must differ');
});

// ---------------------------------------------------------------------------
// The record-low trigger
// ---------------------------------------------------------------------------

test('a record low is raised at emergency level with its previous record', () => {
  const station = getStation('tisza-szeged');
  const alert = recordLowWith(station, 100, '2026-08-10T12:00:00Z');
  assert.ok(alert, 'below the record must raise');
  assert.strictEqual(alert.severity, 3);
  assert.strictEqual(alert.evidence.previousRecordM3s, 115);
  assert.strictEqual(alert.evidence.previousRecordDay, '2025-08-16');
  assert.match(alert.title, /augusztusi/);
  assert.match(alert.title, /10 évben/);
});

test('a reading inside the record raises nothing', () => {
  assert.strictEqual(recordLowWith(getStation('tisza-szeged'), 130, '2026-08-10T12:00:00Z'), null);
  assert.strictEqual(recordLowWith(getStation('tisza-szeged'), 115, '2026-08-10T12:00:00Z'), null,
    'equalling the record is not breaking it');
});

test('a thin record cannot raise a record-low alert', () => {
  // "Lower than any August day in 3 years" is a claim about a record that barely exists.
  // The rank still reports the reading as below what it has - the refusal to ANNOUNCE it
  // is the alert layer's own rule, and this is the test that it has one.
  const thin = JSON.parse(JSON.stringify(AUGUST_DOC));
  thin['tisza-szeged'].months[7].years = 3;

  const { rankFlow } = require('../src/domain/flow-history');
  const rank = rankFlow('tisza-szeged', 100, { at: Date.UTC(2026, 7, 10), document: thin });
  assert.strictEqual(rank.years, 3);
  assert.ok(rank.belowRecord, 'the rank still says it is below');

  assert.strictEqual(recordLowWith(getStation('tisza-szeged'), 100, '2026-08-10T12:00:00Z', thin), null);
});

test('buildAlerts raises record lows from the readings it is given', () => {
  const doc = buildAlerts(
    { events: [] },
    { 'tisza-szeged': { flowM3s: 100, timestamp: '2026-08-10T12:00:00Z' } },
    { historyDocument: AUGUST_DOC },
  );
  assert.strictEqual(doc.count, 1);
  assert.strictEqual(doc.alerts[0].level, 'emergency');
  assert.strictEqual(doc.alerts[0].id, 'record-low:tisza-szeged:2026-08');
});

/** recordLow against an injected document, so the test does not depend on the baked file. */
function recordLowWith(station, flowM3s, timestamp, document = AUGUST_DOC) {
  return recordLow(station, { flowM3s, timestamp }, Date.now(), document);
}
