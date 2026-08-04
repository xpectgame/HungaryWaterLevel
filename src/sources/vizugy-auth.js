'use strict';

const { fetchJson, browserHeaders } = require('../lib/http');

/**
 * Anonymous token acquisition for the hydrological query service.
 *
 * Read out of the portal's own bundle, which does exactly this:
 *
 *   requestNewToken() { return this.http.get(`${authApiBaseUrl}/token`).pipe(map(t => t.access_token)) }
 *   isTokenExpired(t) { return Date.now() > 1000 * JSON.parse(atob(t.split('.')[1])).exp }
 *
 * No credentials are involved - the endpoint hands a JWT to anyone who asks, which is
 * consistent with the data being published as open. The token is short-lived, so it is
 * cached until its own `exp` claim rather than re-fetched per request: a 15-minute poll
 * across ~30 stations would otherwise mint 30 tokens a cycle.
 */

const DEFAULT_AUTH_BASE_URL = 'https://data.vizugy.hu/AuthApi/auth';

// Refresh slightly early. A token that expires between the check and the request it
// authorises produces a 401 that looks like a permissions problem.
const EXPIRY_SKEW_MS = 60 * 1000;

/**
 * Read the `exp` claim without verifying the signature.
 *
 * Verification is the server's job; this only needs to know when to ask for a new one.
 */
function tokenExpiresAt(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString('utf8'));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function isTokenUsable(jwt, now = Date.now()) {
  if (!jwt) return false;
  const expiresAt = tokenExpiresAt(jwt);
  // An unparseable token is not necessarily invalid - the service may change its format.
  // Let the server reject it rather than refusing to try.
  if (expiresAt === null) return true;
  return now + EXPIRY_SKEW_MS < expiresAt;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.authBaseUrl]
 * @param {Function} [opts.fetch] injected for tests
 */
function createTokenProvider(opts = {}) {
  const authBaseUrl = opts.authBaseUrl || DEFAULT_AUTH_BASE_URL;
  // The gateway answers 403 to a request without them - see lib/http.
  const origin = new URL(authBaseUrl).origin;
  const request =
    opts.fetch || ((url) => fetchJson(url, { timeoutMs: 15000, headers: browserHeaders(origin) }));

  let token = null;
  let inFlight = null;

  async function getToken({ force = false } = {}) {
    if (!force && isTokenUsable(token)) return token;

    // A cold poll fires every station at once; they must share one token request.
    if (inFlight) return inFlight;

    inFlight = request(`${authBaseUrl}/token`)
      .then((body) => {
        const value = body && (body.access_token || body.accessToken || body.token);
        if (!value) {
          throw new Error(`No access_token in the response from ${authBaseUrl}/token`);
        }
        token = value;
        return token;
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  }

  return {
    getToken,
    /** Called after a 401 so the next attempt fetches a fresh token. */
    invalidate() {
      token = null;
    },
    get current() {
      return token;
    },
  };
}

module.exports = { createTokenProvider, tokenExpiresAt, isTokenUsable, DEFAULT_AUTH_BASE_URL };
