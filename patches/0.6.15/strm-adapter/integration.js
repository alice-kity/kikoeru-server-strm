'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { StrmStateStore, makeRecordKey } = require('./state-store');
const { DurationProbeQueue } = require('./duration-queue');
const { StrmCacheManager } = require('./cache-manager');
const { RedirectRateLimiter } = require('./redirect-rate-limit');
const { SingleFlight } = require('./single-flight');
const { parseVirtualMediaName, DEFAULT_MEDIA_EXTENSIONS } = require('./virtual-name');
const {
  FINAL_ALLOWED_HOSTS,
  readPointerFile,
  PointerError,
  validateHostPatterns,
} = require('./pointer');
const {
  DEFAULT_HELPER_USER_AGENT,
  normalizeUserAgent,
  resolveRedirect,
} = require('./http');
const { scanStrmMemo, probeRemoteDuration } = require('./scanner');
const { sharedHelperStatus } = require('./shared-helper-rate');

const RUNTIME_SYMBOL = Symbol.for('kikoeru.strm.runtime.v1');
const LOUDNESS_METHODS = ['loudnorm', 'ebur128'];
const REDIRECT_MODES = ['direct', 'local'];

function envBoolean(value, fallback) {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function envNumber(value, fallback, min = 0) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, number) : fallback;
}

function envList(value, fallback) {
  if (value == null || value === '') return fallback;
  return String(value).split(',').map(item => item.trim()).filter(Boolean);
}

function normalizeHelperHosts(value) {
  const missing = value == null
    || (typeof value === 'string' && value.trim() === '')
    || (Array.isArray(value) && value.length === 0);
  try {
    return validateHostPatterns(value, { field: 'STRM_ALLOWED_HOSTS' });
  } catch (error) {
    const configError = new Error(missing
      ? 'STRM_ALLOWED_HOSTS is required; configure one or more Helper hosts'
      : 'STRM_ALLOWED_HOSTS contains an empty or wildcard pattern');
    configError.code = missing ? 'HELPER_HOST_REQUIRED' : 'HELPER_HOST_INVALID';
    configError.status = 500;
    configError.cause = error;
    throw configError;
  }
}

function normalizeLoudnessMethod(value, fallback = 'loudnorm') {
  const method = String(value == null ? '' : value).trim().toLowerCase();
  return LOUDNESS_METHODS.includes(method) ? method : fallback;
}

function normalizeRedirectMode(value, fallback = 'direct') {
  const mode = String(value == null ? '' : value).trim().toLowerCase();
  return REDIRECT_MODES.includes(mode) ? mode : fallback;
}

const REDIRECT_CALIBRATION_VERSION = 3;
const REDIRECT_RESOLVE_DEFAULTS = Object.freeze({
  method: 'HEAD',
  timeoutMs: 10000,
  maxConcurrent: 1,
  minIntervalMs: 1000,
  maxQueue: 32,
  perMinute: 30,
  perHour: 1800,
  cacheTtlMs: 10000,
  cooldownMs: 1000,
  severeCooldownMs: 60000,
  severeAfter429: 3,
  max429Retries: 3,
  retryBaseMs: 1000,
  retryMaxMs: 60000,
  retryJitterMs: 250,
});

/**
 * Keep runtime compatibility with the entrypoint migration. Only the known
 * overlay defaults (150/120 or 400/120, calibration <=2) are recalibrated;
 * clearly custom intervals/budgets remain operator-owned values.
 */
function migrateRedirectResolveConfig(config = {}, sourceConfig = config) {
  const raw = sourceConfig && typeof sourceConfig === 'object' ? sourceConfig : {};
  const result = Object.assign({}, REDIRECT_RESOLVE_DEFAULTS, config || {});
  const calibration = Number(raw.calibrationVersion || 0);
  const minInterval = Number(raw.minIntervalMs);
  const perHour = Number(raw.perHour);
  const hasPerMinute = Object.prototype.hasOwnProperty.call(raw, 'perMinute');
  const hasPerHour = Object.prototype.hasOwnProperty.call(raw, 'perHour');
  const legacyNoBudget = !hasPerMinute && !hasPerHour && (minInterval === 150 || minInterval === 400);
  const legacyCalibrated = calibration <= 2 && perHour === 120 && (minInterval === 150 || minInterval === 400);
  if (legacyNoBudget || legacyCalibrated) {
    result.minIntervalMs = 1000;
    result.perHour = 1800;
    if (legacyNoBudget && Number(raw.maxQueue) === 64) result.maxQueue = 32;
  }
  result.calibrationVersion = REDIRECT_CALIBRATION_VERSION;
  return result;
}

const PRELOAD_PURPOSE_RE = /(^|[;,\s])(prefetch|preload|prerender)(?=$|[;,\s])/i;

function requestHeader(req, name) {
  const headers = req && req.headers ? req.headers : {};
  const lowerName = name.toLowerCase();
  const value = headers[lowerName] == null ? headers[name] : headers[lowerName];
  return Array.isArray(value) ? value[0] : value;
}

function safeRangeHeader(value) {
  if (!value) return '';
  const text = String(value).trim();
  return /^bytes=\d*-\d*(?:,\d*-\d*){0,3}$/i.test(text) ? text.slice(0, 96) : '[present]';
}

function userAgentHash(value) {
  return crypto.createHash('sha256').update(normalizeUserAgent(value)).digest('hex').slice(0, 16);
}

function preloadSignal(value) {
  const match = String(value || '').match(PRELOAD_PURPOSE_RE);
  return match ? match[2].toLowerCase() : '';
}

/**
 * Identify only explicit prefetch signals by default.  Range alone is never
 * treated as prefetch because ordinary playback and seek requests use Range.
 * `mode=observe` is the safe default; `detectHead` remains opt-in because
 * clients may use HEAD for ordinary media probing.
 */
function classifyPreloadRequest(req, settings = {}) {
  const options = typeof settings === 'object' && settings ? settings : {};
  const requestedMode = String(options.mode || 'observe').toLowerCase();
  const mode = ['off', 'observe', 'short-circuit'].includes(requestedMode) ? requestedMode : 'observe';
  const enabled = options.enabled !== false && mode !== 'off';
  // Keep only the recognized token for diagnostics.  An arbitrary header can
  // contain query-like data and must never be copied into logs.
  const purpose = preloadSignal(requestHeader(req, 'purpose'));
  const secPurpose = preloadSignal(requestHeader(req, 'sec-purpose'));
  const purposeMatch = Boolean(purpose || secPurpose);
  const headMatch = options.detectHead === true && String(req && req.method || '').toUpperCase() === 'HEAD';
  const isPreload = purposeMatch || headMatch;
  const reason = purposeMatch ? 'purpose' : (headMatch ? 'head-opt-in' : 'none');
  return {
    isPreload,
    explicit: purposeMatch,
    shortCircuit: Boolean(enabled && mode === 'short-circuit' && isPreload),
    reason,
    purpose,
    secPurpose,
    range: safeRangeHeader(requestHeader(req, 'range')),
  };
}

function logPreloadDiagnostic(req, target, decision, logger = console) {
  logger.info?.('[STRM] preload guard work=%s index=%s reason=%s range=%s purpose=%s secPurpose=%s',
    target && target.workId == null ? '-' : target.workId,
    target && target.index == null ? '-' : target.index,
    decision.reason,
    decision.range || '-',
    decision.purpose || '-',
    decision.secPurpose || '-');
}

function sendPreloadResponse(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('X-Kikoeru-Strm-Preload', 'skipped');
  return res.status(204).end();
}

async function resolveWithPreloadGuard({ req, target, runtime, resolveFinal = resolveRedirect, logger = console } = {}) {
  const decision = classifyPreloadRequest(req, runtime && runtime.options && runtime.options.preloadGuard);
  if (decision.isPreload) logPreloadDiagnostic(req, target, decision, logger);
  if (decision.shortCircuit) return { preload: true, decision, resolved: null };
  const userAgent = normalizeUserAgent(requestHeader(req, 'user-agent'));
  const resolved = await resolveFinal(target.pointer.url, Object.assign(
    {},
    runtime.redirectOptions(userAgent),
    { userAgent },
  ));
  return { preload: false, decision, resolved };
}

function defaultStrmConfig(appRoot, upstreamConfig) {
  const configured = upstreamConfig.strm && typeof upstreamConfig.strm === 'object' ? upstreamConfig.strm : {};
  const cacheRoot = configured.coldCache && configured.coldCache.rootDir
    ? configured.coldCache.rootDir
    : path.join(upstreamConfig.databaseFolderDir || path.join(appRoot, 'sqlite'), 'strm-cache');
  const result = Object.assign({
    enabled: true,
    redirectMode: 'direct',
    extension: '.strm',
    filenameMode: 'media-extension-before-strm',
    allowedSchemes: ['http', 'https'],
    // Helper hosts are deployment-owned.  Never ship a private/default Helper
    // endpoint; createRuntime fails explicitly until one is configured.
    allowedHosts: [],
    finalAllowedHosts: FINAL_ALLOWED_HOSTS.slice(),
    maxPointerBytes: 64 * 1024,
    durationProbe: {
      enabled: true,
      intervalMs: 2000,
      maxConcurrent: 1,
      timeoutMs: 60000,
      maxQueue: 1000,
      retryDelayMs: 60 * 60 * 1000,
    },
    redirectResolve: {
      method: 'HEAD',
      timeoutMs: 10000,
      maxConcurrent: 1,
      minIntervalMs: 1000,
      maxQueue: 32,
      perMinute: 30,
      perHour: 1800,
      cacheTtlMs: 10000,
      cooldownMs: 1000,
      severeCooldownMs: 60000,
      severeAfter429: 3,
      max429Retries: 3,
      retryBaseMs: 1000,
      retryMaxMs: 60000,
      retryJitterMs: 250,
    },
    // Purpose/Sec-Purpose is observed by default.  Client media requests can
    // carry those markers too, so interruption is an explicit opt-in.
    preloadGuard: {
      enabled: true,
      mode: 'observe',
      detectHead: false,
      calibrationVersion: 2,
    },
    coldCache: {
      enabled: true,
      rootDir: cacheRoot,
      maxTotalBytes: 20 * 1024 * 1024 * 1024,
      maxFileBytes: 2 * 1024 * 1024 * 1024,
      maxVideoBytes: 512 * 1024 * 1024,
      cleanupPolicy: 'lru+ttl',
      maxAgeMs: 30 * 24 * 60 * 60 * 1000,
      cleanupIntervalMs: 60 * 60 * 1000,
      downloadTimeoutMs: 15 * 60 * 1000,
    },
    loudness: {
      enabled: true,
      audioOnly: true,
      method: 'loudnorm',
      timeoutMs: 15 * 60 * 1000,
    },
    statePath: path.join(upstreamConfig.databaseFolderDir || path.join(appRoot, 'sqlite'), 'strm-state.json'),
  }, configured, {
    durationProbe: Object.assign({
      enabled: true, intervalMs: 2000, maxConcurrent: 1, timeoutMs: 60000,
      maxQueue: 1000, retryDelayMs: 60 * 60 * 1000,
    }, configured.durationProbe || {}),
    redirectResolve: Object.assign({
      method: 'HEAD', timeoutMs: 10000, maxConcurrent: 1, minIntervalMs: 1000,
      maxQueue: 32, perMinute: 30, perHour: 1800, cacheTtlMs: 10000,
      cooldownMs: 1000, severeCooldownMs: 60000, severeAfter429: 3,
      max429Retries: 3, retryBaseMs: 1000, retryMaxMs: 60000, retryJitterMs: 250,
    }, configured.redirectResolve || {}),
    preloadGuard: Object.assign({ enabled: true, mode: 'observe', detectHead: false, calibrationVersion: 2 }, configured.preloadGuard || {}),
    coldCache: Object.assign({
      enabled: true, rootDir: cacheRoot, maxTotalBytes: 20 * 1024 * 1024 * 1024,
      maxFileBytes: 2 * 1024 * 1024 * 1024, maxVideoBytes: 512 * 1024 * 1024,
      cleanupPolicy: 'lru+ttl', maxAgeMs: 30 * 24 * 60 * 60 * 1000,
      cleanupIntervalMs: 60 * 60 * 1000, downloadTimeoutMs: 15 * 60 * 1000,
    }, configured.coldCache || {}),
    loudness: Object.assign({ enabled: true, audioOnly: true, method: 'loudnorm', timeoutMs: 15 * 60 * 1000 }, configured.loudness || {}),
  });
  result.redirectMode = normalizeRedirectMode(result.redirectMode);
  result.finalAllowedHosts = FINAL_ALLOWED_HOSTS.slice();
  result.loudness.method = normalizeLoudnessMethod(result.loudness.method);
  const configuredRedirect = configured.redirectResolve && typeof configured.redirectResolve === 'object'
    ? configured.redirectResolve : {};
  result.redirectResolve = migrateRedirectResolveConfig(result.redirectResolve, configuredRedirect);
  return result;
}

function createRuntime(appRoot) {
  const configModule = require(path.join(appRoot, 'dist/src/config.js'));
  const upstreamConfig = configModule.config;
  const base = defaultStrmConfig(appRoot, upstreamConfig);
  const configuredHelperHosts = process.env.STRM_ALLOWED_HOSTS == null
    || String(process.env.STRM_ALLOWED_HOSTS).trim() === ''
    ? base.allowedHosts
    : process.env.STRM_ALLOWED_HOSTS;
  const helperHosts = normalizeHelperHosts(configuredHelperHosts);
  const runtimeConfig = Object.assign({}, upstreamConfig, {
    strm: Object.assign({}, upstreamConfig.strm || {}, {
      allowedHosts: helperHosts,
      finalAllowedHosts: FINAL_ALLOWED_HOSTS.slice(),
    }),
  });
  const options = Object.assign({}, base, {
    enabled: envBoolean(process.env.STRM_ENABLED, base.enabled),
    redirectMode: normalizeRedirectMode(process.env.STRM_REDIRECT_MODE, base.redirectMode),
    allowedSchemes: envList(process.env.STRM_ALLOWED_SCHEMES, base.allowedSchemes),
    allowedHosts: helperHosts,
    finalAllowedHosts: FINAL_ALLOWED_HOSTS.slice(),
    maxPointerBytes: envNumber(process.env.STRM_MAX_POINTER_BYTES, base.maxPointerBytes, 1),
    statePath: process.env.STRM_STATE_PATH || base.statePath,
    redirectResolve: Object.assign({}, base.redirectResolve, {
      maxConcurrent: envNumber(process.env.STRM_REDIRECT_MAX_CONCURRENT, base.redirectResolve.maxConcurrent, 1),
      minIntervalMs: envNumber(process.env.STRM_REDIRECT_MIN_INTERVAL_MS, base.redirectResolve.minIntervalMs),
      maxQueue: envNumber(process.env.STRM_REDIRECT_MAX_QUEUE, base.redirectResolve.maxQueue, 1),
      perMinute: envNumber(process.env.STRM_REDIRECT_PER_MINUTE, base.redirectResolve.perMinute, 1),
      perHour: envNumber(process.env.STRM_REDIRECT_PER_HOUR, base.redirectResolve.perHour, 1),
      cacheTtlMs: envNumber(process.env.STRM_REDIRECT_CACHE_TTL_MS, base.redirectResolve.cacheTtlMs),
      cooldownMs: envNumber(process.env.STRM_REDIRECT_COOLDOWN_MS, base.redirectResolve.cooldownMs),
      severeCooldownMs: envNumber(process.env.STRM_REDIRECT_SEVERE_COOLDOWN_MS, base.redirectResolve.severeCooldownMs, 1),
      severeAfter429: envNumber(process.env.STRM_REDIRECT_SEVERE_AFTER_429, base.redirectResolve.severeAfter429, 1),
      max429Retries: envNumber(process.env.STRM_REDIRECT_MAX_429_RETRIES, base.redirectResolve.max429Retries),
      retryBaseMs: envNumber(process.env.STRM_REDIRECT_RETRY_BASE_MS, base.redirectResolve.retryBaseMs),
      retryMaxMs: envNumber(process.env.STRM_REDIRECT_RETRY_MAX_MS, base.redirectResolve.retryMaxMs, 1),
      retryJitterMs: envNumber(process.env.STRM_REDIRECT_RETRY_JITTER_MS, base.redirectResolve.retryJitterMs),
    }),
    preloadGuard: Object.assign({}, base.preloadGuard, {
      enabled: envBoolean(process.env.STRM_PRELOAD_GUARD_ENABLED, base.preloadGuard.enabled),
      mode: process.env.STRM_PRELOAD_GUARD_MODE || base.preloadGuard.mode,
      detectHead: envBoolean(process.env.STRM_PRELOAD_GUARD_DETECT_HEAD, base.preloadGuard.detectHead),
    }),
    durationProbe: Object.assign({}, base.durationProbe, {
      enabled: envBoolean(process.env.STRM_DURATION_PROBE_ENABLED, base.durationProbe.enabled),
      intervalMs: envNumber(process.env.STRM_DURATION_PROBE_INTERVAL_MS, base.durationProbe.intervalMs),
      maxQueue: envNumber(process.env.STRM_DURATION_PROBE_MAX_QUEUE, base.durationProbe.maxQueue, 1),
      timeoutMs: envNumber(process.env.STRM_DURATION_PROBE_TIMEOUT_MS, base.durationProbe.timeoutMs, 1),
    }),
    coldCache: Object.assign({}, base.coldCache, {
      enabled: envBoolean(process.env.STRM_COLD_CACHE_ENABLED, base.coldCache.enabled),
      rootDir: process.env.STRM_CACHE_ROOT || base.coldCache.rootDir,
      maxTotalBytes: envNumber(process.env.STRM_CACHE_MAX_TOTAL_BYTES, base.coldCache.maxTotalBytes),
      maxFileBytes: envNumber(process.env.STRM_CACHE_MAX_FILE_BYTES, base.coldCache.maxFileBytes),
      maxVideoBytes: envNumber(process.env.STRM_CACHE_MAX_VIDEO_BYTES, base.coldCache.maxVideoBytes),
      maxAgeMs: envNumber(process.env.STRM_CACHE_MAX_AGE_MS, base.coldCache.maxAgeMs),
      cleanupIntervalMs: envNumber(process.env.STRM_CACHE_CLEANUP_INTERVAL_MS, base.coldCache.cleanupIntervalMs),
    }),
    loudness: Object.assign({}, base.loudness, {
      enabled: envBoolean(process.env.STRM_LOUDNESS_ENABLED, base.loudness.enabled),
      audioOnly: envBoolean(process.env.STRM_LOUDNESS_AUDIO_ONLY, base.loudness.audioOnly),
      method: normalizeLoudnessMethod(process.env.STRM_LOUDNESS_METHOD, base.loudness.method),
    }),
  });
  const store = new StrmStateStore(options.statePath);
  const queue = new DurationProbeQueue({
    intervalMs: options.durationProbe.intervalMs,
    maxQueue: options.durationProbe.maxQueue,
  });
  const cache = new StrmCacheManager({
    store,
    config: Object.assign({}, options.coldCache, {
      loudnessEnabled: options.loudness.enabled,
      loudnessAudioOnly: options.loudness.audioOnly,
      loudnessMethod: options.loudness.method,
      loudnessTimeoutMs: options.loudness.timeoutMs,
    }),
    logger: {
      error(...args) { console.error(...args); },
      warn(...args) { console.warn(...args); },
    },
  });
  const redirects = new RedirectRateLimiter(options.redirectResolve, {
    warn(...args) { console.warn(...args); },
  });
  const runtime = {
    appRoot,
    configModule,
    config: runtimeConfig,
    options,
    store,
    queue,
    cache,
    redirects,
    coldStarts: new SingleFlight(),
    metrics: {
      coldLocal: 0,
      hotRedirect: 0,
      localPlayback: 0,
      preloadSkip: 0,
    },
    ready: store.init(),
    pointerOptions() {
      return {
        maxPointerBytes: runtime.options.maxPointerBytes,
        allowedSchemes: runtime.options.allowedSchemes,
        allowedHosts: runtime.options.allowedHosts,
      };
    },
    redirectOptions(userAgent = DEFAULT_HELPER_USER_AGENT) {
      return {
        allowedSchemes: runtime.options.allowedSchemes,
        allowedHosts: runtime.options.allowedHosts,
        finalAllowedHosts: FINAL_ALLOWED_HOSTS.slice(),
        userAgent: normalizeUserAgent(userAgent),
        timeoutMs: runtime.options.redirectResolve.timeoutMs,
        max429Retries: runtime.options.redirectResolve.max429Retries,
        retryBaseMs: runtime.options.redirectResolve.retryBaseMs,
        retryMaxMs: runtime.options.redirectResolve.retryMaxMs,
        retryJitterMs: runtime.options.redirectResolve.retryJitterMs,
        sharedRate: {
          path: `${runtime.options.statePath}.helper-budget.json`,
          minIntervalMs: runtime.options.redirectResolve.minIntervalMs,
          perMinute: runtime.options.redirectResolve.perMinute,
          perHour: runtime.options.redirectResolve.perHour,
        },
      };
    },
    async updateOptions(next) {
      const safeNext = Object.assign({}, next, {
        allowedHosts: normalizeHelperHosts(next.allowedHosts),
        finalAllowedHosts: FINAL_ALLOWED_HOSTS.slice(),
      });
      runtime.options = safeNext;
      runtime.config.strm = safeNext;
      runtime.redirects.configure(safeNext.redirectResolve || {});
      runtime.cache.configure(Object.assign({}, safeNext.coldCache, {
        loudnessEnabled: safeNext.loudness.enabled,
        loudnessAudioOnly: safeNext.loudness.audioOnly,
        loudnessMethod: safeNext.loudness.method,
      }));
      if (typeof runtime.configModule.setNewConfigValue === 'function') {
        runtime.configModule.setNewConfigValue({ strm: safeNext });
      }
      return safeNext;
    },
  };
  // Expose a deliberately non-sensitive status handle for smoke tests and
  // operators.  It contains no pointer URL or CDN Location.
  global[RUNTIME_SYMBOL] = runtime;
  return runtime;
}

function getRuntime(appRoot) {
  return global[RUNTIME_SYMBOL] || createRuntime(appRoot);
}

function rootContext(config, dir) {
  const absoluteDir = path.resolve(dir);
  const roots = Array.isArray(config.rootFolders) ? config.rootFolders : [];
  let match = null;
  for (const root of roots) {
    if (!root || !root.path) continue;
    const rootPath = path.resolve(root.path);
    const rel = path.relative(rootPath, absoluteDir);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      if (!match || rootPath.length > match.rootPath.length) {
        match = { rootFolder: root.name, rootPath, workRelativePath: rel.split(path.sep).join('/') };
      }
    }
  }
  return match || { rootFolder: '', rootPath: path.parse(absoluteDir).root, workRelativePath: '' };
}

function withStrmExtensionGate(utilsExports, task) {
  // `scrapeWorkMemo` has the extension list in its closure.  Temporarily
  // hiding `.strm` while it probes local files prevents ffprobe from opening
  // a pointer text file.  Calls are serialized so concurrent scans cannot
  // observe an incomplete list mutation.
  const gate = utilsExports.__strmGate || { tail: Promise.resolve() };
  utilsExports.__strmGate = gate;
  const previous = gate.tail;
  let release;
  gate.tail = new Promise(resolve => { release = resolve; });
  return previous.then(async () => {
    const list = utilsExports.supportedMediaExtList;
    const index = Array.isArray(list) ? list.indexOf('.strm') : -1;
    if (index >= 0) list.splice(index, 1);
    try {
      return await task();
    } finally {
      if (index >= 0 && !list.includes('.strm')) list.push('.strm');
      release();
    }
  });
}

function installUtils(utilsExports, appRoot) {
  if (!utilsExports || utilsExports.__strmAdapterInstalled) return;
  const runtime = getRuntime(appRoot);
  const originalScrape = utilsExports.scrapeWorkMemo;
  const originalGetTrackList = utilsExports.getTrackList;
  const originalToTree = utilsExports.toTree;
  const mediaList = utilsExports.supportedMediaExtList;
  if (Array.isArray(mediaList) && !mediaList.includes('.strm')) mediaList.push('.strm');

  utilsExports.getTrackList = async function getTrackListWithStrm(id, dir, memo) {
    await runtime.ready;
    // The extension list must remain intact for the original track-list
    // filter: removing `.strm` here would make every pointer disappear from
    // the work tree.  Only scrapeWorkMemo below uses the gate, because that is
    // the path where upstream invokes local ffprobe.
    const tracks = await originalGetTrackList(id, dir, memo);
    return tracks.map(track => {
      if (String(track.ext).toLowerCase() !== '.strm') return track;
      const virtual = parseVirtualMediaName(track.title, DEFAULT_MEDIA_EXTENSIONS);
      return Object.assign(track, {
        isStrm: true,
        sourceExt: '.strm',
        mediaExt: virtual.mediaExt || null,
        displayTitle: virtual.displayName || track.title,
        isVideo: Boolean(virtual.isVideo),
      });
    });
  };

  utilsExports.scrapeWorkMemo = async function scrapeWorkMemoWithStrm(dir, oldMemo = {}) {
    await runtime.ready;
    const localMemo = await withStrmExtensionGate(utilsExports, () => originalScrape(dir, oldMemo));
    const context = rootContext(runtime.config, dir);
    const strmMemo = await scanStrmMemo(dir, {
      oldMemo,
      store: runtime.store,
      queue: runtime.queue,
      rootFolder: context.rootFolder,
      workRelativePath: context.workRelativePath,
      pointerOptions: runtime.pointerOptions(),
      probeEnabled: runtime.options.enabled && runtime.options.durationProbe.enabled,
      probeTimeoutMs: runtime.options.durationProbe.timeoutMs,
      retryDelayMs: runtime.options.durationProbe.retryDelayMs,
      logger: {
        info(message) { console.info(message); },
        warn(message) { console.warn(message); },
      },
      probe: async (url, probeOptions, entry) => {
        const target = {
          key: entry.key,
          pointerFingerprint: entry.pointer.fingerprint,
          pointer: { url },
          userAgent: DEFAULT_HELPER_USER_AGENT,
        };
        const resolved = await resolveStrmRedirect(runtime, target);
        return probeRemoteDuration(resolved.final.toString(), Object.assign({}, probeOptions, {
          userAgent: resolved.userAgent || DEFAULT_HELPER_USER_AGENT,
        }));
      },
    });
    localMemo.duration = Object.assign({}, localMemo.duration || {}, strmMemo.duration);
    localMemo.mtime = Object.assign({}, localMemo.mtime || {}, strmMemo.mtime);
    localMemo.strm = strmMemo.strm;
    localMemo.isContainLyric = Boolean(localMemo.isContainLyric || strmMemo.isContainLyric);
    return localMemo;
  };

  utilsExports.toTree = function toTreeWithStrm(...args) {
    const tree = originalToTree(...args);
    function rewrite(items) {
      for (const item of items || []) {
        if (item.type === 'folder') {
          rewrite(item.children);
          continue;
        }
        if (!/\.strm$/i.test(String(item.title || ''))) continue;
        const virtual = parseVirtualMediaName(item.title, DEFAULT_MEDIA_EXTENSIONS);
        item.sourceExt = '.strm';
        item.isStrm = true;
        item.mediaExt = virtual.mediaExt || null;
        item.isVideo = Boolean(virtual.isVideo);
        if (virtual.valid) {
          item.title = virtual.displayName;
          item.ext = virtual.mediaExt;
          item.type = virtual.isVideo ? 'video' : 'audio';
        }
      }
    }
    rewrite(tree);
    return tree;
  };
  Object.defineProperty(utilsExports, '__strmAdapterInstalled', { value: true, enumerable: false });
}

function jsonMemo(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function isWithin(base, candidate) {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function errorCode(error) {
  return String(error && error.code || 'STRM_REQUEST_FAILED').replace(/[^A-Z0-9_-]/gi, '').slice(0, 64) || 'STRM_REQUEST_FAILED';
}

function sendStrmError(res, error) {
  const code = errorCode(error);
  const status = Number(error && error.status) >= 400 && Number(error.status) < 600 ? Number(error.status) : 502;
  // Never include an URL, query string, request headers or an upstream error
  // message in the response/log.  The code is enough for operator diagnosis.
  console.warn('[STRM] request failed code=%s', code);
  if (!res.headersSent) {
    if (status === 429 && Number(error && error.retryAfterMs) > 0) {
      const retryAfter = String(Math.ceil(Number(error.retryAfterMs) / 1000));
      if (typeof res.set === 'function') res.set('Retry-After', retryAfter);
      else res.setHeader?.('Retry-After', retryAfter);
    }
    res.status(status).json({ error: 'STRM media request failed', code });
  }
}

function incrementMetric(runtime, name) {
  if (!runtime || !runtime.metrics) return;
  runtime.metrics[name] = Number(runtime.metrics[name] || 0) + 1;
}

function sendStrmRedirect(res, runtime, finalUrl) {
  // The in-process resolver may reuse a validated Location briefly, but a
  // signed 302 must never be cached by a browser/proxy: the Helper does not
  // expose a reliable expiry contract and stale Locations break seek/Range.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vary', 'User-Agent');
  return res.redirect(302, finalUrl.toString());
}

function redirectRequestKey(target, userAgent = target && target.userAgent) {
  const normalizedUserAgent = normalizeUserAgent(userAgent);
  return `${String(target && target.key || '')}:${String(target && target.pointerFingerprint || '')}:${userAgentHash(normalizedUserAgent)}`;
}

function resolveStrmRedirect(runtime, target, resolveFinal = resolveRedirect) {
  const userAgent = normalizeUserAgent(target && target.userAgent);
  const task = () => resolveFinal(target.pointer.url, Object.assign(
    {},
    runtime.redirectOptions(userAgent),
    { userAgent },
  ));
  if (runtime.redirects && typeof runtime.redirects.resolve === 'function') {
    return runtime.redirects.resolve(redirectRequestKey(target, userAgent), task);
  }
  return task();
}

/**
 * Resolve and download one STRM media object as a single cold-start task.
 * Playback and loudnorm requests must share this flight; otherwise an iOS
 * client that asks for loudnorm before opening the media URL can leave the
 * first-play download permanently unstarted.
 */
function ensureStrmLocal(runtime, target, resolveFinal = resolveRedirect, cacheOptions = {}) {
  // Cold local delivery deliberately uses one stable consumer identity for
  // every client.  This keeps Helper HEAD, CDN GET, and cache-manager's
  // default download UA aligned and avoids sharing a media cache flight across
  // browser-specific identities.
  const coldTarget = Object.assign({}, target, { userAgent: DEFAULT_HELPER_USER_AGENT });
  const task = async () => {
    const resolved = await resolveStrmRedirect(runtime, coldTarget, resolveFinal);
    try {
      const local = await runtime.cache.ensureLocal(target, resolved.final, {
        coldCacheEnabled: runtime.options.coldCache.enabled,
        allowedSchemes: runtime.options.allowedSchemes,
        finalAllowedHosts: runtime.options.finalAllowedHosts,
        loudnessTimeoutMs: runtime.options.loudness.timeoutMs,
        preserveLoudness: cacheOptions.preserveLoudness === true,
      });
      return { local, resolved };
    } catch (error) {
      // Keep the resolved URL in memory for the configured size-policy
      // fallback.  It is never persisted or included in logs/responses.
      if (error && typeof error === 'object') error.resolved = resolved;
      throw error;
    }
  };
  const key = redirectRequestKey(coldTarget, DEFAULT_HELPER_USER_AGENT);
  if (runtime.coldStarts && typeof runtime.coldStarts.run === 'function') {
    return runtime.coldStarts.run(key, task);
  }
  return task();
}

function setMediaContentType(res, mediaExt) {
  const types = {
    '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.avi': 'video/x-msvideo',
    '.webm': 'audio/webm', '.aac': 'audio/aac',
  };
  if (types[mediaExt]) res.setHeader('Content-Type', types[mediaExt]);
}

function strmLoudnormPayload(record, completeLocal) {
  if (record && (record.loudnessReady || record.loudnessStatus === 'skipped')) {
    return {
      loudnorm: record.loudnorm == null ? 0 : record.loudnorm,
      peakLevels: [],
      ready: true,
      status: record.loudnessStatus || 'ready',
      retry: false,
    };
  }
  if (completeLocal) {
    return {
      loudnorm: null,
      peakLevels: [],
      ready: false,
      status: record && record.loudnessStatus === 'error' ? 'retrying' : 'pending',
      code: 'STRM_LOUDNORM_PENDING',
      retryAfterMs: 2000,
      retry: true,
    };
  }
  return {
    loudnorm: null,
    peakLevels: [],
    ready: false,
    status: record && record.loudnessStatus === 'error' ? 'retrying' : 'pending',
    code: record && record.loudnessStatus === 'error' ? 'STRM_COLD_START_FAILED' : 'STRM_LOUDNORM_CACHE_PENDING',
    retryAfterMs: 3000,
    retry: false,
  };
}

function isColdPathSkip(error) {
  return Boolean(error && [
    'DOWNLOAD_TOO_LARGE',
    'COLD_CACHE_POLICY',
    'COLD_CACHE_DISABLED',
  ].includes(error.code));
}

function isLoudnessDisabled(runtime, target) {
  return runtime.options.loudness.enabled === false
    || (runtime.options.loudness.audioOnly && target.isVideo);
}

function startStrmColdBootstrap(runtime, target, resolveFinal = resolveRedirect, logger = console) {
  // Keep the resolver injectable for loudnorm/playback convergence tests and
  // callers that need the same request policy; tolerate the historical third
  // logger argument for compatibility.
  if (typeof resolveFinal !== 'function') {
    logger = resolveFinal || console;
    resolveFinal = resolveRedirect;
  }
  return ensureStrmLocal(runtime, target, resolveFinal).then(() => undefined).catch(async error => {
    if (isColdPathSkip(error)) {
      await runtime.store.upsert(target.key, {
        loudnessReady: true,
        loudnessStatus: 'skipped',
        loudnessError: null,
        downloadReady: false,
      });
      return;
    }
    const code = errorCode(error);
    await runtime.store.upsert(target.key, {
      loudnessReady: false,
      loudnessStatus: 'error',
      loudnessError: code,
    }).catch(() => undefined);
    logger.warn?.('[STRM] cold start failed work=%s index=%s code=%s',
      target && target.workId == null ? '-' : target.workId,
      target && target.index == null ? '-' : target.index,
      code);
  });
}

/**
 * Shared STRM playback implementation.  Keeping this function injectable
 * makes cold/hot path tests independent from the compressed upstream router.
 */
async function handleStrmPlayback({ req, res, target, runtime, resolveFinal = resolveRedirect, logger = console } = {}) {
  const preloadDecision = classifyPreloadRequest(req, runtime.options.preloadGuard);
  if (preloadDecision.isPreload) logPreloadDiagnostic(req, target, preloadDecision, logger);
  if (preloadDecision.shortCircuit) {
    incrementMetric(runtime, 'preloadSkip');
    return sendPreloadResponse(res);
  }
  await runtime.ready;
  const pointerInfo = target;
  const record = await runtime.cache.get(pointerInfo);
  const completeLocal = record && record.downloadReady && record.cachePath
    && await fs.promises.stat(record.cachePath).then(stat => stat.isFile()).catch(() => false);
  if (completeLocal && !record.loudnessReady && !isLoudnessDisabled(runtime, target)) {
    await runtime.store.upsert(target.key, { lastAccessAt: Date.now() });
    void runtime.cache.analyze(pointerInfo, { loudnessTimeoutMs: runtime.options.loudness.timeoutMs }).catch(() => undefined);
    incrementMetric(runtime, 'coldLocal');
    setMediaContentType(res, target.mediaExt);
    return res.sendFile(record.cachePath);
  }
  // A disabled loudness policy (including video when audio-only analysis is
  // enabled) is already hot: direct mode should return 302 immediately, while
  // local mode still serves/creates its local file below.
  const hot = isLoudnessDisabled(runtime, target)
    || await runtime.cache.shouldUseHot(pointerInfo, { coldCacheEnabled: runtime.options.coldCache.enabled });
  if (hot) {
    if (runtime.options.redirectMode === 'local') {
      try {
        if (completeLocal) {
          incrementMetric(runtime, 'localPlayback');
          setMediaContentType(res, target.mediaExt);
          return res.sendFile(record.cachePath);
        }
        const result = await ensureStrmLocal(runtime, target, resolveFinal, { preserveLoudness: true });
        incrementMetric(runtime, 'localPlayback');
        setMediaContentType(res, target.mediaExt);
        return res.sendFile(result.local.path);
      } catch (error) {
        // If local delivery is impossible because of the configured cache
        // policy, retain the direct 302 fallback rather than blocking play.
        if (isColdPathSkip(error)) {
          // The cold flight resolves with the stable server UA.  That URL is
          // intentionally not suitable for a browser redirect: resolve again
          // under the original request UA so Helper/r302 returns the matching
          // consumer-bound Location.
          const fallback = await resolveStrmRedirect(runtime, target, resolveFinal);
          await runtime.store.upsert(target.key, { loudnessReady: true, loudnessStatus: 'skipped', downloadReady: false });
          incrementMetric(runtime, 'hotRedirect');
          return sendStrmRedirect(res, runtime, fallback.final);
        }
        throw error;
      }
    }
    const resolved = await resolveStrmRedirect(runtime, target, resolveFinal);
    incrementMetric(runtime, 'hotRedirect');
    return sendStrmRedirect(res, runtime, resolved.final);
  }
  try {
    const result = await ensureStrmLocal(runtime, target, resolveFinal);
    incrementMetric(runtime, 'coldLocal');
    setMediaContentType(res, target.mediaExt);
    return res.sendFile(result.local.path);
  } catch (error) {
    // A configured size policy intentionally falls back to the direct path
    // and marks loudness as skipped; transient failures stay visible.
    if (isColdPathSkip(error)) {
      // See the local hot-branch fallback above: never expose the stable-UA
      // cold URL to a browser whose Helper lookup used a different UA.
      const fallback = await resolveStrmRedirect(runtime, target, resolveFinal);
      await runtime.store.upsert(target.key, { loudnessReady: true, loudnessStatus: 'skipped', downloadReady: false });
      incrementMetric(runtime, 'hotRedirect');
      return sendStrmRedirect(res, runtime, fallback.final);
    }
    throw error;
  }
}

function installRoutes(routesRouter, appRoot) {
  if (!routesRouter || routesRouter.__strmRoutesInstalled) return;
  const runtime = getRuntime(appRoot);
  const config = runtime.config;
  const db = require(path.join(appRoot, 'dist/src/database/db.js'));
  const utils = require(path.join(appRoot, 'dist/src/filesystem/utils.js'));
  const express = require('express');
  const custom = express.Router();

  async function resolveTrack(req) {
    const workId = Number(req.params.id);
    const index = Number(req.params.index == null ? req.params.hash : req.params.index);
    if (!Number.isInteger(workId) || !Number.isInteger(index) || index < 0) {
      const error = new Error('invalid track coordinates'); error.code = 'INVALID_TRACK'; error.status = 400; throw error;
    }
    const work = await db.knex('t_work').select('root_folder', 'dir', 'memo').where('id', '=', workId).first();
    if (!work) {
      const error = new Error('work not found'); error.code = 'WORK_NOT_FOUND'; error.status = 404; throw error;
    }
    const rootFolder = (config.rootFolders || []).find(root => root.name === work.root_folder);
    if (!rootFolder || !rootFolder.path) {
      const error = new Error('root folder not found'); error.code = 'ROOT_FOLDER_NOT_FOUND'; error.status = 500; throw error;
    }
    const workPath = path.resolve(rootFolder.path, work.dir);
    if (!isWithin(rootFolder.path, workPath)) {
      const error = new Error('work path outside root'); error.code = 'INVALID_WORK_PATH'; error.status = 403; throw error;
    }
    const tracks = await utils.getTrackList(workId, workPath, jsonMemo(work.memo));
    const track = tracks[index];
    if (!track) {
      const error = new Error('track not found'); error.code = 'TRACK_NOT_FOUND'; error.status = 404; throw error;
    }
    const physicalTitle = track.title;
    if (String(track.ext).toLowerCase() !== '.strm' && !/\.strm$/i.test(String(physicalTitle))) return null;
    const physicalPath = path.resolve(workPath, track.subtitle || '', physicalTitle);
    if (!isWithin(workPath, physicalPath)) {
      const error = new Error('track path outside work'); error.code = 'INVALID_TRACK_PATH'; error.status = 403; throw error;
    }
    const virtual = parseVirtualMediaName(physicalTitle, DEFAULT_MEDIA_EXTENSIONS);
    if (!virtual.valid) {
      const error = new PointerError(virtual.code || 'VIRTUAL_NAME_INVALID', 'STRM virtual media name is invalid');
      error.status = 409;
      throw error;
    }
    const pointer = await readPointerFile(physicalPath, runtime.pointerOptions());
    const relative = path.relative(rootFolder.path, physicalPath).split(path.sep).join('/');
    const key = makeRecordKey(rootFolder.name, relative);
    return {
      key,
      workId,
      index,
      work,
      rootFolder,
      physicalPath,
      relativePath: relative,
      pointer,
      pointerFingerprint: pointer.fingerprint,
      pointerMtimeMs: pointer.mtimeMs,
      mediaExt: virtual.mediaExt,
      isVideo: virtual.isVideo,
      virtual,
      // Keep the browser identity in memory only.  It is normalized before
      // crossing the Helper boundary and is never written to STRM state/logs.
      userAgent: normalizeUserAgent(requestHeader(req, 'user-agent')),
    };
  }

  async function handleStream(req, res, next) {
    let target;
    try { target = await resolveTrack(req); } catch (error) { return sendStrmError(res, error); }
    if (!target) return next();
    try {
      return await handleStrmPlayback({ req, res, target, runtime });
    } catch (error) {
      return sendStrmError(res, error);
    }
  }

  async function handleDownload(req, res, next) {
    let target;
    try { target = await resolveTrack(req); } catch (error) { return sendStrmError(res, error); }
    if (!target) return next();
    try {
      const resolved = await resolveStrmRedirect(runtime, target);
      incrementMetric(runtime, 'hotRedirect');
      return sendStrmRedirect(res, runtime, resolved.final);
    } catch (error) {
      return sendStrmError(res, error);
    }
  }

  async function handleStrmLoudnorm(req, res, next) {
    let target;
    try { target = await resolveTrack(req); } catch (error) { return sendStrmError(res, error); }
    if (!target) return next();
    try {
      await runtime.ready;
      const record = await runtime.cache.get(target);
      const completeLocal = record && record.downloadReady && record.cachePath
        && await fs.promises.stat(record.cachePath).then(stat => stat.isFile()).catch(() => false);
      const loudnessSkipped = isLoudnessDisabled(runtime, target)
        || (!completeLocal && runtime.options.coldCache.enabled === false);
      if (loudnessSkipped) {
        await runtime.store.upsert(target.key, {
          loudnessReady: true,
          loudnessStatus: 'skipped',
          loudnessError: null,
          loudnorm: null,
        });
        return res.json(strmLoudnormPayload({
          loudnessReady: true,
          loudnessStatus: 'skipped',
          loudnorm: null,
        }, false));
      }
      const payload = strmLoudnormPayload(record, completeLocal);
      if (!completeLocal && !(record && (record.loudnessReady || record.loudnessStatus === 'skipped'))) {
        // A native iOS client may request loudnorm before it opens the media
        // URL.  Start the same single-flight cold path here so that pending
        // can converge to a local cache and then a ready loudnorm result.
        void startStrmColdBootstrap(runtime, target).catch(() => undefined);
      } else if (payload.retry) {
        // The cache manager's per-key singleflight merges this with playback
        // analysis.  Return a 200 JSON body so clients can stop a spinner and
        // retry later instead of waiting on a long request forever.
        void runtime.cache.analyze(target, {
          loudnessTimeoutMs: runtime.options.loudness.timeoutMs,
        }).catch(() => undefined);
      }
      // Return promptly while the shared cold path or local loudnorm task
      // converges in the background; iOS can poll this compatibility endpoint.
      delete payload.retry;
      return res.json(payload);
    } catch (error) {
      return sendStrmError(res, error);
    }
  }

  async function rejectStrm(req, res, next) {
    try {
      const target = await resolveTrack(req);
      if (!target) return next();
      return res.status(409).json({ error: 'STRM media does not support server-side transcoding or AI translation', code: 'STRM_OPERATION_REJECTED' });
    } catch (error) {
      if (error instanceof PointerError || ['VIRTUAL_EXTENSION_MISSING', 'VIRTUAL_EXTENSION_UNSUPPORTED'].includes(error && error.code)) {
        return res.status(409).json({ error: 'STRM media operation is not supported', code: 'STRM_OPERATION_REJECTED' });
      }
      return sendStrmError(res, error);
    }
  }

  async function status(req, res) {
    if (config.auth && (!req.user || req.user.name !== 'admin')) return res.status(403).json({ error: 'admin required' });
    try {
      await runtime.ready;
      const result = await runtime.cache.status();
      const sharedHelper = await sharedHelperStatus(runtime.redirectOptions().sharedRate);
      res.json({
        enabled: runtime.options.enabled,
        config: publicStrmConfig(runtime.options),
        queue: {
          pending: runtime.queue.pending,
          running: runtime.queue.running,
          started: runtime.queue.startedCount,
          completed: runtime.queue.completedCount,
          failed: runtime.queue.failedCount,
        },
        redirect: runtime.redirects.status(),
        sharedHelper,
        metrics: Object.assign({}, runtime.metrics),
        ...result,
      });
    } catch (error) { sendStrmError(res, error); }
  }

  async function update(req, res) {
    if (config.auth && (!req.user || req.user.name !== 'admin')) return res.status(403).json({ error: 'admin required' });
    try {
      const body = req.body && req.body.strm ? req.body.strm : (req.body || {});
      const next = mergePublicStrmConfig(runtime.options, body);
      await runtime.updateOptions(next);
      res.json({ message: 'STRM 配置已保存', config: publicStrmConfig(next) });
    } catch (error) { sendStrmError(res, error); }
  }

  async function cleanup(req, res) {
    if (config.auth && (!req.user || req.user.name !== 'admin')) return res.status(403).json({ error: 'admin required' });
    try { res.json(await runtime.cache.cleanup()); } catch (error) { sendStrmError(res, error); }
  }

  custom.get('/media/stream/:id/:index', handleStream);
  custom.get('/media/download/:id/:index', handleDownload);
  custom.get('/media/transcode/:id/:index', rejectStrm);
  custom.get('/media/pre-transcode/:id/:index', rejectStrm);
  custom.post('/media/pre-transcode/:id/:index', rejectStrm);
  custom.get('/media/calculate/loudnorm/:id/:hash', handleStrmLoudnorm);
  custom.put('/lyric/translate/:id/:index', rejectStrm);
  custom.get('/admin/strm', status);
  custom.get('/strm/status', status);
  custom.get('/strm/config', status);
  custom.put('/admin/strm', update);
  custom.post('/admin/strm/cleanup', cleanup);
  // Put adapter layers ahead of upstream `/media` and `/` mounts.  Calling
  // next() for ordinary local media preserves every upstream route.
  routesRouter.stack.unshift(...custom.stack);
  Object.defineProperty(routesRouter, '__strmRoutesInstalled', { value: true, enumerable: false });
  console.log('[STRM] adapter enabled for Kikoeru 0.6.15 (remote URLs are redacted)');
}

function publicStrmConfig(options) {
  return {
    enabled: Boolean(options.enabled),
    redirectMode: options.redirectMode,
    extension: options.extension,
    filenameMode: options.filenameMode,
    allowedSchemes: options.allowedSchemes,
    allowedHosts: options.allowedHosts,
    finalAllowedHosts: FINAL_ALLOWED_HOSTS.slice(),
    maxPointerBytes: options.maxPointerBytes,
    durationProbe: options.durationProbe,
    redirectResolve: options.redirectResolve,
    preloadGuard: options.preloadGuard,
    coldCache: options.coldCache,
    loudness: options.loudness,
    statePath: options.statePath,
  };
}

function mergePublicStrmConfig(current, body) {
  const next = Object.assign({}, current);
  const boolKeys = ['enabled'];
  for (const key of boolKeys) if (Object.prototype.hasOwnProperty.call(body, key)) next[key] = Boolean(body[key]);
  if (Object.prototype.hasOwnProperty.call(body, 'redirectMode')) {
    const mode = String(body.redirectMode).trim().toLowerCase();
    if (!REDIRECT_MODES.includes(mode)) throw Object.assign(new Error('invalid redirect mode'), { code: 'INVALID_CONFIG', status: 400 });
    next.redirectMode = mode;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'finalAllowedHosts')) {
    throw Object.assign(new Error('finalAllowedHosts is fixed to the 115 CDN allowlist'), {
      code: 'FINAL_HOSTS_FIXED', status: 400,
    });
  }
  for (const key of ['allowedSchemes', 'allowedHosts']) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      if (!Array.isArray(body[key]) || body[key].length > 64) throw Object.assign(new Error('invalid host configuration'), { code: 'INVALID_CONFIG', status: 400 });
      next[key] = key === 'allowedHosts'
        ? normalizeHelperHosts(body[key])
        : body[key].map(value => String(value).trim()).filter(Boolean);
    }
  }
  if (body.durationProbe && typeof body.durationProbe === 'object') {
    next.durationProbe = Object.assign({}, current.durationProbe);
    for (const key of ['enabled']) if (key in body.durationProbe) next.durationProbe[key] = Boolean(body.durationProbe[key]);
    for (const key of ['intervalMs', 'timeoutMs', 'maxQueue', 'retryDelayMs']) if (key in body.durationProbe) next.durationProbe[key] = envNumber(body.durationProbe[key], current.durationProbe[key]);
  }
  if (body.redirectResolve && typeof body.redirectResolve === 'object') {
    next.redirectResolve = Object.assign({}, current.redirectResolve);
    for (const key of [
      'maxConcurrent', 'minIntervalMs', 'maxQueue', 'perMinute', 'perHour', 'cacheTtlMs',
      'cooldownMs', 'severeCooldownMs', 'severeAfter429', 'max429Retries',
      'retryBaseMs', 'retryMaxMs', 'retryJitterMs',
    ]) {
      if (key in body.redirectResolve) {
        const minimum = ['maxConcurrent', 'maxQueue', 'perMinute', 'perHour', 'severeCooldownMs', 'severeAfter429', 'retryMaxMs'].includes(key) ? 1 : 0;
        next.redirectResolve[key] = envNumber(body.redirectResolve[key], current.redirectResolve[key], minimum);
      }
    }
  }
  if (body.preloadGuard && typeof body.preloadGuard === 'object') {
    next.preloadGuard = Object.assign({}, current.preloadGuard);
    if ('enabled' in body.preloadGuard) next.preloadGuard.enabled = Boolean(body.preloadGuard.enabled);
    if ('detectHead' in body.preloadGuard) next.preloadGuard.detectHead = Boolean(body.preloadGuard.detectHead);
    if ('mode' in body.preloadGuard) {
      const mode = String(body.preloadGuard.mode).toLowerCase();
      if (!['off', 'observe', 'short-circuit'].includes(mode)) throw Object.assign(new Error('invalid preload guard mode'), { code: 'INVALID_CONFIG', status: 400 });
      next.preloadGuard.mode = mode;
    }
  }
  if (body.coldCache && typeof body.coldCache === 'object') {
    next.coldCache = Object.assign({}, current.coldCache);
    for (const key of ['enabled']) if (key in body.coldCache) next.coldCache[key] = Boolean(body.coldCache[key]);
    for (const key of ['maxTotalBytes', 'maxFileBytes', 'maxVideoBytes', 'maxAgeMs', 'cleanupIntervalMs']) if (key in body.coldCache) next.coldCache[key] = envNumber(body.coldCache[key], current.coldCache[key]);
  }
  if (body.loudness && typeof body.loudness === 'object') {
    next.loudness = Object.assign({}, current.loudness);
    for (const key of ['enabled', 'audioOnly']) if (key in body.loudness) next.loudness[key] = Boolean(body.loudness[key]);
    if ('method' in body.loudness) {
      const method = String(body.loudness.method).trim().toLowerCase();
      if (!LOUDNESS_METHODS.includes(method)) throw Object.assign(new Error('invalid loudness method'), { code: 'INVALID_CONFIG', status: 400 });
      next.loudness.method = method;
    }
  }
  return next;
}

  module.exports = {
  RUNTIME_SYMBOL,
  REDIRECT_CALIBRATION_VERSION,
  migrateRedirectResolveConfig,
  defaultStrmConfig,
  createRuntime,
  getRuntime,
  installUtils,
  installRoutes,
  handleStrmPlayback,
  ensureStrmLocal,
  resolveStrmRedirect,
  redirectRequestKey,
  startStrmColdBootstrap,
  strmLoudnormPayload,
  classifyPreloadRequest,
  logPreloadDiagnostic,
  resolveWithPreloadGuard,
  publicStrmConfig,
  mergePublicStrmConfig,
  normalizeHelperHosts,
  FINAL_ALLOWED_HOSTS,
  normalizeRedirectMode,
  rootContext,
};
