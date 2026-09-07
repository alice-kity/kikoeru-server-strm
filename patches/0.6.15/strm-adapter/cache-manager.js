'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { SingleFlight } = require('./single-flight');
const { downloadToFile } = require('./http');
const { makeRecordKey } = require('./state-store');

const execFileAsync = promisify(execFile);

function normalizeLoudnessMethod(value) {
  return String(value == null ? '' : value).trim().toLowerCase() === 'ebur128'
    ? 'ebur128'
    : 'loudnorm';
}

function configuredLoudnessMethod(config = {}) {
  if (Object.prototype.hasOwnProperty.call(config, 'loudnessMethod')) return config.loudnessMethod;
  if (config.loudness && typeof config.loudness === 'object') return config.loudness.method;
  return undefined;
}

function isFile(pathName) {
  return fs.promises.stat(pathName).then(stat => stat.isFile()).catch(() => false);
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeLimits(config = {}) {
  return {
    enabled: config.enabled !== false,
    rootDir: path.resolve(String(config.rootDir || path.join(process.cwd(), 'sqlite', 'strm-cache'))),
    maxTotalBytes: numberOrDefault(config.maxTotalBytes, 20 * 1024 * 1024 * 1024),
    maxFileBytes: numberOrDefault(config.maxFileBytes, 2 * 1024 * 1024 * 1024),
    maxVideoBytes: numberOrDefault(config.maxVideoBytes, 512 * 1024 * 1024),
    maxAgeMs: numberOrDefault(config.maxAgeMs, 30 * 24 * 60 * 60 * 1000),
    cleanupIntervalMs: numberOrDefault(config.cleanupIntervalMs, 60 * 60 * 1000),
    downloadTimeoutMs: numberOrDefault(config.downloadTimeoutMs, 15 * 60 * 1000),
    loudnessEnabled: config.loudnessEnabled !== false,
    loudnessAudioOnly: config.loudnessAudioOnly !== false,
    loudnessMethod: normalizeLoudnessMethod(configuredLoudnessMethod(config)),
  };
}

/**
 * STRM's only server-side media cache.  A cache entry is complete only after
 * a `.part` download has been atomically renamed to its final path.
 */
class StrmCacheManager {
  constructor({ store, config = {}, runLoudnorm = null, runLoudness = null, resolveFinal = null, logger = console } = {}) {
    if (!store) throw new Error('StrmCacheManager requires a state store');
    this.store = store;
    this.limits = normalizeLimits(config);
    this.runLoudnorm = runLoudnorm || defaultRunLoudnorm;
    this.runLoudness = runLoudness || ((filePath, options = {}) => {
      const method = normalizeLoudnessMethod(options.loudnessMethod ?? options.method ?? this.limits.loudnessMethod);
      if (method === 'ebur128') return defaultRunEbur128(filePath, options);
      return this.runLoudnorm(filePath, options);
    });
    this.resolveFinal = resolveFinal;
    this.logger = logger;
    this.downloads = new SingleFlight();
    this.loudness = new SingleFlight();
    this.activeParts = new Set();
    this.cleanupTimer = null;
    this._resetCleanupTimer();
  }

  _resetCleanupTimer() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    if (this.limits.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        this.cleanup().catch(error => this.logger.error('[STRM] cache cleanup failed:', error.code || error.message));
      }, this.limits.cleanupIntervalMs);
      this.cleanupTimer.unref?.();
    }
  }

  configure(config = {}) {
    const previousInterval = this.limits.cleanupIntervalMs;
    this.limits = normalizeLimits(Object.assign({}, this.limits, config));
    if (previousInterval !== this.limits.cleanupIntervalMs) this._resetCleanupTimer();
    return this.limits;
  }

  cachePath(key, mediaExt = '') {
    const ext = /^\.[a-z0-9]{1,8}$/i.test(String(mediaExt)) ? String(mediaExt).toLowerCase() : '.media';
    return path.join(this.limits.rootDir, `${String(key)}${ext}`);
  }

  async _recordFor(pointerInfo) {
    const key = pointerInfo.key || makeRecordKey(pointerInfo.rootFolder, pointerInfo.relativePath);
    const current = await this.store.get(key);
    if (current && current.pointerFingerprint && current.pointerFingerprint !== pointerInfo.pointerFingerprint) {
      if (current.cachePath) await fs.promises.rm(current.cachePath, { force: true }).catch(() => undefined);
      await this.store.upsert(key, {
        rootFolder: pointerInfo.rootFolder,
        relativePath: pointerInfo.relativePath,
        pointerFingerprint: pointerInfo.pointerFingerprint,
        pointerMtimeMs: pointerInfo.pointerMtimeMs,
        downloadReady: false,
        loudnessReady: false,
        loudnessStatus: 'pending',
        cachePath: null,
        cacheBytes: 0,
        loudnorm: null,
        loudnessMethod: this.limits.loudnessMethod,
        probeStatus: 'pending',
      });
      return this.store.get(key);
    }
    if (!current) {
      await this.store.upsert(key, {
        rootFolder: pointerInfo.rootFolder,
        relativePath: pointerInfo.relativePath,
        pointerFingerprint: pointerInfo.pointerFingerprint,
        pointerMtimeMs: pointerInfo.pointerMtimeMs,
        mediaExt: pointerInfo.mediaExt || null,
        isVideo: Boolean(pointerInfo.isVideo),
        downloadReady: false,
        loudnessReady: false,
        loudnessStatus: 'pending',
        cachePath: null,
        cacheBytes: 0,
        loudnorm: null,
        loudnessMethod: this.limits.loudnessMethod,
      });
      return this.store.get(key);
    }
    const storedMethod = current.loudnessMethod == null
      ? 'loudnorm'
      : normalizeLoudnessMethod(current.loudnessMethod);
    const methodChanged = storedMethod !== this.limits.loudnessMethod;
    if (methodChanged || current.loudnessMethod !== this.limits.loudnessMethod) {
      const methodPatch = { loudnessMethod: this.limits.loudnessMethod };
      if (methodChanged) {
        Object.assign(methodPatch, {
          loudnessReady: false,
          loudnessStatus: 'pending',
          loudnessError: null,
          loudnorm: null,
        });
      }
      await this.store.upsert(key, methodPatch);
      return this.store.get(key);
    }
    return current;
  }

  async get(pointerInfo) {
    return this._recordFor(pointerInfo);
  }

  async shouldUseHot(pointerInfo, options = {}) {
    if (!this.limits.enabled || options.coldCacheEnabled === false) return true;
    const record = await this._recordFor(pointerInfo);
    if (!this.limits.loudnessEnabled || (this.limits.loudnessAudioOnly && pointerInfo.isVideo)) return true;
    if (record.loudnessReady || record.loudnessStatus === 'skipped') return true;
    if (record.downloadReady && record.cachePath && await isFile(record.cachePath)) return false;
    if (pointerInfo.isVideo && this.limits.maxVideoBytes <= 0) return true;
    return false;
  }

  async ensureLocal(pointerInfo, finalUrl, options = {}) {
    const key = pointerInfo.key || makeRecordKey(pointerInfo.rootFolder, pointerInfo.relativePath);
    return this.downloads.run(key, async () => {
      const keyedPointer = Object.assign({ key }, pointerInfo);
      const record = await this._recordFor(pointerInfo);
      if (record.downloadReady && record.cachePath && record.pointerFingerprint === pointerInfo.pointerFingerprint && await isFile(record.cachePath)) {
        await this.store.upsert(key, { lastAccessAt: Date.now() });
        return { key, path: record.cachePath, reused: true, record };
      }
      if (!this.limits.enabled || options.coldCacheEnabled === false) {
        const error = new Error('cold cache is disabled');
        error.code = 'COLD_CACHE_DISABLED';
        throw error;
      }
      const maxBytes = pointerInfo.isVideo
        ? Math.min(this.limits.maxFileBytes, this.limits.maxVideoBytes)
        : this.limits.maxFileBytes;
      if (maxBytes <= 0) {
        const error = new Error('media exceeds the configured cold cache policy');
        error.code = 'COLD_CACHE_POLICY';
        throw error;
      }
      await fs.promises.mkdir(this.limits.rootDir, { recursive: true });
      const finalPath = this.cachePath(key, pointerInfo.mediaExt);
      const partPath = `${finalPath}.part`;
      const preserveLoudness = options.preserveLoudness === true
        && (record.loudnessReady || record.loudnessStatus === 'skipped');
      await fs.promises.rm(partPath, { force: true }).catch(() => undefined);
      let result;
      let stat;
      this.activeParts.add(partPath);
      try {
        result = await downloadToFile(finalUrl, partPath, {
          maxBytes,
          timeoutMs: this.limits.downloadTimeoutMs,
          allowedSchemes: options.allowedSchemes,
          finalAllowedHosts: options.finalAllowedHosts,
        });
        stat = await fs.promises.stat(partPath);
        if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) {
          await fs.promises.rm(partPath, { force: true }).catch(() => undefined);
          const error = new Error('cold cache download did not produce a valid complete file');
          error.code = 'COLD_CACHE_INCOMPLETE';
          throw error;
        }
        await fs.promises.rename(partPath, finalPath);
      } finally {
        this.activeParts.delete(partPath);
      }
      const updated = await this.store.upsert(key, {
        rootFolder: pointerInfo.rootFolder,
        relativePath: pointerInfo.relativePath,
        pointerFingerprint: pointerInfo.pointerFingerprint,
        pointerMtimeMs: pointerInfo.pointerMtimeMs,
        mediaExt: pointerInfo.mediaExt || null,
        isVideo: Boolean(pointerInfo.isVideo),
        downloadReady: true,
        cachePath: finalPath,
        cacheBytes: stat.size,
        cachedAt: Date.now(),
        lastAccessAt: Date.now(),
        loudnessStatus: preserveLoudness ? record.loudnessStatus : 'pending',
        loudnessReady: preserveLoudness,
        loudnessMethod: preserveLoudness ? record.loudnessMethod : this.limits.loudnessMethod,
      });
      if (!preserveLoudness) {
        this._scheduleLoudness(keyedPointer, finalPath, options).catch(error => {
          this.logger.error('[STRM] local loudness failed:', error.code || error.message);
        });
      }
      return { key, path: finalPath, reused: false, bytes: result.bytes, record: updated };
    });
  }

  async _scheduleLoudness(pointerInfo, filePath, options = {}) {
    const key = pointerInfo.key || makeRecordKey(pointerInfo.rootFolder, pointerInfo.relativePath);
    const method = normalizeLoudnessMethod(options.loudnessMethod ?? options.method ?? this.limits.loudnessMethod);
    if (!this.limits.loudnessEnabled || (this.limits.loudnessAudioOnly && pointerInfo.isVideo)) {
      await this.store.upsert(key, {
        loudnessReady: true,
        loudnessStatus: 'skipped',
        loudnessError: null,
        loudnorm: null,
        loudnessMethod: method,
        loudnessAt: Date.now(),
      });
      return { skipped: true };
    }
    return this.loudness.run(key, async () => {
      try {
        const result = await this.runLoudness(filePath, {
          timeoutMs: options.loudnessTimeoutMs,
          loudnessMethod: method,
          method,
        });
        await this.store.upsert(key, {
          loudnessReady: true,
          loudnessStatus: 'ready',
          loudnessError: null,
          loudnorm: result,
          loudnessMethod: method,
          loudnessAt: Date.now(),
        });
        return result;
      } catch (error) {
        // Keep the complete download reusable.  A later playback request or
        // an explicit analyze call can retry against the same local file.
        const fallbackCode = method === 'ebur128' ? 'EBUR128_FAILED' : 'LOUDNORM_FAILED';
        const safeCode = String(error && error.code || fallbackCode)
          .replace(/[^A-Z0-9_-]/gi, '').slice(0, 64) || fallbackCode;
        await this.store.upsert(key, {
          loudnessReady: false,
          loudnessStatus: 'error',
          loudnessError: safeCode,
          loudnorm: null,
          loudnessMethod: method,
          loudnessAt: Date.now(),
        });
        throw error;
      }
    });
  }

  async analyze(pointerInfo, options = {}) {
    const record = await this._recordFor(pointerInfo);
    if (!record.downloadReady || !record.cachePath || !(await isFile(record.cachePath))) {
      const error = new Error('loudness input is not a complete local cache');
      error.code = 'LOUDNESS_CACHE_MISSING';
      throw error;
    }
    return this._scheduleLoudness(pointerInfo, record.cachePath, options);
  }

  async cleanupPartFiles() {
    let entries;
    try {
      entries = await fs.promises.readdir(this.limits.rootDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.part')) continue;
      const partPath = path.join(this.limits.rootDir, entry.name);
      if (this.activeParts.has(partPath)) continue;
      await fs.promises.rm(partPath, { force: true });
      removed += 1;
    }
    return removed;
  }

  async cleanup(now = Date.now()) {
    const removedParts = await this.cleanupPartFiles();
    const records = await this.store.list();
    const candidates = [];
    let total = 0;
    for (const record of records) {
      if (!record.downloadReady || !record.cachePath) continue;
      if (this.downloads.has(record.key) || this.loudness.has(record.key)) {
        total += Number(record.cacheBytes || 0);
        continue;
      }
      const present = await isFile(record.cachePath);
      if (!present) {
        await this.store.upsert(record.key, { downloadReady: false, cachePath: null, cacheBytes: 0 });
        continue;
      }
      const stat = await fs.promises.stat(record.cachePath).catch(() => null);
      if (!stat) continue;
      const item = Object.assign({}, record, { cacheBytes: stat.size });
      total += stat.size;
      candidates.push(item);
    }
    candidates.sort((a, b) => Number(a.lastAccessAt || a.cachedAt || 0) - Number(b.lastAccessAt || b.cachedAt || 0));
    const expired = candidates.filter(record => this.limits.maxAgeMs > 0 && now - Number(record.lastAccessAt || record.cachedAt || now) > this.limits.maxAgeMs);
    const remove = new Set(expired.map(record => record.key));
    for (const record of candidates) {
      if (total <= this.limits.maxTotalBytes && !remove.has(record.key)) continue;
      remove.add(record.key);
      total -= Number(record.cacheBytes || 0);
    }
    for (const record of candidates) {
      if (!remove.has(record.key)) continue;
      await fs.promises.rm(record.cachePath, { force: true }).catch(async error => {
        await this.store.upsert(record.key, { cleanupPending: true, cleanupError: error.code || 'remove-failed' });
      });
      if (await isFile(record.cachePath)) continue;
      // Keep loudnorm and probe fields; only the temporary media is evicted.
      await this.store.upsert(record.key, {
        downloadReady: false,
        cachePath: null,
        cacheBytes: 0,
        cleanupPending: false,
        lastEvictedAt: now,
      });
    }
    return { totalBytes: Math.max(0, total), removed: remove.size, removedParts };
  }

  async status() {
    const records = await this.store.list();
    const cache = records.reduce((sum, record) => sum + (record.downloadReady ? Number(record.cacheBytes || 0) : 0), 0);
    return {
      records,
      cacheBytes: cache,
      activeDownloads: this.downloads.size(),
      activePartFiles: this.activeParts.size,
      activeLoudness: this.loudness.size(),
      pendingCleanup: records.filter(record => record.cleanupPending).length,
    };
  }

  close() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }
}

function ffmpegLoudnessArgs(filePath, filter) {
  return [
    '-hide_banner', '-nostats', '-v', 'info', '-i', filePath,
    '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-af', filter, '-f', 'null', '-',
  ];
}

async function runFfmpegLoudness(filePath, filter, options = {}) {
  const execute = options.execFileImpl || execFileAsync;
  const { stderr } = await execute('ffmpeg', ffmpegLoudnessArgs(filePath, filter), {
    timeout: Number(options.timeoutMs || 15 * 60 * 1000),
    maxBuffer: 1024 * 1024,
  });
  return stderr;
}

async function defaultRunLoudnorm(filePath, options = {}) {
  const stderr = await runFfmpegLoudness(filePath, 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', options);
  return parseLoudnormResult(stderr);
}

async function defaultRunEbur128(filePath, options = {}) {
  const stderr = await runFfmpegLoudness(filePath, 'ebur128=framelog=quiet:peak=true', options);
  return parseEbur128Result(stderr);
}

async function defaultRunLoudness(filePath, options = {}) {
  const method = normalizeLoudnessMethod(options.loudnessMethod ?? options.method);
  return method === 'ebur128'
    ? defaultRunEbur128(filePath, options)
    : defaultRunLoudnorm(filePath, options);
}

function parseLoudnormResult(output) {
  const text = String(output || '');
  const start = text.lastIndexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw Object.assign(new Error('ffmpeg loudnorm returned no JSON result'), { code: 'LOUDNORM_RESULT_MISSING' });
  }
  try {
    const result = JSON.parse(text.slice(start, end + 1));
    if (!result || typeof result !== 'object') throw new Error('not an object');
    return result;
  } catch {
    throw Object.assign(new Error('ffmpeg loudnorm returned invalid JSON'), { code: 'LOUDNORM_RESULT_INVALID' });
  }
}

const EBUR128_VALUE_PATTERN = '[+-]?(?:(?:\\d+(?:\\.\\d*)?)|(?:\\.\\d+)|(?:inf|nan))';

function stripFfmpegLogPrefix(line) {
  return String(line).replace(/^\s*\[[^\]]+\]\s*/, '').trim();
}

function parseEbur128Metric(line, label) {
  const match = line.match(new RegExp(`^${label}\\s*:\\s*(${EBUR128_VALUE_PATTERN})(?:\\s|$)`, 'i'));
  return match ? match[1] : null;
}

function parseEbur128Result(output) {
  const values = {
    input_i: null,
    input_thresh: null,
    input_lra: null,
    input_tp: null,
  };
  const lines = String(output || '').split(/\r?\n/);
  let inSummary = false;
  let section = '';
  let summaryFound = false;

  for (const rawLine of lines) {
    const line = stripFfmpegLogPrefix(rawLine);
    if (!inSummary) {
      if (line === 'Summary:') {
        inSummary = true;
        summaryFound = true;
      }
      continue;
    }
    if (line === 'Summary:') break;
    if (line === 'Integrated loudness:') {
      section = 'integrated';
      continue;
    }
    if (line === 'Loudness range:') {
      section = 'range';
      continue;
    }
    if (line === 'Sample peak:') {
      section = 'sample-peak';
      continue;
    }
    if (line === 'True peak:') {
      section = 'true-peak';
      continue;
    }
    if (section === 'integrated') {
      if (values.input_i === null) values.input_i = parseEbur128Metric(line, 'I');
      if (values.input_thresh === null) values.input_thresh = parseEbur128Metric(line, 'Threshold');
    } else if (section === 'range' && values.input_lra === null) {
      values.input_lra = parseEbur128Metric(line, 'LRA');
    } else if (section === 'true-peak' && values.input_tp === null) {
      values.input_tp = parseEbur128Metric(line, 'Peak');
    }
  }

  if (!summaryFound) {
    throw Object.assign(new Error('ffmpeg ebur128 returned no Summary result'), { code: 'EBUR128_RESULT_MISSING' });
  }
  if (Object.values(values).some(value => value === null)) {
    throw Object.assign(new Error('ffmpeg ebur128 Summary is incomplete'), { code: 'EBUR128_RESULT_INVALID' });
  }

  // ebur128 measures the input only.  The output/target fields below are
  // intentionally null so the existing loudnorm payload shape remains
  // explicit without inventing normalization results.
  return Object.assign(values, {
    output_i: null,
    output_tp: null,
    output_lra: null,
    output_thresh: null,
    target_offset: null,
    normalization_type: null,
  });
}

module.exports = {
  StrmCacheManager,
  defaultRunLoudnorm,
  defaultRunEbur128,
  defaultRunLoudness,
  parseLoudnormResult,
  parseEbur128Result,
  normalizeLoudnessMethod,
  normalizeLimits,
};
