'use strict';

const fs = require('fs');
const path = require('path');

function taskError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function createNativeWaveform({ runtime, trackBridge, mediaProcess, audioWaveform, waveformCodec, heavyTaskQueue }) {
  const registry = mediaProcess.waveformRegistry;
  const format = `KWAV/${waveformCodec.WAVEFORM_VERSION}`;
  const keyFor = target => mediaProcess.taskKey(target.workId, target.seq);
  const policyKey = () => runtime.cache.analysisPolicyKey();

  async function validate(target) {
    if (!await trackBridge.validateTarget(target)) {
      throw taskError('STRM_TARGET_CHANGED', 'STRM pointer changed during waveform analysis');
    }
  }

  async function read(target) {
    const buffer = await trackBridge.readWaveform(target, format);
    if (!buffer) return null;
    try { return { buffer, waveform: waveformCodec.decodeAudioWaveform(buffer) }; } catch { return null; }
  }

  function getHandle(target) {
    const handle = registry.get(keyFor(target));
    if (!handle) return null;
    if (handle.pointerFingerprint !== target.pointerFingerprint || handle.targetKey !== target.key
      || (handle.skipped && handle.policyKey !== policyKey())) {
      registry.remove(handle);
      return null;
    }
    return handle;
  }

  async function status(target) {
    const cached = await read(target);
    if (cached) return { ready: true, active: false, state: 'done', cached, task: null };
    const skipped = target.isVideo || Boolean(await runtime.cache.getAnalysisSkip(target));
    const task = getHandle(target);
    const active = Boolean(task && ['queued', 'running'].includes(task.info.state));
    return { ready: false, active, skipped, state: active ? task.info.state : (skipped ? 'failed' : task?.info.state || 'absent'), task };
  }

  async function assertComplete(target, source) {
    const record = await runtime.cache.get(target);
    const root = runtime.cache.limits.rootDir;
    const relative = source && path.relative(root, source);
    if (!source || !path.isAbsolute(source) || !relative || relative.startsWith('..') || path.isAbsolute(relative)
      || /\.(?:strm|part)$/i.test(source) || !record?.downloadReady
      || record.cachePath !== source || record.pointerFingerprint !== target.pointerFingerprint) {
      throw taskError('STRM_CACHE_INCOMPLETE', 'Waveform analysis requires complete local media');
    }
    const stat = await fs.promises.stat(source);
    if (!stat.isFile() || stat.size <= 0) throw taskError('STRM_CACHE_INCOMPLETE', 'Waveform analysis requires complete local media');
  }

  function update(handle, patch) {
    if (!handle.invalidated) registry.update(handle, patch);
  }

  async function compute(handle, target, sourcePath) {
    await validate(target);
    const cached = await read(target);
    if (cached) return cached;
    if (target.isVideo) throw taskError('STRM_WAVEFORM_SKIPPED', 'STRM video waveform analysis is disabled');
    let source = sourcePath;
    try {
      if (!source) source = await runtime.ensureTargetLocal(target);
    } catch (error) {
      if (!['DOWNLOAD_TOO_LARGE', 'COLD_CACHE_POLICY', 'COLD_CACHE_DISABLED'].includes(error.code)) throw error;
      handle.skipped = true;
      if (handle.policyKey === policyKey()) await runtime.cache.markAnalysisSkipped(target, error.code);
      throw taskError('STRM_WAVEFORM_SKIPPED', 'Waveform analysis is skipped by the current cache policy');
    }
    const waveform = await heavyTaskQueue.add(async () => {
      if (handle.invalidated) throw taskError('STRM_TARGET_CHANGED', 'STRM pointer changed');
      await validate(target);
      await assertComplete(target, source);
      update(handle, { state: 'running', percent: 0, extra: { stage: 'analyze' } });
      return audioWaveform.getAudioWaveform(source, {
        signal: handle.abort.signal,
        onProgress(percent) {
          if (Number.isFinite(percent)) update(handle, {
            state: 'running', percent: Math.max(0, Math.min(99, percent)), extra: { stage: 'analyze' },
          });
        },
      });
    });
    await validate(target);
    const buffer = waveformCodec.encodeAudioWaveform(waveform);
    if (!await trackBridge.persistWaveform(target, buffer, format, waveform.bucketDurationSec)) {
      throw taskError('STRM_TARGET_CHANGED', 'STRM pointer changed before waveform was persisted');
    }
    return { buffer, waveform };
  }

  function start(target, { sourcePath } = {}) {
    const previous = getHandle(target);
    if (previous && ['queued', 'running'].includes(previous.info.state)) return { handle: previous, alreadyRunning: true };
    const handle = registry.create(keyFor(target), { retained: true, extra: { stage: sourcePath ? 'analyze' : 'download' } });
    Object.assign(handle, {
      pointerFingerprint: target.pointerFingerprint, targetKey: target.key,
      policyKey: policyKey(), abort: new AbortController(),
    });
    handle.promise = compute(handle, target, sourcePath);
    void handle.promise.then(() => {
      if (!handle.invalidated) registry.finish(handle, { state: 'done', percent: 100, extra: { stage: 'done' } });
    }, error => {
      if (!handle.invalidated) registry.finish(handle, {
        state: 'failed', percent: 0,
        error: error.code === 'STRM_WAVEFORM_SKIPPED' ? 'Waveform analysis is skipped by the current cache policy' : 'Waveform analysis failed',
        extra: { stage: 'failed', code: error.code === 'STRM_TARGET_CHANGED' ? error.code : 'STRM_WAVEFORM_FAILED' },
      });
    });
    runtime.cache.trackWaveform(target, handle.promise);
    return { handle, alreadyRunning: false };
  }

  function invalidate(target) {
    const handle = getHandle(target);
    if (!handle) return;
    handle.invalidated = true;
    handle.abort.abort();
    registry.update(handle, { state: 'failed', percent: 0, error: 'STRM pointer changed' });
    registry.remove(handle);
  }

  function result(cached, query = {}) {
    const requested = Number(query.resolution ?? query.bucketDurationSec);
    const resolution = Number.isFinite(requested) && requested > 0 ? Math.min(60, Math.max(0.05, requested)) : 0.05;
    return resolution > cached.waveform.bucketDurationSec
      ? waveformCodec.encodeAudioWaveform(audioWaveform.mergeAudioWaveform(cached.waveform, resolution))
      : cached.buffer;
  }

  return { start, status, read, result, invalidate, format };
}

module.exports = { createNativeWaveform };
