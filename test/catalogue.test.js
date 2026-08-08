'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { matchStations, splitName, fold, distanceKm, normalizeRecord } = require('../src/jobs/catalogue');
const { summarizeOperations, describeSchema, deref, typeName } = require('../src/lib/openapi');

/**
 * Filling EXTERNAL_IDS from a name match alone is the most dangerous shortcut in this
 * project: a wrong törzsszám does not fail, it silently reports a different river under
 * a station's name and the balance stays entirely plausible. So the matcher has to be
 * able to say "I am not sure", and these tests are mostly about the cases where it must.
 */

// The real shape: Mdr is a GUID, MdrNev is the watercourse name.
const DUNA = '711e32b7-14ea-4995-8e3e-5595ec8d58c8';
const CATALOGUE = [
  { Tsz: 1001, Nev: 'Rajka', Lat: 47.9975, Lon: 17.1997, Mdr: DUNA, MdrNev: 'Duna', Fkm: 1848 },
  { Tsz: 3876, Nev: 'Rajka 2. zsilip, alvíz', Lat: 47.99, Lon: 17.19, Mdr: 'aa11bb22-14ea-4995-8e3e-5595ec8d58c8', MdrNev: 'Mosoni-Duna' },
  { Tsz: 1234, Nev: 'Duna Mohács', Lat: 45.9928, Lon: 18.6931, Mdr: DUNA, MdrNev: 'Duna', Fkm: 1447 },
  { Tsz: 2002, Nev: 'Tiszabecs', Lat: 48.1006, Lon: 22.7869, MdrNev: 'Tisza', Fkm: 757 },
  { Tsz: 3003, Nev: 'Őrtilos', Lat: 46.2861, Lon: 16.8875, MdrNev: 'Dráva', Fkm: 236 },
  { Tsz: 4004, Nev: 'Sarkad', Lat: 46.7439, Lon: 21.3839, MdrNev: 'Fekete-Körös' },
];

test('accents and case are folded before comparing', () => {
  assert.strictEqual(fold('Őrtilos'), 'ortilos');
  assert.strictEqual(fold('DRÁVA'), 'drava');
  assert.strictEqual(fold('Fekete-Körös'), 'fekete koros');
});

test('a compound river name is not split at its own hyphen', () => {
  // Splitting on a bare hyphen turned "Fekete-Körös – Sarkad" into river "fekete",
  // place "koros" - and there are five compound river names in the registry.
  assert.deepStrictEqual(splitName('Fekete-Körös – Sarkad (Ant)'), {
    river: 'fekete koros',
    place: 'sarkad',
  });
  assert.deepStrictEqual(splitName('Duna – Rajka'), { river: 'duna', place: 'rajka' });
});

test('a station matches its catalogue entry with high confidence', () => {
  const registry = [{ id: 'duna-rajka', name: 'Duna – Rajka', lat: 47.9975, lon: 17.1997, riverKm: 1848 }];
  const [match] = matchStations(CATALOGUE, registry);

  assert.strictEqual(match.best.record.tsz, 1001);
  assert.strictEqual(match.best.confidence, 'high');
  assert.ok(match.best.km < 1);
});

test('a lock gauge beside the real one does not win on distance', () => {
  // The failure this fixes: "Rajka 2. zsilip, alvíz" sat 1.9 km from the registry's
  // coordinates while the real Rajka sat 3.7 km away, so ranking on distance alone
  // picked the lock. It is on the Mosoni-Duna, and the river name says so.
  const registry = [{ id: 'duna-rajka', name: 'Duna – Rajka', lat: 47.9975, lon: 17.1997, riverKm: 1848 }];
  const [match] = matchStations(CATALOGUE, registry);

  assert.strictEqual(match.best.record.tsz, 1001);
  assert.ok(
    !match.alternatives.some((a) => a.record.tsz === 3876),
    'a gauge on a different watercourse must be rejected, not merely outranked',
  );
});

test('a river-prefixed catalogue name still matches exactly', () => {
  // The catalogue writes "Duna Mohács" where the registry says "Duna – Mohács".
  const registry = [{ id: 'duna-mohacs', name: 'Duna – Mohács', lat: 45.9928, lon: 18.6931, riverKm: 1447 }];
  const [match] = matchStations(CATALOGUE, registry);

  assert.strictEqual(match.best.record.tsz, 1234);
  assert.strictEqual(match.best.confidence, 'high');
});

test('a GUID watercourse field is ignored rather than folded into a name', () => {
  // Mdr holds a GUID and MdrNev the name. Folding the GUID meant the river never
  // matched, which downgraded every station in the registry to "plausible".
  assert.strictEqual(normalizeRecord({ Tsz: 1, Mdr: DUNA }).water, null);
  assert.strictEqual(normalizeRecord({ Tsz: 1, Mdr: DUNA, MdrNev: 'Duna' }).water, 'Duna');
});

test('river kilometre rejects a same-name gauge far along the river', () => {
  const registry = [{ id: 'duna-rajka', name: 'Duna – Rajka', lat: 47.9975, lon: 17.1997, riverKm: 1700 }];
  const [match] = matchStations(CATALOGUE, registry);
  assert.strictEqual(match.best, null, '148 river-km apart is not the same station');
});

test('a name that matches at the wrong place is not accepted as confident', () => {
  // The failure this exists to prevent: the right name on the wrong river, or a
  // same-named settlement 100 km away. Coordinates are what falsify it.
  const registry = [{ id: 'duna-rajka', name: 'Duna – Rajka', lat: 46.0, lon: 18.7 }];
  const [match] = matchStations(CATALOGUE, registry);

  assert.notStrictEqual(match.best && match.best.confidence, 'high');
});

test('a station absent from the catalogue reports no match rather than the nearest one', () => {
  const registry = [{ id: 'lajta-mosonmagyarovar', name: 'Lajta – Mosonmagyaróvár', lat: 47.87, lon: 17.27 }];
  const [match] = matchStations(CATALOGUE, registry);

  assert.strictEqual(match.best, null, 'a station with no entry must not borrow one');
});

test('the river disambiguates two gauges with the same place name', () => {
  const catalogue = [
    { Tsz: 10, Nev: 'Szeged', Lat: 46.25, Lon: 20.15, MdrNev: 'Tisza' },
    { Tsz: 11, Nev: 'Szeged', Lat: 46.26, Lon: 20.16, MdrNev: 'Maros' },
  ];
  const [match] = matchStations(catalogue, [
    { id: 'tisza-szeged', name: 'Tisza – Szeged', lat: 46.25, lon: 20.15 },
  ]);

  assert.strictEqual(match.best.record.tsz, 10);
});

test('records are normalised regardless of the casing the service used', () => {
  assert.strictEqual(normalizeRecord({ tsz: 7, nev: 'X', lat: 1, lon: 2, mdrNev: 'Y' }).tsz, 7);
  assert.strictEqual(normalizeRecord({ Tsz: 7, Nev: 'X', Lat: 1, Lon: 2, MdrNev: 'Y' }).name, 'X');
  assert.strictEqual(normalizeRecord({ Tsz: 7, MdrNev: 'Duna' }).water, 'Duna');
});

test('distance is null when either side has no coordinates', () => {
  assert.strictEqual(distanceKm({ lat: 47, lon: 19 }, { lat: null, lon: null }), null);
  assert.ok(Math.abs(distanceKm({ lat: 47, lon: 19 }, { lat: 47, lon: 19 })) < 1e-9);
});

// ---------------------------------------------------------------------------
// Reading the contract
// ---------------------------------------------------------------------------

const SPEC = {
  openapi: '3.0.4',
  info: { title: 'VRAQuery API', version: 'v1.0.0' },
  paths: {
    '/Vra/InternetVmo/{vmoType}/{onlyActive}': {
      get: {
        summary: 'Állomások',
        parameters: [
          { name: 'vmoType', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'onlyActive', in: 'path', required: true, schema: { type: 'boolean' } },
        ],
        responses: { 200: { content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Vmo' } } } } } },
      },
    },
    '/TS/TsShortList': {
      post: {
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/TsQuery' } } } },
      },
    },
  },
  components: {
    schemas: {
      Vmo: { type: 'object', properties: { Tsz: { type: 'integer' }, Nev: { type: 'string' } } },
      TsQuery: {
        type: 'object',
        required: ['StationIds'],
        properties: {
          StationIds: { type: 'array', items: { type: 'integer' } },
          Haf: { $ref: '#/components/schemas/Haf' },
          Freq: { type: 'string', enum: ['all', 'day'] },
        },
      },
      Haf: { type: 'object', properties: { code: { type: 'integer' }, child: { $ref: '#/components/schemas/Haf' } } },
    },
  },
};

test('operations flatten to one line each, with their parameters', () => {
  const lines = summarizeOperations(SPEC).join('\n');

  assert.match(lines, /GET.*\/Vra\/InternetVmo\/\{vmoType\}\/\{onlyActive\}/);
  assert.match(lines, /path: vmoType: integer \(required\)/);
  assert.match(lines, /POST.*\/TS\/TsShortList/);
  assert.match(lines, /body\[application\/json\]: TsQuery/);
  assert.match(lines, /200\[application\/json\]: Vmo\[\]/);
});

test('a path filter narrows the listing', () => {
  const lines = summarizeOperations(SPEC, { filter: /^\/TS\// }).join('\n');
  assert.match(lines, /TsShortList/);
  assert.doesNotMatch(lines, /InternetVmo/);
});

test('a request schema expands to its properties, marking the required ones', () => {
  const lines = describeSchema(SPEC, 'TsQuery').join('\n');

  assert.match(lines, /\* StationIds: integer\[\]/, 'required fields carry a marker');
  assert.match(lines, /Freq: enum\(all\|day\)/, 'enums show their allowed values');
  assert.match(lines, /Haf: Haf/);
});

test('a self-referential schema terminates instead of recursing forever', () => {
  // Hydrological data-type trees reference themselves; an unbounded walk never returns.
  const lines = describeSchema(SPEC, 'Haf', { depth: 5 });
  assert.ok(lines.length < 30, `expected a bounded expansion, got ${lines.length} lines`);
  assert.match(lines.join('\n'), /code: integer/);
});

test('an unknown schema name reports what is available rather than throwing', () => {
  const lines = describeSchema(SPEC, 'NoSuchThing').join('\n');
  assert.match(lines, /no schema named NoSuchThing/);
  assert.match(lines, /TsQuery/);
});

test('a spec with no paths or components does not throw', () => {
  assert.deepStrictEqual(summarizeOperations({}), []);
  assert.match(describeSchema({}, 'X').join(''), /no schema named X/);
  assert.strictEqual(deref({}, { $ref: '#/nope' }), null);
  assert.strictEqual(typeName(null), 'unknown');
});
