'use strict';

const { fetchText } = require('../lib/http');

/**
 * Unit availability from the ENTSO-E Transparency Platform.
 *
 * MAVIR publishes how much nuclear power Hungary is generating. It does not publish how
 * many Paks units are running, and those are different questions: two units at 40% and
 * one unit at 80% produce the same megawatts while moving very different amounts of
 * cooling water, because pumps belong to a unit rather than to its output.
 *
 * ENTSO-E answers the question that MAVIR does not. European generators are obliged to
 * publish outages of units above 100 MW, planned and forced, with the capacity that
 * remains available - which is exactly "how many units are running". It is free, and
 * it covers every Hungarian plant in this registry that matters.
 *
 * ---------------------------------------------------------------------------
 * STATUS: VERIFIED AGAINST THE LIVE PLATFORM, 2026-08-10
 * ---------------------------------------------------------------------------
 * Four documents, all exercised by `npm run probe -- --entsoe`:
 *
 *   A75  generation by production type, quarter-hourly. Replaces the MAVIR scrape.
 *   A73  generation per unit. The document MAVIR has no equivalent of, and the reason
 *        this adapter exists. Window must not exceed one day.
 *   A80  unavailability of generation units. Capped at 200 instances per response.
 *   A65  total load, used as a cross-check on whether A75 carries the whole fleet.
 *
 * What the first real run corrected, none of which failed loudly:
 *
 *   - Paks is published as EIGHT generators, PA_gép1..PA_gép8, not four units. A
 *     VVER-440 block carries two turbogenerators. The pattern written from expectation
 *     ('^paks') matched none of them, and a pattern that matches nothing reports every
 *     unit available forever.
 *   - A80 and A73 disagree. On the first comparison A80 had all four blocks available
 *     while A73 showed seven of eight generators at 5-11 MW - house load, not output.
 *     An outage notice is a document; generation is the machine. The unit count is
 *     taken from A73 for that reason, and A80 is kept for the part it can answer.
 *
 * A token is free: register on the Transparency Platform, then email
 * transparency@entsoe.eu asking for API access, and set ENTSOE_TOKEN. It must be the
 * bare token on one line - see cleanToken for what a careless paste costs.
 *
 * Without a token this adapter returns nothing and the units model falls back to
 * inferring units from output - a lower bound, honestly labelled as one.
 */

const DEFAULTS = {
  baseUrl: 'https://web-api.tp.entsoe.eu/api',
  // Hungary's bidding zone / control area.
  domain: '10YHU-MAVIR----U',
  // A80: unavailability of generation units. A77 is the production-unit variant; some
  // publishers use one and some the other, so both are worth probing.
  documentType: 'A80',
  timeoutMs: 30000,
};

/**
 * Clean up a pasted token, and say so when it cannot be cleaned up.
 *
 * The token travels as a query parameter, so anything extra in it comes back as a bare
 * HTTP 401 - a message that says "wrong credentials" when the credentials are right and
 * the paste was wrong. That happened here: a secret was set to the token followed by a
 * newline and the YAML line that references it, and three documents failed with 401
 * apiece while the token itself was perfectly valid.
 *
 * A surrounding newline or a stray quote is silently fixed, because that is a paste
 * artefact and not a decision. Anything left inside the value is reported by name: an
 * ENTSO-E token is a UUID, so a space or a colon in the middle of one is a mistake worth
 * interrupting for rather than passing to a server that can only answer 401.
 */
function cleanToken(raw) {
  if (raw === undefined || raw === null) return { token: null };

  const trimmed = String(raw).trim().replace(/^["']|["']$/g, '');
  if (trimmed === '') return { token: null };

  if (/\s/.test(trimmed)) {
    return {
      token: null,
      error:
        'ENTSOE_TOKEN contains whitespace, so it is not just the token. A common cause is ' +
        'pasting the surrounding YAML into the secret. The value must be the bare token ' +
        'on one line - no "ENTSOE_TOKEN:" prefix, no indentation, no quotes.',
    };
  }

  return { token: trimmed };
}

function config(env = process.env) {
  const { token, error } = cleanToken(env.ENTSOE_TOKEN);
  return {
    baseUrl: env.ENTSOE_BASE_URL || DEFAULTS.baseUrl,
    domain: env.ENTSOE_DOMAIN || DEFAULTS.domain,
    documentType: env.ENTSOE_DOCUMENT_TYPE || DEFAULTS.documentType,
    token,
    tokenError: error || null,
    timeoutMs: Number(env.ENTSOE_TIMEOUT_MS) || DEFAULTS.timeoutMs,
  };
}

/**
 * The platform's own explanation of a rejection, which it puts in the body.
 *
 * A 4xx here arrives with an `Acknowledgement_MarketDocument` carrying a `Reason` that
 * says exactly which parameter is wrong - "The amount of requested data is too large",
 * "No matching data found", and so on. Throwing away the body turns a precise
 * instruction into a bare status code, which is how an afternoon gets spent guessing at
 * parameter combinations the server was willing to describe.
 */
function describeError(err) {
  const body = (err && err.body) || '';
  const reason = /<text>([\s\S]*?)<\/text>/i.exec(body);
  const code = /<code>([\s\S]*?)<\/code>/i.exec(body);
  if (!reason && !code) return (err && err.message) || String(err);

  const parts = [reason ? reason[1].trim() : null, code ? `code ${code[1].trim()}` : null].filter(Boolean);
  return `${(err && err.message) || err} — ${parts.join(', ')}`;
}

/** The platform's timestamp format: yyyyMMddHHmm, always UTC. */
function formatPeriod(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`
  );
}

/**
 * @param {object} cfg
 * @param {object} opts
 * @param {Date} opts.from
 * @param {Date} opts.to
 * @param {string} [opts.documentType]  A80 outages, A75 generation by type, A73 by unit
 * @param {string} [opts.processType]   A16 = realised, required for generation documents
 * @param {string} [opts.domainParam]   generation uses in_Domain, outages biddingZone_Domain
 */
function buildUrl(cfg, { from, to, documentType, processType, domainParam = 'biddingZone_Domain' }) {
  const params = new URLSearchParams({
    securityToken: cfg.token || '',
    documentType: documentType || cfg.documentType,
    [domainParam]: cfg.domain,
    periodStart: formatPeriod(from),
    periodEnd: formatPeriod(to),
  });
  // Generation documents are undefined without it; outage documents reject it.
  if (processType) params.set('processType', processType);
  return `${cfg.baseUrl}?${params.toString()}`;
}

/**
 * Production-type codes, as the platform defines them.
 *
 * B14 is nuclear, and in Hungary nuclear means Paks I and nothing else - the same fact
 * the MAVIR adapter leans on, available here without scraping a portal.
 */
const PSR_TYPES = {
  B01: 'biomass',
  B02: 'coal', // lignite
  B04: 'naturalGas',
  B05: 'coal', // hard coal
  B06: 'oil',
  B10: 'hydroPumped',
  B11: 'hydro',
  B12: 'hydro',
  B14: 'nuclear',
  B16: 'pv',
  B17: 'waste',
  B19: 'wind',
  B20: 'wind',
};

/**
 * The last real point of a Period, with the time it belongs to.
 *
 * Points are numbered from 1 and the platform omits trailing positions that have no
 * value yet, so the newest published point is the highest position present - not the
 * last one the resolution implies.
 */
function lastPoint(period) {
  const start = tagValue(period, 'start');
  const resolution = tagValue(period, 'resolution') || 'PT15M';
  const minutes = Number((resolution.match(/PT(\d+)M/) || [])[1]) || 60;

  let best = null;
  for (const point of allBlocks(period, 'Point')) {
    const position = Number(tagValue(point, 'position'));
    const quantity = Number(tagValue(point, 'quantity'));
    if (!Number.isFinite(position) || !Number.isFinite(quantity)) continue;
    if (!best || position > best.position) best = { position, quantity };
  }
  if (!best) return null;

  const startMs = start ? Date.parse(start) : NaN;
  return {
    mw: best.quantity,
    // Position 1 covers the interval starting at `start`.
    timestamp: Number.isFinite(startMs)
      ? new Date(startMs + (best.position - 1) * minutes * 60000).toISOString()
      : null,
  };
}

/**
 * Generation by production type, in the shape the MAVIR adapter returns.
 *
 * A75 answers the same question MAVIR's chart does - what is Hungary generating right
 * now, by fuel - from a documented API rather than from a portal's minified bundle.
 * Consumption series are skipped: the platform reports pumped storage in both
 * directions, and counting the pumping as generation would double the hydro term.
 */
function parseGeneration(xml) {
  const bySource = {};
  let timestamp = null;

  for (const series of allBlocks(xml, 'TimeSeries')) {
    if (tagValue(series, 'inBiddingZone_Domain\\.mRID') === null &&
        tagValue(series, 'outBiddingZone_Domain\\.mRID') !== null) {
      continue; // consumption leg of a pumped-storage series
    }

    const psrType = tagValue(series, 'psrType');
    const key = PSR_TYPES[psrType];
    if (!key) continue;

    for (const period of allBlocks(series, 'Period')) {
      const point = lastPoint(period);
      if (!point) continue;
      bySource[key] = (bySource[key] || 0) + point.mw;
      if (!timestamp || (point.timestamp && point.timestamp > timestamp)) timestamp = point.timestamp;
    }
  }

  if (Object.keys(bySource).length === 0) return null;
  return { timestamp: timestamp || new Date().toISOString(), generationMw: bySource };
}

/**
 * Generation per unit (A73).
 *
 * This is the document MAVIR has no equivalent of, and it is the one the units cooling
 * model actually wants: four Paks units listed separately, so "how many are running" is
 * read rather than inferred from a total.
 */
function parseUnitGeneration(xml) {
  const units = [];

  for (const series of allBlocks(xml, 'TimeSeries')) {
    // The unit's name is nested inside PowerSystemResources, not a dotted element -
    // and <name> also appears elsewhere in the document, so the block has to be
    // isolated first or the first <name> in the series wins.
    const resources = allBlocks(series, 'PowerSystemResources')[0];
    const name =
      (resources && tagValue(resources, 'name')) ||
      tagValue(series, 'registeredResource\\.name') ||
      tagValue(series, 'production_RegisteredResource\\.name');
    if (!name) continue;

    const psrType = tagValue(series, 'psrType');
    const nominal = Number((resources && tagValue(resources, 'nominalP')) || tagValue(series, 'nominalP'));

    let latest = null;
    for (const period of allBlocks(series, 'Period')) {
      const point = lastPoint(period);
      if (point && (!latest || (point.timestamp || '') > (latest.timestamp || ''))) latest = point;
    }
    if (!latest) continue;

    units.push({
      unitName: name.trim(),
      sourceType: PSR_TYPES[psrType] || null,
      powerMw: latest.mw,
      nominalMw: Number.isFinite(nominal) ? nominal : null,
      timestamp: latest.timestamp,
    });
  }

  return units;
}

/**
 * Pull the fields we need out of the response.
 *
 * A real XML parser would be the right tool, and pulling one in for four element names
 * from a document whose shape is fixed by a published schema is not. This reads only
 * what it understands and ignores the rest, which is also what keeps it from breaking
 * when the platform adds elements.
 */
function tagValue(xml, name) {
  const match = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return match ? match[1].trim() : null;
}

function allBlocks(xml, name) {
  const blocks = [];
  const pattern = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'gi');
  let match;
  while ((match = pattern.exec(xml)) !== null) blocks.push(match[1]);
  return blocks;
}

function parseOutages(xml) {
  const outages = [];

  for (const series of allBlocks(xml, 'TimeSeries')) {
    const name =
      tagValue(series, 'production_RegisteredResource\\.name') ||
      tagValue(series, 'production_RegisteredResource\\.pSRType\\.powerSystemResources\\.name');

    const nominal = Number(
      tagValue(series, 'production_RegisteredResource\\.pSRType\\.powerSystemResources\\.nominalP'),
    );

    const period = allBlocks(series, 'available_Period')[0] || series;
    const start = tagValue(period, 'start');
    const end = tagValue(period, 'end');
    // Capacity still available during the outage - zero means the unit is fully out.
    const available = Number(tagValue(period, 'quantity'));

    if (!name) continue;

    outages.push({
      unitName: name,
      nominalMw: Number.isFinite(nominal) ? nominal : null,
      availableMw: Number.isFinite(available) ? available : null,
      start: start ? new Date(start).toISOString() : null,
      end: end ? new Date(end).toISOString() : null,
    });
  }

  return outages;
}

/** Outages overlapping `now`. A published outage that has not started is not one yet. */
function activeAt(outages, now = Date.now()) {
  return outages.filter((o) => {
    const from = o.start ? Date.parse(o.start) : -Infinity;
    const to = o.end ? Date.parse(o.end) : Infinity;
    return from <= now && now < to;
  });
}

/**
 * How many of a plant's units are available, given the outages in force.
 *
 * A unit counts as out when the outage leaves it no capacity. A partial derating still
 * has the unit online with its pumps running, which is what the water model cares
 * about - so it does not reduce the count.
 */
function unitsOnlineFor(plant, outages, now = Date.now()) {
  const pattern = plant.entsoeUnitPattern;
  if (!pattern || !plant.unitCount) return null;

  const matcher = new RegExp(pattern, 'i');
  const fullyOut = activeAt(outages, now).filter(
    (o) => matcher.test(o.unitName) && o.availableMw !== null && o.availableMw <= 0,
  );

  // Distinct units - the platform may publish several overlapping messages for one.
  const names = new Set(fullyOut.map((o) => o.unitName));

  // The platform's "unit" is not always this registry's unit. Paks is listed as eight
  // generators, PA_gép1..PA_gép8, while `unitCount` is four blocks - a VVER-440 block
  // carries two turbogenerators. Subtracting eight names from four blocks clamps to
  // zero and reports the whole plant dark.
  //
  // A block only counts as out when every generator in it is out: one turbine down
  // still leaves the block's circulating pumps running for the other, and pumps are
  // what the water model is counting.
  const perUnit = plant.entsoeGeneratorsPerUnit;
  if (perUnit > 1) {
    const outPerBlock = new Map();
    for (const name of names) {
      const generator = Number((name.match(/(\d+)\s*$/) || [])[1]);
      if (!Number.isFinite(generator)) continue;
      const block = Math.ceil(generator / perUnit);
      outPerBlock.set(block, (outPerBlock.get(block) || 0) + 1);
    }
    const blocksOut = [...outPerBlock.values()].filter((count) => count >= perUnit).length;
    return Math.max(0, plant.unitCount - blocksOut);
  }

  return Math.max(0, plant.unitCount - names.size);
}

/**
 * A generator is running when it is putting out more than this share of its rating.
 *
 * Observed at Paks on 2026-08-10: one generator at 214 MW and seven between 5 and 11.
 * That is not seven machines at low load - a VVER-440 turbogenerator does not idle at
 * 2% - it is house load, the plant drawing from the grid to keep its own systems alive
 * while the turbine is stopped. Ten percent sits far above that floor and far below
 * anything that could be called production.
 */
const RUNNING_FRACTION = 0.1;

/**
 * How many of a plant's units are running, measured rather than inferred.
 *
 * A73 says what each generator is producing right now. A80 says what somebody filed a
 * notice about, and the two disagreed the first time they were compared: A80 reported
 * all four Paks blocks available while A73 showed seven of eight generators at house
 * load. An outage notice is a document; output is the machine.
 *
 * That matters here more than usual, because the number feeds a cooling-water figure.
 * A stopped turbine's circulating pumps are off whether or not anyone filed for it, and
 * counting it as running would put a hundred cubic metres a second of Danube water into
 * the model that is not being drawn.
 */
function unitsRunningFrom(plant, units) {
  if (!plant.entsoeUnitPattern || !plant.unitCount || !Array.isArray(units)) return null;

  const matcher = new RegExp(plant.entsoeUnitPattern, 'i');
  const mine = units.filter((unit) => matcher.test(unit.unitName || ''));
  if (mine.length === 0) return null;

  const perUnit = plant.entsoeGeneratorsPerUnit || 1;
  // The rating per generator. The document's own nominalP is the better source, but it
  // came back as 0 for every unit, so the plant's nameplate split evenly is the fallback.
  const nominalPerGenerator = (plant.capacityMw || 0) / (plant.unitCount * perUnit);

  const runningGenerators = new Set();
  for (const unit of mine) {
    const rating = unit.nominalMw > 0 ? unit.nominalMw : nominalPerGenerator;
    if (!(rating > 0)) continue;
    if (unit.powerMw >= rating * RUNNING_FRACTION) runningGenerators.add(unit.unitName);
  }

  if (perUnit === 1) return Math.min(plant.unitCount, runningGenerators.size);

  // Fold generators back to blocks: a block is drawing cooling water if either of its
  // turbines is turning, because each has its own condenser on the same circuit.
  const blocks = new Set();
  for (const name of runningGenerators) {
    const generator = Number((name.match(/(\d+)\s*$/) || [])[1]);
    if (Number.isFinite(generator)) blocks.add(Math.ceil(generator / perUnit));
  }
  return Math.min(plant.unitCount, blocks.size);
}

/**
 * Fetch outages over a window, splitting it whenever the platform says it is too big.
 *
 * The window for this document cannot be chosen by picking a number, because it is
 * squeezed from both sides and the squeeze moves:
 *
 *   Too wide - the platform caps the document at 200 instances and answers HTTP 400.
 *              Nine days returned "The number of instances (320) exceeds the allowed
 *              maximum (200)". Four days still gave 213.
 *   Too narrow - one day returned zero outages while A73 showed seven of Paks's eight
 *              generators sitting at 5-11 MW. The period does not select outages by
 *              their own interval, so a long-running outage published weeks ago falls
 *              outside a short window and vanishes. Zero outages then reads as "every
 *              unit is running", which is the most confident possible way to be wrong.
 *
 * And how many instances a week contains depends on how busy the outage feed happens to
 * be, so any fixed figure is a guess that expires. Splitting on the platform's own
 * complaint needs no guess: ask for the whole window, and when it objects, halve and
 * ask again. Merged on unit name and start time, because the halves share a boundary
 * and an outage spanning it is returned by both.
 */
const MAX_OUTAGE_SPLITS = 4;

async function fetchOutageWindow(cfg, { from, to }, depth = 0) {
  try {
    const { body } = await fetchText(buildUrl(cfg, { from, to }), { timeoutMs: cfg.timeoutMs });
    return parseOutages(body);
  } catch (err) {
    const tooMany = /exceeds the allowed maximum/i.test((err && err.body) || '');
    if (!tooMany || depth >= MAX_OUTAGE_SPLITS) throw err;

    // Sequentially, not in parallel. A split can itself split, so the fan-out doubles
    // per level - and firing them together turns one rejected request into a burst
    // against a rate-limited public service, for no gain: this runs on a fifteen-minute
    // poll and has no deadline worth a thundering herd.
    const middle = new Date((from.getTime() + to.getTime()) / 2);
    const earlier = await fetchOutageWindow(cfg, { from, to: middle }, depth + 1);
    const later = await fetchOutageWindow(cfg, { from: middle, to }, depth + 1);

    const merged = new Map();
    for (const outage of [...earlier, ...later]) merged.set(`${outage.unitName}|${outage.start}`, outage);
    return [...merged.values()];
  }
}

/**
 * Fetch current unit availability, keyed by plant id.
 * Returns an empty result rather than throwing when no token is configured.
 */
async function fetchAvailability(plants, env = process.env, now = new Date()) {
  const cfg = config(env);

  if (!cfg.token) {
    return {
      source: 'entsoe',
      configured: false,
      availability: {},
      note: cfg.tokenError || 'ENTSOE_TOKEN is not set; unit counts fall back to inference from output.',
    };
  }

  // A73 first, because it measures. A80 only says what somebody filed a notice about,
  // and the two disagreed the first time they met: A80 called all four Paks blocks
  // available while A73 had seven of eight generators at house load. The cooling model
  // turns this number into cubic metres a second of Danube water, so it has to come
  // from the machine rather than the paperwork.
  //
  // Outages are still fetched, for the part A73 cannot answer: whether a stopped unit
  // is stopped on purpose and until when.
  const [unitGeneration, outages] = await Promise.all([
    fetchUnitGeneration(env, now).catch(() => null),
    // Six days, in pieces. See fetchOutageWindow for why neither end of the window can
    // be chosen by picking a number.
    fetchOutageWindow(cfg, {
      from: new Date(now.getTime() - 5 * 86400000),
      to: new Date(now.getTime() + 86400000),
    }).catch(() => []),
  ]);

  const availability = {};
  for (const plant of plants) {
    const measured = unitGeneration ? unitsRunningFrom(plant, unitGeneration.units) : null;
    const declared = unitsOnlineFor(plant, outages, now.getTime());
    const online = measured !== null ? measured : declared;
    if (online === null) continue;

    availability[plant.id] = {
      unitsOnline: online,
      unitCount: plant.unitCount,
      source: 'entsoe',
      basis: measured !== null ? 'generation' : 'outage-notices',
      // Both, when both exist. A gap between them is worth seeing rather than
      // resolving silently - it is either an unfiled outage or a unit on house load,
      // and those are different stories about the same plant.
      declaredOnline: declared,
    };
  }

  return {
    source: 'entsoe',
    configured: true,
    fetchedAt: new Date().toISOString(),
    outageCount: outages.length,
    activeOutages: activeAt(outages, now.getTime()).length,
    unitsMeasured: unitGeneration ? unitGeneration.units.length : 0,
    availability,
  };
}

/**
 * Current generation by production type - the MAVIR replacement.
 *
 * Returns the same shape mavir.fetchGeneration does, so the poller can take either.
 * A75 needs processType A16 ("realised") and in_Domain rather than the bidding-zone
 * parameter the outage documents use; without processType the platform answers with a
 * "no matching data" acknowledgement rather than an error, which is the kind of failure
 * that looks like an empty grid.
 */
async function fetchGeneration(env = process.env, now = new Date()) {
  const cfg = config(env);
  if (!cfg.token) throw new Error(cfg.tokenError || 'ENTSOE_TOKEN is not set');

  // A day back. The platform publishes with a lag of an hour or so, and asking for only
  // the current hour regularly returns an empty document.
  const url = buildUrl(cfg, {
    from: new Date(now.getTime() - 24 * 3600 * 1000),
    to: new Date(now.getTime() + 3600 * 1000),
    documentType: 'A75',
    processType: 'A16',
    domainParam: 'in_Domain',
  });

  const { body } = await fetchText(url, { timeoutMs: cfg.timeoutMs });
  const parsed = parseGeneration(body);
  if (!parsed) {
    throw new Error(`ENTSO-E returned no generation series (${body.slice(0, 200).replace(/\s+/g, ' ')})`);
  }

  return { source: 'entsoe', fetchedAt: new Date().toISOString(), ...parsed };
}

/**
 * Every point of every series, for diagnosing the shape rather than reading a value.
 *
 * Exists because a mix summed from each fuel's own last point is only a mix if they all
 * publish at the same moment, and there is no way to tell from the summed number whether
 * they do. Used by the probe; nothing in the app reads it.
 */
async function fetchGenerationRaw(env = process.env, now = new Date()) {
  const cfg = config(env);
  if (!cfg.token) throw new Error(cfg.tokenError || 'ENTSOE_TOKEN is not set');

  const url = buildUrl(cfg, {
    from: new Date(now.getTime() - 24 * 3600 * 1000),
    to: new Date(now.getTime() + 3600 * 1000),
    documentType: 'A75',
    processType: 'A16',
    domainParam: 'in_Domain',
  });
  const { body } = await fetchText(url, { timeoutMs: cfg.timeoutMs });

  const byType = {};
  for (const series of allBlocks(body, 'TimeSeries')) {
    if (tagValue(series, 'inBiddingZone_Domain\\.mRID') === null &&
        tagValue(series, 'outBiddingZone_Domain\\.mRID') !== null) continue;
    const key = PSR_TYPES[tagValue(series, 'psrType')];
    if (!key) continue;

    for (const period of allBlocks(series, 'Period')) {
      const start = Date.parse(tagValue(period, 'start'));
      const resolution = tagValue(period, 'resolution') || 'PT15M';
      const minutes = Number((resolution.match(/PT(\d+)M/) || [])[1]) || 60;
      for (const point of allBlocks(period, 'Point')) {
        const position = Number(tagValue(point, 'position'));
        const mw = Number(tagValue(point, 'quantity'));
        if (!Number.isFinite(position) || !Number.isFinite(mw) || !Number.isFinite(start)) continue;
        (byType[key] = byType[key] || []).push({
          timestamp: new Date(start + (position - 1) * minutes * 60000).toISOString(),
          mw,
        });
      }
    }
  }

  for (const points of Object.values(byType)) points.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  return { byType };
}

/**
 * Generation per unit (A73).
 *
 * The document that makes the units cooling model a measurement rather than an
 * inference. Limited to a 24-hour window by the platform.
 */
async function fetchUnitGeneration(env = process.env, now = new Date()) {
  const cfg = config(env);
  if (!cfg.token) throw new Error(cfg.tokenError || 'ENTSOE_TOKEN is not set');

  // Strictly inside one day. The platform enforces this and says so: "The time interval
  // of Data Item Actual Generation Output per Generation Unit [16.1.A] must not span
  // more than 1 day." The previous window was 24 hours back plus an hour of clock-skew
  // headroom - 25 hours, and rejected outright. The hour of headroom that every other
  // request here carries is the one thing this document will not tolerate.
  const url = buildUrl(cfg, {
    from: new Date(now.getTime() - 23 * 3600 * 1000),
    to: new Date(now.getTime() + 3600 * 1000),
    documentType: 'A73',
    processType: 'A16',
    domainParam: 'in_Domain',
  });

  const { body } = await fetchText(url, { timeoutMs: cfg.timeoutMs });
  return { source: 'entsoe', fetchedAt: new Date().toISOString(), units: parseUnitGeneration(body) };
}

module.exports = {
  fetchAvailability,
  fetchGeneration,
  fetchGenerationRaw,
  fetchUnitGeneration,
  parseOutages,
  parseGeneration,
  parseUnitGeneration,
  lastPoint,
  activeAt,
  unitsOnlineFor,
  unitsRunningFrom,
  buildUrl,
  formatPeriod,
  config,
  cleanToken,
  describeError,
  PSR_TYPES,
  DEFAULTS,
};
