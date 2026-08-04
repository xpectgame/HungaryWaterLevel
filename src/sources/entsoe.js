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

function config(env = process.env) {
  return {
    baseUrl: env.ENTSOE_BASE_URL || DEFAULTS.baseUrl,
    domain: env.ENTSOE_DOMAIN || DEFAULTS.domain,
    documentType: env.ENTSOE_DOCUMENT_TYPE || DEFAULTS.documentType,
    token: env.ENTSOE_TOKEN || null,
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

function buildUrl(cfg, { from, to }) {
  const params = new URLSearchParams({
    securityToken: cfg.token || '',
    documentType: cfg.documentType,
    biddingZone_Domain: cfg.domain,
    periodStart: formatPeriod(from),
    periodEnd: formatPeriod(to),
  });
  return `${cfg.baseUrl}?${params.toString()}`;
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
      note: 'ENTSOE_TOKEN is not set; unit counts fall back to inference from output.',
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

module.exports = {
  fetchAvailability,
  parseOutages,
  activeAt,
  unitsOnlineFor,
  buildUrl,
  formatPeriod,
  config,
  DEFAULTS,
};
