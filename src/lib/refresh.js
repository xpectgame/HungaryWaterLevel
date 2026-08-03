'use strict';

/**
 * On-demand refresh, for deployments with no long-running poller.
 *
 * On a server, a 15-minute interval keeps the store warm and this is a no-op. On
 * serverless there is no interval - the process only exists while it is handling a
 * request - so freshness has to be pulled in by the first request that notices the data
 * is old.
 *
 * Two things that matter under concurrency:
 *
 *   - Concurrent requests share one in-flight refresh rather than each firing their own.
 *     A cold instance receiving ten simultaneous requests must hit the upstream once,
 *     not ten times.
 *   - A failed refresh does not fail the request. Serving slightly stale data with an
 *     accurate `lastPollAt` beats a 500, and /health already reports staleness.
 */

function createRefresher(ctx, { runOnce } = {}) {
  const poll = runOnce || require('../jobs/poll').runOnce;
  let inFlight = null;
  let lastAttemptAt = 0;

  return async function ensureFresh() {
    if (!ctx.config.lazyRefresh) return;

    const lastPoll = ctx.store.lastPoll();
    const lastPollMs = lastPoll ? Date.parse(lastPoll.timestamp) : 0;
    const age = Date.now() - lastPollMs;

    if (age < ctx.config.pollIntervalMs) return;

    // After a failure, wait before trying again rather than hammering a dead upstream
    // on every single request.
    if (Date.now() - lastAttemptAt < ctx.config.refreshRetryMs) return;

    if (inFlight) {
      await inFlight;
      return;
    }

    lastAttemptAt = Date.now();
    inFlight = poll(ctx.store, ctx.config, quietLogger)
      .catch((err) => {
        console.error('[refresh] on-demand refresh failed:', err.message);
      })
      .finally(() => {
        inFlight = null;
        ctx.cache.clear();
      });

    await inFlight;
  };
}

/** Serverless logs are noisy enough; only failures are worth a line. */
const quietLogger = {
  log() {},
  warn() {},
  error: (...args) => console.error(...args),
};

/** Express middleware wrapper. */
function refreshMiddleware(ctx) {
  const ensureFresh = createRefresher(ctx);
  return (req, res, next) => {
    ensureFresh().then(() => next(), () => next());
  };
}

module.exports = { createRefresher, refreshMiddleware };
