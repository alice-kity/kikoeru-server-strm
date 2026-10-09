'use strict';

const crypto = require('crypto');
const fs = require('fs');

const DEFAULT_ALLOWED_SCHEMES = Object.freeze(['http:', 'https:']);
const FINAL_ALLOWED_HOSTS = Object.freeze(['.115cdn.net']);

class PointerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PointerError';
    this.code = code;
    this.status = details.status || 400;
    this.details = details;
  }
}

function normalizeSchemes(values) {
  const list = Array.isArray(values) ? values : String(values || '').split(',');
  return new Set(list.map(value => {
    const scheme = String(value).trim().toLowerCase();
    return scheme.endsWith(':') ? scheme : `${scheme}:`;
  }).filter(Boolean));
}

function normalizeHostPattern(value) {
  const pattern = String(value || '').trim().toLowerCase();
  return pattern;
}

function hostPatternValues(values) {
  if (Array.isArray(values)) return values;
  if (values == null) return [];
  return String(values).split(',');
}

function isValidHostPattern(pattern) {
  if (pattern.startsWith('.')) {
    return /^\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i.test(pattern);
  }
  if (/[/?#@]/.test(pattern) || pattern.includes('://')) return false;
  try {
    const parsed = new URL(`http://${pattern}`);
    return Boolean(parsed.hostname)
      && !parsed.username
      && !parsed.password
      && parsed.pathname === '/'
      && parsed.search === ''
      && parsed.hash === ''
      && parsed.host.toLowerCase() === pattern.toLowerCase();
  } catch {
    return false;
  }
}

function validateHostPatterns(values, options = {}) {
  const list = hostPatternValues(values);
  const field = String(options.field || 'host allowlist');
  if (!list.length) {
    throw new PointerError(options.requiredCode || 'HOST_ALLOWLIST_REQUIRED', `${field} is required`);
  }
  const normalized = list.map(normalizeHostPattern);
  if (normalized.some(pattern => !pattern || pattern.includes('*') || !isValidHostPattern(pattern))) {
    throw new PointerError(options.invalidCode || 'HOST_ALLOWLIST_INVALID', `${field} contains an empty or wildcard pattern`);
  }
  return normalized;
}

/**
 * Host matching is intentionally conservative.  An exact pattern can include
 * a port (`helper.example:13258`); a leading dot is a subdomain suffix and
 * does not match the bare parent domain.
 */
function hostMatches(urlOrHost, patterns) {
  const values = hostPatternValues(patterns);
  if (!values.length) return false;
  let hostname;
  let host;
  try {
    const parsed = urlOrHost instanceof URL ? urlOrHost : new URL(String(urlOrHost));
    hostname = parsed.hostname.toLowerCase();
    host = parsed.host.toLowerCase();
  } catch {
    const raw = String(urlOrHost || '').toLowerCase();
    host = raw;
    hostname = raw.split(':')[0];
  }
  for (const rawValue of values) {
    const pattern = normalizeHostPattern(rawValue);
    if (!pattern || pattern.includes('*')) continue;
    if (pattern.startsWith('.')) {
      if (hostname.endsWith(pattern) && hostname !== pattern.slice(1)) return true;
      continue;
    }
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      if (hostname.endsWith(suffix) && hostname !== suffix.slice(1)) return true;
      continue;
    }
    if (pattern === host || pattern === hostname) return true;
  }
  return false;
}

function pointerFingerprint(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parsePointerText(text, options = {}) {
  const maxBytes = Number(options.maxPointerBytes || 64 * 1024);
  const rawText = String(text == null ? '' : text);
  const rawBytes = Buffer.byteLength(rawText, 'utf8');
  if (rawBytes > maxBytes) {
    throw new PointerError('POINTER_TOO_LARGE', `STRM pointer exceeds ${maxBytes} bytes`, { status: 413 });
  }

  const withoutBom = rawText.replace(/^\uFEFF/, '');
  const lines = withoutBom.split(/\r?\n|\r/);
  let first = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim()) {
      first = index;
      break;
    }
  }
  if (first < 0) {
    throw new PointerError('POINTER_EMPTY', 'STRM pointer is empty');
  }
  const urlText = lines[first].trim();
  const trailing = lines.slice(first + 1).filter(line => line.trim());
  if (trailing.length) {
    throw new PointerError('POINTER_EXTRA_CONTENT', 'STRM pointer contains more than one non-empty URL line');
  }

  let parsed;
  try {
    parsed = new URL(urlText);
  } catch {
    throw new PointerError('POINTER_INVALID_URL', 'STRM pointer URL is invalid');
  }
  const allowedSchemes = normalizeSchemes(options.allowedSchemes || DEFAULT_ALLOWED_SCHEMES);
  if (!allowedSchemes.has(parsed.protocol.toLowerCase())) {
    throw new PointerError('POINTER_SCHEME_NOT_ALLOWED', `STRM pointer protocol is not allowed: ${parsed.protocol}`);
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.protocol === 'file:') {
    throw new PointerError('POINTER_URL_NOT_ALLOWED', 'STRM pointer URL contains a forbidden authority');
  }
  if (Object.prototype.hasOwnProperty.call(options, 'allowedHosts')) {
    validateHostPatterns(options.allowedHosts, { field: 'STRM helper host list' });
  }
  if (options.allowedHosts && !hostMatches(parsed, options.allowedHosts)) {
    throw new PointerError('POINTER_HOST_NOT_ALLOWED', 'STRM pointer host is not allowlisted');
  }
  if (options.allowedPrefixes && !options.allowedPrefixes.some(prefix => urlText.startsWith(String(prefix)))) {
    throw new PointerError('POINTER_PREFIX_NOT_ALLOWED', 'STRM pointer URL prefix is not allowlisted');
  }
  return {
    url: parsed.toString(),
    protocol: parsed.protocol.toLowerCase(),
    host: parsed.host.toLowerCase(),
    hostname: parsed.hostname.toLowerCase(),
    fingerprint: pointerFingerprint(rawText),
  };
}

async function readPointerFile(filePath, options = {}) {
  const maxBytes = Number(options.maxPointerBytes || 64 * 1024);
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const stat = await handle.stat();
    if (stat.size > maxBytes) {
      throw new PointerError('POINTER_TOO_LARGE', `STRM pointer exceeds ${maxBytes} bytes`, { status: 413 });
    }
    const buffer = Buffer.alloc(Math.max(1, stat.size));
    const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
    const parsed = parsePointerText(buffer.subarray(0, bytesRead).toString('utf8'), options);
    parsed.mtimeMs = Math.round(stat.mtimeMs);
    parsed.size = stat.size;
    return parsed;
  } catch (error) {
    if (error instanceof PointerError) throw error;
    if (error && error.code === 'ENOENT') {
      throw new PointerError('POINTER_NOT_FOUND', 'STRM pointer does not exist', { status: 404 });
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

function safeUrlForLog(value) {
  try {
    const parsed = new URL(String(value));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

module.exports = {
  DEFAULT_ALLOWED_SCHEMES,
  FINAL_ALLOWED_HOSTS,
  PointerError,
  hostMatches,
  validateHostPatterns,
  parsePointerText,
  pointerFingerprint,
  readPointerFile,
  safeUrlForLog,
};
