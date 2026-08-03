'use strict';

const { runOnce } = require('./poll');

/**
 * The cron request handler, separated from its Vercel wiring so it can be tested
 * against a real context instead of only in production.
 *
 * This endpoint writes, which is why it is the only one in the project that
 * authenticates. Two refusals matter:
 *
 *   - No secret in production. An unauthenticated write endpoint that anyone can spam
 *     would let a stranger drive the upstream fetch rate, which is exactly the load
 *     problem the cron exists to prevent.
 *   - A memory store. The cron would populate one instance's memory and return 200,
 *     while every other instance - including the ones serving traffic - stayed empty.
 *     Succeeding while achieving nothing is the worst possible outcome, so it fails
 *     loudly instead.
 */
function createCronHandler(ctx, { poll = runOnce, random = Math.random } = {}) {
  return async function cronHandler(req, res) {
    const { config, store, cache } = ctx;

    if (config.cronSecret) {
      const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (provided !== config.cronSecret) {
        // No detail - this endpoint writes, so it should not explain itself.
        return res.status(401).json({ error: 'Unauthorized' });
      }
    } else if (config.nodeEnv === 'production') {
      return res.status(500).json({
        error: 'CRON_SECRET is not set. Refusing to expose an unauthenticated write endpoint in production.',
      });
    }

    if (config.store === 'memory') {
      return res.status(500).json({
        error:
          'Cron requires shared storage. With STORE=memory the result would be written to an instance that serves no traffic. Set DATABASE_URL.',
      });
    }

    try {
      const summary = await poll(store, config);
      if (cache) cache.clear();

      // Pruning is a full scan and the data only ages out once a day, so it does not
      // belong on every tick.
      if (random() < 0.01) {
        summary.pruned = await store.prune(config.retentionDays);
      }

      return res.status(200).json({ ok: true, ...summary });
    } catch (err) {
      console.error('[cron] cycle failed:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  };
}

module.exports = { createCronHandler };
