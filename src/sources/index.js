'use strict';

const vizugy = require('./vizugy');
const mavir = require('./mavir');
const fixture = require('./fixture');

/**
 * Picks the data provider and gives the rest of the app one shape to code against.
 *
 * The live provider degrades one side at a time on purpose: if MAVIR is down the water
 * balance is still perfectly valid, and if the gauges are down the plant water figures
 * still are. Failing both because one broke would throw away good data.
 */
function createProvider(config) {
  if (config.provider === 'fixture') {
    return {
      name: 'fixture',
      synthetic: true,
      async fetchHydrology() {
        return fixture.fetchAll();
      },
      async fetchGeneration() {
        return fixture.fetchGeneration();
      },
    };
  }

  return {
    name: 'live',
    synthetic: false,
    async fetchHydrology() {
      return vizugy.fetchAll();
    },
    async fetchGeneration() {
      return mavir.fetchGeneration();
    },
  };
}

/** Fetch both sides, isolating failures so one dead upstream cannot take out the other. */
async function fetchAll(provider) {
  const [hydrologyResult, generationResult] = await Promise.allSettled([
    provider.fetchHydrology(),
    provider.fetchGeneration(),
  ]);

  const errors = [];

  let hydrology = null;
  if (hydrologyResult.status === 'fulfilled') {
    hydrology = hydrologyResult.value;
    if (hydrology.errors && hydrology.errors.length > 0) {
      errors.push({ upstream: 'vizugy', stationErrors: hydrology.errors });
    }
  } else {
    errors.push({ upstream: 'vizugy', error: errorMessage(hydrologyResult.reason) });
  }

  let generation = null;
  if (generationResult.status === 'fulfilled') {
    generation = generationResult.value;
  } else {
    errors.push({ upstream: 'mavir', error: errorMessage(generationResult.reason) });
  }

  return { hydrology, generation, errors, provider: provider.name, synthetic: provider.synthetic };
}

function errorMessage(reason) {
  if (!reason) return 'unknown error';
  return String(reason.message || reason);
}

module.exports = { createProvider, fetchAll, vizugy, mavir, fixture };
