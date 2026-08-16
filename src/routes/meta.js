'use strict';

const express = require('express');
const path = require('node:path');
const { listStations } = require('../config/stations');
const { vizugy, mavir } = require('../sources');
const { asyncRoute } = require('../lib/async-route');
const { historyCoverage } = require('../domain/flow-history');

module.exports = function metaRoutes(ctx) {
  const router = express.Router();
  const { store, config } = ctx;

  /**
   * GET /health
   *
   * Reports degraded rather than ok when the data is stale. An API that answers 200
   * while serving a four-day-old river is worse than one that admits it - the numbers
   * still look perfectly plausible.
   */
  router.get('/health', asyncRoute(async (req, res) => {
    const lastPoll = await store.lastPoll();
    const stats = await store.stats();
    const newest = stats.newestReading ? Date.parse(stats.newestReading) : null;
    const ageMs = newest ? Date.now() - newest : null;
    const stale = ageMs == null || ageMs > config.maxReadingAgeMs;

    const status = stale ? 'degraded' : 'ok';
    res.status(stale ? 503 : 200).json({
      status,
      provider: config.provider,
      synthetic: config.provider === 'fixture',
      dataAgeSeconds: ageMs == null ? null : Math.round(ageMs / 1000),
      maxAcceptableAgeSeconds: Math.round(config.maxReadingAgeMs / 1000),
      lastPoll,
      store: stats,
      uptimeSeconds: Math.round(process.uptime()),
      build: buildInfo(),
    });
  }));

  /**
   * GET /meta/sources - provenance, licensing and, importantly, what is modelled
   * rather than measured.
   */
  router.get('/meta/sources', (req, res) => {
    res.json({
      upstream: [
        {
          id: 'vizugy',
          name: 'Országos Vízügyi Főigazgatóság - vízrajzi nyílt adatok',
          url: 'https://data.vizugy.hu/',
          provides: ['discharge (m3/s)', 'water level', 'water temperature'],
          licence: 'Free to use with attribution to OVF or the relevant regional water directorate.',
          attributionRequired: true,
          endpointStatus: vizugy.EXTERNAL_IDS && Object.keys(vizugy.EXTERNAL_IDS).length > 0
            ? 'configured'
            : 'unconfigured - station identifiers and response shape need to be confirmed against the live portal',
          configuredBaseUrl: vizugy.config().baseUrl,
        },
        {
          id: 'mavir',
          name: 'MAVIR Zrt. - villamosenergia-rendszer valós idejű adatok',
          url: 'https://www.mavir.hu/',
          provides: ['generation by primary source (MW)', 'system load', 'import/export balance'],
          cadence: '15 minutes',
          limitation:
            'Published per source type, not per plant. Only nuclear maps to a single plant (Paks I); all other per-plant figures are allocated estimates.',
          endpointStatus: 'unverified - default path follows the known chart-backend pattern but has not been confirmed',
          configuredBaseUrl: mavir.config().baseUrl,
        },
      ],
      derived: [
        {
          quantity: 'net water balance (dQ)',
          method: 'sum of border inflow gauges minus sum of border outflow gauges, plus an estimated ungauged inflow term',
          caveats: [
            'A difference of two numbers near 3600 m3/s, each carrying 5-10% rating-curve uncertainty. The combined error band is typically wider than the result.',
            'Instantaneous comparison ignores travel time (up to ~8 days across the Tisza system). Use method=lagged when enough history exists.',
            'Gauged stations cover roughly 93% of long-term mean inflow; the remainder is an estimate, not a measurement.',
          ],
        },
        {
          quantity: 'how today compares with the same calendar month over ten years',
          method:
            'Per station, the 5th-95th percentiles of daily mean discharge for each calendar month, ' +
            'over ten years of the OVF archive, baked offline by `npm run probe -- --flow-history`. ' +
            'A live reading is placed in that distribution and reported as a band plus a percentile.',
          caveats: [
            'Ten years is a short record. A reading below everything in it is reported as below the record, not as a percentile, because the data cannot say how unusual it is.',
            'Bucketed by calendar month, so there is a seam at each boundary: 31 August is compared against a set that includes 1 August, a wetter day in a receding summer.',
            'Daily means, not raw samples: cadence varies between gauges and across years, and percentiles over raw samples would weight a 15-minute gauge above an hourly one.',
            'Coverage is not uniform. Mohács discharge only reaches back to mid-2021 (five years, June-December); Tiszasziget publishes no archive at all. A month with fewer than five years is not published.',
          ],
          coverage: historyCoverage(),
        },
        {
          quantity: 'power plant cooling water',
          method: 'electrical output scaled to a published nominal cooling flow (model=linear), or derived from condenser heat duty (model=thermal)',
          caveats: [
            'Real plants run discrete pumps, so the true relationship is a staircase rather than the smooth curve modelled here.',
            'Only Paks I has a directly readable generation figure. The gas fleet is split by capacity share, which ignores merit-order dispatch.',
            'Withdrawal is not consumption. Once-through plants return over 99% of what they take.',
          ],
        },
      ],
      staticReferences: [
        {
          name: 'OKIRKapu - Országos Környezetvédelmi Információs Rendszer',
          use: 'Water abstraction permits (m3/year, m3/s ceilings) for individual plants.',
          status: 'not yet integrated - permit fields marked confidence: unknown need to be filled from here',
        },
        {
          name: 'Paks II környezeti hatástanulmány (KHT)',
          use: 'Design cooling water demand for the planned units, normal and drought conditions.',
          status: 'planning figures only',
        },
        {
          name: 'KSH / OVF éves vízmérleg',
          use: 'Long-term annual balance (~110-120 km3/a inflow) used to calibrate the ungauged inflow term.',
          status: 'used as a constant, not fetched live',
        },
        {
          name: 'vraquery vmoType 14, AdatFajtaKod 299 (Talajnedvesség)',
          use: 'The 23 stations behind /talajnedvesseg: soil moisture as a percentage, hourly.',
          status: 'live; the station registry and a one-year percentile record are baked',
          limitation:
            'No sensor depth, no soil type and no wilting point are published, so a reading is comparable with itself over time and only roughly between stations. ' +
            'All 23 stations are in the south-east, which is not a national network. ' +
            'The record behind the percentiles is about one year, not the ten the river and well histories use.',
        },
        {
          name: 'geoportal.vizugy.hu Honlap/Vizikozmu/MapServer/0',
          use: 'The 732 municipal wastewater treatment works behind /szennyviz: design capacity in population equivalent, arriving organic load, annual volume, receiving watercourse.',
          status: 'baked into src/config/sewage.json; the register is not a live feed',
        },
        {
          name: 'geoportal.vizugy.hu VGT_1/02_00/MapServer/1',
          use: 'The 424 industrial and other non-municipal discharge points behind /ipari: location, sector, receiving water body.',
          status: 'baked into src/config/industry.json',
          // Spelled out here rather than left to be discovered from empty fields: these
          // are the four things this layer is asked for and does not contain, and the
          // fifth is that it is fifteen years old.
          limitation:
            'No volume, no pollutant load, no permit limit and no operator on any row - the register records where and from which sector, nothing more. ' +
            'Surveyed for the first river basin management plan, around 2009, so anything built since is absent. ' +
            'Whether a discharge goes to surface water or to groundwater is derived here from the receiving body code, not read from a field.',
        },
      ],
      attribution:
        'Hydrological data: Országos Vízügyi Főigazgatóság (OVF). Electricity system data: MAVIR Zrt. This API is an independent derived product and is not endorsed by either organisation.',
    });
  });

  /** GET /meta/stations - the registry alone, without readings. */
  router.get('/meta/stations', (req, res) => {
    res.json({
      count: listStations().length,
      byRole: {
        inflow: listStations('inflow').length,
        outflow: listStations('outflow').length,
        interior: listStations('interior').length,
      },
      stations: listStations().map((s) => ({
        id: s.id,
        name: s.name,
        river: s.river,
        role: s.role,
        longTermMeanM3s: s.meanFlow,
        travelTimeToBorderHours: s.travelTimeHours ?? null,
        uncertaintyPct: s.uncertaintyPct,
        redundantWith: s.redundantWith || null,
      })),
    });
  });

  /** GET /openapi.yaml */
  router.get('/openapi.yaml', (req, res) => {
    res.type('text/yaml').sendFile(path.join(__dirname, '..', '..', 'openapi.yaml'));
  });

  return router;
};

/**
 * Which build is actually serving this request.
 *
 * Deployment platforms hand out an immutable URL per build alongside the moving
 * production alias, so it is easy to keep reloading a stale deployment and conclude a
 * fix did not work. Reporting the commit removes the guesswork: compare it with the
 * repository and the question answers itself.
 */
function buildInfo() {
  const commit = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || null;
  return {
    commit: commit ? commit.slice(0, 7) : null,
    commitMessage: process.env.VERCEL_GIT_COMMIT_MESSAGE || null,
    branch: process.env.VERCEL_GIT_COMMIT_REF || null,
    environment: process.env.VERCEL_ENV || null,
    entryPoint: require.main ? require.main.filename : null,
  };
}
