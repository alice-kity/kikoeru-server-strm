'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const adapterDir = path.resolve(__dirname, '../patches/0.6.17/strm-adapter');
const { createNativeTasks, lufsPayload } = require(path.join(adapterDir, 'native-tasks'));
const { StrmCacheManager } = require(path.join(adapterDir, 'cache-manager'));
const { installRoutes } = require(path.join(adapterDir, 'integration'));
const { createNativeWaveform } = require(path.join(adapterDir, 'native-waveform'));

class FakeTaskRegistry {
  constructor() { this.tasks = new Map(); }
  get(key) { return this.tasks.get(key); }
  getActive(key) {
    const value = this.get(key);
    return value && ['queued', 'running'].includes(value.info.state) ? value : undefined;
  }
  create(key, options = {}) {
    const handle = {
      key,
      retained: options.retained !== false,
      info: { state: 'queued', percent: options.percent ?? 0, updatedAt: Date.now(), extra: options.extra },
      emitter: new EventEmitter(),
    };
    this.tasks.set(key, handle);
    return handle;
  }
  update(handle, patch) {
    handle.info = { ...handle.info, ...patch, updatedAt: Date.now() };
    handle.emitter.emit('progress', handle.info);
    return handle.info;
  }
  finish(handle, patch) { return this.update(handle, patch); }
  remove(handle) { if (this.tasks.get(handle.key) === handle) this.tasks.delete(handle.key); }
}

function makeTarget(mediaExt = '.flac') {
  return {
    key: 'Root/Work/voice.flac.strm',
    workId: 7,
    seq: 3,
    index: 3,
    row: { id: 18, duration: 12.5, lufs: null },
    pointerFingerprint: 'a'.repeat(64),
    mediaExt,
    isVideo: false,
    isStrm: true,
  };
}

async function makeCacheFixture(t, target = makeTarget()) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kikoeru-native-tasks-'));
  const cacheRoot = path.join(root, 'cache');
  await fs.promises.mkdir(cacheRoot, { recursive: true });
  const mediaPath = path.join(cacheRoot, 'voice.flac');
  await fs.promises.writeFile(mediaPath, Buffer.from('fixture-audio'));
  const record = {
    key: target.key,
    downloadReady: true,
    cachePath: mediaPath,
    pointerFingerprint: target.pointerFingerprint,
  };
  const runtime = {
    options: { loudness: { enabled: true, audioOnly: true } },
    cache: {
      limits: { rootDir: cacheRoot },
      async get() { return record; },
      async markAnalysisSkipped(_target, reason) { return { skipped: true, reason }; },
    },
  };
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  return { root, cacheRoot, mediaPath, record, runtime };
}

function buildNativeTasks({ runtime, target = makeTarget(), analyze, persist, queueAdd, validate } = {}) {
  const registry = new FakeTaskRegistry();
  const calls = { analyze: 0, persist: [], validate: 0 };
  const tasks = createNativeTasks({
    runtime,
    trackBridge: {
      async validateTarget(value) { calls.validate++; return validate ? validate(value) : true; },
      async persistLufs(value, lufs) { calls.persist.push([value, lufs]); return persist ? persist(value, lufs) : true; },
    },
    mediaProcess: { loudnormRegistry: registry, taskKey: (workId, seq) => `${workId}/${seq}` },
    audioProcessor: {
      async calculateLUFSReadOnly(filePath, options) {
        calls.analyze++;
        return analyze ? analyze(filePath, options) : { input_i: '-18.23', input_tp: '-1.00' };
      },
    },
    lightTaskQueue: { add: queueAdd || (task => task()) },
    logger: { warn() {} },
  });
  return { tasks, registry, calls, target };
}

test('native loudnorm uses one registry task, native analyzer, and CAS persisted input_i only', async t => {
  const target = makeTarget();
  const fixture = await makeCacheFixture(t, target);
  const { tasks, registry, calls } = buildNativeTasks({ runtime: fixture.runtime, target });

  const first = tasks.startLoudnorm(target, { sourcePath: fixture.mediaPath });
  const second = tasks.startLoudnorm(target, { sourcePath: fixture.mediaPath });
  assert.equal(second.handle, first.handle);
  assert.equal(second.alreadyRunning, true);
  const result = await first.handle.promise;
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(calls.analyze, 1);
  assert.equal(calls.persist.length, 1);
  assert.equal(calls.persist[0][1], -18.23);
  assert.equal(registry.get('7/3').info.state, 'done');
  assert.deepEqual(tasks.status({ ...target, row: { ...target.row, lufs: -18.23 } }), {
    ready: true, active: false, state: 'done', skipped: false, lufs: -18.23, task: undefined,
  });
  assert.deepEqual(result.loudnorm.input_tp, '-1.00');
  assert.deepEqual(lufsPayload(-18.23).loudnorm, {
    input_i: '-18.23', input_tp: '', input_lra: '', input_thresh: '',
    output_i: '', output_tp: '', output_lra: '', output_thresh: '',
    normalization_type: '', target_offset: '',
  });
});

test('native LUFS task rejects pointer text and incomplete, mismatched, or external cache files before ffmpeg', async t => {
  const target = makeTarget();
  const fixture = await makeCacheFixture(t, target);
  const { tasks, calls } = buildNativeTasks({ runtime: fixture.runtime, target });

  const pointerText = path.join(fixture.root, 'voice.flac.strm');
  await fs.promises.writeFile(pointerText, 'https://example.invalid/media');
  const textTask = tasks.startLoudnorm(target, { sourcePath: pointerText });
  await assert.rejects(textTask.handle.promise, error => error.code === 'STRM_LOCAL_MEDIA_REQUIRED');

  const partial = path.join(fixture.cacheRoot, 'voice.flac.part');
  await fs.promises.writeFile(partial, 'partial');
  const partialTask = tasks.startLoudnorm(target, { sourcePath: partial });
  await assert.rejects(partialTask.handle.promise, error => error.code === 'STRM_LOCAL_MEDIA_REQUIRED');

  fixture.record.pointerFingerprint = 'b'.repeat(64);
  const mismatch = tasks.startLoudnorm(target, { sourcePath: fixture.mediaPath });
  await assert.rejects(mismatch.handle.promise, error => error.code === 'STRM_CACHE_INCOMPLETE');

  fixture.record.pointerFingerprint = target.pointerFingerprint;
  fixture.record.downloadReady = false;
  const incomplete = tasks.startLoudnorm(target, { sourcePath: fixture.mediaPath });
  await assert.rejects(incomplete.handle.promise, error => error.code === 'STRM_CACHE_INCOMPLETE');
  assert.equal(calls.analyze, 0);
});

test('video and disabled loudness policy are terminal skipped states without analysis', async t => {
  const target = { ...makeTarget('.mp4'), isVideo: true };
  const fixture = await makeCacheFixture(t, target);
  const { tasks, calls } = buildNativeTasks({ runtime: fixture.runtime, target });

  const started = tasks.startLoudnorm(target, { sourcePath: fixture.mediaPath });
  assert.equal(started.skipped, true);
  assert.equal(tasks.status(target).ready, true);
  assert.equal(tasks.status(target).skipped, true);
  assert.equal(calls.analyze, 0);

  fixture.runtime.options.loudness.enabled = false;
  assert.equal(tasks.status({ ...target, isVideo: false }).skipped, true);
});

test('failed analyzer exposes only fixed safe error text and does not persist a value', async t => {
  const target = makeTarget();
  const fixture = await makeCacheFixture(t, target);
  const { tasks, registry, calls } = buildNativeTasks({
    runtime: fixture.runtime,
    target,
    analyze: async () => { throw new Error('https://cdn.invalid/audio?token=secret'); },
  });
  const handle = tasks.startLoudnorm(target, { sourcePath: fixture.mediaPath }).handle;
  await assert.rejects(handle.promise);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(registry.get('7/3').info.state, 'failed');
  assert.match(registry.get('7/3').info.error, /^Native LUFS analysis failed$/);
  assert.doesNotMatch(JSON.stringify(registry.get('7/3').info), /cdn\.invalid|secret/);
  assert.equal(calls.persist.length, 0);
});

test('native registry forgets a finished policy skip immediately when limits change', async t => {
  const target = makeTarget();
  const fixture = await makeCacheFixture(t, target);
  let policy = 'small-limit';
  fixture.runtime.cache.analysisPolicyKey = () => policy;
  const { tasks, calls } = buildNativeTasks({ runtime: fixture.runtime, target });
  const skipped = tasks.startLoudnorm(target, {
    ensureLocal: async () => { throw Object.assign(new Error('too large'), { code: 'DOWNLOAD_TOO_LARGE' }); },
  });
  await skipped.handle.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tasks.status(target).skipped, true);
  policy = 'larger-limit';
  assert.equal(tasks.status(target).ready, false);
  assert.equal(tasks.status(target).state, 'absent');
  const retry = tasks.startLoudnorm(target, { sourcePath: fixture.mediaPath });
  await retry.handle.promise;
  assert.equal(calls.analyze, 1);
});

test('waveform invalidation aborts analysis and never persists the stale result', async t => {
  const target = makeTarget();
  const fixture = await makeCacheFixture(t, target);
  const registry = new FakeTaskRegistry();
  let release, entered, current = true, persisted = 0, signal;
  const gate = new Promise(resolve => { release = resolve; });
  const running = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  Object.assign(fixture.runtime.cache, {
    analysisPolicyKey: () => 'policy',
    trackWaveform: (_target, promise) => { void promise.catch(() => undefined); return promise; },
  });
  const waveform = createNativeWaveform({
    runtime: fixture.runtime,
    trackBridge: {
      validateTarget: async () => current, readWaveform: async () => null,
      persistWaveform: async () => { persisted++; return true; },
    },
    mediaProcess: { waveformRegistry: registry, taskKey: (id, seq) => `${id}/${seq}` },
    audioWaveform: { getAudioWaveform: async (_source, options) => { signal = options.signal; entered(); await gate; return {}; } },
    waveformCodec: { WAVEFORM_VERSION: 4, encodeAudioWaveform: () => Buffer.from('wave') },
    heavyTaskQueue: { add: fn => fn() },
  });
  const first = waveform.start(target, { sourcePath: fixture.mediaPath });
  assert.equal(waveform.start(target, { sourcePath: fixture.mediaPath }).handle, first.handle);
  await running;
  current = false;
  waveform.invalidate(target);
  assert.equal(signal.aborted, true);
  release();
  await assert.rejects(first.handle.promise, error => error.code === 'STRM_TARGET_CHANGED');
  assert.equal(persisted, 0);
  assert.equal(registry.get('7/3'), undefined);
});

test('cache policy skip is durable without LUFS and becomes retryable after policy change', async () => {
  const state = new Map();
  const store = {
    async get(key) { return state.get(key) || null; },
    async upsert(key, patch) { const value = { ...(state.get(key) || {}), ...patch, key }; state.set(key, value); return value; },
    async list() { return [...state.values()]; },
  };
  const cache = new StrmCacheManager({ store, config: { rootDir: '/tmp/native-cache', cleanupIntervalMs: 0 } });
  const target = makeTarget();
  try {
    await cache.get(target);
    await cache.markAnalysisSkipped(target, 'DOWNLOAD_TOO_LARGE');
    assert.deepEqual(await cache.getAnalysisSkip(target), { skipped: true, reason: 'DOWNLOAD_TOO_LARGE' });
    assert.equal(await cache.shouldUseHot(target), true);
    assert.equal((await store.get(target.key)).lufs, undefined);
    await cache.configure?.({ maxFileBytes: 1 });
    cache.configure({ maxFileBytes: 1 });
    assert.equal(await cache.getAnalysisSkip(target), null);
  } finally {
    cache.close();
  }
});

function fakeExpress() {
  return {
    Router() {
      return {
        stack: [],
        get(routePath, ...handlers) { this.stack.push({ method: 'get', path: routePath, handle: handlers.at(-1) }); return this; },
        post(routePath, ...handlers) { this.stack.push({ method: 'post', path: routePath, handle: handlers.at(-1) }); return this; },
        put(routePath, ...handlers) { this.stack.push({ method: 'put', path: routePath, handle: handlers.at(-1) }); return this; },
      };
    },
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    chunks: [],
    ended: false,
    headersSent: false,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; this.headersSent = true; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    flushHeaders() { this.headersSent = true; },
    write(value) { this.chunks.push(value); return true; },
    end() { this.ended = true; return this; },
  };
}

function registerTestRoutes({ target = makeTarget(), nativeTasks = {}, runtimeOptions = {} } = {}) {
  const routesRouter = { stack: [] };
  const task = new EventEmitter();
  task.info = { state: 'queued', percent: 0, extra: { stage: 'download' } };
  task.promise = new Promise(() => {});
  const runtime = {
    config: { auth: false },
    options: { enabled: true, loudness: { enabled: true, audioOnly: true }, coldCache: { enabled: true }, ...runtimeOptions },
    ready: Promise.resolve(),
    cache: {
      async getAnalysisSkip() { return null; },
      async status() { return {}; },
      async cleanup() { return {}; },
      trackAnalysis(_target, promise) { return promise; },
    },
    nativeTasks: {
      status() { return { ready: false, active: true, state: 'queued', skipped: false, lufs: null, task }; },
      startLoudnorm() { return { handle: task, alreadyRunning: true }; },
      lufsPayload,
      async wait() { return { timedOut: true, error: null }; },
      ...nativeTasks,
    },
    queue: { pending: 0, running: 0, startedCount: 0, completedCount: 0, failedCount: 0 },
    redirects: { status() { return {}; } },
    metrics: {},
    redirectOptions() { return { sharedRate: {} }; },
  };
  const bridge = {
    async resolveTrack() { return target; },
    async validateTarget() { return true; },
  };
  installRoutes(routesRouter, '/unused/app', {
    express: fakeExpress(),
    runtime,
    bridge,
    nativeTasks: runtime.nativeTasks,
    mediaProcess: { RESULT_WAIT_DEFAULT_MS: 1000, RESULT_WAIT_MAX_MS: 5000 },
  });
  return { routesRouter, runtime, target };
}

function findRoute(routesRouter, method, suffix) {
  const layer = routesRouter.stack.find(item => item.method === method && item.path.includes(suffix));
  assert.ok(layer, `route not registered: ${method} ${suffix}`);
  return layer.handle;
}

test('STRM unsupported transcode routes return terminal 409, SSE closes', async () => {
  const { routesRouter } = registerTestRoutes();
  const taskReq = { params: { task: 'transcode', id: '7', seq: '3' }, query: {}, headers: {}, on() {}, removeListener() {} };
  const sse = fakeResponse();
  await findRoute(routesRouter, 'get', 'stream_notify')(taskReq, sse, () => assert.fail('should not fall through'));
  assert.equal(sse.statusCode, 200);
  assert.equal(sse.ended, true);
  assert.match(sse.chunks.join(''), /STRM_TASK_UNSUPPORTED/);

  const resultReq = { params: { task: 'transcode', id: '7', seq: '3' }, query: {}, headers: {} };
  const result = fakeResponse();
  await findRoute(routesRouter, 'get', '/result/')(resultReq, result, () => assert.fail('should not fall through'));
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, 'STRM_TASK_UNSUPPORTED');
});

test('native loudnorm task status omits fake download percentage and blocking result times out with 503', async () => {
  const { routesRouter } = registerTestRoutes();
  const statusReq = { params: { task: 'loudnorm', id: '7', seq: '3' }, query: {}, headers: {} };
  const status = fakeResponse();
  await findRoute(routesRouter, 'get', '/status/')(statusReq, status, () => assert.fail('should not fall through'));
  assert.equal(status.body.progress.stage, 'download');
  assert.equal(status.body.progress.percent, null);

  const resultReq = { params: { task: 'loudnorm', id: '7', seq: '3' }, query: { wait: 'true', waitMs: '1' }, headers: {} };
  const result = fakeResponse();
  await findRoute(routesRouter, 'get', '/result/')(resultReq, result, () => assert.fail('should not fall through'));
  assert.equal(result.statusCode, 503);
  assert.equal(result.headers['retry-after'], '1');
});

test('STRM disabled still rejects pointer tracks while ordinary tracks fall through', async () => {
  const target = makeTarget();
  const { routesRouter } = registerTestRoutes({ target, runtimeOptions: { enabled: false } });
  const handler = findRoute(routesRouter, 'get', '/media/stream/');
  const req = { params: { id: '7', index: '3' }, headers: {} };
  const res = fakeResponse();
  await handler(req, res, () => assert.fail('STRM must never fall through to native media routes'));
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'STRM_DISABLED');
});
