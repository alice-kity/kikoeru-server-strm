'use strict';

const fs = require('fs');
const path = require('path');
const { SingleFlight } = require('./single-flight');
const { downloadToFile } = require('./http');
const { makeRecordKey } = require('./state-store');

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
  };
}

function isWithin(base, candidate) {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function rootFolderName(pointerInfo) {
  if (pointerInfo && pointerInfo.rootFolderName) return String(pointerInfo.rootFolderName);
  const folder = pointerInfo && pointerInfo.rootFolder;
  if (folder && typeof folder === 'object') return String(folder.name || '');
  return String(folder || '');
}

function recordFingerprint(record) {
  if (record && Object.prototype.hasOwnProperty.call(record, 'pointerFingerprint')) {
    return record.pointerFingerprint == null ? null : String(record.pointerFingerprint);
  }
  if (record && record.probeFingerprint != null) return String(record.probeFingerprint);
  return null;
}

function targetFingerprint(pointerInfo) {
  return pointerInfo && pointerInfo.pointerFingerprint == null
    ? null
    : String(pointerInfo && pointerInfo.pointerFingerprint);
}

function changedTargetError() {
  const error = new Error('STRM pointer changed during cache operation');
  error.code = 'STRM_TARGET_CHANGED';
  error.status = 409;
  return error;
}

/**
 * STRM's media cache stores only complete local media and download metadata.
 * LUFS analysis and its task lifecycle belong to Kikoeru's native track/task
 * tables and registry; no loudness JSON is written to this state store.
 */
class StrmCacheManager {
  constructor({ store, config = {}, scheduleLoudness = null, logger = console } = {}) {
    if (!store) throw new Error('StrmCacheManager requires a state store');
    this.store = store;
    this.limits = normalizeLimits(config);
    this.scheduleLoudness = scheduleLoudness;
    this.isTargetCurrent = null;
    this.logger = logger;
    this.downloads = new SingleFlight();
    this.analysisPromises = new Map();
    this.waveformPromises = new Map();
    this.scheduleWaveform = null;
    this.activeParts = new Set();
    this.generations = new Map();
    this.activeDownloads = new Map();
    this.cleanupTimer = null;
    this._resetCleanupTimer();
  }

  _resetCleanupTimer() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    if (this.limits.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        this.cleanup().catch(error => this.logger.error('[STRM] cache cleanup failed:', error.code || 'CACHE_CLEANUP_FAILED'));
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

  cachePath(key, mediaExt = '', pointerFingerprint = '') {
    const ext = /^\.[a-z0-9]{1,8}$/i.test(String(mediaExt)) ? String(mediaExt).toLowerCase() : '.media';
    const fingerprint = String(pointerFingerprint || '').replace(/[^a-f0-9]/gi, '').slice(0, 16);
    const suffix = fingerprint ? `_${fingerprint}` : '';
    return path.join(this.limits.rootDir, `${String(key)}${suffix}${ext}`);
  }

  _key(pointerInfo) {
    return pointerInfo.key || makeRecordKey(rootFolderName(pointerInfo), pointerInfo.relativePath);
  }

  _analysisPolicyKey() {
    return JSON.stringify({
      enabled: this.limits.enabled,
      loudnessEnabled: this.limits.loudnessEnabled,
      loudnessAudioOnly: this.limits.loudnessAudioOnly,
      maxFileBytes: this.limits.maxFileBytes,
      maxVideoBytes: this.limits.maxVideoBytes,
    });
  }

  analysisPolicyKey() {
    return this._analysisPolicyKey();
  }

  async _assertTargetCurrent(pointerInfo) {
    if (typeof this.isTargetCurrent !== 'function') return true;
    if ((await this.isTargetCurrent(pointerInfo)) !== true) throw changedTargetError();
    return true;
  }

  async _compareAndUpsert(key, expectedFingerprint, patch) {
    if (typeof this.store.compareAndUpsert === 'function') {
      return this.store.compareAndUpsert(key, expectedFingerprint, patch);
    }
    const current = await this.store.get(key);
    if (recordFingerprint(current) !== (expectedFingerprint == null ? null : String(expectedFingerprint))) {
      return { updated: false, record: current };
    }
    return { updated: true, record: await this.store.upsert(key, patch) };
  }

  async _recordFor(pointerInfo, attempt = 0) {
    const key = this._key(pointerInfo);
    const folder = rootFolderName(pointerInfo);
    const wantedFingerprint = targetFingerprint(pointerInfo);
    await this._assertTargetCurrent(pointerInfo);
    const current = await this.store.get(key);
    await this._assertTargetCurrent(pointerInfo);
    const currentFingerprint = recordFingerprint(current);
    if (current && currentFingerprint !== wantedFingerprint) {
      const previousCachePath = current.cachePath;
      const changed = await this._compareAndUpsert(key, currentFingerprint, {
        rootFolder: folder,
        relativePath: pointerInfo.relativePath,
        pointerFingerprint: pointerInfo.pointerFingerprint,
        pointerMtimeMs: pointerInfo.pointerMtimeMs,
        mediaExt: pointerInfo.mediaExt || null,
        isVideo: Boolean(pointerInfo.isVideo),
        downloadReady: false,
        cachePath: null,
        cacheBytes: 0,
        analysisSkipped: false,
        analysisSkipReason: null,
        analysisSkipPolicy: null,
        probeStatus: 'pending',
      });
      if (!changed.updated) {
        if (attempt < 5) return this._recordFor(pointerInfo, attempt + 1);
        throw changedTargetError();
      }
      await this._assertTargetCurrent(pointerInfo);
      if (previousCachePath && isWithin(this.limits.rootDir, previousCachePath)) {
        await fs.promises.rm(previousCachePath, { force: true }).catch(() => undefined);
      }
      return changed.record;
    }
    if (!current) {
      const created = await this._compareAndUpsert(key, null, {
        rootFolder: folder,
        relativePath: pointerInfo.relativePath,
        pointerFingerprint: pointerInfo.pointerFingerprint,
        pointerMtimeMs: pointerInfo.pointerMtimeMs,
        mediaExt: pointerInfo.mediaExt || null,
        isVideo: Boolean(pointerInfo.isVideo),
        downloadReady: false,
        cachePath: null,
        cacheBytes: 0,
        probeStatus: 'pending',
      });
      if (!created.updated) {
        if (attempt < 5) return this._recordFor(pointerInfo, attempt + 1);
        throw changedTargetError();
      }
      await this._assertTargetCurrent(pointerInfo);
      return created.record;
    }
    if (current.pointerMtimeMs !== pointerInfo.pointerMtimeMs) {
      const updated = await this._compareAndUpsert(key, currentFingerprint, { pointerMtimeMs: pointerInfo.pointerMtimeMs });
      if (!updated.updated) {
        if (attempt < 5) return this._recordFor(pointerInfo, attempt + 1);
        throw changedTargetError();
      }
      await this._assertTargetCurrent(pointerInfo);
      return updated.record;
    }
    if (current.analysisSkipped && current.analysisSkipPolicy !== this._analysisPolicyKey()) {
      const updated = await this._compareAndUpsert(key, currentFingerprint, {
        analysisSkipped: false,
        analysisSkipReason: null,
        analysisSkipPolicy: null,
      });
      if (!updated.updated) {
        if (attempt < 5) return this._recordFor(pointerInfo, attempt + 1);
        throw changedTargetError();
      }
      await this._assertTargetCurrent(pointerInfo);
      return updated.record;
    }
    return current;
  }

  async get(pointerInfo) {
    return this._recordFor(pointerInfo);
  }

  async touch(pointerInfo) {
    await this._assertTargetCurrent(pointerInfo);
    const updated = await this._compareAndUpsert(this._key(pointerInfo), targetFingerprint(pointerInfo), {
      lastAccessAt: Date.now(),
    });
    if (!updated.updated) throw changedTargetError();
    return updated.record;
  }

  async _isLufsReady(pointerInfo, options) {
    if (Object.prototype.hasOwnProperty.call(options, 'loudnessReady')) return Boolean(options.loudnessReady);
    const row = pointerInfo.row || {};
    return row.lufs !== null && row.lufs !== undefined && row.lufs !== '' && Number.isFinite(Number(row.lufs));
  }

  async shouldUseHot(pointerInfo, options = {}) {
    if (!this.limits.enabled || options.coldCacheEnabled === false) return true;
    const record = await this._recordFor(pointerInfo);
    if (record.analysisSkipped && record.analysisSkipPolicy === this._analysisPolicyKey()) return true;
    if (!this.limits.loudnessEnabled || (this.limits.loudnessAudioOnly && pointerInfo.isVideo)) return true;
    if (await this._isLufsReady(pointerInfo, options)) return true;
    if (record.downloadReady && record.cachePath && await isFile(record.cachePath)) return false;
    if (pointerInfo.isVideo && this.limits.maxVideoBytes <= 0) return true;
    return false;
  }

  _scheduleAnalysis(pointerInfo, filePath, callback) {
    if (typeof callback !== 'function') return;
    const key = this._key(pointerInfo);
    const existing = this.analysisPromises.get(key);
    if (existing) return existing;
    // The runtime callback may itself register the native task. Invoke it
    // before recording a promise, otherwise it joins the wrapper promise
    // which is waiting for that same callback (a promise resolution cycle).
    let task;
    try { task = callback(pointerInfo, filePath); } catch (error) { task = Promise.reject(error); }
    return this.trackAnalysis(pointerInfo, task);
  }

  trackAnalysis(pointerInfo, taskPromise) {
    return this._trackTask(this.analysisPromises, pointerInfo, taskPromise);
  }

  trackWaveform(pointerInfo, taskPromise) {
    return this._trackTask(this.waveformPromises, pointerInfo, taskPromise);
  }

  _trackTask(tasks, pointerInfo, taskPromise) {
    const key = this._key(pointerInfo);
    const existing = tasks.get(key);
    if (existing) return existing;
    const promise = Promise.resolve(taskPromise);
    tasks.set(key, promise);
    void promise.catch(error => {
      this.logger.warn?.('[STRM] native media scheduling failed work=%s seq=%s code=%s',
        pointerInfo.workId == null ? '-' : pointerInfo.workId,
        pointerInfo.seq == null ? pointerInfo.index : pointerInfo.seq,
        error && error.code || 'LUFS_SCHEDULE_FAILED');
    }).finally(() => {
      if (tasks.get(key) === promise) tasks.delete(key);
    });
    return promise;
  }

  async _notifyReady(pointerInfo, filePath, options = {}) {
    const callback = options.scheduleLoudness || this.scheduleLoudness;
    if (typeof callback === 'function' && this.limits.loudnessEnabled
      && !(this.limits.loudnessAudioOnly && pointerInfo.isVideo)) {
      this._scheduleAnalysis(pointerInfo, filePath, callback);
    }
    if (typeof this.scheduleWaveform === 'function' && !pointerInfo.isVideo) {
      this.trackWaveform(pointerInfo, this.scheduleWaveform(pointerInfo, filePath));
    }
  }

  async invalidateTarget(pointerInfo) {
    const key = this._key(pointerInfo);
    const current = await this.store.get(key);
    const activeFingerprint = this.activeDownloads.get(key);
    const fingerprint = String(pointerInfo.pointerFingerprint || '');
    const identity = recordFingerprint(current);
    if (current && identity !== fingerprint) return false;
    if (!current && activeFingerprint && activeFingerprint !== fingerprint) return false;
    if (current && identity === fingerprint) {
      const invalidated = await this._compareAndUpsert(key, identity, {
        rootFolder: rootFolderName(pointerInfo),
        relativePath: pointerInfo.relativePath,
        pointerFingerprint: null,
        pointerMtimeMs: null,
        downloadReady: false,
        cachePath: null,
        cacheBytes: 0,
      });
      if (!invalidated.updated) return false;
      this.generations.set(key, (this.generations.get(key) || 0) + 1);
      if (current.cachePath && isWithin(this.limits.rootDir, current.cachePath)) {
        await fs.promises.rm(current.cachePath, { force: true }).catch(() => undefined);
      }
    } else {
      this.generations.set(key, (this.generations.get(key) || 0) + 1);
    }
    this.analysisPromises.delete(key);
    this.waveformPromises.delete(key);
    return true;
  }

  async ensureLocal(pointerInfo, finalUrl, options = {}) {
    const key = this._key(pointerInfo);
    const fingerprint = String(pointerInfo.pointerFingerprint || '');
    const flightKey = `${key}:${fingerprint}`;
    return this.downloads.run(flightKey, async () => {
      const generation = this.generations.get(key) || 0;
      this.activeDownloads.set(key, fingerprint);
      const record = await this._recordFor(pointerInfo);
      if ((this.generations.get(key) || 0) !== generation) throw changedTargetError();
      if (record.analysisSkipped && record.analysisSkipPolicy === this._analysisPolicyKey()) {
        const skipped = new Error('cold cache is skipped by current media policy');
        skipped.code = record.analysisSkipReason || 'COLD_CACHE_POLICY';
        throw skipped;
      }
      if (record.downloadReady && record.cachePath && record.pointerFingerprint === pointerInfo.pointerFingerprint
        && isWithin(this.limits.rootDir, record.cachePath) && await isFile(record.cachePath)) {
        const refreshed = await this._compareAndUpsert(key, fingerprint, { lastAccessAt: Date.now() });
        if (!refreshed.updated || (this.generations.get(key) || 0) !== generation) throw changedTargetError();
        void this._notifyReady(pointerInfo, record.cachePath, options);
        return { key, path: record.cachePath, reused: true, record: refreshed.record || record };
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
      const finalPath = this.cachePath(key, pointerInfo.mediaExt, pointerInfo.pointerFingerprint);
      const partPath = `${finalPath}.part`;
      await fs.promises.rm(partPath, { force: true }).catch(() => undefined);
      let result;
      let stat;
      this.activeParts.add(partPath);
      try {
        // Resolve a signed URL only after cache reuse and local policy checks.
        const sourceUrl = typeof finalUrl === 'function' ? await finalUrl() : finalUrl;
        result = await downloadToFile(sourceUrl, partPath, {
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
        if ((this.generations.get(key) || 0) !== generation) {
          await fs.promises.rm(partPath, { force: true }).catch(() => undefined);
          throw changedTargetError();
        }
        if (typeof this.isTargetCurrent === 'function' && (await this.isTargetCurrent(pointerInfo)) !== true) {
          await fs.promises.rm(partPath, { force: true }).catch(() => undefined);
          throw changedTargetError();
        }
        if ((this.generations.get(key) || 0) !== generation) {
          await fs.promises.rm(partPath, { force: true }).catch(() => undefined);
          throw changedTargetError();
        }
        await fs.promises.rename(partPath, finalPath);
      } finally {
        this.activeParts.delete(partPath);
      }
      if ((this.generations.get(key) || 0) !== generation) {
        await fs.promises.rm(finalPath, { force: true }).catch(() => undefined);
        throw changedTargetError();
      }
      if (typeof this.isTargetCurrent === 'function' && (await this.isTargetCurrent(pointerInfo)) !== true) {
        await fs.promises.rm(finalPath, { force: true }).catch(() => undefined);
        throw changedTargetError();
      }
      if ((this.generations.get(key) || 0) !== generation) {
        await fs.promises.rm(finalPath, { force: true }).catch(() => undefined);
        throw changedTargetError();
      }
      const updated = await this._compareAndUpsert(key, fingerprint, {
        rootFolder: rootFolderName(pointerInfo),
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
      });
      if (!updated.updated) {
        await fs.promises.rm(finalPath, { force: true }).catch(() => undefined);
        throw changedTargetError();
      }
      if ((this.generations.get(key) || 0) !== generation) {
        await fs.promises.rm(finalPath, { force: true }).catch(() => undefined);
        await this._compareAndUpsert(key, fingerprint, {
          downloadReady: false,
          cachePath: null,
          cacheBytes: 0,
        });
        throw changedTargetError();
      }
      // The callback only occupies the native task registry and starts or
      // joins analysis.  It is deliberately not awaited inside the download
      // single-flight, so analysis cannot wait on its own cache flight.
      void this._notifyReady(pointerInfo, finalPath, options);
      return { key, path: finalPath, reused: false, bytes: result.bytes, record: updated.record };
    }).finally(() => {
      if (this.activeDownloads.get(key) === fingerprint) this.activeDownloads.delete(key);
    });
  }

  async analyze(pointerInfo, options = {}) {
    const record = await this._recordFor(pointerInfo);
    if (!record.downloadReady || !record.cachePath || !isWithin(this.limits.rootDir, record.cachePath)
      || !(await isFile(record.cachePath))) {
      const error = new Error('loudness input is not a complete local cache');
      error.code = 'STRM_CACHE_INCOMPLETE';
      throw error;
    }
    const callback = options.scheduleLoudness || this.scheduleLoudness;
    if (typeof callback !== 'function') {
      const error = new Error('native LUFS task bridge is unavailable');
      error.code = 'LUFS_TASK_UNAVAILABLE';
      throw error;
    }
    return this._scheduleAnalysis(pointerInfo, record.cachePath, callback);
  }

  async markAnalysisSkipped(pointerInfo, reason) {
    const safeReason = String(reason || 'COLD_CACHE_POLICY').replace(/[^A-Z0-9_-]/gi, '').slice(0, 64) || 'COLD_CACHE_POLICY';
    const updated = await this._compareAndUpsert(this._key(pointerInfo), targetFingerprint(pointerInfo), {
      rootFolder: rootFolderName(pointerInfo),
      relativePath: pointerInfo.relativePath,
      pointerFingerprint: pointerInfo.pointerFingerprint,
      pointerMtimeMs: pointerInfo.pointerMtimeMs,
      mediaExt: pointerInfo.mediaExt || null,
      isVideo: Boolean(pointerInfo.isVideo),
      analysisSkipped: true,
      analysisSkipReason: safeReason,
      analysisSkipPolicy: this._analysisPolicyKey(),
    });
    if (!updated.updated) throw changedTargetError();
    return { skipped: true, reason: safeReason };
  }

  async getAnalysisSkip(pointerInfo) {
    const record = await this._recordFor(pointerInfo);
    if (!record.analysisSkipped) return null;
    if (record.pointerFingerprint !== pointerInfo.pointerFingerprint
      || record.analysisSkipPolicy !== this._analysisPolicyKey()) {
      await this.store.upsert(this._key(pointerInfo), {
        analysisSkipped: false,
        analysisSkipReason: null,
        analysisSkipPolicy: null,
      });
      return null;
    }
    return { skipped: true, reason: record.analysisSkipReason || 'COLD_CACHE_POLICY' };
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
      if (!record.downloadReady || !record.cachePath || !isWithin(this.limits.rootDir, record.cachePath)) continue;
      if (this.activeDownloads.has(record.key) || this.analysisPromises.has(record.key) || this.waveformPromises.has(record.key)) {
        total += Number(record.cacheBytes || 0);
        continue;
      }
      const present = await isFile(record.cachePath);
      if (!present) {
        await this._compareAndUpsert(record.key, recordFingerprint(record), { downloadReady: false, cachePath: null, cacheBytes: 0 });
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
        await this._compareAndUpsert(record.key, recordFingerprint(record), { cleanupPending: true, cleanupError: error.code || 'remove-failed' });
      });
      if (await isFile(record.cachePath)) continue;
      await this._compareAndUpsert(record.key, recordFingerprint(record), {
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
    const cacheBytes = records.reduce((sum, record) => sum + (record.downloadReady ? Number(record.cacheBytes || 0) : 0), 0);
    return {
      records,
      cacheBytes,
      activeDownloads: this.activeDownloads.size,
      activePartFiles: this.activeParts.size,
      activeLoudness: this.analysisPromises.size,
      activeWaveforms: this.waveformPromises.size,
      pendingCleanup: records.filter(record => record.cleanupPending).length,
    };
  }

  close() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }
}

module.exports = { StrmCacheManager, normalizeLimits, isFile };
