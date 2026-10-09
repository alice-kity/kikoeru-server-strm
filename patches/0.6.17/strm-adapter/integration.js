'use strict';

const fs = require('fs');
const path = require('path');
const {
  getRuntime,
  handleStrmPlayback,
  resolveStrmRedirect,
  sendStrmRedirect,
  sendStrmError,
  ensureStrmLocal,
  incrementMetric,
  setMediaContentType,
  isColdPathSkip,
  isLoudnessDisabled,
  strmLoudnormPayload,
  publicStrmConfig,
  mergePublicStrmConfig,
  FINAL_ALLOWED_HOSTS,
} = require('./runtime');
const { normalizeUserAgent, resolveRedirect } = require('./http');
const { sharedHelperStatus } = require('./shared-helper-rate');

const INSTALLED = '__strmRoutesInstalledV2';
const PROVIDER_INSTALLED = '__strmProviderInstalledV2';
const TASK_NAMES = new Set(['transcode', 'loudnorm', 'waveform']);
const TASK_OPERATIONS = new Set(['status', 'start', 'stream_notify', 'result']);

function strmSourceError() {
  const error = new Error('STRM pointer text is not a media source');
  error.code = 'STRM_SOURCE_REQUIRES_ADAPTER';
  error.status = 409;
  return error;
}

function isStrmPath(relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/');
  return path.posix.extname(normalized).toLowerCase() === '.strm';
}

function getLocalProvider(exportsValue) {
  if (!exportsValue) return null;
  return exportsValue.LocalProvider || exportsValue.default || exportsValue;
}

function ensureTrackBridge(runtime, appRoot) {
  if (runtime.trackBridge) return runtime.trackBridge;
  const { createTrackBridge } = require('./native-tracks');
  const bridge = createTrackBridge(appRoot, runtime);
  runtime.attachTrackBridge(bridge);
  return bridge;
}

function installUtils(utilsExports, appRoot) {
  if (!utilsExports) return;
  const runtime = getRuntime(appRoot);
  const bridge = ensureTrackBridge(runtime, appRoot);
  bridge.installUtils?.(utilsExports);
}

function installProvider(LocalProviderExports, appRoot) {
  const Provider = getLocalProvider(LocalProviderExports);
  if (!Provider || !Provider.prototype || Provider.prototype[PROVIDER_INSTALLED]) return;
  // The local provider is imported from filesystem/backend/registry. Avoid
  // constructing native-tracks while registry is still evaluating: utils or
  // routes will attach the bridge after this module has fully loaded.
  const prototype = Provider.prototype;
  const originalGetLocalPath = prototype.getLocalPath;
  const originalResolveSource = prototype.resolveSource;
  if (typeof originalGetLocalPath === 'function') {
    prototype.getLocalPath = function getLocalPathWithoutStrmText(relPath, ...args) {
      if (isStrmPath(relPath)) throw strmSourceError();
      return originalGetLocalPath.call(this, relPath, ...args);
    };
  }
  if (typeof originalResolveSource === 'function') {
    prototype.resolveSource = async function resolveSourceWithoutStrmText(relPath, ...args) {
      if (isStrmPath(relPath)) throw strmSourceError();
      return originalResolveSource.call(this, relPath, ...args);
    };
  }
  Object.defineProperty(prototype, PROVIDER_INSTALLED, { value: true, enumerable: false });
}

function requestUserAgent(req) {
  const headers = req && req.headers || {};
  return normalizeUserAgent(headers['user-agent'] || headers['User-Agent']);
}

async function resolveTarget(bridge, req) {
  const workId = Number(req.params && req.params.id);
  const rawSeq = req.params && (req.params.seq ?? req.params.index ?? req.params.hash);
  const seq = Number(rawSeq);
  if (!Number.isInteger(workId) || workId < 0 || !Number.isInteger(seq) || seq < 0) {
    const error = new Error('invalid track coordinates');
    error.code = 'INVALID_TRACK';
    error.status = 400;
    throw error;
  }
  const target = await bridge.resolveTrack(workId, seq, requestUserAgent(req));
  if (!target) return null;
  const valid = await bridge.validateTarget(target);
  if (valid === false || (valid && valid.valid === false)) {
    const error = new Error('STRM pointer changed');
    error.code = 'STRM_TARGET_CHANGED';
    error.status = 409;
    throw error;
  }
  return target;
}

function disabledResponse(res) {
  return res.status(409).json({ error: 'STRM media is disabled', code: 'STRM_DISABLED' });
}

function unsupportedResponse(res, taskName) {
  return res.status(409).json({
    error: 'STRM media does not support this server-side task',
    code: 'STRM_TASK_UNSUPPORTED',
    task: taskName,
  });
}

function writeEvent(res, info) {
  res.write(`data: ${JSON.stringify(info)}\n\n`);
}

function nativeProgressView(info = {}) {
  const stage = info.extra && info.extra.stage || info.state;
  return {
    state: info.state,
    stage,
    percent: stage === 'analyze' && info.state === 'running' ? info.percent : null,
    error: info.error,
    updatedAt: info.updatedAt,
  };
}

function sendTerminalSse(res, info) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  writeEvent(res, info);
  res.end();
}

function streamTask(req, res, handle) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  let closed = false;
  const heartbeat = setInterval(() => { if (!closed) res.write(': keep-alive\n\n'); }, 15000);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    handle.emitter.removeListener('progress', onProgress);
    req.removeListener('close', cleanup);
  };
  const onProgress = info => {
    if (closed) return;
    writeEvent(res, nativeProgressView(info));
    if (info.state === 'done' || info.state === 'failed') {
      cleanup();
      res.end();
    }
  };
  req.on('close', cleanup);
  handle.emitter.on('progress', onProgress);
  onProgress(handle.info);
}

function sendRetry(res, taskName, target, handle, progress, error, statusCode = 202) {
  res.setHeader('Retry-After', '1');
  res.status(statusCode).json({
    status: 'not_ready',
    task: taskName,
    workId: target.workId,
    seq: target.seq,
    state: handle ? handle.info.state : 'queued',
    progress: progress || null,
    notifyUrl: `/api/media/task/${taskName}/stream_notify/${target.workId}/${target.seq}`,
    ...(error ? { error } : {}),
  });
}

function waitRequested(query = {}) {
  const flag = value => typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  return flag(query.wait) || flag(query.blocking);
}

function resultWaitMs(query, mediaProcess) {
  const fallback = mediaProcess.RESULT_WAIT_DEFAULT_MS || 15 * 60 * 1000;
  const maximum = mediaProcess.RESULT_WAIT_MAX_MS || 60 * 60 * 1000;
  const raw = query.waitMs === undefined ? query.timeoutMs : query.waitMs;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), maximum);
}

function freshLufs(target) {
  const row = target && target.row;
  if (!row || row.lufs === null || row.lufs === undefined || row.lufs === '') return null;
  const value = Number(row.lufs);
  return Number.isFinite(value) ? value : null;
}

function installRoutes(routesRouter, appRoot, dependencies = {}) {
  if (!routesRouter || routesRouter[INSTALLED]) return;
  const runtime = dependencies.runtime || getRuntime(appRoot);
  const bridge = dependencies.bridge || ensureTrackBridge(runtime, appRoot);
  const nativeTasks = dependencies.nativeTasks || runtime.nativeTasks;
  const waveform = dependencies.nativeWaveform || runtime.nativeWaveform;
  const config = runtime.config;
  const express = dependencies.express || require('express');
  const mediaProcess = dependencies.mediaProcess || require(path.join(appRoot, 'dist/src/routes/media-process.js'));
  const custom = express.Router();

  async function withTarget(req, res, next, task) {
    let target;
    try { target = await resolveTarget(bridge, req); } catch (error) { return sendStrmError(res, error); }
    if (!target) return next();
    if (!runtime.options.enabled) return disabledResponse(res);
    try { return await task(target); } catch (error) { return sendStrmError(res, error); }
  }

  async function handleStream(req, res, next) {
    return withTarget(req, res, next, target => handleStrmPlayback({ req, res, target, runtime }));
  }

  async function handleDownload(req, res, next) {
    return withTarget(req, res, next, async target => {
      const resolved = await resolveStrmRedirect(runtime, target);
      incrementMetric(runtime, 'hotRedirect');
      return sendStrmRedirect(res, runtime, resolved.final);
    });
  }

  async function rejectTranscode(req, res, next) {
    return withTarget(req, res, next, () => unsupportedResponse(res, 'transcode'));
  }

  async function handleLoudnorm(req, res, next) {
    return withTarget(req, res, next, async target => {
      await runtime.ready;
      const record = await runtime.cache.get(target);
      const completeLocal = Boolean(record && record.downloadReady && record.cachePath
        && record.pointerFingerprint === target.pointerFingerprint
        && await fs.promises.stat(record.cachePath).then(stat => stat.isFile() && stat.size > 0).catch(() => false));
      if (isLoudnessDisabled(runtime, target) || (!completeLocal && runtime.options.coldCache.enabled === false)) {
        return res.json(strmLoudnormPayload(target, false, { skipped: true }));
      }
      const policySkip = await runtime.cache.getAnalysisSkip?.(target);
      if (policySkip) return res.json(strmLoudnormPayload(target, false, { skipped: true }));
      const status = nativeTasks.status(target);
      if (freshLufs(target) === null && !(status.task && status.active)) {
        if (completeLocal) {
          void runtime.scheduleLoudness(target, record.cachePath).catch(() => undefined);
        } else {
          nativeTasks.startLoudnorm(target, { ensureLocal: value => runtime.ensureTargetLocal(value) });
        }
      }
      const updated = nativeTasks.status(target);
      const payload = strmLoudnormPayload(target, completeLocal, updated);
      delete payload.retry;
      return res.json(payload);
    });
  }

  async function handleUnsupportedTask(req, res, next, phase, taskName) {
    return withTarget(req, res, next, () => {
      if (phase === 'stream_notify') {
        return sendTerminalSse(res, {
          state: 'failed',
          percent: 0,
          error: 'STRM media does not support this server-side task',
          code: 'STRM_TASK_UNSUPPORTED',
          task: taskName,
        });
      }
      return unsupportedResponse(res, taskName);
    });
  }

  async function handleLoudnormTask(req, res, next, phase) {
    return withTarget(req, res, next, async target => {
      await runtime.ready;
      const policySkip = await runtime.cache.getAnalysisSkip?.(target);
      const status = nativeTasks.status(target);
      const task = status.task;
      const base = { task: 'loudnorm', workId: target.workId, seq: target.seq };
      if (phase === 'status') {
        return res.json({
          ...base,
          ready: status.ready || Boolean(policySkip),
          active: policySkip ? false : status.active,
          state: policySkip ? 'done' : status.state,
          skipped: status.skipped || Boolean(policySkip) || undefined,
          progress: !policySkip && status.active && task ? nativeProgressView(task.info) : null,
        });
      }
      if (phase === 'start') {
        if (status.ready || policySkip) {
          return res.json({ ...base, status: 'ready', alreadyRunning: false, ready: true, active: false, state: 'done', ...(status.skipped || policySkip ? { skipped: true } : {}), progress: null });
        }
        const started = nativeTasks.startLoudnorm(target, {
          ensureLocal: value => runtime.ensureTargetLocal(value),
        });
        const handle = started.handle;
        if (handle && handle.promise && status.task !== handle) {
          runtime.cache.trackAnalysis(target, handle.promise);
        }
        return res.json({
          ...base,
          status: 'started',
          alreadyRunning: started.alreadyRunning,
          ready: false,
          active: true,
          state: handle.info.state,
          progress: nativeProgressView(handle.info),
        });
      }
      if (phase === 'stream_notify') {
        if (status.ready || policySkip) {
          return sendTerminalSse(res, { state: 'done', percent: 100, ...(status.skipped || policySkip ? { skipped: true } : {}) });
        }
        if (!task) return sendTerminalSse(res, { state: 'idle', percent: 0 });
        if (!task.emitter || typeof task.emitter.on !== 'function') {
          return sendTerminalSse(res, { state: task.info.state, percent: task.info.percent, error: task.info.error });
        }
        return streamTask(req, res, task);
      }
      if (phase === 'result') {
        if (status.ready || policySkip) {
          return res.json(status.skipped || policySkip ? { loudnorm: 0, peakLevels: [], skipped: true } : nativeTasks.lufsPayload(status.lufs));
        }
        if (task && status.active && waitRequested(req.query)) {
          const outcome = await nativeTasks.wait(task, resultWaitMs(req.query, mediaProcess));
          const fresh = await bridge.resolveTrack(target.workId, target.seq, target.userAgent);
          if (!fresh || fresh.pointerFingerprint !== target.pointerFingerprint) {
            return res.status(409).json({ error: 'STRM pointer changed', code: 'STRM_TARGET_CHANGED', ...base });
          }
          target.row = fresh.row;
          const afterWait = nativeTasks.status(target);
          if (afterWait.ready) {
            return res.json(afterWait.skipped ? { loudnorm: 0, peakLevels: [], skipped: true } : nativeTasks.lufsPayload(afterWait.lufs));
          }
          if (outcome.timedOut) return sendRetry(res, 'loudnorm', target, task, task.info, '等待结果超时', 503);
          if (outcome.error) return res.status(500).json({ error: outcome.error, ...base, state: 'failed' });
          return res.status(500).json({ error: '任务已结束但结果不可用', ...base, state: task.info.state });
        }
        if (task && status.active) return sendRetry(res, 'loudnorm', target, task, task.info);
        if (task && task.info.state === 'failed') {
          return res.status(500).json({ error: task.info.error || 'Native LUFS analysis failed', ...base, state: 'failed' });
        }
        return res.status(404).json({ error: '结果未就绪', ...base, state: task ? task.info.state : 'absent' });
      }
      return next();
    });
  }

  async function handleWaveformTask(req, res, next, phase) {
    return withTarget(req, res, next, async target => {
      await runtime.ready;
      const status = await waveform.status(target);
      const task = status.task;
      const base = { task: 'waveform', workId: target.workId, seq: target.seq };
      const sendResult = cached => {
        res.setHeader('Content-Type', 'application/octet-stream');
        return res.send(waveform.result(cached, req.query));
      };
      if (phase === 'status') return res.json({
        ...base, ready: status.ready, active: status.active, state: status.state,
        skipped: status.skipped || undefined,
        progress: status.active && task ? nativeProgressView(task.info) : null,
      });
      if (phase === 'stream_notify') {
        if (status.ready) return sendTerminalSse(res, { state: 'done', percent: 100 });
        if (status.skipped) return sendTerminalSse(res, { state: 'failed', percent: 0, skipped: true, code: 'STRM_WAVEFORM_SKIPPED' });
        return task ? streamTask(req, res, task) : sendTerminalSse(res, { state: 'idle', percent: 0 });
      }
      if (status.skipped) return res.status(409).json({ ...base, code: 'STRM_WAVEFORM_SKIPPED', error: 'Waveform analysis is skipped by the current cache policy' });
      if (phase === 'start') {
        if (status.ready) return res.json({ ...base, status: 'ready', ready: true, active: false, state: 'done', alreadyRunning: false });
        const started = waveform.start(target);
        return res.json({ ...base, status: 'started', ready: false, active: true,
          state: started.handle.info.state, alreadyRunning: started.alreadyRunning,
          progress: nativeProgressView(started.handle.info) });
      }
      if (status.ready) return sendResult(status.cached);
      if (task && status.active && waitRequested(req.query)) {
        const outcome = await nativeTasks.wait(task, resultWaitMs(req.query, mediaProcess));
        const fresh = await bridge.resolveTrack(target.workId, target.seq, target.userAgent);
        if (!fresh || fresh.pointerFingerprint !== target.pointerFingerprint) {
          return res.status(409).json({ ...base, error: 'STRM pointer changed', code: 'STRM_TARGET_CHANGED' });
        }
        const cached = await waveform.read(fresh);
        if (cached) return sendResult(cached);
        if (outcome.timedOut) return sendRetry(res, 'waveform', target, task, task.info, '等待结果超时', 503);
        return res.status(500).json({ ...base, state: 'failed', error: task.info.error || 'Waveform analysis failed' });
      }
      if (task && status.active) return sendRetry(res, 'waveform', target, task, nativeProgressView(task.info));
      return res.status(task?.info.state === 'failed' ? 500 : 404).json({
        ...base, state: status.state, error: task?.info.error || '结果未就绪',
      });
    });
  }

  async function handleTask(req, res, next, phase) {
    const taskName = req.params.task;
    if (!TASK_NAMES.has(taskName) || !TASK_OPERATIONS.has(phase)) return next();
    if (taskName === 'loudnorm') return handleLoudnormTask(req, res, next, phase);
    if (taskName === 'waveform') return handleWaveformTask(req, res, next, phase);
    return handleUnsupportedTask(req, res, next, phase, taskName);
  }

  async function status(req, res) {
    if (config.auth && (!req.user || req.user.name !== 'admin')) return res.status(403).json({ error: 'admin required' });
    try {
      await runtime.ready;
      const result = await runtime.cache.status();
      const sharedHelper = await sharedHelperStatus(runtime.redirectOptions().sharedRate);
      return res.json({
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
    } catch (error) { return sendStrmError(res, error); }
  }

  async function update(req, res) {
    if (config.auth && (!req.user || req.user.name !== 'admin')) return res.status(403).json({ error: 'admin required' });
    try {
      const body = req.body && req.body.strm ? req.body.strm : (req.body || {});
      const next = mergePublicStrmConfig(runtime.options, body);
      await runtime.updateOptions(next);
      return res.json({ message: 'STRM 配置已保存', config: publicStrmConfig(next) });
    } catch (error) { return sendStrmError(res, error); }
  }

  async function cleanup(req, res) {
    if (config.auth && (!req.user || req.user.name !== 'admin')) return res.status(403).json({ error: 'admin required' });
    try { return res.json(await runtime.cache.cleanup()); } catch (error) { return sendStrmError(res, error); }
  }

  custom.get('/media/stream/:id/:index', handleStream);
  custom.get('/media/download/:id/:index', handleDownload);
  custom.get('/media/transcode/:id/:index', rejectTranscode);
  custom.get('/media/pre-transcode/:id/:index', rejectTranscode);
  custom.post('/media/pre-transcode/:id/:index', rejectTranscode);
  custom.get('/media/calculate/loudnorm/:id/:hash', handleLoudnorm);
  custom.get('/media/task/:task/status/:id/:seq', (req, res, next) => handleTask(req, res, next, 'status'));
  custom.post('/media/task/:task/start/:id/:seq', (req, res, next) => handleTask(req, res, next, 'start'));
  custom.get('/media/task/:task/stream_notify/:id/:seq', (req, res, next) => handleTask(req, res, next, 'stream_notify'));
  custom.get('/media/task/:task/result/:id/:seq', (req, res, next) => handleTask(req, res, next, 'result'));
  custom.put('/lyric/translate/:id/:index', rejectTranscode);
  custom.get('/admin/strm', status);
  custom.get('/strm/status', status);
  custom.get('/strm/config', status);
  custom.put('/admin/strm', update);
  custom.post('/admin/strm/cleanup', cleanup);
  routesRouter.stack.unshift(...custom.stack);
  Object.defineProperty(routesRouter, INSTALLED, { value: true, enumerable: false });
  console.log('[STRM] adapter enabled for Kikoeru 0.6.17 (remote URLs are redacted)');
}

module.exports = {
  installUtils,
  installProvider,
  installRoutes,
  isStrmPath,
  resolveTarget,
  sendTerminalSse,
};
