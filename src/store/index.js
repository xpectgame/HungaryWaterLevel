'use strict';

const { MemoryStore } = require('./memory');

/**
 * Picks a store implementation.
 *
 * `node:sqlite` is required lazily rather than at module load, so a serverless bundle
 * that only ever uses the memory store never touches the experimental SQLite binding -
 * and never emits its warning.
 */
function createStore(config) {
  if (config.store === 'postgres') {
    const { PostgresStore } = require('./postgres');
    return new PostgresStore(config.databaseUrl, { schema: config.databaseSchema });
  }

  if (config.store === 'memory') {
    return new MemoryStore({ maxSamplesPerStation: config.memoryMaxSamples });
  }

  const { TimeseriesStore } = require('./timeseries');
  return new TimeseriesStore(config.dbPath);
}

module.exports = { createStore, MemoryStore };
