'use strict';

const path = require('path');
const fs = require('fs');

const EMPTY_LOUDNORM = Object.freeze({
  input_i: '', input_tp: '', input_lra: '', input_thresh: '',
  output_i: '', output_tp: '', output_lra: '', output_thresh: '',
  normalization_type: '', target_offset: '',
});

function taskKey(target) {
  const workId = Number(target && target.workId);
  const seq = Number(target && (target.seq == null ? target.index : target.seq));
  if (!Number.isInteger(workId) || workId < 0 || !Number.isInteger(seq) || seq < 0) {
    const error = new Error('invalid STRM task coordinates');
    error.code = 'INVALID_TRACK';
    error.status = 400;
    throw error;
  }
  return `${workId}/${seq}`;
}

function storedLufs(row) {
  if (!row || row.lufs === null || row.lufs === undefined || row.lufs === '') return null;
  const value = Number(row.lufs);
  return Number.isFinite(value) ? value : null;
}

function lufsPayload(value) {
  return {
    loudnorm: Object.assign({}, EMPTY_LOUDNORM, {
      input_i: Number(value).toFixed(2),
    }),
    peakLevels: [],
  };
}

function resultPayload(result) {
  if (result && result.loudnorm && typeof result.loudnorm === 'object') {
    return { loudnorm: Object.assign({}, result.loudnorm), peakLevels: Array.isArray(result.peakLevels) ? result.peakLevels : [] };
  }
  return result;
}

function localPathFrom(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.path === 'string') return value.path;
  if (value && value.local && typeof value.local.path === 'string') return value.local.path;
  if (value && typeof value.cachePath === 'string') return value.cachePath;
  return null;
}

function isPathInside(base, candidate) {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function errorWithCode(code, message, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function safeTaskError(error) {
  const rawCode = String(error && error.code || 'LUFS_FAILED');
  const code = rawCode.replace(/[^A-Z0-9_-]/gi, '').slice(0, 64) || 'LUFS_FAILED';
  const known = {
    INVALID_TRACK: 'Invalid track coordinates',
    STRM_TARGET_CHANGED: 'STRM pointer changed during analysis',
    STRM_LOCAL_MEDIA_REQUIRED: 'A complete local media cache is required',
    STRM_CACHE_INCOMPLETE: 'A complete local media cache is required',
    STRM_TASK_UNSUPPORTED: 'This task is unsupported for STRM media',
    LUFS_RESULT_INVALID: 'Native LUFS analysis returned no integrated loudness',
    COLD_CACHE_POLICY: 'Media analysis is skipped by the current cache policy',
    DOWNLOAD_TOO_LARGE: 'Media analysis is skipped by the current cache policy',
    COLD_CACHE_DISABLED: 'Media analysis is skipped by the current cache policy',
  };
  return { code, message: known[code] || 'Native LUFS analysis failed' };
}

/**
 * Build STRM loudness task adapters around Kikoeru 0.6.17's task registry,
 * light queue, and read-only LUFS analyzer.  The cache path is resolved before
 * ffmpeg starts, and the track bridge performs a pointer-fingerprint CAS when
 * the result is persisted.
 */
function createNativeTasks({
  runtime,
  trackBridge,
  mediaProcess,
  audioProcessor,
  lightTaskQueue,
  ensureLocal,
  assertCompleteLocal,
  logger = console,
} = {}) {
  const registry = mediaProcess && mediaProcess.loudnormRegistry;
  const calculateLUFSReadOnly = audioProcessor && audioProcessor.calculateLUFSReadOnly;
  if (!runtime) throw new Error('createNativeTasks requires runtime');
  if (!trackBridge) throw new Error('createNativeTasks requires trackBridge');
  if (!registry || typeof registry.create !== 'function' || typeof registry.getActive !== 'function') {
    throw new Error('createNativeTasks requires the native loudnorm registry');
  }
  if (typeof calculateLUFSReadOnly !== 'function') {
    throw new Error('createNativeTasks requires calculateLUFSReadOnly');
  }
  if (!lightTaskQueue || typeof lightTaskQueue.add !== 'function') {
    throw new Error('createNativeTasks requires the native light task queue');
  }

  function keyFor(target) {
    return typeof mediaProcess.taskKey === 'function'
      ? mediaProcess.taskKey(target.workId, target.seq == null ? target.index : target.seq)
      : taskKey(target);
  }

  function isSkipped(target) {
    const policy = runtime.options && runtime.options.loudness || {};
    return policy.enabled === false || (policy.audioOnly !== false && Boolean(target && target.isVideo));
  }

  function sameTarget(handle, target) {
    if (!handle || !target) return false;
    const expected = handle.pointerFingerprint || (handle.extra && handle.extra.pointerFingerprint);
    if (expected && target.pointerFingerprint && expected !== target.pointerFingerprint) return false;
    const expectedKey = handle.targetKey || (handle.extra && handle.extra.targetKey);
    if (expectedKey && target.key && expectedKey !== target.key) return false;
    return true;
  }

  function analysisPolicyKey() {
    return runtime.cache?.analysisPolicyKey?.()
      || JSON.stringify({ coldCache: runtime.options?.coldCache, loudness: runtime.options?.loudness });
  }

  function getHandle(target, { includeFinished = true } = {}) {
    const key = keyFor(target);
    const handle = includeFinished ? registry.get(key) : registry.getActive(key);
    if (!handle) return undefined;
    if (!sameTarget(handle, target) || (handle.skipped && handle.analysisPolicyKey !== analysisPolicyKey())) {
      registry.remove?.(handle);
      return undefined;
    }
    return handle;
  }

  async function validateTarget(target) {
    if (typeof trackBridge.validateTarget !== 'function') return true;
    const result = await trackBridge.validateTarget(target);
    if (result === false || (result && result.valid === false)) {
      throw errorWithCode('STRM_TARGET_CHANGED', 'STRM pointer changed during media analysis');
    }
    return true;
  }

  function update(handle, patch) {
    if (handle.invalidated) return handle.info;
    return registry.update(handle, patch);
  }

  function finish(handle, state, patch = {}) {
    if (handle.invalidated) {
      registry.remove?.(handle);
      return handle.info;
    }
    return registry.finish(handle, Object.assign({ state }, patch));
  }

  async function resolveAnalysisPath(target, options) {
    let source = localPathFrom(options.sourcePath);
    if (!source) {
      const prepare = options.ensureLocal || ensureLocal;
      if (typeof prepare !== 'function') {
        throw errorWithCode('STRM_LOCAL_MEDIA_REQUIRED', 'STRM analysis requires a complete local media cache');
      }
      source = localPathFrom(await prepare(target));
    }
    await assertAnalysisCache(target, source);
    return source;
  }

  async function assertAnalysisCache(target, source) {
    if (!source || !path.isAbsolute(source)
      || /\.(?:strm|part)$/i.test(source)
      || source.includes(`${path.sep}.part${path.sep}`)) {
      throw errorWithCode('STRM_LOCAL_MEDIA_REQUIRED', 'STRM analysis requires a complete local media cache');
    }
    if (typeof assertCompleteLocal === 'function') {
      const valid = await assertCompleteLocal(target, source);
      if (valid !== true) throw errorWithCode('STRM_CACHE_INCOMPLETE', 'STRM analysis requires a complete local media cache');
      return;
    }
    let stat;
    try { stat = await fs.promises.stat(source); } catch {
      throw errorWithCode('STRM_CACHE_INCOMPLETE', 'STRM analysis requires a complete local media cache');
    }
    if (!stat.isFile() || stat.size <= 0) {
      throw errorWithCode('STRM_CACHE_INCOMPLETE', 'STRM analysis requires a complete local media cache');
    }
    if (!runtime.cache || typeof runtime.cache.get !== 'function') {
      throw new Error('runtime.cache.get is required to validate STRM analysis input');
    }
    const record = await runtime.cache.get(target);
    const cacheRoot = runtime.cache.limits && runtime.cache.limits.rootDir;
    if (!record || record.downloadReady !== true || !record.cachePath
      || path.resolve(record.cachePath) !== path.resolve(source)
      || record.pointerFingerprint !== target.pointerFingerprint
      || (cacheRoot && !isPathInside(cacheRoot, source))
      || (target.mediaExt && path.extname(source).toLowerCase() !== String(target.mediaExt).toLowerCase())) {
      throw errorWithCode('STRM_CACHE_INCOMPLETE', 'STRM analysis requires a complete local media cache');
    }
  }

  async function compute(handle, target, options) {
    await validateTarget(target);
    let sourcePath;
    if (options.sourcePath) {
      sourcePath = await resolveAnalysisPath(target, options);
    } else {
      update(handle, { state: 'queued', extra: { stage: 'download' } });
      try {
        sourcePath = await resolveAnalysisPath(target, options);
      } catch (error) {
        if (!['DOWNLOAD_TOO_LARGE', 'COLD_CACHE_POLICY', 'COLD_CACHE_DISABLED'].includes(String(error && error.code || ''))) throw error;
        if (handle.analysisPolicyKey === analysisPolicyKey()) {
          await runtime.cache.markAnalysisSkipped?.(target, error.code);
        }
        handle.skipped = true;
        return { skipped: true };
      }
    }
    await validateTarget(target);

    const row = target.row || {};
    const rawDuration = options.durationSec == null ? row.duration : options.durationSec;
    const duration = rawDuration == null || rawDuration === '' ? undefined : Number(rawDuration);
    const durationSec = Number.isFinite(duration) && duration > 0 ? duration : undefined;
    const result = await lightTaskQueue.add(async () => {
      if (handle.invalidated) throw errorWithCode('STRM_TARGET_CHANGED', 'STRM pointer changed during media analysis');
      update(handle, { state: 'running', percent: 0, extra: { stage: 'analyze' } });
      return calculateLUFSReadOnly(sourcePath, {
        durationSec,
        onProgress(percent) {
          const value = Number(percent);
          if (!Number.isFinite(value)) return;
          update(handle, {
            state: 'running',
            percent: Math.max(0, Math.min(99, Math.round(value))),
            extra: { stage: 'analyze' },
          });
        },
      });
    });
    await validateTarget(target);
    const lufs = Number(result && result.input_i);
    if (!Number.isFinite(lufs)) {
      throw errorWithCode('LUFS_RESULT_INVALID', 'Native LUFS analyzer returned no integrated loudness', 500);
    }
    if (typeof trackBridge.persistLufs !== 'function') {
      throw new Error('trackBridge.persistLufs is required');
    }
    const persisted = await trackBridge.persistLufs(target, lufs);
    if (persisted !== true && !(Number.isFinite(Number(persisted)) && Number(persisted) > 0)) {
      throw errorWithCode('STRM_TARGET_CHANGED', 'STRM pointer changed before LUFS was persisted');
    }
    handle.lufs = lufs;
    handle.result = resultPayload({ loudnorm: result, peakLevels: [] });
    return handle.result;
  }

  function startLoudnorm(target, options = {}) {
    const key = keyFor(target);
    if (isSkipped(target)) return { handle: undefined, alreadyRunning: false, ready: true, skipped: true };
    const lufs = storedLufs(target.row);
    if (lufs !== null) return { handle: undefined, alreadyRunning: false, ready: true, skipped: false, lufs };

    const active = registry.getActive(key);
    if (active && sameTarget(active, target)) {
      return { handle: active, alreadyRunning: true, ready: false, skipped: false };
    }
    if (active) registry.remove?.(active);

    const handle = registry.create(key, {
      retained: true,
      extra: { stage: options.sourcePath ? 'analyze' : 'download' },
    });
    handle.targetKey = target.key;
    handle.pointerFingerprint = target.pointerFingerprint;
    handle.analysisPolicyKey = analysisPolicyKey();
    handle.target = target;
    const promise = compute(handle, target, options);
    handle.promise = promise;
    void promise.then(
      () => finish(handle, 'done', { percent: 100, extra: { stage: 'done' } }),
      error => {
        const safe = safeTaskError(error);
        finish(handle, 'failed', { percent: 0, error: safe.message, extra: { stage: 'failed', code: safe.code } });
        logger.warn?.('[STRM] native loudness task failed work=%s seq=%s code=%s', target.workId, target.seq == null ? target.index : target.seq, safe.code);
      },
    );
    // A playback hook may schedule analysis without awaiting it.  Keep the
    // task rejection observed while preserving the rejecting handle.promise
    // for result/wait callers.
    void promise.catch(() => undefined);
    return { handle, alreadyRunning: false, ready: false, skipped: false };
  }

  function status(target) {
    if (isSkipped(target)) {
      return { ready: true, active: false, state: 'done', skipped: true, lufs: null, task: undefined };
    }
    const lufs = storedLufs(target.row);
    if (lufs !== null) {
      return { ready: true, active: false, state: 'done', skipped: false, lufs, task: undefined };
    }
    const task = getHandle(target);
    if (task && task.skipped) {
      return { ready: true, active: false, state: 'done', skipped: true, lufs: null, task };
    }
    const active = task && (task.info.state === 'queued' || task.info.state === 'running');
    return {
      ready: false,
      active: Boolean(active),
      state: active ? task.info.state : (task ? task.info.state : 'absent'),
      skipped: false,
      lufs: null,
      task,
    };
  }

  function invalidate(target) {
    let key;
    try { key = keyFor(target); } catch { return false; }
    const handle = registry.get?.(key);
    if (!handle || !sameTarget(handle, target)) return false;
    handle.invalidated = true;
    registry.update?.(handle, {
      state: 'failed',
      percent: 0,
      error: 'STRM pointer changed',
      extra: { stage: 'failed', code: 'STRM_TARGET_CHANGED' },
    });
    registry.remove?.(handle);
    return true;
  }

  function scheduleLoudness(target, sourcePath) {
    const started = startLoudnorm(target, { sourcePath });
    return started.handle && started.handle.promise
      ? started.handle.promise
      : Promise.resolve(started.skipped ? { skipped: true } : (started.lufs == null ? null : lufsPayload(started.lufs)));
  }

  async function wait(handle, timeoutMs) {
    if (!handle || !handle.promise) return { settled: true, timedOut: false, error: null };
    let timer;
    let timedOut = false;
    let error = null;
    const settled = handle.promise.then(
      () => undefined,
      value => { error = safeTaskError(value).message; },
    );
    await Promise.race([
      settled,
      new Promise(resolve => {
        timer = setTimeout(() => { timedOut = true; resolve(); }, Math.max(1, Number(timeoutMs) || 1));
      }),
    ]);
    if (timer) clearTimeout(timer);
    return { settled: !timedOut, timedOut, error };
  }

  return {
    startLoudnorm,
    scheduleLoudness,
    getHandle,
    status,
    invalidate,
    wait,
    lufsPayload,
    resultPayload,
    keyFor,
    isSkipped,
  };
}

module.exports = {
  EMPTY_LOUDNORM,
  createNativeTasks,
  taskKey,
  storedLufs,
  lufsPayload,
  safeTaskError,
};
