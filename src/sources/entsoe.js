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
 * STATUS: UNVERIFIED
 * ---------------------------------------------------------------------------
 * Everything below - the document type, the domain code, the XML element names - is
 * written from the platform's published interface, but it could not be exercised: the
 * API needs a token, and the host was unreachable from the machine this was written on.
 * Treat it as a first draft that `npm run probe -- --entsoe` will confirm or correct.
 *
 * A token is free: register on the Transparency Platform, then email
 * transparency@entsoe.eu asking for API access, and set ENTSOE_TOKEN.
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
  return Math.max(0, plant.unitCount - names.size);
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

  // A window around now catches outages already running and those just starting.
  const from = new Date(now.getTime() - 7 * 86400000);
  const to = new Date(now.getTime() + 2 * 86400000);
  const url = buildUrl(cfg, { from, to });

  const { body } = await fetchText(url, { timeoutMs: cfg.timeoutMs });
  const outages = parseOutages(body);

  const availability = {};
  for (const plant of plants) {
    const online = unitsOnlineFor(plant, outages, now.getTime());
    if (online !== null) {
      availability[plant.id] = { unitsOnline: online, unitCount: plant.unitCount, source: 'entsoe' };
    }
  }

  return {
    source: 'entsoe',
    configured: true,
    fetchedAt: new Date().toISOString(),
    outageCount: outages.length,
    activeOutages: activeAt(outages, now.getTime()).length,
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
 * Generation per unit (A73).
 *
 * The document that makes the units cooling model a measurement rather than an
 * inference. Limited to a 24-hour window by the platform.
 */
async function fetchUnitGeneration(env = process.env, now = new Date()) {
  const cfg = config(env);
  if (!cfg.token) throw new Error(cfg.tokenError || 'ENTSOE_TOKEN is not set');

  const url = buildUrl(cfg, {
    from: new Date(now.getTime() - 24 * 3600 * 1000),
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
  fetchUnitGeneration,
  parseOutages,
  parseGeneration,
  parseUnitGeneration,
  lastPoint,
  activeAt,
  unitsOnlineFor,
  buildUrl,
  formatPeriod,
  config,
  cleanToken,
  PSR_TYPES,
  DEFAULTS,
};
