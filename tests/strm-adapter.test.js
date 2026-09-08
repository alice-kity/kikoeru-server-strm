'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');

const adapterDir = path.resolve(__dirname, '../patches/0.6.15/strm-adapter');
const { parsePointerText, PointerError, hostMatches, safeUrlForLog } = require(path.join(adapterDir, 'pointer'));
const { parseVirtualMediaName } = require(path.join(adapterDir, 'virtual-name'));
const {
  DEFAULT_HELPER_USER_AGENT,
  downloadToFile,
  helperRequestHeaders,
  normalizeUserAgent,
  resolveRedirect,
  parseRetryAfter,
} = require(path.join(adapterDir, 'http'));
const { SingleFlight } = require(path.join(adapterDir, 'single-flight'));
const { DurationProbeQueue } = require(path.join(adapterDir, 'duration-queue'));
const { RedirectRateLimiter } = require(path.join(adapterDir, 'redirect-rate-limit'));
const { normalizeOptions: normalizeSharedHelperOptions } = require(path.join(adapterDir, 'shared-helper-rate'));
const { StrmStateStore, makeRecordKey } = require(path.join(adapterDir, 'state-store'));
const { StrmCacheManager, defaultRunLoudnorm, parseLoudnormResult } = require(path.join(adapterDir, 'cache-manager'));
const { scanStrmMemo, probeRemoteDuration } = require(path.join(adapterDir, 'scanner'));
const {
  installUtils, RUNTIME_SYMBOL, defaultStrmConfig, classifyPreloadRequest, resolveWithPreloadGuard,
  handleStrmPlayback, ensureStrmLocal, startStrmColdBootstrap, resolveStrmRedirect, strmLoudnormPayload,
  migrateRedirectResolveConfig, normalizeRedirectMode,
} = require(path.join(adapterDir, 'integration'));
const { ADMIN_HTML, MENU_SCRIPT, createAdminUiMiddleware } = require(path.join(adapterDir, 'admin-ui'));
const { withOverlayNodeOptions } = require(path.resolve(__dirname, '../scripts/strm-child-env'));
const { migrateRedirectConfigValue, migratePreloadConfig } = require(path.resolve(__dirname, '../scripts/strm-entrypoint'));

test('state store persists the latest record values after concurrent mutations', async () => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kikoeru-strm-state-'));
  const statePath = path.join(tempRoot, 'state.json');
  const state = new StrmStateStore(statePath);
  try {
    await Promise.all(Array.from({ length: 64 }, async (_value, index) => {
      const key = `record-${index}`;
      await state.upsert(key, { probeStatus: 'pending', duration: null });
      await state.upsert(key, { probeStatus: 'ok', duration: index + 0.5 });
    }));
    const reloaded = new StrmStateStore(statePath);
    const records = await reloaded.list();
    assert.equal(records.length, 64);
    assert.ok(records.every(record => record.probeStatus === 'ok'));
    assert.deepEqual(records.map(record => record.duration).sort((a, b) => a - b),
      Array.from({ length: 64 }, (_value, index) => index + 0.5));
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
});

test('pointer parser accepts one URL and rejects unsafe content', () => {
  const parsed = parsePointerText('\uFEFF\nhttps://mp.123063.xyz:13258/redirect?id=secret\r\n', {
    allowedHosts: ['mp.123063.xyz:13258'],
  });
  assert.equal(parsed.hostname, 'mp.123063.xyz');
  assert.equal(parsed.host, 'mp.123063.xyz:13258');
  assert.equal(parsed.fingerprint.length, 64);
  assert.throws(() => parsePointerText('file:///etc/passwd', { allowedHosts: ['mp.123063.xyz:13258'] }), error => error.code === 'POINTER_SCHEME_NOT_ALLOWED');
  assert.throws(() => parsePointerText('https://other.invalid/a', { allowedHosts: ['mp.123063.xyz:13258'] }), error => error.code === 'POINTER_HOST_NOT_ALLOWED');
  assert.throws(() => parsePointerText('https://mp.123063.xyz:13258/a\n<script>', { allowedHosts: ['mp.123063.xyz:13258'] }), error => error.code === 'POINTER_EXTRA_CONTENT');
  assert.throws(() => parsePointerText('https://user:pass@mp.123063.xyz:13258/a', { allowedHosts: ['mp.123063.xyz:13258'] }), error => error.code === 'POINTER_URL_NOT_ALLOWED');
  assert.equal(safeUrlForLog(parsed.url), 'https://mp.123063.xyz:13258/redirect');
  assert.equal(hostMatches('https://cdnfhnfile.115cdn.net/a?q=secret', ['.115cdn.net']), true);
  assert.equal(hostMatches('https://115cdn.net/a', ['.115cdn.net']), false);
});

test('virtual filename keeps the physical pointer marker', () => {
  assert.deepEqual(parseVirtualMediaName('voice.flac.strm'), {
    isStrm: true, valid: true, logicalName: 'voice.flac', displayName: 'voice.flac',
    mediaExt: '.flac', isVideo: false, sourceExt: '.strm',
  });
  assert.equal(parseVirtualMediaName('movie.mp4.strm').isVideo, true);
  assert.equal(parseVirtualMediaName('bare.strm').code, 'VIRTUAL_EXTENSION_MISSING');
  assert.equal(parseVirtualMediaName('voice.exe.strm').code, 'VIRTUAL_EXTENSION_UNSUPPORTED');
});

test('track-list adapter keeps physical .strm and exposes virtual metadata', async () => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kikoeru-strm-tracklist-'));
  await fs.promises.mkdir(path.join(tempRoot, 'dist/src'), { recursive: true });
  await fs.promises.writeFile(path.join(tempRoot, 'dist/src/config.js'), [
    "const path = require('path');",
    `const config = { databaseFolderDir: ${JSON.stringify(tempRoot)}, rootFolders: [], strm: { allowedHosts: ['fixture-helper'] } };`,
    'module.exports = { config, setNewConfigValue() {} };',
  ].join('\n'));
  const physicalTrack = {
    title: 'voice.flac.strm', subtitle: null, ext: '.strm',
    hash: '1/0', duration: 12.5,
  };
  const mockUtils = {
    supportedMediaExtList: ['.mp3', '.strm'],
    getTrackList: async () => {
      assert.ok(mockUtils.supportedMediaExtList.includes('.strm'), 'physical STRM extension was filtered out');
      return [Object.assign({}, physicalTrack)];
    },
    scrapeWorkMemo: async () => ({ duration: {}, mtime: {}, isContainLyric: false }),
    toTree: tracks => tracks,
  };
  try {
    installUtils(mockUtils, tempRoot);
    const tracks = await mockUtils.getTrackList(1, tempRoot, {});
    assert.equal(tracks[0].title, 'voice.flac.strm');
    assert.equal(tracks[0].ext, '.strm');
    assert.equal(tracks[0].isStrm, true);
    assert.equal(tracks[0].sourceExt, '.strm');
    assert.equal(tracks[0].mediaExt, '.flac');
    assert.equal(tracks[0].displayTitle, 'voice.flac');
  } finally {
    const runtime = global[RUNTIME_SYMBOL];
    runtime?.cache.close();
    runtime?.queue.close();
    delete global[RUNTIME_SYMBOL];
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
});

test('HEAD resolver validates Helper and final Location host without following redirects', async () => {
  let helperHeaders;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/helper')) {
      helperHeaders = req.headers;
      res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/media?token=do-not-log` });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'audio/flac', 'Content-Length': '4' });
    res.end('test');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const result = await resolveRedirect(`http://127.0.0.1:${port}/helper`, {
      allowedHosts: [`127.0.0.1:${port}`],
      finalAllowedHosts: ['127.0.0.1'],
      timeoutMs: 2000,
      userAgent: 'BrowserFixture/1.2 (UA-bound)',
    });
    assert.equal(result.statusCode, 302);
    assert.equal(result.final.hostname, '127.0.0.1');
    assert.equal(result.final.search, '?token=do-not-log');
    assert.equal(helperHeaders['user-agent'], 'BrowserFixture/1.2 (UA-bound)');
    assert.equal(helperHeaders.accept, '*/*');
    assert.equal(helperHeaders['cache-control'], 'no-cache');
    assert.equal(helperHeaders.pragma, 'no-cache');
    assert.equal(helperHeaders.authorization, undefined);
    assert.equal(helperHeaders.cookie, undefined);
    assert.equal(helperHeaders.range, undefined);
    assert.equal(result.userAgent, 'BrowserFixture/1.2 (UA-bound)');
    await assert.rejects(resolveRedirect(`http://127.0.0.1:${port}/helper`, {
      allowedHosts: [`127.0.0.1:${port}`], finalAllowedHosts: ['evil.invalid'], timeoutMs: 2000,
    }), error => error.code === 'FINAL_HOST_NOT_ALLOWED');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Helper and cold-download UA fall back to the same safe identity', async () => {
  assert.equal(normalizeUserAgent(''), DEFAULT_HELPER_USER_AGENT);
  assert.equal(normalizeUserAgent('x'.repeat(513)), DEFAULT_HELPER_USER_AGENT);
  assert.equal(normalizeUserAgent('bad\r\nUA'), DEFAULT_HELPER_USER_AGENT);
  const safeHeaders = helperRequestHeaders({
    Authorization: 'Bearer secret', Cookie: 'session=secret', Range: 'bytes=0-',
  }, 'Browser/fixture');
  assert.equal(safeHeaders['User-Agent'], 'Browser/fixture');
  assert.equal(Object.hasOwn(safeHeaders, 'Authorization'), false);
  assert.equal(Object.hasOwn(safeHeaders, 'Cookie'), false);
  assert.equal(Object.hasOwn(safeHeaders, 'Range'), false);

  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kikoeru-strm-ua-'));
  let helperUa = null;
  let downloadUa = null;
  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      helperUa = req.headers['user-agent'];
      res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/media` });
      return res.end();
    }
    downloadUa = req.headers['user-agent'];
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': '5' });
    return res.end('hello');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const resolved = await resolveRedirect(`http://127.0.0.1:${server.address().port}/helper`, {
      allowedHosts: [`127.0.0.1:${server.address().port}`],
      finalAllowedHosts: ['127.0.0.1'],
      timeoutMs: 2000,
    });
    const partPath = path.join(temp, 'media.part');
    await downloadToFile(resolved.final, partPath, {
      finalAllowedHosts: ['127.0.0.1'],
      timeoutMs: 2000,
      maxBytes: 100,
    });
    assert.equal(helperUa, DEFAULT_HELPER_USER_AGENT);
    assert.equal(downloadUa, DEFAULT_HELPER_USER_AGENT);
    assert.equal(helperUa, downloadUa);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

test('Helper 429 honors Retry-After with bounded exponential retry, while 403 is not retried', async () => {
  const source = 'https://mp.123063.xyz:13258/redirect?pickcode=fixture';
  const waits = [];
  let calls = 0;
  const responses = [
    { statusCode: 429, headers: { 'retry-after': '2' } },
    { statusCode: 429, headers: { 'retry-after': '0' } },
    { statusCode: 302, headers: { location: 'https://cdnfhnfile.115cdn.net/media?token=fixture' } },
  ];
  const resolved = await resolveRedirect(source, {
    allowedHosts: ['mp.123063.xyz:13258'],
    finalAllowedHosts: ['.115cdn.net'],
    max429Retries: 3,
    retryBaseMs: 1,
    retryMaxMs: 10,
    retryJitterMs: 0,
    sleep: async delay => waits.push(delay),
    requestHead: async () => { calls += 1; return responses.shift(); },
  });
  assert.equal(resolved.statusCode, 302);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 2]);
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter('not-a-date'), 0);

  let forbiddenCalls = 0;
  await assert.rejects(resolveRedirect(source, {
    allowedHosts: ['mp.123063.xyz:13258'], finalAllowedHosts: ['.115cdn.net'],
    requestHead: async () => { forbiddenCalls += 1; return { statusCode: 403, headers: {} }; },
  }), error => error.code === 'HELPER_FORBIDDEN' && error.status === 403);
  assert.equal(forbiddenCalls, 1);
});

test('preload guard observes default/legacy Purpose+Range and only v2 opt-in short-circuits', async () => {
  let helperCalls = 0;
  const server = http.createServer((req, res) => {
    helperCalls += 1;
    res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/cdn?token=fixture` });
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const target = { workId: 7, index: 2, pointer: { url: `http://127.0.0.1:${port}/helper` } };
  const legacy = { strm: { preloadGuard: { mode: 'short-circuit', detectHead: false } } };
  const migrated = migratePreloadConfig(legacy);
  assert.equal(migrated.changed, true);
  assert.equal(migrated.config.strm.preloadGuard.mode, 'observe');
  assert.equal(migrated.config.strm.preloadGuard.calibrationVersion, 2);
  assert.equal(legacy.strm.preloadGuard.mode, 'short-circuit', 'migration must not mutate input');
  assert.equal(classifyPreloadRequest({ method: 'GET', headers: { purpose: 'prefetch', range: 'bytes=0-' } }).shortCircuit, false);
  const runtime = {
    options: { preloadGuard: migrated.config.strm.preloadGuard },
    redirectOptions: () => ({ allowedHosts: [`127.0.0.1:${port}`], finalAllowedHosts: ['127.0.0.1'], timeoutMs: 2000 }),
  };
  try {
    const observed = await resolveWithPreloadGuard({
      req: { method: 'GET', headers: { purpose: 'prefetch', range: 'bytes=0-' } }, target, runtime,
    });
    assert.equal(observed.preload, false, 'default/legacy Purpose must be observation-only');
    assert.equal(helperCalls, 1, 'observed Purpose+Range must resolve Helper normally');

    runtime.options.preloadGuard = { enabled: true, mode: 'short-circuit', detectHead: false, calibrationVersion: 2 };
    const preload = await resolveWithPreloadGuard({
      req: { method: 'GET', headers: { purpose: 'prefetch', range: 'bytes=0-' } }, target, runtime,
    });
    assert.equal(preload.preload, true);
    assert.equal(helperCalls, 1, 'explicit v2 short-circuit must not call Helper');
    const ordinary = await resolveWithPreloadGuard({
      req: { method: 'GET', headers: { range: 'bytes=0-' } }, target, runtime,
    });
    assert.equal(ordinary.preload, false);
    assert.equal(helperCalls, 2, 'ordinary Range playback must resolve Helper');
    assert.equal(classifyPreloadRequest({ method: 'HEAD', headers: {} }, runtime.options.preloadGuard).shortCircuit, false);
    assert.equal(JSON.stringify(observed.decision).includes('fixture'), false, 'diagnostic must not contain URL query');
    const hostileHeader = classifyPreloadRequest({ method: 'GET', headers: { purpose: 'prefetch;token=secret' } }, runtime.options.preloadGuard);
    assert.equal(hostileHeader.purpose, 'prefetch');
    assert.equal(JSON.stringify(hostileHeader).includes('token='), false, 'purpose diagnostics must be token-free');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('scanner child bootstrap decorates scrapeWorkMemo and probes STRM', async () => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kikoeru-strm-child-'));
  const fixture = path.join(temp, 'work');
  const bin = path.join(temp, 'bin');
  const helperServer = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(302, { Location: `http://127.0.0.1:${helperServer.address().port}/media` });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'audio/flac', 'Content-Length': '1' });
    return res.end('x');
  });
  await fs.promises.mkdir(path.join(temp, 'dist/src/filesystem'), { recursive: true });
  await fs.promises.mkdir(fixture, { recursive: true });
  await fs.promises.mkdir(bin, { recursive: true });
  await new Promise(resolve => helperServer.listen(0, '127.0.0.1', resolve));
  const helperHost = `127.0.0.1:${helperServer.address().port}`;
  await fs.promises.writeFile(path.join(fixture, 'voice.flac.strm'), `http://${helperHost}/redirect?id=fixture\n`);
  await fs.promises.writeFile(path.join(temp, 'dist/src/config.js'), [
    'const config = ', JSON.stringify({
      databaseFolderDir: path.join(temp, 'sqlite'), rootFolders: [{ name: 'fixture', path: fixture }],
      strm: {
        enabled: true, allowedSchemes: ['http', 'https'], allowedHosts: [helperHost], finalAllowedHosts: ['127.0.0.1'],
        durationProbe: { enabled: true, intervalMs: 0, maxQueue: 4, timeoutMs: 1000, retryDelayMs: 1000 },
      },
    }), '; module.exports = { config, setNewConfigValue() {} };',
  ].join(''));
  await fs.promises.writeFile(path.join(temp, 'dist/src/filesystem-utils.js'), '');
  await fs.promises.writeFile(path.join(temp, 'dist/src/filesystem/utils.js'), [
    "module.exports = { supportedMediaExtList: ['.mp3'],",
    'getTrackList: async () => [],',
    'scrapeWorkMemo: async () => ({ duration: {}, mtime: {}, isContainLyric: false }),',
    'toTree: value => value };',
  ].join('\n'));
  const childScript = path.join(temp, 'child.js');
  await fs.promises.writeFile(childScript, [
    "const utils = require('./dist/src/filesystem/utils.js');",
    '(async () => {',
    '  const runtime = global[Symbol.for("kikoeru.strm.runtime.v1")];',
    '  const originalRedirectOptions = runtime.redirectOptions;',
    '  runtime.redirectOptions = userAgent => Object.assign(originalRedirectOptions(userAgent), { finalAllowedHosts: ["127.0.0.1"] });',
    `  const memo = await utils.scrapeWorkMemo(${JSON.stringify(fixture)}, {});`,
    '  console.log(JSON.stringify({ strm: Object.keys(memo.strm || {}), duration: memo.duration["voice.flac.strm"], status: memo.strm["voice.flac.strm"] && memo.strm["voice.flac.strm"].status }));',
    '  runtime?.cache?.close(); runtime?.queue?.close();',
    '})().catch(error => { console.error(error.code || "child-failed"); process.exit(1); });',
  ].join('\n'));
  await fs.promises.writeFile(path.join(bin, 'ffprobe'), '#!/bin/sh\nprintf "12.5\\n"\n', { mode: 0o755 });
  try {
    const env = Object.assign({}, process.env, {
      KIKOERU_ROOT: temp,
      PATH: `${bin}:${process.env.PATH || ''}`,
      NODE_OPTIONS: withOverlayNodeOptions(path.resolve(__dirname, '../patches/0.6.15'), ''),
    });
    const child = await new Promise((resolve, reject) => {
      const processChild = spawn(process.execPath, [childScript], { env });
      let stdout = '';
      let stderr = '';
      processChild.stdout.on('data', chunk => { stdout += chunk; });
      processChild.stderr.on('data', chunk => { stderr += chunk; });
      processChild.once('error', reject);
      processChild.once('close', status => resolve({ status, stdout, stderr }));
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(String(child.stdout).trim().split('\n').pop());
    assert.deepEqual(result.strm, ['voice.flac.strm']);
    assert.equal(result.duration, 12.5);
    assert.equal(result.status, 'ok');
  } finally {
    await new Promise(resolve => helperServer.close(resolve));
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

test('redirect resolver gate serializes, merges and rejects a full queue', async () => {
  assert.equal(normalizeRedirectMode(), 'direct');
  assert.equal(normalizeRedirectMode('invalid'), 'direct');
  assert.equal(normalizeRedirectMode('direct'), 'direct');
  assert.equal(defaultStrmConfig('/fixture', { databaseFolderDir: '/fixture/sqlite' }).redirectMode, 'direct');
  assert.equal(defaultStrmConfig('/fixture', {
    databaseFolderDir: '/fixture/sqlite', strm: { redirectMode: 'direct' },
  }).redirectMode, 'direct');
  const explicitDirect = { strm: { redirectMode: 'direct' } };
  const untouchedDirect = migrateRedirectConfigValue(explicitDirect);
  assert.equal(untouchedDirect.config.strm.redirectMode, 'direct');

  const migrated = defaultStrmConfig('/fixture', {
    databaseFolderDir: '/fixture/sqlite',
    strm: { redirectResolve: { minIntervalMs: 150, maxQueue: 64 } },
  }).redirectResolve;
  assert.equal(migrated.minIntervalMs, 1000);
  assert.equal(migrated.maxQueue, 32);
  assert.equal(migrated.perMinute, 30);
  assert.equal(migrated.perHour, 1800);
  assert.equal(migrated.calibrationVersion, 3);
  assert.equal(defaultStrmConfig('/fixture', { databaseFolderDir: '/fixture/sqlite' }).redirectResolve.cacheTtlMs, 10000);
  const defaultPreload = defaultStrmConfig('/fixture', { databaseFolderDir: '/fixture/sqlite' }).preloadGuard;
  assert.equal(defaultPreload.mode, 'observe');
  assert.equal(defaultPreload.calibrationVersion, 2);
  const oldBudget = { strm: { redirectResolve: { minIntervalMs: 400, perMinute: 30, perHour: 120, calibrationVersion: 2 } } };
  const migratedBudget = migrateRedirectConfigValue(oldBudget);
  assert.equal(migratedBudget.config.strm.redirectResolve.minIntervalMs, 1000);
  assert.equal(migratedBudget.config.strm.redirectResolve.perHour, 1800);
  assert.equal(migratedBudget.config.strm.redirectResolve.calibrationVersion, 3);
  assert.equal(oldBudget.strm.redirectResolve.perHour, 120, 'budget migration must not mutate input');
  const historical = migrateRedirectConfigValue({ strm: { redirectResolve: { minIntervalMs: 150, perHour: 120 } } });
  assert.equal(historical.config.strm.redirectResolve.minIntervalMs, 1000);
  assert.equal(historical.config.strm.redirectResolve.perHour, 1800);
  const custom = { minIntervalMs: 250, perMinute: 20, perHour: 120, calibrationVersion: 2 };
  const customCompat = migrateRedirectResolveConfig(custom, custom);
  assert.equal(customCompat.minIntervalMs, 250);
  assert.equal(customCompat.perHour, 120);
  assert.equal(customCompat.calibrationVersion, 3);
  const defaults = new RedirectRateLimiter();
  assert.deepEqual(defaults.options(), {
    maxConcurrent: 1, minIntervalMs: 1000, maxQueue: 32, cacheTtlMs: 0,
    perMinute: 30, perHour: 1800, cooldownMs: 1000, severeCooldownMs: 60000, severeAfter429: 3,
  });
  defaults.close();
  const limiter = new RedirectRateLimiter({ maxConcurrent: 1, minIntervalMs: 20, maxQueue: 1, cacheTtlMs: 40 });
  const starts = [];
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const task = label => async () => {
    calls += 1;
    starts.push(Date.now());
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return label;
  };
  try {
    const first = limiter.resolve('same', task('same'));
    const merged = limiter.resolve('same', task('should-not-run'));
    const queued = limiter.resolve('queued', task('queued'));
    await assert.rejects(limiter.resolve('overflow', task('overflow')), error => error.code === 'REDIRECT_QUEUE_FULL' && error.status === 429);
    assert.equal(await first, 'same');
    assert.equal(await merged, 'same');
    assert.equal(await queued, 'queued');
    assert.equal(calls, 2);
    assert.equal(maximumActive, 1);
    assert.ok(starts[1] - starts[0] >= 15, `${starts[1] - starts[0]}ms gap`);
    assert.equal(await limiter.resolve('same', task('cache-hit')), 'same');
    const status = limiter.status();
    assert.equal(status.rejected, 1);
    assert.ok(status.cacheHits >= 1);
    assert.equal(JSON.stringify(status).includes('http'), false);
  } finally {
    limiter.close();
  }
});

test('redirect budget blocks a second Helper start and records budget wait', async () => {
  const limiter = new RedirectRateLimiter({ maxConcurrent: 1, minIntervalMs: 0, maxQueue: 2, perMinute: 1, perHour: 2 });
  let calls = 0;
  try {
    assert.equal(await limiter.resolve('first', async () => { calls += 1; return 'first'; }), 'first');
    const second = limiter.resolve('second', async () => { calls += 1; return 'second'; });
    await new Promise(resolve => setImmediate(resolve));
    const status = limiter.status();
    assert.equal(calls, 1);
    assert.equal(status.pending, 1);
    assert.ok(status.budgetWaits >= 1);
    assert.equal(status.budget.minuteRemaining, 0);
    limiter.close();
    await assert.rejects(second, error => error.code === 'REDIRECT_RESOLVER_CLOSED');
  } finally {
    limiter.close();
  }
});

test('redirect cache isolates User-Agent identities while merging same-UA Range requests', async () => {
  const limiter = new RedirectRateLimiter({ maxConcurrent: 1, minIntervalMs: 0, maxQueue: 8, cacheTtlMs: 1000 });
  const runtime = {
    redirects: limiter,
    redirectOptions: userAgent => ({
      allowedSchemes: ['http', 'https'],
      allowedHosts: ['helper.example'],
      finalAllowedHosts: ['cdn.example'],
      userAgent,
    }),
  };
  const target = {
    key: 'ua-bound-key', pointerFingerprint: 'ua-bound-pointer',
    pointer: { url: 'https://helper.example/redirect' },
  };
  const calls = [];
  const resolveFinal = async (_url, options) => {
    calls.push(options.userAgent);
    return { final: new URL(`https://cdn.example/media?ua=${encodeURIComponent(options.userAgent)}`), userAgent: options.userAgent };
  };
  try {
    const uaA = Object.assign({}, target, { userAgent: 'Browser/A' });
    const uaB = Object.assign({}, target, { userAgent: 'Browser/B' });
    const [sameA1, sameA2, differentB] = await Promise.all([
      resolveStrmRedirect(runtime, uaA, resolveFinal),
      // This stands in for a second Range/seek request from the same client.
      resolveStrmRedirect(runtime, Object.assign({}, uaA, { range: 'bytes=100-' }), resolveFinal),
      resolveStrmRedirect(runtime, uaB, resolveFinal),
    ]);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.sort(), ['Browser/A', 'Browser/B']);
    assert.equal(sameA1.final.toString(), sameA2.final.toString());
    assert.notEqual(sameA1.final.toString(), differentB.final.toString());
    const cachedA = await resolveStrmRedirect(runtime, uaA, resolveFinal);
    assert.equal(cachedA.final.toString(), sameA1.final.toString());
    assert.equal(calls.length, 2);
    assert.equal(limiter.status().started, 2, 'same-UA seek/cache hit must not consume another Helper slot');
  } finally {
    limiter.close();
  }
});

test('smooth Helper budget allows 120 starts without the old hourly dead zone', async () => {
  const limiter = new RedirectRateLimiter({
    minIntervalMs: 0, maxConcurrent: 1, maxQueue: 256, perMinute: 1800, perHour: 1800,
  });
  try {
    for (let index = 0; index < 120; index += 1) {
      await limiter.resolve(`budget-${index}`, async () => index);
    }
    const status = limiter.status();
    assert.equal(status.started, 120);
    assert.equal(status.pending, 0);
    assert.equal(status.budget.hourRemaining, 1680);
    assert.equal(status.budgetWaits, 0);
  } finally {
    limiter.close();
  }
  const shared = normalizeSharedHelperOptions();
  assert.equal(shared.minIntervalMs, 1000);
  assert.equal(shared.perMinute, 30);
  assert.equal(shared.perHour, 1800);
});

test('30-per-minute Helper budget remains an effective burst ceiling', async () => {
  const limiter = new RedirectRateLimiter({
    minIntervalMs: 0, maxConcurrent: 1, maxQueue: 2, perMinute: 30, perHour: 1800,
  });
  try {
    for (let index = 0; index < 30; index += 1) {
      await limiter.resolve(`minute-${index}`, async () => index);
    }
    const blocked = limiter.resolve('minute-blocked', async () => 31);
    await new Promise(resolve => setImmediate(resolve));
    const status = limiter.status();
    assert.equal(status.started, 30);
    assert.equal(status.pending, 1);
    assert.equal(status.budget.minuteRemaining, 0);
    assert.ok(status.budgetWaits >= 1);
    limiter.close();
    await assert.rejects(blocked, error => error.code === 'REDIRECT_RESOLVER_CLOSED');
  } finally {
    limiter.close();
  }
});

test('final 429 enters limiter cooldown and exposes safe counters', async () => {
  const limiter = new RedirectRateLimiter({
    maxConcurrent: 1, minIntervalMs: 0, maxQueue: 4, perMinute: 30, perHour: 120,
    cooldownMs: 0, severeCooldownMs: 25, severeAfter429: 3,
  });
  try {
    for (let index = 0; index < 3; index += 1) {
      await assert.rejects(limiter.resolve(`rate-${index}`, async () => {
        throw Object.assign(new Error('fixture throttled'), { status: 429, retryAfterMs: 0 });
      }), error => error.status === 429);
    }
    const status = limiter.status();
    assert.equal(status.rateLimited, 3);
    assert.equal(status.consecutiveRateLimits, 3);
    assert.ok(status.cooldowns >= 1);
    assert.ok(status.cooldownRemainingMs > 0);
  } finally {
    limiter.close();
  }
});

test('STRM loudnorm compatibility response has convergent pending/error/ready states without peaks', () => {
  const ready = strmLoudnormPayload({ loudnessReady: true, loudnessStatus: 'ready', loudnorm: { output_i: '-16' } }, true);
  assert.deepEqual(ready, { loudnorm: { output_i: '-16' }, peakLevels: [], ready: true, status: 'ready', retry: false });
  const pending = strmLoudnormPayload({ loudnessReady: false, loudnessStatus: 'pending' }, true);
  assert.equal(pending.code, 'STRM_LOUDNORM_PENDING');
  assert.equal(pending.retry, true);
  assert.deepEqual(pending.peakLevels, []);
  const error = strmLoudnormPayload({ loudnessReady: false, loudnessStatus: 'error' }, true);
  assert.equal(error.status, 'retrying');
  assert.equal(error.retry, true);
  const noCache = strmLoudnormPayload({ loudnessReady: false, loudnessStatus: 'pending' }, false);
  assert.equal(noCache.code, 'STRM_LOUDNORM_CACHE_PENDING');
  assert.equal(noCache.retry, false);
  assert.deepEqual(noCache.peakLevels, []);
  const skipped = strmLoudnormPayload({ loudnessReady: true, loudnessStatus: 'skipped' }, false);
  assert.deepEqual(skipped, { loudnorm: 0, peakLevels: [], ready: true, status: 'skipped', retry: false });
});

test('cold-start resolver merges loudnorm bootstrap and playback requests into one download', async () => {
  let resolveCalls = 0;
  let downloadCalls = 0;
  const runtime = {
    coldStarts: new SingleFlight(),
    redirects: { resolve(_key, task) { return task(); } },
    options: {
      redirectMode: 'direct',
      preloadGuard: { enabled: false, mode: 'off', detectHead: false },
      coldCache: { enabled: true },
      allowedSchemes: ['http', 'https'],
      finalAllowedHosts: ['cdn.example'],
      loudness: { timeoutMs: 1000 },
    },
    store: { upsert: async () => undefined },
    redirectOptions: () => ({}),
    cache: {
      get: async () => ({ downloadReady: false, loudnessReady: false, cachePath: null }),
      shouldUseHot: async () => false,
      ensureLocal: async () => {
        downloadCalls += 1;
        await new Promise(resolve => setTimeout(resolve, 5));
        return { path: '/tmp/fixture.mp3' };
      },
    },
  };
  const target = {
    key: 'cold-start-key',
    pointerFingerprint: 'cold-start-pointer',
    pointer: { url: 'https://helper.example/redirect' },
  };
  const resolveFinal = async () => {
    resolveCalls += 1;
    await new Promise(resolve => setTimeout(resolve, 5));
    return { final: new URL('https://cdn.example/media') };
  };
  const playbackResponse = {
    headers: {}, headersSent: false, kind: null, filePath: null,
    setHeader(name, value) { this.headers[name] = value; },
    sendFile(filePath) { this.kind = 'file'; this.filePath = filePath; this.headersSent = true; return this; },
    redirect(status, location) { this.kind = 'redirect'; this.statusCode = status; this.location = location; this.headersSent = true; return this; },
  };
  const playbackTarget = Object.assign({}, target, { mediaExt: '.mp3', isVideo: false });
  const [playbackResult, loudnormResult] = await Promise.all([
    handleStrmPlayback({ req: { method: 'GET', headers: {} }, res: playbackResponse, target: playbackTarget, runtime, resolveFinal }),
    startStrmColdBootstrap(runtime, playbackTarget, resolveFinal),
  ]);
  assert.equal(resolveCalls, 1);
  assert.equal(downloadCalls, 1);
  assert.equal(playbackResult.kind, 'file');
  assert.equal(playbackResult.filePath, '/tmp/fixture.mp3');
  assert.equal(loudnormResult, undefined);
});

test('STRM playback cold direct then hot 302 semantics share resolver gate', async () => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kikoeru-strm-playback-'));
  let helperHeads = 0;
  let cdnGets = 0;
  const helperUserAgents = [];
  const cdnUserAgents = [];
  let loudnormCalls = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      helperHeads += 1;
      helperUserAgents.push(req.headers['user-agent']);
      res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/cdn?token=fixture` });
      return res.end();
    }
    if (req.url.startsWith('/cdn')) {
      cdnGets += 1;
      cdnUserAgents.push(req.headers['user-agent']);
      res.writeHead(200, { 'Content-Type': 'audio/flac', 'Content-Length': '10' });
      return res.end('0123456789');
    }
    res.writeHead(404); return res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const state = new StrmStateStore(path.join(temp, 'state.json'));
  const manager = new StrmCacheManager({
    store: state,
    config: { rootDir: path.join(temp, 'cache'), maxFileBytes: 100, maxTotalBytes: 1000, cleanupIntervalMs: 0 },
    runLoudnorm: async () => { loudnormCalls += 1; return { input_i: '-20', output_i: '-16' }; },
  });
  const limiter = new RedirectRateLimiter({ maxConcurrent: 1, minIntervalMs: 0, maxQueue: 8, cacheTtlMs: 10000 });
  const target = {
    key: makeRecordKey('fixture', 'work/voice.flac.strm'), rootFolder: 'fixture', relativePath: 'work/voice.flac.strm',
    pointer: { url: `http://127.0.0.1:${server.address().port}/helper?token=fixture` },
    pointerFingerprint: 'fixture-pointer', pointerMtimeMs: Date.now(), mediaExt: '.flac', isVideo: false,
  };
  const runtime = {
    ready: state.init(), store: state, cache: manager, redirects: limiter,
    metrics: { coldLocal: 0, hotRedirect: 0, localPlayback: 0, preloadSkip: 0 },
    options: {
      redirectMode: 'direct',
      preloadGuard: { enabled: true, mode: 'short-circuit', detectHead: false },
      coldCache: { enabled: true }, loudness: { timeoutMs: 1000 },
      allowedSchemes: ['http', 'https'], finalAllowedHosts: ['127.0.0.1'],
      redirectResolve: { timeoutMs: 2000, cacheTtlMs: 10000 },
    },
    redirectOptions: () => ({ allowedSchemes: ['http', 'https'], allowedHosts: [`127.0.0.1:${server.address().port}`], finalAllowedHosts: ['127.0.0.1'], timeoutMs: 2000 }),
  };
  const response = () => ({
    statusCode: 200, headers: {}, kind: null, location: null, filePath: null, body: null, headersSent: false,
    setHeader(name, value) { this.headers[name] = value; },
    sendFile(filePath) { this.kind = 'file'; this.filePath = filePath; this.headersSent = true; return this; },
    redirect(status, location) { this.kind = 'redirect'; this.statusCode = status; this.location = location; this.headersSent = true; return this; },
  });
  try {
    const coldResponse = response();
    await handleStrmPlayback({ req: { method: 'GET', headers: {} }, res: coldResponse, target, runtime });
    assert.equal(coldResponse.kind, 'file');
    assert.equal(runtime.metrics.coldLocal, 1);
    for (let i = 0; i < 50; i += 1) {
      if ((await state.get(target.key)).loudnessReady) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal((await state.get(target.key)).loudnessStatus, 'ready');
    const hotResponse = response();
    await handleStrmPlayback({ req: { method: 'GET', headers: {} }, res: hotResponse, target, runtime });
    assert.equal(hotResponse.kind, 'redirect');
    assert.equal(hotResponse.statusCode, 302);
    assert.equal(hotResponse.headers['Cache-Control'], 'no-store');
    assert.equal(hotResponse.headers.Pragma, 'no-cache');
    assert.equal(hotResponse.headers.Vary, 'User-Agent');
    assert.equal(helperHeads, 1);
    assert.equal(cdnGets, 1);
    assert.deepEqual(helperUserAgents, [DEFAULT_HELPER_USER_AGENT]);
    assert.deepEqual(cdnUserAgents, [DEFAULT_HELPER_USER_AGENT]);
    assert.equal(loudnormCalls, 1);
    assert.equal(runtime.metrics.coldLocal, 1);
    assert.equal(runtime.metrics.hotRedirect, 1);

    const rangeResponse = response();
    await handleStrmPlayback({ req: { method: 'GET', headers: { range: 'bytes=25100288-' } }, res: rangeResponse, target, runtime });
    assert.equal(rangeResponse.kind, 'redirect');
    assert.equal(rangeResponse.statusCode, 302);
    assert.equal(helperHeads, 1, 'direct Range playback must reuse the cached CDN Location');
    assert.ok(limiter.status().cacheHits >= 2);
    assert.equal(runtime.metrics.hotRedirect, 2);

    const directColdTarget = Object.assign({}, target, {
      key: makeRecordKey('fixture', 'work/direct-cold.flac.strm'),
      relativePath: 'work/direct-cold.flac.strm',
      pointerFingerprint: 'direct-cold-pointer',
    });
    const directColdResponse = response();
    await handleStrmPlayback({ req: { method: 'GET', headers: { range: 'bytes=0-' } }, res: directColdResponse, target: directColdTarget, runtime });
    assert.equal(directColdResponse.kind, 'file');
    assert.equal(helperHeads, 2, 'a second direct cold track resolves Helper once for the server download');
    assert.equal(cdnGets, 2, 'a second direct cold track downloads once before serving the local file');
    assert.equal(runtime.metrics.coldLocal, 2);

    runtime.options.redirectMode = 'local';
    const localResponse = response();
    await handleStrmPlayback({ req: { method: 'GET', headers: {} }, res: localResponse, target, runtime });
    assert.equal(localResponse.kind, 'file');
    assert.equal(helperHeads, 2, 'local delivery should not resolve Helper');
    assert.equal(runtime.metrics.localPlayback, 1);
  } finally {
    limiter.close();
    manager.close();
    await new Promise(resolve => server.close(resolve));
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

test('cold-policy fallback re-resolves the redirect for the browser UA', async () => {
  const helperUserAgents = [];
  const target = {
    key: 'cold-fallback-key',
    pointerFingerprint: 'cold-fallback-pointer',
    pointer: { url: 'https://helper.example/redirect' },
    userAgent: 'Browser/Fixture',
    mediaExt: '.mp3',
    isVideo: false,
  };
  const runtime = {
    ready: Promise.resolve(),
    coldStarts: new SingleFlight(),
    redirects: { resolve(_key, task) { return task(); } },
    options: {
      redirectMode: 'local',
      preloadGuard: { enabled: false, mode: 'off', detectHead: false },
      coldCache: { enabled: true },
      loudness: { enabled: true, audioOnly: true, timeoutMs: 1000 },
      allowedSchemes: ['http', 'https'],
      finalAllowedHosts: ['cdn.example'],
      redirectResolve: { cacheTtlMs: 10000 },
    },
    redirectOptions: userAgent => ({ userAgent }),
    cache: {
      get: async () => ({ downloadReady: false, loudnessReady: false }),
      shouldUseHot: async () => false,
      ensureLocal: async () => {
        throw Object.assign(new Error('fixture exceeds cache policy'), { code: 'DOWNLOAD_TOO_LARGE' });
      },
    },
    store: { upsert: async () => undefined },
    metrics: { coldLocal: 0, hotRedirect: 0, localPlayback: 0, preloadSkip: 0 },
  };
  const response = {
    headers: {}, headersSent: false, kind: null, location: null,
    setHeader(name, value) { this.headers[name] = value; },
    redirect(status, location) { this.kind = 'redirect'; this.statusCode = status; this.location = location; this.headersSent = true; return this; },
  };
  const resolveFinal = async (_url, options) => {
    helperUserAgents.push(options.userAgent);
    return {
      final: new URL(`https://cdn.example/media?ua=${encodeURIComponent(options.userAgent)}`),
      userAgent: options.userAgent,
    };
  };

  await handleStrmPlayback({
    req: { method: 'GET', headers: { 'user-agent': target.userAgent } },
    res: response,
    target,
    runtime,
    resolveFinal,
  });

  assert.deepEqual(helperUserAgents, [DEFAULT_HELPER_USER_AGENT, target.userAgent]);
  assert.equal(response.kind, 'redirect');
  assert.equal(response.statusCode, 302);
  assert.match(response.location, /ua=Browser%2FFixture/);
  assert.doesNotMatch(response.location, /Mozilla%2F5\.0/);
});

test('direct mode skips cold download when loudness is disabled', async () => {
  let downloadCalls = 0;
  let resolveCalls = 0;
  const runtime = {
    ready: Promise.resolve(),
    options: {
      redirectMode: 'direct',
      preloadGuard: { enabled: false, mode: 'off', detectHead: false },
      coldCache: { enabled: true },
      loudness: { enabled: false, audioOnly: true, timeoutMs: 1000 },
      allowedSchemes: ['http', 'https'],
      finalAllowedHosts: ['cdn.example'],
      redirectResolve: { cacheTtlMs: 10000 },
    },
    cache: {
      get: async () => ({ downloadReady: false, loudnessReady: false, cachePath: null }),
      shouldUseHot: async () => { throw new Error('disabled loudness must not inspect cold policy'); },
      ensureLocal: async () => { downloadCalls += 1; throw new Error('direct disabled path downloaded'); },
    },
    redirects: { resolve(_key, task) { return task(); } },
    redirectOptions: () => ({}),
    metrics: { coldLocal: 0, hotRedirect: 0, localPlayback: 0, preloadSkip: 0 },
  };
  const response = {
    headers: {}, headersSent: false, kind: null, location: null,
    setHeader(name, value) { this.headers[name] = value; },
    redirect(status, location) { this.kind = 'redirect'; this.statusCode = status; this.location = location; this.headersSent = true; return this; },
  };
  const target = {
    key: 'direct-disabled-key', pointerFingerprint: 'direct-disabled-pointer',
    pointer: { url: 'https://helper.example/redirect' }, mediaExt: '.mp3', isVideo: false,
  };
  const resolveFinal = async () => { resolveCalls += 1; return { final: new URL('https://cdn.example/media') }; };
  await handleStrmPlayback({ req: { method: 'GET', headers: {} }, res: response, target, runtime, resolveFinal });
  assert.equal(response.kind, 'redirect');
  assert.equal(response.statusCode, 302);
  assert.equal(resolveCalls, 1);
  assert.equal(downloadCalls, 0);
});

test('admin UI exposes a same-origin STRM settings entry without credentials in HTML', () => {
  assert.match(ADMIN_HTML, /STRM 设置/);
  assert.match(ADMIN_HTML, /api\/strm\/status/);
  assert.match(ADMIN_HTML, /二次确认后清理缓存/);
  assert.match(ADMIN_HTML, /冷启动与响度策略/);
  assert.match(ADMIN_HTML, /loudnessEnabled/);
  assert.match(ADMIN_HTML, /ebur128/);
  assert.match(ADMIN_HTML, /redirectMode/);
  assert.ok(ADMIN_HTML.indexOf('value="direct"') < ADMIN_HTML.indexOf('value="local"'));
  assert.match(ADMIN_HTML, /冷启动响度后 302（推荐）/);
  assert.match(ADMIN_HTML, /永久本地兼容（手动选项，需完整冷下载）/);
  assert.match(ADMIN_HTML, /direct 首次冷启动先准备本地缓存与响度/);
  assert.match(ADMIN_HTML, /之后播放和 Range 返回 CDN 302/);
  assert.match(ADMIN_HTML, /c\.redirectMode\|\|"direct"/);
  assert.match(ADMIN_HTML, /redirectCacheTtlMs/);
  assert.match(ADMIN_HTML, /value="observe">仅观测（默认）/);
  assert.match(ADMIN_HTML, /g\.mode\|\|"observe"/);
  assert.equal(/jwtsecret|md5secret|password\s*[:=]\s*["'][^"']+["']/.test(ADMIN_HTML), false);
  assert.match(MENU_SCRIPT, /STRM 设置/);
  assert.match(MENU_SCRIPT, /admin\/advanced/);
  assert.match(MENU_SCRIPT, /admin\/strm/);
  assert.match(MENU_SCRIPT, /api\/admin\/strm-fragment/);
  assert.match(MENU_SCRIPT, /__kikoeruStrmVueRouteInstalled/);
  assert.doesNotMatch(MENU_SCRIPT, /position:fixed;right:16px;bottom:16px/);
  assert.doesNotMatch(MENU_SCRIPT, /pushState|preventDefault|hideNativePages|cloneNode|STRM_UI_PATH/);
  assert.doesNotThrow(() => new vm.Script(MENU_SCRIPT));
  const response = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(v) { this.body = String(v || ''); } };
  createAdminUiMiddleware()({ method: 'GET', url: '/admin/strm' }, response, () => { throw new Error('page should be handled'); });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /STRM 设置/);
});

test('admin UI serves direct and trailing-slash routes while preserving middleware fallthrough', () => {
  const middleware = createAdminUiMiddleware();
  for (const url of ['/admin/strm', '/admin/strm/', '/admin/strm?from=dashboard', '/api/admin/strm-fragment', '/api/admin/strm-fragment/']) {
    const response = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(v) { this.body = String(v || ''); } };
    let nextCalled = false;
    middleware({ method: 'GET', url }, response, () => { nextCalled = true; });
    assert.equal(response.statusCode, 200);
    assert.equal(nextCalled, false);
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.match(response.headers['Content-Type'], /text\/html/);
    assert.match(response.body, /q-layout--standard/);
    assert.match(response.body, /q-drawer/);
    assert.match(response.body, /q-page-container/);
  }
  let fallthrough = 0;
  middleware({ method: 'POST', url: '/admin/strm' }, {}, () => { fallthrough += 1; });
  assert.equal(fallthrough, 1);
  let apiUiFallthrough = 0;
  middleware({ method: 'GET', url: '/api/admin/strm-ui' }, {}, () => { apiUiFallthrough += 1; });
  assert.equal(apiUiFallthrough, 1);
});

test('admin UI has the native dashboard shell, active STRM route and binary cache units', () => {
  assert.match(ADMIN_HTML, /class="q-layout q-layout--standard"/);
  assert.match(ADMIN_HTML, /class="q-header q-layout__section--marginal bg-black absolute-top"/);
  assert.match(ADMIN_HTML, /class="q-drawer q-drawer--left"/);
  assert.match(ADMIN_HTML, /class="q-page-container"/);
  assert.match(ADMIN_HTML, /data-strm-nav href="\/admin\/scanner"/);
  assert.match(ADMIN_HTML, /data-strm-nav href="\/admin\/advanced"/);
  assert.match(ADMIN_HTML, /data-strm-nav href="\/admin\/strm" aria-current="page"/);
  assert.match(ADMIN_HTML, /KiB/);
  assert.match(ADMIN_HTML, /MiB/);
  assert.match(ADMIN_HTML, /GiB/);
  assert.match(ADMIN_HTML, /TiB/);
  assert.match(ADMIN_HTML, /id="cacheUsage"/);
  assert.match(ADMIN_HTML, /id="cacheLimit"/);
  assert.match(ADMIN_HTML, /id="cacheState"/);
  assert.match(ADMIN_HTML, /已超限/);
  assert.doesNotMatch(MENU_SCRIPT, /preventDefault|pushState|popstate|data-kikoeru-strm-view/);
  assert.match(MENU_SCRIPT, /router\.matcher\s*=\s*fresh\.matcher/);
  assert.match(MENU_SCRIPT, /links\.splice/);
});

class AdminUiFakeClassList {
  constructor(value = '') { this.values = new Set(String(value).split(/\s+/).filter(Boolean)); }
  add(...values) { values.forEach(value => this.values.add(value)); }
  remove(...values) { values.forEach(value => this.values.delete(value)); }
  toggle(value, force) { const shouldAdd = force === undefined ? !this.values.has(value) : Boolean(force); if (shouldAdd) this.values.add(value); else this.values.delete(value); return shouldAdd; }
  contains(value) { return this.values.has(value); }
  toString() { return Array.from(this.values).join(' '); }
}

class AdminUiFakeElement {
  constructor(tagName = 'div', attrs = {}, textContent = '') {
    this.tagName = String(tagName).toUpperCase();
    this.attrs = Object.assign({}, attrs);
    this.children = [];
    this.parentNode = null;
    this.listeners = {};
    this.style = { display: '' };
    this.classList = new AdminUiFakeClassList(this.attrs.class || '');
    this.textContent = textContent;
    this.innerHTML = '';
    this.value = '';
    this.checked = false;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.children.indexOf(this);
    return index < 0 ? null : this.parentNode.children[index + 1] || null;
  }
  setAttribute(name, value) { this.attrs[name] = String(value); if (name === 'class') this.classList = new AdminUiFakeClassList(value); }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  removeAttribute(name) { delete this.attrs[name]; }
  appendChild(child) { if (child.parentNode) child.parentNode.removeChild(child); child.parentNode = this; this.children.push(child); return child; }
  insertBefore(child, before) { if (child.parentNode) child.parentNode.removeChild(child); child.parentNode = this; const index = before ? this.children.indexOf(before) : -1; if (index < 0) this.children.push(child); else this.children.splice(index, 0, child); return child; }
  removeChild(child) { const index = this.children.indexOf(child); if (index >= 0) { this.children.splice(index, 1); child.parentNode = null; } return child; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  dispatch(type, event = {}) { for (const handler of (this.listeners[type] || []).slice()) handler(event); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const result = [];
    const matches = node => {
      if (selector === '*') return true;
      if (selector === 'audio,video') return node.tagName === 'AUDIO' || node.tagName === 'VIDEO';
      if (selector === '.q-page-container') return node.classList.contains('q-page-container');
      if (selector === '.q-page') return node.classList.contains('q-page');
      if (selector === '[data-kikoeru-strm-menu]') return node.getAttribute('data-kikoeru-strm-menu') === 'true';
      if (selector === '[data-kikoeru-strm-runtime]') return node.getAttribute('data-kikoeru-strm-runtime') === 'true';
      if (selector === 'style[data-kikoeru-strm-style]') return node.tagName === 'STYLE' && node.getAttribute('data-kikoeru-strm-style') === 'true';
      if (selector === '[data-strm-nav]') return node.getAttribute('data-strm-nav') !== null;
      if (selector === 'a[href="/admin/advanced"]' || selector === '[href="/admin/advanced"]') return node.getAttribute('href') === '/admin/advanced';
      if (selector === '.q-item__section--main, .q-item__label') return node.classList.contains('q-item__section--main') || node.classList.contains('q-item__label');
      return false;
    };
    const visit = node => { node.children.forEach(child => { if (matches(child)) result.push(child); visit(child); }); };
    visit(this);
    return result;
  }
}

function makeAdminUiVueFixture() {
  const body = new AdminUiFakeElement('body');
  const head = new AdminUiFakeElement('head');
  const app = new AdminUiFakeElement('div', { id: 'q-app' });
  const nativePage = new AdminUiFakeElement('form', { id: 'native-page' }, 'native page');
  body.appendChild(head);
  body.appendChild(app);
  body.appendChild(nativePage);
  const links = [
    { title: '音声库', icon: 'folder', path: '/admin' },
    { title: '高级设置', icon: 'settings', path: '/admin/advanced' },
    { title: '回到主页', icon: 'home', path: '/' },
  ];
  class FakeRouter {
    static instances = [];
    constructor(options) {
      this.options = options;
      this.matcher = { routes: options.routes };
      FakeRouter.instances.push(this);
    }
  }
  const routes = [{ path: '/admin', children: [{ path: 'advanced', component: { name: 'Advanced' } }] }, { path: '/login' }];
  const router = new FakeRouter({ routes });
  const transitions = [];
  router.history = {
    getCurrentLocation() { return '/admin/strm'; },
    transitionTo(path) { transitions.push(path); },
  };
  const layout = { links, $children: [] };
  const rootVm = { $router: router, $children: [layout] };
  app.__vue__ = rootVm;
  const window = {
    location: { href: 'http://fixture.test/admin', pathname: '/admin', origin: 'http://fixture.test' },
    addEventListener() {},
    fetches: [],
    fetch(url) { this.fetches.push(url); return Promise.resolve({ ok: true, text: () => Promise.resolve(ADMIN_HTML) }); },
  };
  const document = {
    readyState: 'complete', body, head, documentElement: body,
    getElementById(id) { return id === 'q-app' ? app : null; },
    createElement(tagName) { return new AdminUiFakeElement(tagName); },
    querySelector(selector) { return body.querySelector(selector) || head.querySelector(selector); },
    querySelectorAll(selector) { return body.querySelectorAll(selector); },
    addEventListener() {},
  };
  class FakeParser {
    parseFromString() {
      const source = new AdminUiFakeElement('main', { id: 'strm-admin-content' });
      source.innerHTML = '<section data-fixture="strm"><span id="status">status</span></section>';
      const script = new AdminUiFakeElement('script', { 'data-strm-admin-script': 'true' });
      script.textContent = 'window.__fixtureRuntimeRan=true;';
      const style = new AdminUiFakeElement('style', { 'data-strm-admin-style': 'true' }, '.q-page{color:red}');
      return { querySelector(selector) { return selector === '#strm-admin-content' ? source : selector === 'script[data-strm-admin-script]' ? script : selector === 'style[data-strm-admin-style]' ? style : null; } };
    }
  }
  return { app, body, head, nativePage, links, router, routes, transitions, window, document, DOMParser: FakeParser, FakeRouter };
}

test('dashboard integration adds a real Vue child route and native link exactly once', () => {
  const fixture = makeAdminUiVueFixture();
  const context = vm.createContext(Object.assign({ URL, DOMParser: fixture.DOMParser, MutationObserver: class { observe() {} }, setTimeout() { return 1; }, clearTimeout() {}, window: fixture.window, document: fixture.document }, fixture.window));
  new vm.Script(MENU_SCRIPT).runInContext(context);
  assert.equal(fixture.FakeRouter.instances.length, 2, 'matcher is rebuilt once with the added child route');
  const fresh = fixture.FakeRouter.instances[1];
  const admin = fresh.options.routes.find(route => route.path === '/admin');
  assert.ok(admin.children.some(route => route.path === 'strm'));
  assert.deepEqual(fixture.transitions, ['/admin/strm']);
  assert.equal(fixture.links.filter(link => link.path === '/admin/strm').length, 1);
  assert.deepEqual(fixture.links.map(link => link.path), ['/admin', '/admin/advanced', '/admin/strm', '/']);
  assert.equal(fixture.body.children.length, 3, 'native DOM is not taken over by a cloned page');
  new vm.Script(MENU_SCRIPT).runInContext(context);
  assert.equal(fixture.FakeRouter.instances.length, 2);
  assert.equal(fixture.links.filter(link => link.path === '/admin/strm').length, 1);
});

test('Vue STRM component fetches fragment, injects runtime, and cleans up on destroy', async () => {
  const fixture = makeAdminUiVueFixture();
  const context = vm.createContext(Object.assign({ URL, DOMParser: fixture.DOMParser, MutationObserver: class { observe() {} }, setTimeout() { return 1; }, clearTimeout() {}, window: fixture.window, document: fixture.document, Promise }, fixture.window));
  new vm.Script(MENU_SCRIPT).runInContext(context);
  const component = fixture.window.__kikoeruStrmAdminComponent;
  assert.ok(component);
  const vnode = component.render((_tag, data) => ({ data }));
  assert.deepEqual(Array.from(vnode.data.class), ['q-page', 'q-pa-md']);
  assert.equal(vnode.data.attrs.id, 'strm-admin-content');
  const vmInstance = { $el: new AdminUiFakeElement('div', { id: 'strm-admin-content' }) };
  component.mounted.call(vmInstance);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.window.fetches, ['/api/admin/strm-fragment']);
  assert.match(vmInstance.$el.innerHTML, /data-fixture="strm"/);
  assert.equal(fixture.head.querySelectorAll('style[data-kikoeru-strm-style]').length, 1);
  assert.equal(fixture.body.querySelectorAll('[data-kikoeru-strm-runtime]').length, 1);
  fixture.window.__kikoeruStrmAdminRuntime = { root: vmInstance.$el };
  component.beforeDestroy.call(vmInstance);
  assert.equal(fixture.body.querySelectorAll('[data-kikoeru-strm-runtime]').length, 0);
  assert.equal(fixture.window.__kikoeruStrmAdminRuntime, undefined);
});

test('STRM admin runtime loads config and keeps save/cleanup API contracts', async () => {
  const ids = ['status', 'metrics', 'rawMetrics', 'enabled', 'redirectMode', 'preloadMode', 'detectHead', 'redirectCacheTtlMs', 'coldCacheEnabled', 'maxTotalBytes', 'maxFileBytes', 'maxVideoBytes', 'maxAgeMs', 'loudnessEnabled', 'loudnessAudioOnly', 'loudnessMethod', 'cacheUsage', 'cacheLimit', 'cacheState', 'cacheProgress', 'refresh', 'save', 'cleanup', 'message'];
  const elements = new Map(ids.map(id => [id, new AdminUiFakeElement('input', { id })]));
  const root = new AdminUiFakeElement('main', { id: 'strm-admin-content', class: 'q-page' });
  const body = new AdminUiFakeElement('body');
  body.appendChild(root);
  const document = {
    body, documentElement: body,
    getElementById(id) { return id === 'strm-admin-content' ? root : elements.get(id) || null; },
    querySelectorAll() { return []; },
  };
  const status = { enabled: true, cacheBytes: 3 * 1024 * 1024, records: [{ id: 1 }], config: { redirectMode: 'local', preloadGuard: { mode: 'observe', detectHead: true }, redirectResolve: { cacheTtlMs: 12000 }, coldCache: { enabled: true, maxTotalBytes: 4 * 1024 * 1024, maxFileBytes: 5 * 1024 * 1024, maxVideoBytes: 6 * 1024 * 1024, maxAgeMs: 7 * 24 * 60 * 60 * 1000 }, loudness: { enabled: true, audioOnly: false, method: 'ebur128' } }, queue: {}, redirect: {}, metrics: {} };
  const calls = [];
  const response = data => ({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(data)) });
  const window = {
    location: { pathname: '/admin/strm' },
    localStorage: { getItem(key) { return key === 'jwt-token' ? '__q_strn|fixture-jwt' : null; } },
    fetch(url, options) { calls.push({ url, options }); return Promise.resolve(response(status)); },
    addEventListener() {}, confirm() { return true; },
  };
  const context = vm.createContext({ window, document, localStorage: window.localStorage, fetch: window.fetch.bind(window), Promise, Object, Number, String, Boolean, JSON });
  const runtime = ADMIN_HTML.match(/<script data-strm-admin-script>([\s\S]*?)<\/script>/)[1];
  new vm.Script(runtime).runInContext(context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(window.__kikoeruStrmAdminRuntime.root, root);
  assert.equal(calls[0].url, '/api/strm/status');
  assert.match(elements.get('status').innerHTML, /已连接/);
  assert.equal(elements.get('maxTotalBytes').value, '0.004');
  assert.equal(elements.get('redirectCacheTtlMs').value, '12');
  assert.equal(elements.get('cacheUsage').textContent, '3.00 MiB');
  assert.equal(elements.get('cacheLimit').textContent, '4.00 MiB');
  assert.equal(elements.get('cacheState').textContent, '正常');

  elements.get('enabled').checked = false;
  elements.get('redirectMode').value = 'direct';
  elements.get('preloadMode').value = 'short-circuit';
  elements.get('detectHead').checked = false;
  elements.get('redirectCacheTtlMs').value = '8';
  elements.get('coldCacheEnabled').checked = true;
  elements.get('maxTotalBytes').value = '2.5';
  elements.get('maxFileBytes').value = '10';
  elements.get('maxVideoBytes').value = '12';
  elements.get('maxAgeMs').value = '3';
  elements.get('loudnessEnabled').checked = false;
  elements.get('loudnessAudioOnly').checked = true;
  elements.get('loudnessMethod').value = 'loudnorm';
  await elements.get('save').onclick();
  const saveCall = calls.find(call => call.options && call.options.method === 'PUT');
  assert.ok(saveCall);
  assert.equal(saveCall.url, '/api/admin/strm');
  assert.equal(saveCall.options.headers.Authorization, 'Bearer fixture-jwt');
  assert.equal(saveCall.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(saveCall.options.body), { enabled: false, redirectMode: 'direct', preloadGuard: { mode: 'short-circuit', detectHead: false }, redirectResolve: { cacheTtlMs: 8000 }, coldCache: { enabled: true, maxTotalBytes: 2.5 * 1024 * 1024 * 1024, maxFileBytes: 10 * 1024 * 1024, maxVideoBytes: 12 * 1024 * 1024, maxAgeMs: 3 * 24 * 60 * 60 * 1000 }, loudness: { enabled: false, audioOnly: true, method: 'loudnorm' } });
  await elements.get('cleanup').onclick();
  const cleanupCall = calls.find(call => call.options && call.options.method === 'POST');
  assert.ok(cleanupCall);
  assert.equal(cleanupCall.url, '/api/admin/strm/cleanup');
});

test('STRM media recovery waits through pauses and reloads one stalled long-pause stream', () => {
  let clock = 0;
  let nextTimer = 1;
  const timers = new Map();
  const schedule = (fn, delay) => {
    const id = nextTimer++;
    timers.set(id, { at: clock + Number(delay || 0), fn });
    return id;
  };
  const cancel = id => timers.delete(id);
  const advance = milliseconds => {
    clock += milliseconds;
    let due;
    do {
      due = Array.from(timers.entries()).filter(([, timer]) => timer.at <= clock);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.fn();
      }
    } while (due.length);
  };
  const listeners = new WeakMap();
  class FakeMedia {
    constructor({ src = '', source = null } = {}) {
      this.tagName = 'AUDIO';
      this.attrs = { src, crossorigin: 'anonymous' };
      this.source = source;
      this.currentSrc = src;
      this.src = src;
      this.currentTime = 0;
      this.duration = 240;
      this.readyState = 4;
      this.networkState = 1;
      this.paused = true;
      this.loadCalls = 0;
      this.playCalls = 0;
      listeners.set(this, {});
    }
    getAttribute(name) { return this.attrs[name] || null; }
    removeAttribute(name) { delete this.attrs[name]; }
    querySelector(selector) { return selector === 'source' ? this.source : null; }
    addEventListener(type, handler) { const map = listeners.get(this); (map[type] ||= []).push(handler); }
    removeEventListener(type, handler) { const map = listeners.get(this); map[type] = (map[type] || []).filter(item => item !== handler); }
    dispatch(type) { if (type === 'pause') this.paused = true; if (type === 'play') this.paused = false; for (const handler of (listeners.get(this)[type] || []).slice()) handler({ type, target: this }); }
    load() { this.loadCalls += 1; }
    play() { this.playCalls += 1; this.paused = false; this.dispatch('play'); return Promise.resolve(); }
  }
  const strmUrl = 'http://127.0.0.1:12346/api/media/stream/1676198/12';
  const source = { getAttribute(name) { return name === 'src' ? strmUrl : null; } };
  const directMedia = new FakeMedia({ src: strmUrl });
  const childSourceMedia = new FakeMedia({ source });
  childSourceMedia.currentSrc = '';
  childSourceMedia.src = '';
  const localMedia = new FakeMedia({ src: 'http://127.0.0.1:12346/api/media/file/1676198/12' });
  const media = [directMedia, childSourceMedia, localMedia];
  const document = {
    readyState: 'loading',
    documentElement: {},
    body: null,
    querySelectorAll(selector) { return selector === 'audio,video' ? media : []; },
    querySelector() { return null; },
    addEventListener() {},
  };
  class TestDate extends Date { static now() { return clock; } }
  const context = vm.createContext({
    window: { location: { href: 'http://127.0.0.1:12346/work/1676198', origin: 'http://127.0.0.1:12346' } },
    document,
    URL,
    Date: TestDate,
    setTimeout: schedule,
    clearTimeout: cancel,
    MutationObserver: class { observe() {} },
    HTMLMediaElement: FakeMedia,
    localStorage: { getItem() { return ''; } },
  });
  new vm.Script(MENU_SCRIPT).runInContext(context);
  new vm.Script(MENU_SCRIPT).runInContext(context);

  assert.ok(directMedia.__kikoeruStrmRecovery, 'direct STRM source installs recovery state');
  assert.ok(childSourceMedia.__kikoeruStrmRecovery, 'source-child STRM source installs recovery state');
  assert.equal(localMedia.__kikoeruStrmRecovery, undefined, 'non-STRM media is untouched');

  directMedia.currentTime = 4;
  directMedia.dispatch('pause');
  advance(10000);
  directMedia.dispatch('play');
  advance(3000);
  assert.equal(directMedia.loadCalls, 0, 'short pause never reloads');

  directMedia.currentTime = 10;
  directMedia.dispatch('pause');
  advance(30000);
  directMedia.dispatch('play');
  directMedia.currentTime = 10.6;
  advance(2500);
  assert.equal(directMedia.loadCalls, 0, 'long pause with healthy progress never reloads');

  directMedia.currentTime = 25;
  directMedia.readyState = 2;
  directMedia.networkState = 2;
  directMedia.dispatch('pause');
  advance(30000);
  directMedia.dispatch('play');
  directMedia.dispatch('waiting');
  advance(2500);
  assert.equal(directMedia.loadCalls, 1, 'stalled long pause reloads once');
  assert.equal(directMedia.__kikoeruStrmRecovery.recoveryAttempts, 1);
  directMedia.currentTime = 0;
  directMedia.dispatch('loadedmetadata');
  assert.equal(directMedia.currentTime, 25, 'recovery restores the paused position');
  assert.equal(directMedia.playCalls, 1, 'recovery restores the playing intent');
  directMedia.dispatch('stalled');
  directMedia.dispatch('error');
  advance(3000);
  directMedia.dispatch('play');
  advance(3000);
  assert.equal(directMedia.loadCalls, 1, 'duplicate stall/error events do not loop reloads');

  childSourceMedia.currentTime = 7;
  childSourceMedia.readyState = 2;
  childSourceMedia.networkState = 2;
  childSourceMedia.dispatch('pause');
  advance(30000);
  childSourceMedia.dispatch('play');
  childSourceMedia.dispatch('waiting');
  advance(2500);
  assert.equal(childSourceMedia.loadCalls, 1, 'source-child media uses the same recovery path');
  childSourceMedia.dispatch('canplay');
  assert.equal(childSourceMedia.currentTime, 7);
});

test('single-flight merges concurrent callers', async () => {
  const flight = new SingleFlight();
  let calls = 0;
  const task = () => flight.run('same', async () => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 10));
    return 'done';
  });
  const values = await Promise.all([task(), task(), task()]);
  assert.deepEqual(values, ['done', 'done', 'done']);
  assert.equal(calls, 1);
  assert.equal(flight.size(), 0);
});

test('duration queue is one worker and honors interval', async () => {
  const starts = [];
  const queue = new DurationProbeQueue({ intervalMs: 8, maxQueue: 4 });
  const values = await Promise.all([
    queue.enqueue(1, async value => { starts.push(Date.now()); return value; }),
    queue.enqueue(2, async value => { starts.push(Date.now()); return value; }),
    queue.enqueue(3, async value => { starts.push(Date.now()); return value; }),
  ]);
  assert.deepEqual(values, [1, 2, 3]);
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] >= 6, `${starts[1] - starts[0]}ms gap`);
  assert.ok(starts[2] - starts[1] >= 6, `${starts[2] - starts[1]}ms gap`);
  queue.close();
});

test('scanner probes URL, never pointer text, and memoizes unchanged state', async () => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kikoeru-strm-scan-'));
  const state = new StrmStateStore(path.join(temp, 'state.json'));
  const queue = new DurationProbeQueue({ intervalMs: 0, maxQueue: 4 });
  const pointerPath = path.join(temp, 'voice.flac.strm');
  await fs.promises.writeFile(pointerPath, 'https://mp.123063.xyz:13258/redirect?id=fixture\n');
  await fs.promises.writeFile(path.join(temp, 'voice.srt'), 'local subtitle');
  let probeCalls = 0;
  const probe = async url => {
    probeCalls += 1;
    assert.match(url, /^https:\/\/mp\.123063\.xyz:13258\//);
    return 12.5;
  };
  const first = await scanStrmMemo(temp, {
    store: state, queue, rootFolder: 'fixture', workRelativePath: 'RJ0001',
    pointerOptions: { allowedHosts: ['mp.123063.xyz:13258'] }, probe, probeEnabled: true,
  });
  assert.equal(probeCalls, 1);
  assert.equal(first.duration['voice.flac.strm'], 12.5);
  assert.equal(first.strm['voice.flac.strm'].sourceExt, '.strm');
  const second = await scanStrmMemo(temp, {
    store: state, queue, oldMemo: first, rootFolder: 'fixture', workRelativePath: 'RJ0001',
    pointerOptions: { allowedHosts: ['mp.123063.xyz:13258'] }, probe, probeEnabled: true,
  });
  assert.equal(probeCalls, 1);
  assert.equal(second.duration['voice.flac.strm'], 12.5);
  queue.close();
  await fs.promises.rm(temp, { recursive: true, force: true });
});

test('remote duration probe uses a browser-like user agent for CDN compatibility', async () => {
  let args;
  const duration = await probeRemoteDuration('https://cdn.example/media.wav', {
    timeoutMs: 1234,
    execFileImpl: async (_command, receivedArgs) => {
      args = receivedArgs;
      return { stdout: '407.874688\n', stderr: '' };
    },
  });
  assert.equal(duration, 407.874688);
  assert.equal(args[args.indexOf('-user_agent') + 1], 'Mozilla/5.0');
});

test('cold cache performs one complete download and atomically reuses it', async () => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kikoeru-strm-cache-'));
  let downloads = 0;
  const server = http.createServer((req, res) => {
    downloads += 1;
    res.writeHead(200, { 'Content-Type': 'audio/flac', 'Content-Length': '10' });
    res.end('0123456789');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const state = new StrmStateStore(path.join(temp, 'state.json'));
  const manager = new StrmCacheManager({
    store: state,
    config: { rootDir: path.join(temp, 'cache'), maxFileBytes: 100, maxTotalBytes: 1000, cleanupIntervalMs: 0 },
    runLoudnorm: async filePath => ({ input: path.basename(filePath), integrated: -16 }),
  });
  const key = makeRecordKey('fixture', 'RJ0001/voice.flac.strm');
  const pointerInfo = {
    key, rootFolder: 'fixture', relativePath: 'RJ0001/voice.flac.strm',
    pointerFingerprint: crypto.createHash('sha256').update('pointer').digest('hex'),
    pointerMtimeMs: Date.now(), mediaExt: '.flac', isVideo: false,
  };
  const url = `http://127.0.0.1:${server.address().port}/media`;
  try {
    const [first, second] = await Promise.all([
      manager.ensureLocal(pointerInfo, url, { finalAllowedHosts: ['127.0.0.1'] }),
      manager.ensureLocal(pointerInfo, url, { finalAllowedHosts: ['127.0.0.1'] }),
    ]);
    assert.equal(downloads, 1);
    assert.equal(first.path, second.path);
    assert.equal(await fs.promises.readFile(first.path, 'utf8'), '0123456789');
    assert.equal((await state.get(key)).downloadReady, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await manager.status()).activeDownloads, 0);
  } finally {
    manager.close();
    await new Promise(resolve => server.close(resolve));
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

test('cache cleanup removes orphan .part files but preserves an active download', async () => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kikoeru-strm-parts-'));
  const cacheRoot = path.join(temp, 'cache');
  await fs.promises.mkdir(cacheRoot, { recursive: true });
  const orphan = path.join(cacheRoot, 'orphan.mp3.part');
  const active = path.join(cacheRoot, 'active.mp3.part');
  await fs.promises.writeFile(orphan, 'orphan');
  await fs.promises.writeFile(active, 'active');
  const state = new StrmStateStore(path.join(temp, 'state.json'));
  const manager = new StrmCacheManager({ store: state, config: { rootDir: cacheRoot, cleanupIntervalMs: 0 } });
  manager.activeParts.add(active);
  try {
    const result = await manager.cleanup();
    assert.equal(result.removedParts, 1);
    assert.equal(await fs.promises.access(orphan).then(() => true).catch(() => false), false);
    assert.equal(await fs.promises.access(active).then(() => true).catch(() => false), true);
  } finally {
    manager.close();
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

test('disabling loudness switches an uncached media object directly to hot path', async () => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kikoeru-strm-policy-'));
  const state = new StrmStateStore(path.join(temp, 'state.json'));
  const manager = new StrmCacheManager({
    store: state,
    config: { rootDir: path.join(temp, 'cache'), cleanupIntervalMs: 0, loudnessEnabled: false },
  });
  const pointerInfo = {
    key: makeRecordKey('fixture', 'RJ0001/voice.mp3.strm'),
    rootFolder: 'fixture', relativePath: 'RJ0001/voice.mp3.strm',
    pointerFingerprint: 'policy-pointer', pointerMtimeMs: Date.now(), mediaExt: '.mp3', isVideo: false,
  };
  try {
    assert.equal(await manager.shouldUseHot(pointerInfo, { coldCacheEnabled: true }), true);
  } finally {
    manager.close();
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

test('loudnorm output is parsed from info logs and failure state is persisted for retry', async () => {
  let receivedArgs;
  const parsed = await defaultRunLoudnorm('/fixture.wav', {
    execFileImpl: async (_command, args) => {
      receivedArgs = args;
      return { stderr: 'ffmpeg info\n{\n  "input_i": "-20.0",\n  "output_i": "-16.0"\n}\n' };
    },
  });
  assert.equal(receivedArgs[receivedArgs.indexOf('-v') + 1], 'info');
  assert.equal(parsed.output_i, '-16.0');
  assert.equal(parseLoudnormResult('prefix {"input_i":"-18"} suffix').input_i, '-18');

  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kikoeru-strm-loudnorm-'));
  const cachePath = path.join(temp, 'cached.flac');
  await fs.promises.writeFile(cachePath, 'complete local media');
  const state = new StrmStateStore(path.join(temp, 'state.json'));
  const key = makeRecordKey('fixture', 'RJ0001/cached.flac.strm');
  const pointerInfo = {
    key, rootFolder: 'fixture', relativePath: 'RJ0001/cached.flac.strm',
    pointerFingerprint: 'pointer-fingerprint', pointerMtimeMs: Date.now(),
    mediaExt: '.flac', isVideo: false,
  };
  await state.upsert(key, {
    key, rootFolder: pointerInfo.rootFolder, relativePath: pointerInfo.relativePath,
    pointerFingerprint: pointerInfo.pointerFingerprint, downloadReady: true,
    cachePath, cacheBytes: 20, loudnessReady: false, loudnessStatus: 'pending',
  });
  let shouldFail = true;
  const manager = new StrmCacheManager({
    store: state,
    config: { rootDir: temp, cleanupIntervalMs: 0 },
    runLoudnorm: async () => {
      if (shouldFail) throw Object.assign(new Error('fixture loudnorm failure'), { code: 'FIXTURE_LOUDNORM_FAILED' });
      return { input_i: '-20.0', output_i: '-16.0' };
    },
  });
  try {
    await assert.rejects(manager.analyze(pointerInfo), error => error.code === 'FIXTURE_LOUDNORM_FAILED');
    let record = await state.get(key);
    assert.equal(record.downloadReady, true);
    assert.equal(record.loudnessReady, false);
    assert.equal(record.loudnessStatus, 'error');
    assert.equal(record.loudnessError, 'FIXTURE_LOUDNORM_FAILED');
    assert.equal(Object.hasOwn(record, 'peakLevels'), false);
    shouldFail = false;
    await manager.analyze(pointerInfo);
    record = await state.get(key);
    assert.equal(record.loudnessReady, true);
    assert.equal(record.loudnessStatus, 'ready');
    assert.equal(record.loudnessError, null);
    assert.deepEqual(record.loudnorm, { input_i: '-20.0', output_i: '-16.0' });
  } finally {
    manager.close();
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

test('defaultRunLoudnorm parses a local small audio fixture when ffmpeg is available', async t => {
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) {
    t.skip('ffmpeg is unavailable in the host test environment');
    return;
  }
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kikoeru-strm-wav-'));
  const sampleRate = 8000;
  const samples = Math.floor(sampleRate / 4);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) wav.writeInt16LE(Math.round(Math.sin(i / 8) * 12000), 44 + i * 2);
  const wavPath = path.join(temp, 'fixture.wav');
  await fs.promises.writeFile(wavPath, wav);
  try {
    const result = await defaultRunLoudnorm(wavPath, { timeoutMs: 30000 });
    assert.equal(typeof result.input_i, 'string');
    assert.equal(typeof result.output_i, 'string');
    assert.equal(Object.hasOwn(result, 'peakLevels'), false);
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

test('over-limit download aborts the response instead of draining the CDN', async () => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kikoeru-strm-limit-'));
  const partPath = path.join(temp, 'media.flac.part');
  const totalBytes = 1024 * 1024;
  let sentBytes = 0;
  let connectionClosed = false;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/flac', 'Content-Length': String(totalBytes) });
    const chunk = Buffer.alloc(16 * 1024, 0x61);
    const timer = setInterval(() => {
      if (res.destroyed) return;
      sentBytes += chunk.length;
      res.write(chunk);
      if (sentBytes >= totalBytes) {
        clearInterval(timer);
        res.end();
      }
    }, 5);
    req.on('close', () => {
      connectionClosed = true;
      clearInterval(timer);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { downloadToFile } = require(path.join(adapterDir, 'http'));
    await assert.rejects(downloadToFile(`http://127.0.0.1:${server.address().port}/large`, partPath, {
      maxBytes: 100, finalAllowedHosts: ['127.0.0.1'], timeoutMs: 2000,
    }), error => error.code === 'DOWNLOAD_TOO_LARGE');
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(connectionClosed, true);
    assert.ok(sentBytes < totalBytes, `sent ${sentBytes} of ${totalBytes} bytes`);
    assert.equal(fs.existsSync(partPath), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});
