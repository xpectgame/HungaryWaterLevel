'use strict';

/**
 * Hide readings that a different provider wrote.
 *
 * The failure this exists for, seen in production: the deployment was switched from
 * fixture to live, and for the next few hours it kept serving the fixture rows already
 * in the store - under `provider: live`, `synthetic: false`, and each station labelled
 * `measured`. The Danube read 2050 m3/s while the river was carrying 820, and Paks
 * read 1966 MW, 98% of nameplate, while the plant was throttled back.
 *
 * Nothing lied on its own. The provider flag described the configuration, the quality
 * flag described how the row was obtained when it was written, and the age check found
 * rows well inside a day old. Put together they made generated numbers look measured.
 *
 * The rows always carried their origin - `source: 'fixture'` against `'vizugy'` or
 * `'mavir'`. This is the missing step: once the configured provider is live, a row from
 * the fixture era is not stale data, it is data from a different world, and it is
 * dropped. The balance then falls back to climatology and says so, which is a visible
 * gap rather than an invisible fiction.
 *
 * It also removes the manual cleanup that would otherwise be required at every switch:
 * a station whose upstream is working overwrites its own row on the next poll, and one
 * whose upstream is broken - MAVIR, at the time of writing - reports nothing instead of
 * repeating last week's fixture for a day.
 */

/** Sources that belong to the synthetic provider. */
const SYNTHETIC_SOURCES = new Set(['fixture', 'synthetic']);

function isForeign(source, provider) {
  if (!source) return false; // pre-dates the stamp; age is the only guard available
  const synthetic = SYNTHETIC_SOURCES.has(source);
  return provider === 'fixture' ? !synthetic : synthetic;
}

/**
 * Wrap a store so reads drop rows written under a different provider.
 *
 * Wrapping rather than filtering at each call site: there are seven routes reading the
 * store and one of them forgetting is exactly how this bug returns.
 */
function withProviderFilter(store, provider) {
  const keepReadings = (readings) => {
    if (!readings) return readings;
    const kept = {};
    for (const [id, reading] of Object.entries(readings)) {
      if (!isForeign(reading && reading.source, provider)) kept[id] = reading;
    }
    return kept;
  };

  return Object.create(store, {
    latestReadings: {
      value: async (...args) => keepReadings(await store.latestReadings(...args)),
    },
    latestGeneration: {
      value: async (...args) => {
        const generation = await store.latestGeneration(...args);
        return generation && isForeign(generation.source, provider) ? null : generation;
      },
    },
    readingAt: {
      value: async (...args) => {
        const reading = await store.readingAt(...args);
        return reading && isForeign(reading.source, provider) ? null : reading;
      },
    },
  });
}

module.exports = { withProviderFilter, isForeign, SYNTHETIC_SOURCES };
