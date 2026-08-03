'use strict';

/**
 * Wraps an async Express handler so a rejected promise reaches the error middleware.
 *
 * Express 4 does not await handlers, so without this an async handler that throws
 * leaves the request hanging until the client times out - the failure mode that looks
 * like a network problem and wastes an afternoon.
 */
function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = { asyncRoute };
