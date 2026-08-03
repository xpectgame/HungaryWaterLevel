'use strict';

const { startPolling } = require('./jobs/poll');

/**
 * Standalone-server behaviour: bind a port, run the background poller, shut down
 * cleanly. Used when this project owns the process (a VPS, Railway, Fly, a container).
 *
 * Takes an already-built context and app rather than making its own, so the entry point
 * can hand over the same instances it exports - a host that imports the entry gets the
 * app, and running it directly gets the app plus a listening socket, with no chance of
 * two contexts and two database pools existing at once.
 */

/** The one line an operator reads to know where data lives and what keeps it fresh. */
function describeStore(config, store) {
  if (config.store === 'memory') return 'memory (no persistence)';
  if (config.store === 'postgres') return store.path;
  return config.dbPath;
}

function describeIngest(config) {
  if (config.backgroundPolling) return `background poll every ${Math.round(config.pollIntervalMs / 60000)} min`;
  if (config.lazyRefresh) return 'on demand, driven by requests';
  return 'external cron (nothing in this process fetches)';
}

function serve(ctx, app) {
  const { config, store, cache } = ctx;

  const stopPolling = config.backgroundPolling
    ? startPolling(store, config, {
        log: (...args) => {
          console.log(...args);
          // New data invalidates every derived response.
          cache.clear();
        },
        warn: console.warn,
        error: console.error,
      })
    : () => {};

  const server = app.listen(config.port, config.host, () => {
    console.log(`[api] HungaryWaterLevel listening on http://${config.host}:${config.port}`);
    console.log(`[api] provider=${config.provider}${config.provider === 'fixture' ? ' (SYNTHETIC DATA)' : ''}`);
    console.log(`[api] store=${describeStore(config, store)}, ingest=${describeIngest(config)}`);
  });

  const shutdown = (signal) => {
    console.log(`[api] ${signal} received, shutting down`);
    stopPolling();
    server.close(async () => {
      await store.close();
      process.exit(0);
    });
    // Do not let a hung connection keep the process alive forever.
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

module.exports = { serve, describeStore, describeIngest };
