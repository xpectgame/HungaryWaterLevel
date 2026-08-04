'use strict';

/**
 * Standalone entry point - `npm start`, and the file `main` names.
 *
 * Hosts disagree about how to start a Node project: some import the file named by
 * `main`, some derive it from the `start` script, some let a framework preset scan for
 * a conventional filename like app.js or server.js. Guessing which applies cost this
 * project three failed deployments.
 *
 * The answer is to stop guessing: every name a detector can land on exports a built app.
 * This file re-exports src/app.js rather than constructing its own, so however the host
 * arrives, it gets the same instance - one context, one database pool.
 *
 * Run directly, it additionally binds a port and starts the background poller.
 */

const app = require('./src/app');

module.exports = app;

// Only when executed - an imported entry must not seize a port from its host.
if (require.main === module) {
  if (!app.context) {
    // Construction failed; bootstrap already logged the reason and there is nothing
    // to serve. The exported handler still reports it to any host that imports us.
    process.exit(1);
  }
  require('./src/cli').serve(app.context, app);
}
