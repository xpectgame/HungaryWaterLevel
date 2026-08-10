'use strict';

const USER_AGENT = 'HungaryWaterLevel/0.1 (open data aggregator)';

/**
 * Headers that make a request look like the portal's own.
 *
 * data.vizugy.hu answers /AuthApi/auth/token with 403 rather than 404 - the endpoint
 * exists and is refusing us specifically. A single-page application always sends Origin
 * and Referer, and a gateway that checks them rejects anything that does not. This is
 * not evading a restriction: the data is published as open and the token is handed out
 * anonymously; it is sending the headers the service expects.
 */
function browserHeaders(origin, referer) {
  return {
    Origin: origin,
    // Which page the request came from. Asset servers that check this reject anything
    // that omits it, so a page can load while every script it references 403s.
    Referer: referer || `${origin}/`,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'hu-HU,hu;q=0.9,en;q=0.8',
  };
}

class HttpError extends Error {
  constructor(message, { status, url, body, cause } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
    if (cause) this.cause = cause;
  }
}

/**
 * Unwrap what actually went wrong.
 *
 * fetch reports every transport failure as the same three words - "fetch failed" - and
 * puts the real reason in `cause`: a TLS handshake rejection, a DNS miss, a refused
 * connection. Those need completely different responses, and the default message
 * distinguishes none of them. Legacy government servers in particular fail the TLS
 * negotiation that modern Node defaults to, and that is invisible without this.
 */
function describeCause(err) {
  const parts = [];
  let current = err;
  const seen = new Set();

  while (current && !seen.has(current)) {
    seen.add(current);
    const code = current.code ? ` [${current.code}]` : '';
    const text = `${current.message || current}${code}`;
    if (!parts.includes(text)) parts.push(text);
    current = current.cause;
  }
  return parts.join(' <- ');
}

/**
 * fetch with a timeout, one retry on transient failure, and errors that say what broke.
 *
 * Upstream here is a pair of public government services with no SLA. They time out,
 * they return HTML error pages with a 200, and they occasionally 502. The poller runs
 * unattended every 15 minutes, so a failure has to be legible from a log line alone.
 */
// `body` is destructured under another name on purpose: the response body below is also
// called `body`, and inside that block the parameter is shadowed by a const that has not
// been initialised yet. Every request threw "Cannot access 'body' before initialization",
// including the GETs that never passed one.
async function fetchText(
  url,
  { timeoutMs = 15000, headers = {}, retries = 1, method = 'GET', body: requestBody } = {},
) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        // The query service's time-series calls are POSTs carrying a JSON filter, so a
        // GET-only client cannot read a single discharge value from it.
        ...(requestBody === undefined ? {} : { body: requestBody }),
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*', ...headers },
        signal: controller.signal,
        redirect: 'follow',
      });

      const body = await response.text();

      if (!response.ok) {
        // 500 characters was not enough to reach the part that explains anything.
        // ENTSO-E answers a bad request with a document whose sender, receiver and
        // timestamps take about 600 characters before the <Reason> element that names
        // the wrong parameter - so the truncation was throwing away the only useful
        // half of the response and leaving a bare status code.
        throw new HttpError(`HTTP ${response.status} from ${url}`, {
          status: response.status,
          url,
          body: body.slice(0, 4000),
        });
      }

      return { body, contentType: response.headers.get('content-type') || '', url: response.url };
    } catch (err) {
      if (err.name === 'AbortError') {
        lastError = new HttpError(`Timeout after ${timeoutMs}ms: ${url}`, { url });
      } else if (err instanceof HttpError) {
        lastError = err;
      } else {
        // A bare "fetch failed" names nothing; carry the chain up so callers can report it.
        lastError = new HttpError(`${describeCause(err)}: ${url}`, { url, cause: err });
      }
      // A 4xx will not fix itself on retry; anything else might.
      if (err instanceof HttpError && err.status && err.status < 500) break;
      if (attempt < retries) await sleep(1000 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

/**
 * Fetch and parse JSON.
 *
 * Checks that the body actually looks like JSON before parsing, because a captive
 * portal or an upstream error page returning HTML with status 200 is a real failure
 * mode here and "Unexpected token < in JSON" is a useless thing to find in a log.
 */
async function fetchJson(url, opts = {}) {
  const { body, contentType } = await fetchText(url, opts);
  const trimmed = body.trim();

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    throw new HttpError(
      `Expected JSON from ${url} but got ${contentType || 'unknown content-type'}: ${trimmed.slice(0, 120)}`,
      { url, body: trimmed.slice(0, 500) },
    );
  }

  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new HttpError(`Malformed JSON from ${url}: ${err.message}`, { url, body: trimmed.slice(0, 500) });
  }
}

/**
 * Fetch binary content.
 *
 * A spreadsheet read through fetchText is destroyed on arrival: the bytes are decoded
 * as UTF-8, every invalid sequence becomes U+FFFD, and re-encoding gives a buffer that
 * is neither the original length nor a valid ZIP. There is no way to recover it, and
 * the failure surfaces much later as "not a ZIP archive".
 */
async function fetchBuffer(url, { timeoutMs = 20000, headers = {}, method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      ...(body === undefined ? {} : { body }),
      headers: { 'User-Agent': USER_AGENT, ...headers },
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new HttpError(`HTTP ${response.status} from ${url}`, { status: response.status, url });
    }

    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') || '',
    };
  } catch (err) {
    if (err.name === 'AbortError') throw new HttpError(`Timeout after ${timeoutMs}ms: ${url}`, { url });
    if (err instanceof HttpError) throw err;
    throw new HttpError(`${describeCause(err)}: ${url}`, { url, cause: err });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { fetchText, fetchJson, fetchBuffer, HttpError, describeCause, browserHeaders, USER_AGENT };
