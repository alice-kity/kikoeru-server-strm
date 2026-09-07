'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { readPointerFile, PointerError } = require('./pointer');
const { parseVirtualMediaName, DEFAULT_MEDIA_EXTENSIONS } = require('./virtual-name');
const { makeRecordKey } = require('./state-store');

const execFileAsync = promisify(execFile);
const PROBE_IMPLEMENTATION_VERSION = 2;

function safeErrorCode(error, fallback = 'PROBE_FAILED') {
  const raw = String(error && error.code || fallback);
  return raw.replace(/[^A-Z0-9_-]/gi, '').slice(0, 64) || fallback;
}

function safeErrorDetail(error) {
  const raw = String(error && (error.probeStderr || error.stderr || error.message) || '')
    .replace(/https?:\/\/[^\s]+/gi, '[url]')
    .replace(/(?:token|pickcode|t|u|s|d|k|us|uc|v)=[^\s&]+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return raw.slice(0, 240);
}

function scanLogger(options = {}) {
  const logger = options.logger && typeof options.logger === 'object' ? options.logger : null;
  return {
    info(message) { logger?.info?.(message); },
    warn(message) { logger?.warn?.(message); },
  };
}

async function listFiles(rootDir) {
  const output = [];
  async function visit(current) {
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        output.push(absolute);
      }
    }
  }
  await visit(rootDir);
  return output;
}

async function probeRemoteDuration(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 60000);
  const userAgent = String(options.userAgent || 'Mozilla/5.0').slice(0, 200);
  const exec = options.execFileImpl || execFileAsync;
  let result;
  try {
    result = await exec('ffprobe', [
      '-v', 'error', '-user_agent', userAgent,
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', String(url),
    ], { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
  } catch (error) {
    const exitCode = Number.isFinite(Number(error && error.code))
      ? `FFPROBE_EXIT_${Number(error.code)}`
      : `FFPROBE_${safeErrorCode(error, 'FAILED')}`;
    error.code = exitCode;
    error.probeStderr = safeErrorDetail(error);
    throw error;
  }
  const { stdout } = result;
  const duration = Number.parseFloat(String(stdout).trim());
  if (!Number.isFinite(duration) || duration < 0) {
    const error = new Error('remote ffprobe returned an invalid duration');
    error.code = 'PROBE_INVALID_DURATION';
    throw error;
  }
  return duration;
}

function relativePath(rootDir, absolute) {
  return path.relative(rootDir, absolute).split(path.sep).join('/');
}

function normalizeRootFolder(value) {
  if (value && typeof value === 'object') return String(value.name || value.path || '');
  return String(value || '');
}

/**
 * Discover only local `.strm` files and update their durable probe state.
 * Local subtitle/image/text files are intentionally not included here.
 */
async function scanStrmMemo(workDir, options = {}) {
  const files = await listFiles(workDir);
  const mediaExtensions = options.mediaExtensions || DEFAULT_MEDIA_EXTENSIONS;
  const pointerOptions = options.pointerOptions || {};
  const stateStore = options.store;
  const queue = options.queue;
  const rootFolder = normalizeRootFolder(options.rootFolder);
  const workRelativePath = String(options.workRelativePath || '');
  const oldMemo = options.oldMemo || {};
  const oldMtime = oldMemo.mtime || {};
  const oldDuration = oldMemo.duration || {};
  const memo = { duration: {}, mtime: {}, strm: {}, isContainLyric: Boolean(oldMemo.isContainLyric) };
  const jobs = [];
  const now = Date.now();
  const logger = scanLogger(options);
  const scanStartedAt = Date.now();
  let discovered = 0;
  let queued = 0;
  let succeeded = 0;
  let failed = 0;
  let invalid = 0;
  logger.info(`[STRM][scan] start scope=${path.posix.join(rootFolder, workRelativePath)} files=${files.length}`);

  for (const filePath of files) {
    const relative = relativePath(workDir, filePath);
    const ext = path.extname(filePath).toLowerCase();
    if (['.lrc', '.srt', '.ass', '.vtt'].includes(ext)) memo.isContainLyric = true;
    if (ext !== '.strm') continue;
    discovered += 1;
    const stat = await fs.promises.stat(filePath);
    const mtimeMs = Math.round(stat.mtimeMs);
    const virtual = parseVirtualMediaName(path.basename(filePath), mediaExtensions);
    const key = makeRecordKey(rootFolder, path.posix.join(workRelativePath.replace(/\\/g, '/'), relative));
    const stateBase = {
      key,
      rootFolder,
      relativePath: path.posix.join(workRelativePath.replace(/\\/g, '/'), relative),
      pointerMtimeMs: mtimeMs,
      mediaExt: virtual.mediaExt || null,
      isVideo: Boolean(virtual.isVideo),
    };
    memo.mtime[relative] = mtimeMs;
    if (!virtual.valid) {
      invalid += 1;
      const record = stateStore ? await stateStore.upsert(key, Object.assign({}, stateBase, {
        probeStatus: 'invalid-name',
        probeError: virtual.code,
        duration: null,
        loudnessReady: false,
        downloadReady: false,
      })) : null;
      memo.strm[relative] = {
        status: 'invalid-name',
        error: virtual.code,
        isStrm: true,
        sourceExt: '.strm',
        mediaExt: virtual.mediaExt || null,
      };
      continue;
    }

    let pointer;
    try {
      pointer = await readPointerFile(filePath, pointerOptions);
    } catch (error) {
      const code = error instanceof PointerError ? error.code : 'POINTER_READ_FAILED';
      if (stateStore) await stateStore.upsert(key, Object.assign({}, stateBase, {
        probeStatus: 'invalid-pointer',
        probeError: code,
        duration: null,
        pointerFingerprint: null,
        downloadReady: false,
        loudnessReady: false,
      }));
      memo.strm[relative] = {
        status: 'invalid-pointer',
        error: code,
        isStrm: true,
        sourceExt: '.strm',
        mediaExt: virtual.mediaExt,
      };
      continue;
    }

    stateBase.pointerFingerprint = pointer.fingerprint;
    const existing = stateStore ? await stateStore.get(key) : null;
    const changed = !existing
      || existing.pointerFingerprint !== pointer.fingerprint
      || Number(existing.pointerMtimeMs) !== mtimeMs;
    const duration = !changed && existing && existing.probeStatus === 'ok' && Number.isFinite(Number(existing.duration))
      ? Number(existing.duration)
      : (!changed && Number.isFinite(Number(oldDuration[relative])) ? Number(oldDuration[relative]) : null);
    if (duration !== null) memo.duration[relative] = duration;
    memo.strm[relative] = {
      status: existing && !changed ? (existing.probeStatus || 'pending') : 'pending',
      isStrm: true,
      sourceExt: '.strm',
      mediaExt: virtual.mediaExt,
      isVideo: virtual.isVideo,
      pointerFingerprint: pointer.fingerprint,
    };
    if (stateStore) {
      await stateStore.upsert(key, Object.assign({}, stateBase, {
        probeStatus: changed ? 'pending' : (existing.probeStatus || 'pending'),
        probeError: changed ? null : (existing.probeError || null),
        duration,
      }));
    }
    const retryAt = Number(existing && existing.probeRetryAt || 0);
    const probeImplementationChanged = Boolean(existing && existing.probeVersion !== PROBE_IMPLEMENTATION_VERSION);
    const shouldProbe = options.probeEnabled !== false && queue && (changed || duration === null)
      && !(existing && !changed && existing.probeStatus === 'error' && retryAt > now && !probeImplementationChanged);
    if (shouldProbe) {
      queued += 1;
      const item = { key, relative, pointer, virtual, stateBase };
      const job = queue.enqueue(item, async entry => {
        const probeStartedAt = Date.now();
        try {
          const probedDuration = await (options.probe || probeRemoteDuration)(entry.pointer.url, {
            timeoutMs: options.probeTimeoutMs,
          }, entry);
          if (stateStore) await stateStore.upsert(entry.key, {
            probeStatus: 'ok',
            probeAt: Date.now(),
            probeError: null,
            probeRetryAt: null,
            probeVersion: PROBE_IMPLEMENTATION_VERSION,
            duration: probedDuration,
            pointerFingerprint: entry.pointer.fingerprint,
            pointerMtimeMs: entry.pointer.mtimeMs,
          });
          succeeded += 1;
          logger.info(`[STRM][duration] ok scope=${path.posix.join(rootFolder, workRelativePath)} file=${entry.relative} seconds=${probedDuration} elapsedMs=${Date.now() - probeStartedAt}`);
          return probedDuration;
        } catch (error) {
          failed += 1;
          const safeCode = safeErrorCode(error);
          if (stateStore) await stateStore.upsert(entry.key, {
            probeStatus: 'error',
            probeAt: Date.now(),
            probeError: safeCode,
            probeRetryAt: Date.now() + Number(options.retryDelayMs || 60 * 60 * 1000),
            probeVersion: PROBE_IMPLEMENTATION_VERSION,
            pointerFingerprint: entry.pointer.fingerprint,
          });
          const detail = safeErrorDetail(error);
          logger.warn(`[STRM][duration] failed scope=${path.posix.join(rootFolder, workRelativePath)} file=${entry.relative} code=${safeCode} elapsedMs=${Date.now() - probeStartedAt}${detail ? ` detail=${detail}` : ''}`);
          throw error;
        }
      });
      jobs.push(job.then(probedDuration => {
        memo.duration[relative] = probedDuration;
        memo.strm[relative].status = 'ok';
        return probedDuration;
      }).catch(error => {
        // Queue admission failures (for example PROBE_QUEUE_FULL) happen
        // before the worker callback and therefore need their own log entry.
        if (error && error.code === 'PROBE_QUEUE_FULL') {
          failed += 1;
          logger.warn(`[STRM][duration] rejected scope=${path.posix.join(rootFolder, workRelativePath)} file=${relative} code=${safeErrorCode(error, 'PROBE_QUEUE_FULL')}`);
        }
        return undefined;
      }));
    }
  }
  await Promise.all(jobs);
  logger.info(`[STRM][scan] finish scope=${path.posix.join(rootFolder, workRelativePath)} strm=${discovered} queued=${queued} ok=${succeeded} failed=${failed} invalid=${invalid} elapsedMs=${Date.now() - scanStartedAt}`);
  return memo;
}

module.exports = {
  listFiles,
  probeRemoteDuration,
  scanStrmMemo,
};
