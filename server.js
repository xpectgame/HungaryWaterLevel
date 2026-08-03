'use strict';

/**
 * The single entry point, for every deployment model.
 *
 * Hosts disagree about how to start a Node project. Some import the file named by
 * package.json `main` and require its default export to be a request handler. Some
 * derive the entry from the `start` script and import that instead. Some just run
 * `npm start` as a real process and expect it to listen on $PORT.
 *
 * Guessing which one applies cost this project two failed deployments, both reported as
 * "Invalid export found in module - the default export must be a function or server"
 * because the file the host picked exported named factories instead of a handler.
 *
 * So this file satisfies all three at once, and `main` and `start` both point here:
 *
 *   - imported -> the default export is the Express app, a valid handler
 *   - executed -> it also binds a port and starts the background poller
 *
 * Nothing else in the tree can be mistaken for an entry point: the factories live in
 * src/app.js and the standalone-server behaviour in src/cli.js, neither of which is
 * named `server`.
 *
 * A configuration error during construction is caught and served as a readable JSON
 * response rather than escaping as an opaque platform crash.
 */

const { createApp, createContext } = require('./src/app');
const { bootstrap } = require('./src/lib/serverless-entry');

const { handler, value: ctx } = bootstrap(() => createContext());
const app = handler || createApp(ctx);

module.exports = app;

// Only when run directly - an imported entry must not seize a port from its host.
if (require.main === module) {
  if (!ctx) {
    // The bootstrap already logged the reason; there is nothing to serve.
    process.exit(1);
  }
  require('./src/cli').serve(ctx, app);
}
