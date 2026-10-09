'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { StrmCacheManager } = require('../patches/0.6.17/strm-adapter/cache-manager');
const { StrmStateStore } = require('../patches/0.6.17/strm-adapter/state-store');

const payload = Buffer.from('complete-fixture-media');

function target(fingerprint = 'a'.repeat(64)) {
  return {
    key: 'fixture-record-key',
    rootFolderName: 'fixture-root',
    relativePath: 'work/voice.flac.strm',
    pointerMtimeMs: 123,
    pointerFingerprint: fingerprint,
    mediaExt: '.flac',
    isVideo: false,
    workId: 9,
    seq: 2,
    row: { id: 22, lufs: null },
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, handler, config = {}) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kikoeru-native-cache-'));
  const server = http.createServer(handler);
  const baseUrl = await listen(server);
  const statePath = path.join(root, 'strm-state.json');
  const store = new StrmStateStore(statePath);
  const cache = new StrmCacheManager({
    store,
    config: {
      rootDir: path.join(root, 'cache'),
      cleanupIntervalMs: 0,
      maxFileBytes: 1024 * 1024,
      downloadTimeoutMs: 3000,
      ...config,
    },
    logger: { warn() {}, error() {} },
  });
  t.after(async () => {
    cache.close();
    await new Promise(resolve => server.close(resolve));
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  return { root, baseUrl, server, statePath, store, cache };
}

function downloadOptions(baseUrl) {
  return { finalAllowedHosts: [new URL(baseUrl).host], allowedSchemes: ['http', 'https'] };
}

test('state CAS accepts a probe-only identity and rejects an older cache generation', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kikoeru-native-cas-'));
  const store = new StrmStateStore(path.join(root, 'strm-state.json'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  await store.upsert('fixture-record-key', { probeFingerprint: 'a'.repeat(64), probeStatus: 'ok' });

  const initialized = await store.compareAndUpsert('fixture-record-key', 'a'.repeat(64), {
    pointerFingerprint: 'a'.repeat(64), downloadReady: false,
  });
  assert.equal(initialized.updated, true);
  const advanced = await store.compareAndUpsert('fixture-record-key', 'a'.repeat(64), {
    pointerFingerprint: 'b'.repeat(64), downloadReady: true, cachePath: '/cache/new.flac',
  });
  assert.equal(advanced.updated, true);
  const stale = await store.compareAndUpsert('fixture-record-key', 'a'.repeat(64), {
    pointerFingerprint: null, downloadReady: false, cachePath: null,
  });
  assert.equal(stale.updated, false);
  assert.equal((await store.get('fixture-record-key')).pointerFingerprint, 'b'.repeat(64));
});

test('0.6.17 cache manager merges duplicate downloads and publishes only the completed file', async t => {
  let requests = 0;
  const fx = await fixture(t, (_req, res) => {
    requests++;
    res.writeHead(200, { 'Content-Length': payload.length, 'Content-Type': 'audio/flac' });
    res.write(payload.subarray(0, 5));
    setTimeout(() => res.end(payload.subarray(5)), 20);
  });
  const track = target();
  const options = downloadOptions(fx.baseUrl);

  const first = fx.cache.ensureLocal(track, `${fx.baseUrl}/audio`, options);
  const second = fx.cache.ensureLocal(track, `${fx.baseUrl}/audio`, options);
  const [a, b] = await Promise.all([first, second]);

  assert.equal(requests, 1);
  assert.equal(a.path, b.path);
  assert.deepEqual(await fs.promises.readFile(a.path), payload);
  const record = await fx.store.get(track.key);
  assert.equal(record.downloadReady, true);
  assert.equal(record.pointerFingerprint, track.pointerFingerprint);
  assert.equal(record.cachePath, a.path);
  assert.equal((await fs.promises.readdir(path.dirname(a.path))).some(name => name.endsWith('.part')), false);
});

test('truncated Content-Length download rejects and removes its .part file', async t => {
  const fx = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Length': '100', 'Content-Type': 'audio/flac' });
    res.write('short');
    setTimeout(() => res.socket && res.socket.destroy(), 20);
  });
  const track = target();

  await assert.rejects(
    fx.cache.ensureLocal(track, `${fx.baseUrl}/truncated`, downloadOptions(fx.baseUrl)),
  );

  const record = await fx.store.get(track.key);
  assert.equal(record.downloadReady, false);
  assert.equal(record.cachePath, null);
  const files = await fs.promises.readdir(fx.cache.limits.rootDir);
  assert.equal(files.some(name => name.endsWith('.part')), false);
  assert.equal(files.some(name => /\.flac$/.test(name)), false);
});

test('over-limit download is remembered as a policy skip until limits change', async t => {
  let requests = 0;
  const fx = await fixture(t, (_req, res) => {
    requests++;
    res.writeHead(200, { 'Content-Length': payload.length, 'Content-Type': 'audio/flac' });
    res.end(payload);
  }, { maxFileBytes: 4 });
  const track = target();
  const options = downloadOptions(fx.baseUrl);

  await assert.rejects(fx.cache.ensureLocal(track, `${fx.baseUrl}/too-large`, options), error => error.code === 'DOWNLOAD_TOO_LARGE');
  await fx.cache.markAnalysisSkipped(track, 'DOWNLOAD_TOO_LARGE');
  await assert.rejects(fx.cache.ensureLocal(track, `${fx.baseUrl}/too-large`, options), error => error.code === 'DOWNLOAD_TOO_LARGE');
  assert.deepEqual(await fx.cache.getAnalysisSkip(track), { skipped: true, reason: 'DOWNLOAD_TOO_LARGE' });
  assert.equal(requests, 1);
  assert.equal((await fs.promises.readdir(fx.cache.limits.rootDir)).some(name => name.endsWith('.part')), false);

  fx.cache.configure({ maxFileBytes: 1024 });
  assert.equal(await fx.cache.getAnalysisSkip(track), null);
});

test('same-manager generation change after validation removes the old part before publish', async t => {
  let validationCount = 0;
  let resumeValidation;
  const enteredValidation = new Promise(resolve => { resumeValidation = resolve; });
  let releaseValidation;
  const validationGate = new Promise(resolve => { releaseValidation = resolve; });
  const fx = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Length': payload.length, 'Content-Type': 'audio/flac' });
    res.end(payload);
  });
  fx.cache.isTargetCurrent = async () => {
    validationCount++;
    if (validationCount === 4) {
      resumeValidation();
      await validationGate;
    }
    return true;
  };
  const track = target();
  const staleDownload = fx.cache.ensureLocal(track, `${fx.baseUrl}/audio`, downloadOptions(fx.baseUrl));
  await enteredValidation;
  assert.equal(await fx.cache.invalidateTarget(track), true);
  releaseValidation();
  await assert.rejects(staleDownload, error => error.code === 'STRM_TARGET_CHANGED');

  const files = await fs.promises.readdir(fx.cache.limits.rootDir);
  assert.equal(files.some(name => name.endsWith('.part')), false);
  assert.equal(files.some(name => /\.flac$/.test(name)), false);
  const record = await fx.store.get(track.key);
  assert.equal(record.pointerFingerprint, null);
  assert.equal(record.downloadReady, false);
});

test('a second cache manager cannot let a stale final validation overwrite a new fingerprint', async t => {
  let oldValidationEntered;
  const oldValidation = new Promise(resolve => { oldValidationEntered = resolve; });
  let releaseOldValidation;
  const staleValidationGate = new Promise(resolve => { releaseOldValidation = resolve; });
  const fx = await fixture(t, (req, res) => {
    const body = req.url === '/old' ? Buffer.from('old-pointer-media') : Buffer.from('new-pointer-media');
    res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'audio/flac' });
    res.end(body);
  });
  let oldValidations = 0;
  fx.cache.isTargetCurrent = async current => {
    oldValidations++;
    if (current.pointerFingerprint === 'a'.repeat(64) && oldValidations === 3) {
      oldValidationEntered();
      // Pause the final pre-rename validation after the old record and
      // complete .part file exist; another process can now replace the cache
      // state with the new fingerprint before this validation returns.
      await staleValidationGate;
    }
    return true;
  };
  const oldTarget = target('a'.repeat(64));
  const newTarget = target('b'.repeat(64));
  const secondStore = new StrmStateStore(fx.statePath);
  const secondManager = new StrmCacheManager({
    store: secondStore,
    config: { rootDir: fx.cache.limits.rootDir, cleanupIntervalMs: 0, maxFileBytes: 1024 * 1024 },
    logger: { warn() {}, error() {} },
  });
  t.after(() => secondManager.close());
  const options = downloadOptions(fx.baseUrl);
  const oldDownload = fx.cache.ensureLocal(oldTarget, `${fx.baseUrl}/old`, options);
  await oldValidation;

  assert.equal(await secondManager.invalidateTarget(oldTarget), true);
  const newDownload = await secondManager.ensureLocal(newTarget, `${fx.baseUrl}/new`, options);
  releaseOldValidation();
  await assert.rejects(oldDownload, error => error.code === 'STRM_TARGET_CHANGED');

  const record = await fx.store.get(newTarget.key);
  assert.equal(record.pointerFingerprint, newTarget.pointerFingerprint);
  assert.equal(record.downloadReady, true);
  assert.equal(record.cachePath, newDownload.path);
  assert.deepEqual(await fs.promises.readFile(record.cachePath), Buffer.from('new-pointer-media'));
});
