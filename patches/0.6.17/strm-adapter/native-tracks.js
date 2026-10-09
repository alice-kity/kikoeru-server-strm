'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createRequire } = require('module');
const { DEFAULT_ALLOWED_SCHEMES, parsePointerText, pointerFingerprint, PointerError } = require('./pointer');
const { DEFAULT_MEDIA_EXTENSIONS, parseVirtualMediaName } = require('./virtual-name');
const { makeRecordKey } = require('./state-store');
const {
  ensurePointerFingerprintColumn,
  migrateLegacyMemo,
  migrateLegacyState,
} = require('./migration');
const { DEFAULT_HELPER_USER_AGENT, normalizeUserAgent } = require('./http');

const STRM_EXT = '.strm';
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const SUBTITLE_EXTENSIONS = new Set(['.lrc', '.srt', '.ass', '.vtt']);
const TEXT_EXTENSIONS = new Set(['.txt', ...SUBTITLE_EXTENSIONS]);
const INVALIDATE_FIELDS = [
  'duration', 'duration_probe_mtime',
  'sample_rate', 'channels', 'bit_rate',
  'lufs', 'lufs_updated_at',
  'waveform_path', 'waveform_format', 'waveform_resolution', 'waveform_updated_at',
  'transcode',
];

function safeCode(error, fallback = 'STRM_SCAN_FAILED') {
  return String(error && error.code || fallback).replace(/[^A-Z0-9_-]/gi, '').slice(0, 64) || fallback;
}

function normalizePath(value) {
  const raw = String(value || '').replace(/\\/g, '/');
  if (!raw || raw === '.') return '';
  return path.posix.normalize(raw).replace(/^\.\//, '');
}

function isSafeRelativePath(value, allowEmpty = false) {
  const raw = String(value || '').replace(/\\/g, '/');
  if (!raw) return allowEmpty;
  if (raw.includes('\0') || path.posix.isAbsolute(raw)) return false;
  if (raw.split('/').some(segment => segment === '..')) return false;
  const normalized = normalizePath(raw);
  return Boolean(normalized && normalized !== '.');
}

function isFilesystemPathInside(rootPath, candidatePath) {
  const root = path.resolve(String(rootPath || ''));
  const candidate = path.resolve(String(candidatePath || ''));
  const relative = path.relative(root, candidate);
  return Boolean(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isInside(base, file) {
  const normalizedBase = normalizePath(base);
  const normalizedFile = normalizePath(file);
  if (!normalizedBase) return !!normalizedFile && normalizedFile !== '.' && !normalizedFile.startsWith('../');
  return normalizedFile.startsWith(`${normalizedBase}/`);
}

function affectedRows(result) {
  if (Array.isArray(result)) return Number(result[0]) || 0;
  if (result && typeof result === 'object' && 'changes' in result) return Number(result.changes) || 0;
  return Number(result) || 0;
}

function compareNatural(left, right) {
  return String(left || '').localeCompare(String(right || ''), undefined, { numeric: true, sensitivity: 'base' });
}

function sortEntries(items, orderBy) {
  if (typeof orderBy === 'function') {
    return orderBy(items, [(item) => item.subtitle, (item) => item.title, (item) => item.ext]);
  }
  return items.sort((a, b) => compareNatural(a.subtitle || '', b.subtitle || '')
    || compareNatural(a.title, b.title)
    || compareNatural(a.ext, b.ext));
}

function isLocalProvider(provider) {
  return Boolean(provider && provider.kind === 'local'
    && typeof provider.listRecursive === 'function'
    && typeof provider.readFile === 'function'
    && typeof provider.stat === 'function');
}

function makeAppDependencies(appRoot, injected = {}) {
  if (injected.knex && injected.trackStore && injected.registry && injected.config) {
    return { ...injected };
  }
  const root = path.resolve(String(appRoot || process.cwd()));
  const appRequire = createRequire(path.join(root, 'package.json'));
  function load(relative) {
    return require(path.join(root, 'dist', 'src', relative));
  }
  const db = injected.db || load('database/db.js');
  const trackStore = injected.trackStore || load('database/trackStore.js');
  const registry = injected.registry || load('filesystem/backend/registry.js');
  const configModule = injected.configModule || load('config.js');
  let orderBy = injected.orderBy;
  if (!orderBy) {
    try {
      orderBy = appRequire('natural-orderby').orderBy;
    } catch { }
  }
  return {
    ...injected,
    knex: injected.knex || db.knex,
    trackStore,
    registry,
    config: injected.config || configModule.config,
    orderBy,
    audioCache: injected.audioCache || load('filesystem/audioCache.js'),
  };
}

function createTrackBridge(appRoot, runtime = {}, injected = {}) {
  const deps = makeAppDependencies(appRoot, injected);
  const knex = deps.knex;
  const trackStore = deps.trackStore;
  const registry = deps.registry;
  const config = runtime.config || deps.config || {};
  const logger = injected.logger || runtime.logger || console;
  const locks = new Map();
  const providerKindByWork = new Map();
  const localWorkScanNeeded = new Set();
  const probeFlights = new Map();
  const probeRetryAt = new Map();
  const probeRetryByTrack = new Map();
  let schemaReady = null;
  let installedUtils = null;
  let appConfig = config;

  function logWarn(message) {
    logger.warn?.(message);
  }

  function durationProbeEnabled() {
    return runtime.options?.enabled !== false && runtime.options?.durationProbe?.enabled !== false;
  }

  function probeIdentity(target) {
    return `${String(target && target.key || '')}:${String(target && target.pointerFingerprint || 'unfingerprinted')}`;
  }

  function trackIdentity(row) {
    return `${Number(row && row.work_id)}/${Number(row && row.seq)}`;
  }

  function probeIdentityForRow(row, loc) {
    const rootFolderName = String(loc && loc.rootFolderName || '');
    const rootRelPath = normalizePath(path.posix.join(normalizePath(loc && loc.workRelPath), normalizePath(row && row.rel_path)));
    const key = makeRecordKey(rootFolderName, rootRelPath);
    return `${key}:${String(row && row.pointer_fingerprint || 'unfingerprinted')}`;
  }

  function isRetryThrottled(row) {
    const identity = trackIdentity(row);
    const previous = probeRetryByTrack.get(identity);
    if (!previous) return false;
    const currentFingerprint = String(row && row.pointer_fingerprint || 'unfingerprinted');
    if (previous.fingerprint !== currentFingerprint) {
      probeRetryByTrack.delete(identity);
      probeRetryAt.delete(previous.probeIdentity);
      return false;
    }
    return Number(previous.retryAt) > Date.now();
  }

  function setProbeRetry(row, loc, fingerprint, retryAt) {
    const identity = `${probeIdentityForRow(row, loc).split(':').slice(0, -1).join(':')}:${String(fingerprint || 'unfingerprinted')}`;
    const trackKey = trackIdentity(row);
    probeRetryAt.set(identity, retryAt);
    probeRetryByTrack.set(trackKey, { fingerprint: String(fingerprint || 'unfingerprinted'), retryAt, probeIdentity: identity });
    return identity;
  }

  function clearProbeRetry(row, target) {
    const trackKey = trackIdentity(row || target && target.row);
    const previous = probeRetryByTrack.get(trackKey);
    if (previous) probeRetryAt.delete(previous.probeIdentity);
    probeRetryByTrack.delete(trackKey);
    if (target) probeRetryAt.delete(probeIdentity(target));
  }

  async function currentTrackMatchesTarget(target) {
    const row = await trackStore.getTrackRow(target.workId, target.seq);
    return Boolean(row && Number(row.id) === Number(target.row && target.row.id)
      && String(row.ext || '').toLowerCase() === STRM_EXT
      && String(row.pointer_fingerprint || '') === String(target.pointerFingerprint || ''));
  }

  async function saveProbeState(target, patch) {
    const store = runtime.store;
    if (!store || typeof store.get !== 'function' || typeof store.upsert !== 'function'
        || !target || !target.pointerFingerprint) return false;
    if (!await currentTrackMatchesTarget(target)) return false;
    try {
      if (runtime.ready && typeof runtime.ready.then === 'function') await runtime.ready;
      const current = await store.get(target.key);
      if (current && current.pointerFingerprint
          && String(current.pointerFingerprint) !== String(target.pointerFingerprint)) return false;
      if (current && current.probeFingerprint
          && String(current.probeFingerprint) !== String(target.pointerFingerprint)) return false;
      if (!await currentTrackMatchesTarget(target)) return false;
      await store.upsert(target.key, {
        probeFingerprint: target.pointerFingerprint,
        ...patch,
      });
      return true;
    } catch (error) {
      logWarn(`[STRM native] probe status write failed code=${safeCode(error, 'STATE_WRITE_FAILED')}`);
      return false;
    }
  }

  async function clearProbeState(target) {
    const store = runtime.store;
    if (!store || typeof store.get !== 'function' || typeof store.upsert !== 'function'
        || !target || !target.key || !target.pointerFingerprint) return false;
    try {
      if (runtime.ready && typeof runtime.ready.then === 'function') await runtime.ready;
      const current = await store.get(target.key);
      if (!current || String(current.probeFingerprint || '') !== String(target.pointerFingerprint)) return false;
      if (current.pointerFingerprint
          && String(current.pointerFingerprint) !== String(target.pointerFingerprint)) return false;
      await store.upsert(target.key, {
        probeFingerprint: null,
        probeStatus: 'pending',
        probeError: null,
        probeRetryAt: null,
      });
      return true;
    } catch (error) {
      logWarn(`[STRM native] probe status invalidation failed code=${safeCode(error, 'STATE_WRITE_FAILED')}`);
      return false;
    }
  }

  async function loadProbeRetries(rows, loc) {
    if (!runtime.store || typeof runtime.store.get !== 'function' || !isLocalLocation(loc)) return;
    if (runtime.ready && typeof runtime.ready.then === 'function') await runtime.ready.catch(() => undefined);
    for (const row of rows) {
      if (String(row.ext || '').toLowerCase() !== STRM_EXT || !row.pointer_fingerprint) continue;
      const identity = probeIdentityForRow(row, loc);
      try {
        const state = await runtime.store.get(identity.slice(0, identity.lastIndexOf(':')));
        const retryAt = Number(state && state.probeRetryAt || 0);
        if (state && state.probeStatus === 'error'
            && String(state.probeFingerprint || '') === String(row.pointer_fingerprint)
            && retryAt > Date.now()) {
          setProbeRetry(row, loc, row.pointer_fingerprint, retryAt);
        } else if (state && state.probeFingerprint
            && String(state.probeFingerprint) !== String(row.pointer_fingerprint)) {
          clearProbeRetry(row);
        }
      } catch (error) {
        logWarn(`[STRM native] probe retry state read failed code=${safeCode(error, 'STATE_READ_FAILED')}`);
      }
    }
  }

  function ensureSchema() {
    if (!schemaReady) {
      schemaReady = ensurePointerFingerprintColumn(knex, {
        timeoutMs: runtime.options?.schemaWaitMs ?? 30000,
        pollMs: runtime.options?.schemaPollMs ?? 100,
      }).catch(error => {
        schemaReady = null;
        throw error;
      });
    }
    return schemaReady;
  }

  function getRootFolder(rootFolderName) {
    const roots = Array.isArray(appConfig.rootFolders) ? appConfig.rootFolders : [];
    return roots.find(root => root && String(root.name) === String(rootFolderName)) || null;
  }

  function getPointerOptions() {
    if (typeof runtime.pointerOptions === 'function') return runtime.pointerOptions();
    return {
      maxPointerBytes: runtime.options?.maxPointerBytes,
      allowedSchemes: runtime.options?.allowedSchemes || DEFAULT_ALLOWED_SCHEMES,
      allowedHosts: runtime.options?.allowedHosts,
    };
  }

  async function getWork(workId) {
    return knex('t_work').select('id', 'root_folder', 'dir', 'title', 'memo')
      .where('id', '=', Number(workId)).first();
  }

  function resolveLocation(work) {
    if (!work || !registry || typeof registry.resolveWork !== 'function') return null;
    return registry.resolveWork(work);
  }

  function isLocalLocation(loc) {
    return Boolean(loc && isLocalProvider(loc.provider));
  }

  function classify(ext, virtual) {
    if (ext === STRM_EXT) return virtual && virtual.valid ? 'audio' : 'unknown';
    const nativeAudioExts = installedUtils && Array.isArray(installedUtils.supportedMediaExtList)
      ? installedUtils.supportedMediaExtList
      : DEFAULT_MEDIA_EXTENSIONS;
    if (Array.from(nativeAudioExts).some(value => String(value).toLowerCase() === ext)) return 'audio';
    if (IMAGE_EXTENSIONS.has(ext)) return 'image';
    if (TEXT_EXTENSIONS.has(ext)) return 'text';
    if (ext === '.pdf') return 'unknown';
    return null;
  }

  async function statEntry(provider, entry, statMissing) {
    let size = Number(entry.size) || 0;
    let mtime = Number(entry.mtimeMs) > 0 ? Math.round(Number(entry.mtimeMs)) : 0;
    let stat = null;
    if (statMissing && size === 0 && mtime === 0) {
      try {
        stat = await provider.stat(entry.relPath);
        if (stat) {
          size = Number(stat.size) || 0;
          mtime = Number(stat.mtimeMs) > 0 ? Math.round(Number(stat.mtimeMs)) : 0;
        }
      } catch { }
    }
    return { size, mtime, stat };
  }

  async function readPointer(provider, rootRelPath) {
    const pointerOptions = getPointerOptions();
    if (!isSafeRelativePath(rootRelPath)) {
      const error = new PointerError('STRM_PATH_INVALID', 'STRM path is outside the media library');
      return { pointer: null, pointerFingerprint: null, pointerMtimeMs: 0, size: 0, error };
    }
    if (provider.kind !== 'local' || typeof provider.abs !== 'function' || !provider.rootPath) {
      const error = new PointerError('STRM_PROVIDER_UNSUPPORTED', 'STRM path is not on a local provider');
      return { pointer: null, pointerFingerprint: null, pointerMtimeMs: 0, size: 0, error };
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await provider.stat(rootRelPath);
      if (!before || before.isDir) {
        const error = new PointerError('POINTER_NOT_FOUND', 'STRM pointer does not exist', { status: 404 });
        return { pointer: null, pointerFingerprint: null, pointerMtimeMs: 0, size: 0, error };
      }
      const maxBytes = Number(pointerOptions.maxPointerBytes || 64 * 1024);
      if (Number(before.size) > maxBytes) {
        const error = new PointerError('POINTER_TOO_LARGE', 'STRM pointer exceeds configured size', { status: 413 });
        return {
          pointer: null,
          pointerFingerprint: null,
          pointerMtimeMs: Math.round(Number(before.mtimeMs) || 0),
          size: Number(before.size) || 0,
          error,
        };
      }
      const physicalPath = provider.abs(rootRelPath);
      if (!isFilesystemPathInside(provider.rootPath, physicalPath)) {
        const error = new PointerError('STRM_PATH_INVALID', 'STRM path is outside the media library');
        return { pointer: null, pointerFingerprint: null, pointerMtimeMs: 0, size: 0, error };
      }
      try {
        const realRoot = await fs.promises.realpath(provider.rootPath);
        const realFile = await fs.promises.realpath(physicalPath);
        if (!isFilesystemPathInside(realRoot, realFile)) {
          const error = new PointerError('STRM_PATH_INVALID', 'STRM path resolves outside the media library');
          return { pointer: null, pointerFingerprint: null, pointerMtimeMs: 0, size: 0, error };
        }
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          return { pointer: null, pointerFingerprint: null, pointerMtimeMs: 0, size: 0, error: new PointerError('POINTER_NOT_FOUND', 'STRM pointer does not exist', { status: 404 }) };
        }
        throw error;
      }
      const buffer = await provider.readFile(rootRelPath);
      const after = await provider.stat(rootRelPath);
      if (!after || Number(before.size) !== Number(after.size)
          || Math.round(Number(before.mtimeMs) || 0) !== Math.round(Number(after.mtimeMs) || 0)) {
        if (attempt === 0) continue;
        const error = new PointerError('POINTER_CHANGED_DURING_READ', 'STRM pointer changed while reading');
        return { pointer: null, pointerFingerprint: null, pointerMtimeMs: 0, size: 0, error };
      }
      const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer ?? '');
      const fingerprint = pointerFingerprint(text);
      try {
        const pointer = parsePointerText(text, pointerOptions);
        return {
          pointer: { url: pointer.url, protocol: pointer.protocol, host: pointer.host, fingerprint },
          pointerFingerprint: fingerprint,
          pointerMtimeMs: Math.round(Number(after.mtimeMs) || 0),
          size: Number(after.size) || 0,
          error: null,
        };
      } catch (error) {
        return {
          pointer: null,
          pointerFingerprint: fingerprint,
          pointerMtimeMs: Math.round(Number(after.mtimeMs) || 0),
          size: Number(after.size) || 0,
          error,
        };
      }
    }
    return { pointer: null, pointerFingerprint: null, pointerMtimeMs: 0, size: 0, error: new Error('unreachable') };
  }

  async function listLocalEntries(loc, statMissing = true) {
    if (!isSafeRelativePath(loc.workRelPath, true)) {
      const error = new Error('work path is outside the media library');
      error.code = 'INVALID_WORK_PATH';
      throw error;
    }
    const items = [];
    for await (const entry of loc.provider.listRecursive(loc.workRelPath)) {
      const ext = path.posix.extname(entry.name).toLowerCase();
      if (ext !== STRM_EXT && !classify(ext, null)) continue;
      const rootRelPath = normalizePath(entry.relPath);
      const relPath = normalizePath(path.posix.relative(normalizePath(loc.workRelPath), rootRelPath));
      if (!isSafeRelativePath(rootRelPath) || !isSafeRelativePath(relPath)) continue;
      const metadata = await statEntry(loc.provider, entry, statMissing);
      const virtual = ext === STRM_EXT ? parseVirtualMediaName(entry.name, DEFAULT_MEDIA_EXTENSIONS) : null;
      const item = {
        relPath,
        rootRelPath,
        title: entry.name,
        subtitle: path.posix.dirname(relPath) === '.' ? null : path.posix.dirname(relPath),
        ext,
        fileType: classify(ext, virtual),
        size: metadata.size,
        mtime: metadata.mtime,
        virtual,
        pointerFingerprint: null,
        pointer: null,
        pointerMtimeMs: metadata.mtime,
        pointerError: null,
      };
      if (ext === STRM_EXT) {
        try {
          const pointer = await readPointer(loc.provider, rootRelPath);
          item.pointerFingerprint = pointer.pointerFingerprint;
          item.pointer = pointer.pointer;
          item.pointerMtimeMs = pointer.pointerMtimeMs || item.mtime;
          item.pointerError = pointer.error;
          item.size = pointer.size || item.size;
          item.mtime = pointer.pointerMtimeMs || item.mtime;
        } catch (error) {
          // Read failures invalidate the prior pointer identity so no stale
          // duration or analysis result remains usable.
          item.pointerError = error;
          item.pointerFingerprint = null;
        }
      }
      items.push(item);
    }
    return sortEntries(items, deps.orderBy);
  }

  function withWorkLock(workId, fn) {
    const id = Number(workId);
    const previous = locks.get(id) || Promise.resolve();
    const run = previous.then(fn, fn);
    locks.set(id, run.then(() => undefined, () => undefined));
    return run;
  }

  function invalidatedPatch(pointerFingerprint) {
    const patch = { pointer_fingerprint: pointerFingerprint };
    for (const field of INVALIDATE_FIELDS) patch[field] = null;
    return patch;
  }

  async function updatePointerFingerprint(row, nextFingerprint) {
    const query = knex('t_track').where('id', '=', row.id);
    if (row.pointer_fingerprint === null || row.pointer_fingerprint === undefined) query.whereNull('pointer_fingerprint');
    else query.andWhere('pointer_fingerprint', '=', String(row.pointer_fingerprint));
    return affectedRows(await query.update(invalidatedPatch(nextFingerprint)));
  }

  function baseTarget(row, work, loc, requestUA) {
    const workRelativePath = normalizePath(loc.workRelPath);
    const trackRelativePath = normalizePath(row.rel_path);
    const safePath = isSafeRelativePath(workRelativePath, true) && isSafeRelativePath(trackRelativePath)
      && isInside(workRelativePath, path.posix.join(workRelativePath, trackRelativePath));
    const relativePath = safePath ? normalizePath(path.posix.join(workRelativePath, trackRelativePath)) : '';
    const rootRelPath = relativePath;
    // LocalProvider.getLocalPath is intentionally fenced by the runtime for
    // `.strm`; use its physical path mapper only for local internal analysis.
    let physicalPath = null;
    if (safePath && typeof loc.provider.abs === 'function') {
      const candidate = loc.provider.abs(rootRelPath);
      if (isFilesystemPathInside(loc.provider.rootPath, candidate)) physicalPath = candidate;
    }
    const virtual = parseVirtualMediaName(path.posix.basename(row.rel_path), DEFAULT_MEDIA_EXTENSIONS);
    const rootFolderName = String(work.root_folder || loc.rootFolderName || '');
    const fingerprint = row.pointer_fingerprint == null ? null : String(row.pointer_fingerprint);
    return {
      key: makeRecordKey(rootFolderName, relativePath),
      workId: Number(work.id),
      seq: Number(row.seq),
      index: Number(row.seq),
      row,
      loc,
      work,
      rootFolder: getRootFolder(rootFolderName),
      rootFolderName,
      physicalPath,
      relativePath,
      rootRelPath,
      pointer: null,
      pointerFingerprint: fingerprint,
      pointerMtimeMs: Math.round(Number(row.mtime) || 0),
      mediaExt: virtual.mediaExt || null,
      isVideo: Boolean(virtual.isVideo),
      virtual,
      userAgent: normalizeUserAgent(requestUA) || DEFAULT_HELPER_USER_AGENT,
      sourceExt: STRM_EXT,
      ext: String(row.ext || '').toLowerCase(),
      isStrm: true,
      valid: Boolean(virtual.valid && safePath && physicalPath),
      pointerError: safePath && physicalPath ? null : new PointerError('STRM_PATH_INVALID', 'STRM path is outside the media library'),
    };
  }

  async function targetForRow(row, work, loc, requestUA, refresh = true) {
    if (!row || String(row.ext || '').toLowerCase() !== STRM_EXT || !isLocalLocation(loc)) return null;
    if (!isSafeRelativePath(loc.workRelPath, true) || !isSafeRelativePath(row.rel_path)) {
      const invalid = baseTarget(row, work, loc, requestUA);
      invalid.valid = false;
      return invalid;
    }
    let currentRow = row;
    if (refresh) {
      try {
        const reread = await readPointer(loc.provider, path.posix.join(loc.workRelPath, row.rel_path));
        const storedFingerprint = row.pointer_fingerprint == null ? null : String(row.pointer_fingerprint);
        if (reread.pointerFingerprint !== storedFingerprint) {
          await syncLocalTracks(work.id, loc, true);
          currentRow = await trackStore.getTrackRow(work.id, row.seq);
          if (!currentRow || String(currentRow.ext || '').toLowerCase() !== STRM_EXT) return null;
        }
      } catch (error) {
        const target = baseTarget(row, work, loc, requestUA);
        target.valid = false;
        target.pointerError = error;
        return target;
      }
    }
    const target = baseTarget(currentRow, work, loc, requestUA);
    const pointed = await readPointer(loc.provider, target.rootRelPath);
    target.pointer = pointed.pointer;
    target.pointerFingerprint = pointed.pointerFingerprint;
    target.pointerMtimeMs = pointed.pointerMtimeMs || target.pointerMtimeMs;
    target.pointerError = pointed.error || null;
    target.valid = Boolean(target.virtual.valid && target.pointer);
    if (String(currentRow.pointer_fingerprint || '') !== String(target.pointerFingerprint || '')) {
      target.valid = false;
      target.pointerError = target.pointerError || Object.assign(new Error('STRM pointer identity is stale'), { code: 'POINTER_IDENTITY_STALE' });
    }
    return target;
  }

  async function invalidateTarget(target) {
    if (!target || !target.isStrm) return;
    clearProbeRetry(target.row, target);
    probeRetryAt.delete(probeIdentity(target));
    try {
      const tasks = runtime.nativeTasks;
      if (tasks && typeof tasks.invalidate === 'function') await tasks.invalidate(target);
    } catch (error) {
      logWarn(`[STRM native] task invalidation failed (${safeCode(error, 'INVALIDATE_FAILED')})`);
    }
    try {
      const cache = runtime.cache;
      const invalidate = cache && (cache.invalidateTarget || cache.invalidate);
      if (typeof invalidate === 'function') await invalidate.call(cache, target);
    } catch (error) {
      logWarn(`[STRM native] remote cache invalidation failed (${safeCode(error, 'INVALIDATE_FAILED')})`);
    }
    await clearProbeState(target);
    const waveformPath = target.row && target.row.waveform_path;
    if (waveformPath && config.audioCacheFolderDir) {
      const absolute = path.resolve(config.audioCacheFolderDir, waveformPath);
      if (isFilesystemPathInside(config.audioCacheFolderDir, absolute)) {
        await fs.promises.rm(absolute, { force: true }).catch(() => undefined);
      }
    }
    runtime.nativeWaveform?.invalidate(target);
    try {
      const cacheDir = config.audioCacheFolderDir;
      if (cacheDir && deps.audioCache && typeof deps.audioCache.deleteTrackCacheFiles === 'function') {
        deps.audioCache.deleteTrackCacheFiles(cacheDir, target.workId, target.seq);
      }
    } catch (error) {
      logWarn(`[STRM native] derived cache invalidation failed (${safeCode(error, 'INVALIDATE_FAILED')})`);
    }
  }

  async function syncLocalTracks(workId, loc, statMissing = true) {
    await ensureSchema();
    return withWorkLock(workId, async () => {
      if (!isLocalLocation(loc)) return { changed: false, added: 0, deleted: 0, pointerChanged: 0 };
      if (!isSafeRelativePath(loc.workRelPath, true)) {
        const error = new Error('work path is outside the media library');
        error.code = 'INVALID_WORK_PATH';
        throw error;
      }
      const work = await getWork(workId);
      if (!work) return { changed: false, added: 0, deleted: 0, pointerChanged: 0 };
      const entries = await listLocalEntries(loc, statMissing);
      const existing = await trackStore.getTrackRows(workId);
      const entryByPath = new Map(entries.map(entry => [entry.relPath, entry]));
      const existingByPath = new Map(existing.map(row => [normalizePath(row.rel_path), row]));
      const additions = entries.filter(entry => !existingByPath.has(entry.relPath));
      const deletions = existing.filter(row => !entryByPath.has(normalizePath(row.rel_path)));
      let pointerChanged = 0;

      if (additions.length) {
        await trackStore.allocateAndInsert(workId, additions.map(entry => ({
          rel_path: entry.relPath,
          ext: entry.ext,
          file_type: entry.fileType,
          size: entry.size,
          mtime: entry.mtime,
        })));
      }

      const afterInsert = await trackStore.getTrackRows(workId);
      const rowsByPath = new Map(afterInsert.map(row => [normalizePath(row.rel_path), row]));
      for (const entry of entries) {
        const row = rowsByPath.get(entry.relPath);
        if (!row) continue;
        const old = existingByPath.get(entry.relPath);
        const oldExt = String(old && old.ext || '').toLowerCase();
        const oldFingerprint = old && old.pointer_fingerprint != null ? String(old.pointer_fingerprint) : null;
        const nextFingerprint = entry.ext === STRM_EXT ? entry.pointerFingerprint : null;
        const isPointerTransition = oldExt === STRM_EXT || entry.ext === STRM_EXT;
        const pointerIdentityChanged = isPointerTransition && oldFingerprint !== (nextFingerprint == null ? null : String(nextFingerprint));
        const metadataChanged = !old || Number(old.size) !== Number(entry.size)
          || Math.round(Number(old.mtime) || 0) !== Math.round(Number(entry.mtime) || 0)
          || String(old.ext || '').toLowerCase() !== entry.ext
          || String(old.file_type || '') !== String(entry.fileType || '');

        if (pointerIdentityChanged) {
          const oldTarget = old && oldExt === STRM_EXT ? baseTarget(old, work, loc, DEFAULT_HELPER_USER_AGENT) : null;
          const changed = await updatePointerFingerprint(row, nextFingerprint);
          if (changed) {
            pointerChanged += 1;
            clearProbeRetry(old || row);
            if (oldTarget) await invalidateTarget(oldTarget);
          } else {
            // A concurrent scanner changed the row after our snapshot. Do not
            // overwrite its metadata with an older directory listing.
            continue;
          }
        }
        if (metadataChanged) {
          const pointerContentsChanged = pointerIdentityChanged;
          const contentChanged = entry.ext === STRM_EXT || oldExt === STRM_EXT
            ? pointerContentsChanged
            : (Number(old && old.size) !== Number(entry.size)
              || Math.round(Number(old && old.mtime) || 0) !== Math.round(Number(entry.mtime) || 0)
              || String(old && old.ext || '').toLowerCase() !== entry.ext);
          await trackStore.updateTrackFileMeta(row.id, {
            ext: entry.ext,
            file_type: entry.fileType,
            size: entry.size,
            mtime: entry.mtime,
          }, contentChanged && !pointerIdentityChanged);
        }
      }

      if (deletions.length) {
        for (const row of deletions) {
          if (String(row.ext || '').toLowerCase() === STRM_EXT) {
            await invalidateTarget(baseTarget(row, work, loc, DEFAULT_HELPER_USER_AGENT));
            clearProbeRetry(row);
          }
        }
        await trackStore.deleteTrackRows(deletions.map(row => row.id));
        for (const row of deletions) {
          deps.audioCache?.deleteTrackCacheFiles?.(config.audioCacheFolderDir, workId, Number(row.seq));
        }
      }

      await loadProbeRetries(await trackStore.getTrackRows(workId), loc);

      return {
        changed: additions.length > 0 || deletions.length > 0 || pointerChanged > 0,
        added: additions.length,
        deleted: deletions.length,
        pointerChanged,
      };
    });
  }

  async function resolveTrack(workId, seq, requestUA) {
    await ensureSchema();
    const work = await getWork(workId);
    if (!work) return null;
    let loc;
    try {
      loc = resolveLocation(work);
    } catch {
      return null;
    }
    if (!isLocalLocation(loc)) return null;
    let row = await trackStore.getTrackRow(Number(workId), Number(seq));
    if (!row) {
      const error = new Error('STRM track row not found');
      error.code = 'TRACK_NOT_FOUND';
      error.status = 404;
      throw error;
    }
    if (String(row.ext || '').toLowerCase() !== STRM_EXT) return null;
    let target = await targetForRow(row, work, loc, requestUA, true);
    if (target && String(target.pointerFingerprint || '') !== String(row.pointer_fingerprint || '')) {
      await syncLocalTracks(workId, loc, true);
      row = await trackStore.getTrackRow(Number(workId), Number(seq));
      if (!row) {
        const error = new Error('STRM track row not found');
        error.code = 'TRACK_NOT_FOUND';
        error.status = 404;
        throw error;
      }
      target = String(row.ext || '').toLowerCase() === STRM_EXT
        ? await targetForRow(row, work, loc, requestUA, false)
        : null;
    }
    return target;
  }

  async function prepareTargetByPath(provider, rootRelPath, requestUA) {
    if (!isSafeRelativePath(rootRelPath)) {
      return { isStrm: true, valid: false, pointerError: Object.assign(new Error('STRM path is outside the media library'), { code: 'STRM_PATH_INVALID' }) };
    }
    const requested = normalizePath(rootRelPath);
    if (!requested.toLowerCase().endsWith(STRM_EXT) || !isLocalProvider(provider)) return null;
    const works = await knex('t_work').select('id', 'root_folder', 'dir', 'title', 'memo').where('root_folder', '=', provider.name);
    const work = works
      .filter(candidate => isInside(normalizePath(candidate.dir), requested))
      .sort((a, b) => normalizePath(b.dir).length - normalizePath(a.dir).length)[0];
    if (!work) return { isStrm: true, valid: false, pointerError: Object.assign(new Error('STRM work row not found'), { code: 'STRM_TRACK_NOT_FOUND' }) };
    const loc = resolveLocation(work);
    await syncLocalTracks(work.id, loc, true);
    const relPath = normalizePath(path.posix.relative(normalizePath(work.dir) || '.', requested));
    const row = (await trackStore.getTrackRows(work.id)).find(candidate => normalizePath(candidate.rel_path) === relPath);
    if (!row || String(row.ext || '').toLowerCase() !== STRM_EXT) {
      return { isStrm: true, valid: false, pointerError: Object.assign(new Error('STRM track row not found'), { code: 'STRM_TRACK_NOT_FOUND' }) };
    }
    return resolveTrack(work.id, row.seq, requestUA);
  }

  async function validateTarget(target) {
    if (!target || !target.isStrm || !target.valid || !target.pointerFingerprint || !isLocalLocation(target.loc)) return false;
    await ensureSchema();
    const row = await trackStore.getTrackRow(target.workId, target.seq);
    if (!row || Number(row.id) !== Number(target.row.id)
        || String(row.ext || '').toLowerCase() !== STRM_EXT
        || String(row.pointer_fingerprint || '') !== String(target.pointerFingerprint)) return false;
    let pointed;
    try {
      pointed = await readPointer(target.loc.provider, target.rootRelPath);
    } catch {
      await syncLocalTracks(target.workId, target.loc, true);
      return false;
    }
    if (!pointed.pointer || pointed.pointerFingerprint !== String(target.pointerFingerprint)) {
      await syncLocalTracks(target.workId, target.loc, true);
      return false;
    }
    target.pointer = pointed.pointer;
    target.pointerMtimeMs = pointed.pointerMtimeMs;
    target.row = row;
    return true;
  }

  async function persistDuration(target, value, options = {}) {
    if (!await validateTarget(target)) return false;
    const duration = value === null ? null : Number(value);
    if (duration !== null && (!Number.isFinite(duration) || duration < 0)) return false;
    const query = knex('t_track').where('id', '=', target.row.id)
      .andWhere('pointer_fingerprint', '=', target.pointerFingerprint);
    if (options.onlyIfEmpty) query.whereNull('duration');
    const wrote = affectedRows(await query.update({
      duration,
      duration_probe_mtime: Math.round(Number(target.pointerMtimeMs) || 0),
    })) > 0;
    if (!wrote) return false;
    // The file may change between the pre-write read and the database CAS.
    // A second provider read closes that window by syncing and clearing this
    // just-written value before it can become a lasting stale result.
    return validateTarget(target);
  }

  async function persistLufs(target, value, options = {}) {
    if (!await validateTarget(target)) return false;
    const lufs = Number(value);
    if (!Number.isFinite(lufs)) return false;
    const query = knex('t_track').where('id', '=', target.row.id)
      .andWhere('pointer_fingerprint', '=', target.pointerFingerprint);
    if (options.onlyIfEmpty) query.whereNull('lufs');
    const wrote = affectedRows(await query.update({ lufs, lufs_updated_at: Date.now() })) > 0;
    if (!wrote) return false;
    return validateTarget(target);
  }

  async function readWaveform(target, format) {
    if (!await validateTarget(target)) return null;
    const row = target.row;
    if (!row.waveform_path || row.waveform_format !== format || !config.audioCacheFolderDir) return null;
    const absolute = path.resolve(config.audioCacheFolderDir, row.waveform_path);
    if (!isFilesystemPathInside(config.audioCacheFolderDir, absolute)) return null;
    try {
      const buffer = await fs.promises.readFile(absolute);
      return await validateTarget(target) ? buffer : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function persistWaveform(target, buffer, format, resolution) {
    if (!config.audioCacheFolderDir || !Buffer.isBuffer(buffer) || !await validateTarget(target)) return false;
    const previous = target.row.waveform_path;
    // Each publication owns its file, so a stale task can remove its output
    // without deleting a newer result for the same seq or fingerprint.
    const relative = path.posix.join(String(target.workId), 'waveform',
      `${target.seq}-strm-${target.pointerFingerprint}-${crypto.randomBytes(6).toString('hex')}.kwav`);
    const absolute = path.join(config.audioCacheFolderDir, relative);
    const temporary = absolute + '.tmp';
    let accepted = false;
    try {
      await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
      await fs.promises.writeFile(temporary, buffer, { mode: 0o600, flag: 'wx' });
      await fs.promises.rename(temporary, absolute);
      if (!await validateTarget(target)) return false;
      const wrote = affectedRows(await knex('t_track').where('id', target.row.id)
        .andWhere('pointer_fingerprint', target.pointerFingerprint).update({
          waveform_path: relative, waveform_format: format,
          waveform_resolution: resolution, waveform_updated_at: Date.now(),
        }));
      accepted = wrote > 0 && await validateTarget(target);
      if (accepted && previous && previous !== relative) {
        const old = path.resolve(config.audioCacheFolderDir, previous);
        if (isFilesystemPathInside(config.audioCacheFolderDir, old)) await fs.promises.rm(old, { force: true }).catch(() => undefined);
      }
      return accepted;
    } finally {
      await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
      if (!accepted) await fs.promises.rm(absolute, { force: true }).catch(() => undefined);
    }
  }

  async function targetForCurrentRow(row, loc, requestUA = DEFAULT_HELPER_USER_AGENT) {
    const work = await getWork(row.work_id);
    if (!work) return null;
    return targetForRow(row, work, loc, requestUA, true);
  }

  async function migrateLegacyForWork(workId, oldMemo) {
    let work;
    let loc;
    try {
      work = await getWork(workId);
      loc = resolveLocation(work);
    } catch {
      return { durationMigrated: 0, lufsMigrated: 0, memoMigrated: 0 };
    }
    if (!isLocalLocation(loc)) return { durationMigrated: 0, lufsMigrated: 0, memoMigrated: 0 };
    const rows = await trackStore.getTrackRows(workId);
    const targetForRow = row => targetForCurrentRow(row, loc);
    const memoMigrated = await migrateLegacyMemo({ oldMemo, rows, targetForRow, persistDuration });
    const legacy = await migrateLegacyState({
      runtime,
      workId,
      loc,
      rows,
      targetForRow,
      persistDuration,
      persistLufs,
      logger,
    });
    return {
      durationMigrated: legacy.durationMigrated,
      lufsMigrated: legacy.lufsMigrated,
      memoMigrated,
    };
  }

  async function resolveRemoteProbe(target) {
    let resolve = injected.resolveStrmRedirect || runtime.resolveStrmRedirect;
    if (typeof resolve !== 'function') {
      try {
        resolve = require('./runtime').resolveStrmRedirect;
      } catch { }
    }
    if (typeof resolve !== 'function') {
      const error = new Error('STRM helper resolver unavailable');
      error.code = 'STRM_RESOLVER_UNAVAILABLE';
      throw error;
    }
    const resolved = await resolve(runtime, target);
    const finalUrl = resolved && (resolved.final || resolved.finalUrl || resolved.url);
    const final = finalUrl && typeof finalUrl.toString === 'function' ? finalUrl.toString() : String(finalUrl || '');
    if (!/^https?:\/\//i.test(final)) {
      const error = new Error('STRM helper did not return an HTTP media URL');
      error.code = 'STRM_RESOLVE_INVALID';
      throw error;
    }
    return {
      url: final,
      userAgent: normalizeUserAgent(resolved && resolved.userAgent) || target.userAgent || DEFAULT_HELPER_USER_AGENT,
    };
  }

  function pendingNativeRows(rows, supportedMediaExtList) {
    const extensions = new Set(Array.from(supportedMediaExtList || DEFAULT_MEDIA_EXTENSIONS, ext => String(ext).toLowerCase()));
    return rows.filter(row => {
      if (!extensions.has(String(row.ext || '').toLowerCase())) return false;
      if (row.duration !== null && row.duration !== undefined) return false;
      const lastProbe = row.duration_probe_mtime;
      return lastProbe === null || lastProbe === undefined
        || Number(lastProbe) !== Math.round(Number(row.mtime) || 0);
    });
  }

  function pendingStrmRows(rows, loc) {
    if (!durationProbeEnabled()) return [];
    const now = Date.now();
    return rows.filter(row => {
      if (String(row.ext || '').toLowerCase() !== STRM_EXT) return false;
      const virtual = parseVirtualMediaName(path.posix.basename(row.rel_path), DEFAULT_MEDIA_EXTENSIONS);
      if (!virtual.valid || (row.duration !== null && row.duration !== undefined)) return false;
      const identity = loc ? probeIdentityForRow(row, loc) : `${Number(row.work_id)}/${Number(row.seq)}:${String(row.pointer_fingerprint || 'unfingerprinted')}`;
      if (probeFlights.has(identity) || Number(probeRetryAt.get(identity) || 0) > now || isRetryThrottled(row)) return false;
      return true;
    });
  }

  function enqueueDurationProbe(target, task) {
    const identity = probeIdentity(target);
    const existing = probeFlights.get(identity);
    if (existing) return existing;
    const queue = runtime.queue;
    let promise;
    if (queue && typeof queue.enqueue === 'function') {
      promise = queue.enqueue({ key: target.key, pointerFingerprint: target.pointerFingerprint }, task);
    } else {
      promise = Promise.resolve().then(task);
    }
    probeFlights.set(identity, promise);
    void promise.finally(() => {
      if (probeFlights.get(identity) === promise) probeFlights.delete(identity);
    }).catch(() => undefined);
    return promise;
  }

  async function scanStrmDurations(loc, rows, concurrency, onProgress) {
    const targets = pendingStrmRows(rows, loc);
    const progress = { total: targets.length, done: 0, succeeded: 0, failed: 0, currentFile: null };
    onProgress?.({ ...progress });
    let cursor = 0;
    const workerCount = Math.max(1, Math.min(targets.length || 1, Number(concurrency) || 1));
    const worker = async () => {
      while (cursor < targets.length) {
        const index = cursor++;
        const row = targets[index];
        let target = null;
        progress.currentFile = row.rel_path;
        onProgress?.({ ...progress });
        try {
          target = await targetForCurrentRow(row, loc);
          if (!target || !target.valid || !target.pointer || !target.pointer.url) {
            const error = target && target.pointerError || Object.assign(new Error('invalid STRM pointer'), { code: 'POINTER_INVALID' });
            throw error;
          }
          await saveProbeState(target, {
            probeStatus: 'pending',
            probeError: null,
            probeRetryAt: null,
            probeAt: Date.now(),
          });
          await enqueueDurationProbe(target, async () => {
            if (!durationProbeEnabled()) {
              throw Object.assign(new Error('STRM duration probing is disabled'), { code: 'STRM_PROBE_DISABLED' });
            }
            if (!await validateTarget(target)) {
              const error = Object.assign(new Error('STRM target changed before probe'), { code: 'POINTER_IDENTITY_STALE' });
              throw error;
            }
            const resolved = await resolveRemoteProbe(target);
            const probe = injected.probeRemoteDuration || require('./scanner').probeRemoteDuration;
            const duration = await probe(resolved.url, {
              timeoutMs: runtime.options?.durationProbe?.timeoutMs,
              userAgent: resolved.userAgent,
            });
            if (!await persistDuration(target, duration)) {
              const error = Object.assign(new Error('STRM target changed before duration was persisted'), { code: 'POINTER_IDENTITY_STALE' });
              throw error;
            }
            await saveProbeState(target, {
              probeStatus: 'ok',
              probeError: null,
              probeRetryAt: null,
              probeAt: Date.now(),
            });
            return duration;
          });
          probeRetryAt.delete(probeIdentity(target));
          progress.succeeded += 1;
        } catch (error) {
          // Turning off probing while a task is queued is not a remote
          // failure. Leave it eligible immediately when the user re-enables.
          if (error && error.code === 'STRM_PROBE_DISABLED') continue;
          progress.failed += 1;
          const code = safeCode(error);
          const failedIdentity = target ? probeIdentity(target) : `${Number(row.work_id)}/${Number(row.seq)}:unfingerprinted`;
          const retryDelay = Math.max(0, Number(runtime.options?.durationProbe?.retryDelayMs ?? 60 * 60 * 1000));
          const retryAt = Date.now() + retryDelay;
          if (target) setProbeRetry(row, loc, target.pointerFingerprint, retryAt);
          else probeRetryAt.set(failedIdentity, retryAt);
          if (target) await saveProbeState(target, {
            probeStatus: 'error',
            probeError: code,
            probeRetryAt: retryAt,
            probeAt: Date.now(),
          });
          logWarn(`[STRM native] duration probe failed work=${row.work_id} seq=${row.seq} code=${code}`);
        } finally {
          progress.done += 1;
          onProgress?.({ ...progress });
        }
      }
    };
    await Promise.all(Array.from({ length: workerCount }, worker));
    progress.currentFile = null;
    onProgress?.({ ...progress });
    return { scanned: targets.length, succeeded: progress.succeeded, failed: progress.failed };
  }

  async function wrappedScanWorkDurations(original, loc, rows, concurrency, onProgress) {
    if (!isLocalLocation(loc)) return original(loc, rows, concurrency, onProgress);
    const strmRows = pendingStrmRows(rows, loc);
    const nativeTotal = pendingNativeRows(rows, installedUtils?.supportedMediaExtList).length;
    const total = nativeTotal + strmRows.length;
    let nativeResult = { scanned: 0, succeeded: 0, failed: 0 };
    const reportNative = progress => onProgress?.({
      total,
      done: Number(progress.done) || 0,
      succeeded: Number(progress.succeeded) || 0,
      failed: Number(progress.failed) || 0,
      currentFile: progress.currentFile || null,
    });
    nativeResult = await original(loc, rows, concurrency, reportNative);
    const reportStrm = progress => onProgress?.({
      total,
      done: nativeResult.scanned + (Number(progress.done) || 0),
      succeeded: nativeResult.succeeded + (Number(progress.succeeded) || 0),
      failed: nativeResult.failed + (Number(progress.failed) || 0),
      currentFile: progress.currentFile || null,
    });
    const strmResult = await scanStrmDurations(loc, rows, concurrency, reportStrm);
    onProgress?.({
      total,
      done: nativeResult.scanned + strmResult.scanned,
      succeeded: nativeResult.succeeded + strmResult.succeeded,
      failed: nativeResult.failed + strmResult.failed,
      currentFile: null,
    });
    return {
      scanned: nativeResult.scanned + strmResult.scanned,
      succeeded: nativeResult.succeeded + strmResult.succeeded,
      failed: nativeResult.failed + strmResult.failed,
    };
  }

  function decorateTrackList(tracks, rows, workId) {
    const rowBySeq = new Map(rows.map(row => [Number(row.seq), row]));
    return tracks.map(track => {
      if (String(track.ext || '').toLowerCase() !== STRM_EXT) return track;
      const row = rowBySeq.get(Number(track.seq));
      const virtual = parseVirtualMediaName(track.title, DEFAULT_MEDIA_EXTENSIONS);
      const decorated = {
        ...track,
        isStrm: true,
        sourceExt: STRM_EXT,
        physicalTitle: track.title,
        displayTitle: virtual.displayName || track.title,
        mediaExt: virtual.mediaExt || null,
        isVideo: Boolean(virtual.isVideo),
        virtual,
        pointerFingerprint: row && row.pointer_fingerprint || null,
        mtime: row ? Number(row.mtime) : 0,
        durationProbeMtime: row ? Number(row.duration_probe_mtime) : null,
        probeRetryAt: row ? Number(probeRetryByTrack.get(`${Number(workId)}/${Number(row.seq)}`)?.retryAt || 0) : 0,
      };
      if (row && row.duration !== null && row.duration !== undefined) decorated.duration = Number(row.duration);
      return decorated;
    });
  }

  function rewriteStrmTree(tree) {
    function visit(items) {
      for (const item of items || []) {
        if (item.type === 'folder') {
          visit(item.children);
          continue;
        }
        const title = String(item.title || '');
        if (!/\.strm$/i.test(title)) continue;
        const virtual = parseVirtualMediaName(title, DEFAULT_MEDIA_EXTENSIONS);
        item.isStrm = true;
        item.sourceExt = STRM_EXT;
        item.mediaExt = virtual.mediaExt || null;
        item.isVideo = Boolean(virtual.isVideo);
        if (virtual.valid) {
          item.title = virtual.displayName;
          item.ext = virtual.mediaExt;
          item.type = 'audio';
        }
      }
    }
    visit(tree);
    return tree;
  }

  function installUtils(utils) {
    if (!utils || utils.__nativeStrmTracksInstalled) return bridge;
    installedUtils = utils;
    appConfig = runtime.config || deps.config || appConfig;
    const originalSync = utils.syncWorkTracks;
    const originalScanDurations = utils.scanWorkDurations;
    const originalGetTrackList = utils.getTrackList;
    const originalToTree = utils.toTree;
    const originalTracksMissing = utils.tracksMissingDuration;
    const originalRowsMissing = utils.rowsMissingDuration;
    const originalConsumeWorkScanNeeded = utils.consumeWorkScanNeeded;
    const originalMigrateMemo = utils.migrateDurationsFromMemo;

    if (typeof originalSync === 'function') {
      utils.syncWorkTracks = async function syncWorkTracksNative(workId, loc) {
        providerKindByWork.set(Number(workId), loc?.provider?.kind || 'unknown');
        if (!isLocalLocation(loc)) return originalSync(workId, loc);
        return syncLocalTracks(workId, loc, true);
      };
    }
    if (typeof originalScanDurations === 'function') {
      utils.scanWorkDurations = function scanWorkDurationsNative(loc, rows, concurrency, onProgress) {
        return wrappedScanWorkDurations(originalScanDurations, loc, rows, concurrency, onProgress);
      };
    }
    if (typeof originalGetTrackList === 'function') {
      utils.getTrackList = async function getTrackListNative(workId, loc, options) {
        providerKindByWork.set(Number(workId), loc?.provider?.kind || 'unknown');
        if (!isLocalLocation(loc)) return originalGetTrackList(workId, loc, options);
        await ensureSchema();
        const rowsBefore = await trackStore.getTrackRows(workId);
        if (!rowsBefore.length || (options && options.sync)) {
          const syncResult = await syncLocalTracks(workId, loc, true);
          if (options && options.sync && syncResult.changed) localWorkScanNeeded.add(Number(workId));
        }
        const safeOptions = options && options.sync ? { ...options, sync: false } : options;
        const tracks = await originalGetTrackList(workId, loc, safeOptions);
        const rows = await trackStore.getTrackRows(workId);
        return decorateTrackList(tracks, rows, workId);
      };
    }
    if (typeof originalConsumeWorkScanNeeded === 'function') {
      utils.consumeWorkScanNeeded = function consumeWorkScanNeededNative(workId) {
        const nativeNeeded = originalConsumeWorkScanNeeded(workId);
        const localNeeded = localWorkScanNeeded.delete(Number(workId));
        return Boolean(nativeNeeded || localNeeded);
      };
    }
    if (typeof originalToTree === 'function') {
      utils.toTree = function toTreeNative(tracks, workTitle, workDir, rootFolderName) {
        const root = getRootFolder(rootFolderName);
        if (root && root.type && root.type !== 'local') return originalToTree(tracks, workTitle, workDir, rootFolderName);
        return rewriteStrmTree(originalToTree(tracks, workTitle, workDir, rootFolderName));
      };
    }
    if (typeof originalTracksMissing === 'function') {
      utils.tracksMissingDuration = function tracksMissingDurationNative(tracks) {
        if (!durationProbeEnabled()) return originalTracksMissing(tracks);
        if (originalTracksMissing(tracks)) return true;
        return (tracks || []).some(track => track.isStrm && track.virtual?.valid
          && providerKindByWork.get(Number(String(track.hash || '').split('/')[0])) === 'local'
          && track.duration === undefined
          && Number(track.probeRetryAt || 0) <= Date.now());
      };
    }
    if (typeof originalRowsMissing === 'function') {
      utils.rowsMissingDuration = function rowsMissingDurationNative(rows) {
        if (!durationProbeEnabled()) return originalRowsMissing(rows);
        if (originalRowsMissing(rows)) return true;
        return (rows || []).some(row => String(row.ext || '').toLowerCase() === STRM_EXT
          && providerKindByWork.get(Number(row.work_id)) === 'local'
          && parseVirtualMediaName(path.posix.basename(row.rel_path), DEFAULT_MEDIA_EXTENSIONS).valid
          && (row.duration === null || row.duration === undefined)
          && !isRetryThrottled(row));
      };
    }
    if (typeof originalMigrateMemo === 'function') {
      utils.migrateDurationsFromMemo = async function migrateDurationsFromMemoNative(workId, oldMemo) {
        const normal = await originalMigrateMemo(workId, oldMemo);
        await ensureSchema();
        const migrated = await migrateLegacyForWork(workId, oldMemo);
        return Number(normal || 0) + Number(migrated.memoMigrated || 0) + Number(migrated.durationMigrated || 0);
      };
    }
    Object.defineProperty(utils, '__nativeStrmTracksInstalled', { value: true, enumerable: false });
    return bridge;
  }

  async function validateTargetPath(provider, rootRelPath) {
    const target = await prepareTargetByPath(provider, rootRelPath);
    if (!target || !target.isStrm) return null;
    return validateTarget(target);
  }

  const bridge = {
    installUtils,
    resolveTrack,
    validateTarget,
    persistDuration,
    persistLufs,
    persistWaveform,
    readWaveform,
    invalidateTarget,
    prepareTargetByPath,
    validateTargetPath,
    ensureSchema,
    syncLocalTracks,
    scanStrmDurations,
    migrateLegacyForWork,
    parseVirtualMediaName,
    pointerFingerprint,
    STRM_EXT,
  };
  return bridge;
}

module.exports = {
  STRM_EXT,
  createTrackBridge,
  safeCode,
  normalizePath,
  isInside,
};
