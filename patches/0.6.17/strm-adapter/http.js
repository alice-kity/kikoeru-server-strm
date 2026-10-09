'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const { pipeline } = require('stream/promises');
const { hostMatches } = require('./pointer');
const { withSharedHelperRate } = require('./shared-helper-rate');

const DEFAULT_HELPER_USER_AGENT = 'Mozilla/5.0';
const MAX_USER_AGENT_LENGTH = 512;

/**
 * Keep the consumer identity stable at the Helper boundary without ever
 * allowing a request header injection.  A missing, oversized, or malformed
 * browser value deliberately falls back to the same UA used by ffprobe and
 * cold-cache downloads.
 */
function normalizeUserAgent(value, fallback = DEFAULT_HELPER_USER_AGENT) {
  const fallbackText = String(fallback || DEFAULT_HELPER_USER_AGENT).trim();
  const safeFallback = !fallbackText || fallbackText.length > MAX_USER_AGENT_LENGTH
    || /[\u0000-\u001f\u007f]/.test(fallbackText)
    ? DEFAULT_HELPER_USER_AGENT
    : fallbackText;
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > MAX_USER_AGENT_LENGTH || /[\u0000-\u001f\u007f]/.test(text)) {
    return safeFallback;
  }
  return text;
}

function safeHeaderValue(value, fallback, maxLength = 256) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) return fallback;
  return text;
}

/**
 * Only a small, non-sensitive header allowlist crosses the Helper boundary.
 * In particular, Authorization/Cookie/Range from a browser request never do.
 */
function helperRequestHeaders(headers = {}, userAgent) {
  const supplied = headers && typeof headers === 'object' ? headers : {};
  const accept = supplied.accept ?? supplied.Accept;
  const cacheControl = supplied['cache-control'] ?? supplied['Cache-Control'];
  const pragma = supplied.pragma ?? supplied.Pragma;
  return {
    'User-Agent': normalizeUserAgent(userAgent ?? supplied['user-agent'] ?? supplied['User-Agent']),
    Accept: safeHeaderValue(accept, '*/*'),
    'Cache-Control': safeHeaderValue(cacheControl, 'no-cache'),
    Pragma: safeHeaderValue(pragma, 'no-cache'),
  };
}

/**
 * CDN downloads use the same UA as Helper HEAD by default.  Keep the
 * allowlist equally strict even though the caller normally supplies no extra
 * headers; a future caller cannot accidentally forward browser credentials.
 */
function mediaRequestHeaders(headers = {}, userAgent) {
  const supplied = headers && typeof headers === 'object' ? headers : {};
  const accept = supplied.accept ?? supplied.Accept;
  return {
    'User-Agent': normalizeUserAgent(userAgent ?? supplied['user-agent'] ?? supplied['User-Agent']),
    Accept: safeHeaderValue(accept, '*/*'),
  };
}

class HttpAdapterError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'HttpAdapterError';
    this.code = code;
    this.status = status;
  }
}

function validateHttpUrl(value, allowedSchemes = ['http:', 'https:']) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new HttpAdapterError('INVALID_REDIRECT_URL', 'remote URL is invalid', 502);
  }
  const schemes = new Set((Array.isArray(allowedSchemes) ? allowedSchemes : [allowedSchemes])
    .map(value => String(value).endsWith(':') ? String(value).toLowerCase() : `${String(value).toLowerCase()}:`));
  if (!schemes.has(parsed.protocol.toLowerCase()) || !parsed.hostname || parsed.username || parsed.password) {
    throw new HttpAdapterError('INVALID_REDIRECT_URL', 'remote URL is not allowed', 502);
  }
  return parsed;
}

async function requestOnce(parsed, method, timeoutMs, headers = {}, sharedRate = null, userAgent) {
  const run = () => requestOnceUnthrottled(parsed, method, timeoutMs, headers, userAgent);
  return withSharedHelperRate(sharedRate, run);
}

function requestOnceUnthrottled(parsed, method, timeoutMs, headers = {}, userAgent) {
  const transport = parsed.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(parsed, {
      method,
      // Helper responses contain short-lived signed CDN URLs.  An
      // intermediary may cache the 302 itself; returning that cached
      // Location after it expires makes the media client stall on the next
      // Range/seek request.  Force revalidation for every Helper lookup.  A
      // browser-like UA is intentional: the Helper's upstream cache has been
      // observed to serve a stale signed Location for the adapter-specific UA
      // even when no-cache is present.
      headers: helperRequestHeaders(headers, userAgent),
      timeout: timeoutMs,
    }, response => {
      // HEAD normally has no body.  Draining any unexpected body keeps the
      // socket reusable and avoids making the helper a resource leak.
      response.resume();
      resolve({
        statusCode: response.statusCode || 0,
        headers: response.headers || {},
      });
    });
    request.once('timeout', () => request.destroy(new HttpAdapterError('REMOTE_TIMEOUT', 'remote request timed out', 504)));
    request.once('error', reject);
    request.end();
  });
}

function parseRetryAfter(value, now = Date.now()) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw == null) return 0;
  const text = String(raw).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return Math.min(60 * 1000, Math.max(0, Math.ceil(Number(text) * 1000)));
  }
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return 0;
  return Math.min(60 * 1000, Math.max(0, at - now));
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function retryAfterFrom(response) {
  if (!response) return 0;
  if (Number.isFinite(Number(response.retryAfterMs))) {
    return Math.min(60 * 1000, Math.max(0, Number(response.retryAfterMs)));
  }
  const headers = response.headers || response;
  return parseRetryAfter(headers['retry-after'] || headers['Retry-After']);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeRateLimitedError(retryAfterMs = 0, rateLimitCount = 1) {
  const error = new HttpAdapterError('HELPER_RATE_LIMITED', 'pointer helper rate limited the request', 429);
  error.retryAfterMs = Math.min(60 * 1000, Math.max(0, Number(retryAfterMs) || 0));
  error.rateLimitCount = Math.max(1, Math.floor(Number(rateLimitCount) || 1));
  return error;
}

async function requestHelperHeadWithRetry(helper, requestHead, options) {
  const maxRetries = Math.floor(boundedNumber(options.max429Retries == null ? 3 : options.max429Retries, 3, 0, 3));
  const baseMs = boundedNumber(options.retryBaseMs == null ? 1000 : options.retryBaseMs, 1000, 0, 60 * 1000);
  const maxMs = Math.max(baseMs, boundedNumber(options.retryMaxMs == null ? 60 * 1000 : options.retryMaxMs, 60 * 1000, 0, 60 * 1000));
  const jitterMs = boundedNumber(options.retryJitterMs == null ? 250 : options.retryJitterMs, 250, 0, 5000);
  const wait = typeof options.sleep === 'function' ? options.sleep : sleep;
  let attempt = 0;
  while (true) {
    let response;
    try {
      response = await requestHead(helper, {
        timeoutMs: Number(options.timeoutMs || 10000),
        userAgent: normalizeUserAgent(options.userAgent),
      });
    } catch (error) {
      if (Number(error && error.status) !== 429) throw error;
      const retryAfterMs = retryAfterFrom(error);
      if (attempt >= maxRetries) throw makeRateLimitedError(retryAfterMs, attempt + 1);
      const exponential = Math.min(maxMs, baseMs * (2 ** attempt));
      const jitter = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;
      await wait(Math.min(60 * 1000, Math.max(exponential + jitter, retryAfterMs)));
      attempt += 1;
      continue;
    }
    if (Number(response && response.statusCode) !== 429) return response;
    const retryAfterMs = retryAfterFrom(response);
    if (attempt >= maxRetries) throw makeRateLimitedError(retryAfterMs, attempt + 1);
    const exponential = Math.min(maxMs, baseMs * (2 ** attempt));
    const jitter = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;
    await wait(Math.min(60 * 1000, Math.max(exponential + jitter, retryAfterMs)));
    attempt += 1;
  }
}

/** Resolve exactly one Helper redirect and validate its final Location. */
async function resolveRedirect(sourceUrl, options = {}) {
  const helper = validateHttpUrl(sourceUrl, options.allowedSchemes);
  const userAgent = normalizeUserAgent(options.userAgent);
  if (options.allowedHosts && !hostMatches(helper, options.allowedHosts)) {
    throw new HttpAdapterError('HELPER_HOST_NOT_ALLOWED', 'pointer helper host is not allowlisted', 403);
  }
  const requestHead = options.requestHead || ((url, opts) => requestOnce(
    url,
    'HEAD',
    opts.timeoutMs,
    {},
    options.sharedRate,
    userAgent,
  ));
  const response = await requestHelperHeadWithRetry(helper, requestHead, Object.assign({}, options, { userAgent }));
  if (response.statusCode === 403) {
    throw new HttpAdapterError('HELPER_FORBIDDEN', 'pointer helper rejected the request', 403);
  }
  if (response.statusCode < 300 || response.statusCode >= 400) {
    throw new HttpAdapterError('HELPER_NOT_REDIRECT', `pointer helper returned HTTP ${response.statusCode}`, 502);
  }
  const rawLocation = response.headers && (response.headers.location || response.headers.Location);
  const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
  if (!location) throw new HttpAdapterError('REDIRECT_LOCATION_MISSING', 'pointer helper did not return a Location', 502);
  let finalUrl;
  try {
    finalUrl = new URL(String(location), helper);
  } catch {
    throw new HttpAdapterError('INVALID_REDIRECT_URL', 'pointer helper Location is invalid', 502);
  }
  // A relative Location would keep the request on the helper and is not the
  // CDN offload contract.  Require an absolute URL for an auditable boundary.
  if (!/^https?:$/i.test(String(location).split(':', 1)[0] + ':') || String(location).startsWith('/')) {
    throw new HttpAdapterError('INVALID_REDIRECT_URL', 'pointer helper Location must be absolute', 502);
  }
  finalUrl = validateHttpUrl(finalUrl.toString(), options.allowedSchemes);
  if (options.finalAllowedHosts && !hostMatches(finalUrl, options.finalAllowedHosts)) {
    throw new HttpAdapterError('FINAL_HOST_NOT_ALLOWED', 'redirect destination host is not allowlisted', 403);
  }
  return {
    source: helper,
    final: finalUrl,
    statusCode: response.statusCode,
    // Kept only in memory so cold-cache GETs can use exactly the same UA as
    // the Helper HEAD.  Callers persist neither this field nor the URL.
    userAgent,
  };
}

function downloadToFile(finalUrl, partPath, options = {}) {
  const parsed = validateHttpUrl(finalUrl.toString ? finalUrl.toString() : finalUrl, options.allowedSchemes);
  if (options.finalAllowedHosts && !hostMatches(parsed, options.finalAllowedHosts)) {
    return Promise.reject(new HttpAdapterError('FINAL_HOST_NOT_ALLOWED', 'download host is not allowlisted', 403));
  }
  const maxBytes = Number(options.maxBytes || 0);
  const timeoutMs = Number(options.timeoutMs || 120000);
  const transport = parsed.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let settled = false;
    let output;
    const fail = async error => {
      if (settled) return;
      settled = true;
      if (output) output.destroy();
      await fs.promises.rm(partPath, { force: true }).catch(() => undefined);
      reject(error);
    };
    const request = transport.get(parsed, {
      headers: mediaRequestHeaders(options.headers, options.userAgent),
      timeout: timeoutMs,
    }, response => {
      const length = Number(response.headers['content-length']);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        void fail(new HttpAdapterError('DOWNLOAD_HTTP_STATUS', `remote download returned HTTP ${response.statusCode}`, 502));
        return;
      }
      if (maxBytes > 0 && Number.isFinite(length) && length > maxBytes) {
        // Do not drain an over-limit CDN response.  Draining would make the
        // server consume the complete media before the caller falls back to a
        // direct 302, violating the cold-path single-consumer guarantee.
        response.destroy();
        request.destroy();
        void fail(new HttpAdapterError('DOWNLOAD_TOO_LARGE', 'remote media exceeds the configured cache limit', 413));
        return;
      }
      output = fs.createWriteStream(partPath, { flags: 'w', mode: 0o600 });
      response.on('data', chunk => {
        bytes += chunk.length;
        if (maxBytes > 0 && bytes > maxBytes) {
          response.destroy(new HttpAdapterError('DOWNLOAD_TOO_LARGE', 'remote media exceeds the configured cache limit', 413));
        }
      });
      response.once('error', error => void fail(error));
      output.once('error', error => void fail(error));
      pipeline(response, output)
        .then(async () => {
          if (settled) return;
          settled = true;
          resolve({ bytes, contentType: response.headers['content-type'] || null });
        })
        .catch(error => void fail(error));
    });
    request.once('timeout', () => request.destroy(new HttpAdapterError('REMOTE_TIMEOUT', 'remote download timed out', 504)));
    request.once('error', error => void fail(error));
  });
}

module.exports = {
  DEFAULT_HELPER_USER_AGENT,
  MAX_USER_AGENT_LENGTH,
  normalizeUserAgent,
  helperRequestHeaders,
  mediaRequestHeaders,
  HttpAdapterError,
  validateHttpUrl,
  requestOnce,
  parseRetryAfter,
  resolveRedirect,
  downloadToFile,
};
