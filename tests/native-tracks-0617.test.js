'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const test = require('node:test');
const { makeRecordKey } = require('../patches/0.6.17/strm-adapter/state-store');
const { createTrackBridge, STRM_EXT } = require('../patches/0.6.17/strm-adapter/native-tracks');
const {
  ensurePointerFingerprintColumn,
  migrateLegacyMemo,
  migrateLegacyState,
  resolveLegacyStatePath,
} = require('../patches/0.6.17/strm-adapter/migration');

const APP_ROOT = process.env.KIKOERU_TEST_APP_ROOT || '/usr/src/kikoeru';
let appRequire;
let knexFactory;
let LocalProvider;
try {
  appRequire = createRequire(path.join(APP_ROOT, 'package.json'));
  knexFactory = appRequire('knex');
  LocalProvider = require(path.join(APP_ROOT, 'dist/src/filesystem/backend/localProvider.js')).LocalProvider;
  appRequire('better-sqlite3');
} catch { }

function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'kikoeru-native-tracks-0617-'));
}

function createKnex(filePath) {
  return knexFactory({
    client: 'better-sqlite3',
    connection: { filename: filePath },
    useNullAsDefault: true,
  });
}

async function createLegacyDatabase(filePath, workRows = []) {
  const knex = createKnex(filePath);
  await knex.schema.createTable('t_work', table => {
    table.bigIncrements('id');
    table.string('root_folder').notNullable();
    table.string('dir').notNullable();
    table.string('title').notNullable();
    table.integer('track_max_seq').notNullable().defaultTo(-1);
    table.text('memo');
  });
  await knex.schema.createTable('t_track', table => {
    table.bigIncrements('id');
    table.bigInteger('work_id').notNullable();
    table.integer('seq').notNullable();
    table.string('rel_path').notNullable();
    table.string('ext').notNullable();
    table.string('file_type').notNullable().defaultTo('unknown');
    table.bigInteger('size').notNullable().defaultTo(0);
    table.bigInteger('mtime').notNullable().defaultTo(0);
    table.float('duration');
    table.bigInteger('duration_probe_mtime');
    table.integer('sample_rate');
    table.integer('channels');
    table.integer('bit_rate');
    table.float('lufs');
    table.bigInteger('lufs_updated_at');
    table.string('waveform_path');
    table.string('waveform_format');
    table.float('waveform_resolution');
    table.bigInteger('waveform_updated_at');
    table.text('transcode');
    table.unique(['work_id', 'seq']);
    table.unique(['work_id', 'rel_path']);
  });
  for (const work of workRows) await knex('t_work').insert(work);
  return knex;
}

function makeTrackStore(knex) {
  return {
    async getTrackRows(workId) {
      return knex('t_track').where('work_id', '=', workId).orderBy('seq', 'asc');
    },
    async getTrackRow(workId, seq) {
      return (await knex('t_track').where({ work_id: workId, seq }).first()) || null;
    },
    async allocateAndInsert(workId, rows) {
      if (!rows.length) return;
      await knex.transaction(async trx => {
        const work = await trx('t_work').select('track_max_seq').where('id', '=', workId).first();
        let next = Number(work.track_max_seq ?? -1);
        for (const row of rows) {
          next += 1;
          await trx('t_track').insert({ work_id: workId, seq: next, ...row });
        }
        await trx('t_work').where('id', '=', workId).update({ track_max_seq: next });
      });
    },
    async updateTrackFileMeta(id, meta, contentChanged) {
      const patch = {
        ext: meta.ext,
        file_type: meta.file_type,
        size: meta.size,
        mtime: meta.mtime,
      };
      if (contentChanged) {
        Object.assign(patch, {
          duration: null,
          duration_probe_mtime: null,
          sample_rate: null,
          channels: null,
          bit_rate: null,
          lufs: null,
          lufs_updated_at: null,
          waveform_path: null,
          waveform_format: null,
          waveform_resolution: null,
          waveform_updated_at: null,
          transcode: null,
        });
      }
      await knex('t_track').where('id', '=', id).update(patch);
    },
    async deleteTrackRows(ids) {
      if (ids.length) await knex('t_track').whereIn('id', ids).delete();
    },
  };
}

function makeUtils(trackStore) {
  const supportedMediaExtList = ['.mp3', '.ogg', '.opus', '.wav', '.aac', '.flac', '.webm', '.mp4', '.m4a', '.mka', '.aiff', '.avi'];
  const nativeWorkScanNeeded = new Set();
  let consumeCalls = 0;
  return {
    supportedMediaExtList,
    nativeWorkScanNeeded,
    get consumeCalls() { return consumeCalls; },
    async syncWorkTracks() { throw new Error('local STRM sync must use native bridge'); },
    async scanWorkDurations(loc, rows, concurrency, onProgress) {
      onProgress?.({ total: 0, done: 0, succeeded: 0, failed: 0, currentFile: null });
      return { scanned: 0, succeeded: 0, failed: 0 };
    },
    async getTrackList(workId) {
      const rows = await trackStore.getTrackRows(workId);
      return rows.map(row => ({
        title: path.posix.basename(row.rel_path),
        subtitle: path.posix.dirname(row.rel_path) === '.' ? null : path.posix.dirname(row.rel_path),
        hash: `${workId}/${row.seq}`,
        seq: Number(row.seq),
        relPath: row.rel_path,
        ext: row.ext,
        duration: supportedMediaExtList.includes(row.ext) && row.duration != null ? Number(row.duration) : undefined,
      }));
    },
    toTree(tracks) {
      return tracks.map(track => ({ type: 'audio', title: track.title, hash: track.hash, duration: track.duration }));
    },
    tracksMissingDuration(tracks) {
      return tracks.some(track => supportedMediaExtList.includes(track.ext) && track.duration === undefined);
    },
    rowsMissingDuration(rows) {
      return rows.some(row => supportedMediaExtList.includes(row.ext) && row.duration == null);
    },
    consumeWorkScanNeeded(workId) {
      consumeCalls += 1;
      return nativeWorkScanNeeded.delete(Number(workId));
    },
    async migrateDurationsFromMemo() { return 0; },
  };
}

async function makeFixture(options = {}) {
  const root = await tempRoot();
  const libraryPath = path.join(root, 'library');
  const workPath = path.join(libraryPath, 'work');
  const emptyWorkPath = path.join(libraryPath, 'emptywork');
  await fs.mkdir(workPath, { recursive: true });
  await fs.mkdir(emptyWorkPath, { recursive: true });
  await fs.writeFile(path.join(workPath, 'existing.mp3'), 'audio');
  if (options.strmText) await fs.writeFile(path.join(workPath, 'Virtual.mp3.strm'), options.strmText);
  if (options.emptyWorkStrmText) await fs.writeFile(path.join(emptyWorkPath, 'Only.mp3.strm'), options.emptyWorkStrmText);
  const fixedSeconds = 1700000000;
  if (options.strmText) await fs.utimes(path.join(workPath, 'Virtual.mp3.strm'), fixedSeconds, fixedSeconds);

  const sourceDb = path.join(root, 'source.sqlite');
  let setupKnex = await createLegacyDatabase(sourceDb, [
    { id: 101, root_folder: 'library', dir: 'work', title: 'Work', track_max_seq: 7, memo: null },
    { id: 102, root_folder: 'library', dir: 'emptywork', title: 'Empty Work', track_max_seq: -1, memo: null },
  ]);
  const existingStat = await fs.stat(path.join(workPath, 'existing.mp3'));
  await setupKnex('t_track').insert({
    work_id: 101,
    seq: 7,
    rel_path: 'existing.mp3',
    ext: '.mp3',
    file_type: 'audio',
    size: existingStat.size,
    mtime: Math.round(existingStat.mtimeMs),
    duration: 42,
    duration_probe_mtime: Math.round(existingStat.mtimeMs),
  });
  await setupKnex.destroy();

  const dbPath = path.join(root, 'cloned.sqlite');
  await fs.copyFile(sourceDb, dbPath);
  const knex = createKnex(dbPath);
  const trackStore = makeTrackStore(knex);
  const provider = new LocalProvider('library', libraryPath);
  await provider.init();
  const config = {
    rootFolders: [{ name: 'library', type: 'local', path: libraryPath }],
    audioCacheFolderDir: path.join(root, 'audio-cache'),
    excludeFolderGlobs: [],
  };
  const workLocations = new Map();
  const registry = {
    resolveWork(work) {
      let loc = workLocations.get(Number(work.id));
      if (!loc) {
        loc = { provider, rootFolderName: work.root_folder, workRelPath: work.dir, writable: true };
        workLocations.set(Number(work.id), loc);
      }
      return loc;
    },
  };
  const invalidateCalls = [];
  const probeCalls = [];
  const cacheDeleteCalls = [];
  const warningMessages = [];
  const stateRecords = new Map();
  const runtime = {
    config,
    options: {
      statePath: path.join(root, 'strm-state-v2.json'),
      durationProbe: { enabled: true, timeoutMs: 12345, retryDelayMs: 60000, intervalMs: 0, maxQueue: 16 },
    },
    store: {
      async get(key) { return stateRecords.get(String(key)) || null; },
      async upsert(key, patch) {
        const record = { ...(stateRecords.get(String(key)) || { key: String(key) }), ...patch };
        stateRecords.set(String(key), record);
        return record;
      },
    },
    ready: Promise.resolve(),
    pointerOptions: () => ({ maxPointerBytes: 4096, allowedSchemes: ['https:'], allowedHosts: ['.example'] }),
    resolveStrmRedirect: async (_runtime, target) => ({ final: new URL('https://cdn.example/resolved-media.mp3'), userAgent: 'StableHelper/1.0' }),
    nativeTasks: { invalidate: target => { invalidateCalls.push({ kind: 'task', key: target.key, fingerprint: target.pointerFingerprint }); } },
    cache: { invalidateTarget: target => { invalidateCalls.push({ kind: 'cache', key: target.key, fingerprint: target.pointerFingerprint }); } },
  };
  const { DurationProbeQueue } = require('../patches/0.6.17/strm-adapter/duration-queue');
  runtime.queue = new DurationProbeQueue({ intervalMs: 0, maxQueue: 16 });
  const injected = {
    knex,
    trackStore,
    registry,
    config,
    audioCache: {
      deleteTrackCacheFiles(_root, workId, seq) { cacheDeleteCalls.push({ workId, seq }); },
    },
    probeRemoteDuration: async (url, probeOptions) => {
      probeCalls.push({ url, ...probeOptions });
      return 123.5;
    },
    logger: { warn(message) { warningMessages.push(String(message)); }, info() {} },
  };
  const bridge = createTrackBridge(APP_ROOT, runtime, injected);
  const utils = makeUtils(trackStore);
  bridge.installUtils(utils);
  const loc = registry.resolveWork({ id: 101, root_folder: 'library', dir: 'work' });
  return {
    root,
    libraryPath,
    workPath,
    emptyWorkPath,
    dbPath,
    sourceDb,
    knex,
    trackStore,
    provider,
    config,
    registry,
    runtime,
    bridge,
    utils,
    loc,
    fixedSeconds,
    invalidateCalls,
    probeCalls,
    cacheDeleteCalls,
    warningMessages,
    stateRecords,
    async close() {
      await knex.destroy();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test('native 0.6.17 SQLite upgrade preserves seq, seeds STRM before empty track-list reads, and invalidates same-size/same-mtime pointer changes', {
  skip: !knexFactory || !LocalProvider ? 'run with the 0.6.17 image dependencies' : false,
}, async t => {
  const fixture = await makeFixture({ strmText: 'https://one.example/a.mp3\n', emptyWorkStrmText: 'https://one.example/empty.mp3\n' });
  t.after(() => fixture.close());

  const sourceKnex = createKnex(fixture.sourceDb);
  const sourceHasPointerColumn = await sourceKnex.schema.hasColumn('t_track', 'pointer_fingerprint');
  await sourceKnex.destroy();
  assert.equal(sourceHasPointerColumn, false, 'the source DB models the prior native schema');

  await ensurePointerFingerprintColumn(fixture.knex);
  await ensurePointerFingerprintColumn(fixture.knex);
  assert.equal(await fixture.knex.schema.hasColumn('t_track', 'pointer_fingerprint'), true);
  assert.equal((await fixture.trackStore.getTrackRows(101)).length, 1, 'the copied pre-upgrade row survives migration');

  fixture.utils.nativeWorkScanNeeded.add(101);
  const firstTracks = await fixture.utils.getTrackList(101, fixture.loc, { sync: true });
  const strmTrack = firstTracks.find(track => track.ext === STRM_EXT);
  assert.ok(strmTrack);
  assert.equal(strmTrack.seq, 8, 'new track appends after persisted track_max_seq');
  assert.equal(strmTrack.hash, '101/8');
  assert.equal(strmTrack.isStrm, true);
  assert.equal(strmTrack.mediaExt, '.mp3');
  assert.equal(fixture.utils.supportedMediaExtList.includes(STRM_EXT), false, '.strm is not globally promoted to media');
  assert.equal(fixture.utils.consumeWorkScanNeeded(101), true, 'native/local inventory changes trigger the existing work scan queue');
  assert.equal(fixture.utils.consumeCalls, 1, 'local pending state does not short-circuit native pending state consumption');
  assert.equal(fixture.utils.consumeWorkScanNeeded(101), false);
  const tree = fixture.utils.toTree(firstTracks, 'Work', 'work', 'library');
  const treeTrack = tree.find(item => item.isStrm);
  assert.equal(treeTrack.type, 'audio');
  assert.equal(treeTrack.title, 'Virtual.mp3');
  assert.equal(treeTrack.isVideo, false);

  const seeded = await fixture.utils.getTrackList(102, fixture.registry.resolveWork({ id: 102, root_folder: 'library', dir: 'emptywork' }));
  assert.equal(seeded.length, 1, 'the empty track table is synced before the original seed path runs');
  assert.equal(seeded[0].isStrm, true);
  assert.equal(seeded[0].hash, '102/0');

  const firstTarget = await fixture.bridge.resolveTrack(101, strmTrack.seq, 'Browser/1.0');
  assert.equal(firstTarget.pointer.url, 'https://one.example/a.mp3');
  assert.equal(firstTarget.rootFolder.name, 'library');
  assert.equal(firstTarget.relativePath, 'work/Virtual.mp3.strm');
  assert.equal(firstTarget.rootRelPath, 'work/Virtual.mp3.strm');
  assert.equal(firstTarget.physicalPath, fixture.provider.abs(firstTarget.rootRelPath));
  assert.equal(firstTarget.userAgent, 'Browser/1.0');

  const row = await fixture.trackStore.getTrackRow(101, strmTrack.seq);
  const progress = [];
  const scanResult = await fixture.utils.scanWorkDurations(fixture.loc, await fixture.trackStore.getTrackRows(101), 1, value => progress.push(value));
  assert.deepEqual(scanResult, { scanned: 1, succeeded: 1, failed: 0 });
  assert.equal(fixture.probeCalls[0].url, 'https://cdn.example/resolved-media.mp3', 'ffprobe receives the helper-resolved media URL, never pointer text');
  assert.equal(fixture.probeCalls[0].url.includes('one.example'), false);
  assert.equal(fixture.probeCalls[0].userAgent, 'StableHelper/1.0');
  assert.equal((await fixture.trackStore.getTrackRow(101, strmTrack.seq)).duration, 123.5);
  const persistedProbeState = await fixture.runtime.store.get(firstTarget.key);
  assert.equal(persistedProbeState.probeStatus, 'ok');
  assert.equal(persistedProbeState.probeFingerprint, firstTarget.pointerFingerprint);
  assert.equal(Object.hasOwn(persistedProbeState, 'duration'), false, 'the auxiliary state stores retry metadata only');
  assert.equal(Object.hasOwn(persistedProbeState, 'lufs'), false);
  assert.equal(JSON.stringify(persistedProbeState).includes('one.example'), false);
  assert.equal(progress.at(-1).total, 1);
  assert.equal(progress.at(-1).done, 1);
  assert.equal(await fixture.bridge.persistLufs(firstTarget, -17.25), true);

  await fs.writeFile(path.join(fixture.workPath, 'notes.lrc'), '[00:00.00]fixture lyric\n');
  const textOnlyChange = await fixture.utils.getTrackList(101, fixture.loc, { sync: true });
  assert.equal(fixture.utils.tracksMissingDuration(textOnlyChange), false, 'audio durations are already complete');
  assert.equal(fixture.utils.consumeWorkScanNeeded(101), true,
    'a text-only inventory change remains visible to the native queue even when no duration is missing');

  const firstStat = await fs.stat(path.join(fixture.workPath, 'Virtual.mp3.strm'));
  const firstFingerprint = row.pointer_fingerprint;
  const replacement = 'https://two.example/b.mp3\n';
  assert.equal(Buffer.byteLength(replacement), Buffer.byteLength('https://one.example/a.mp3\n'));
  await fs.writeFile(path.join(fixture.workPath, 'Virtual.mp3.strm'), replacement);
  await fs.utimes(path.join(fixture.workPath, 'Virtual.mp3.strm'), fixture.fixedSeconds, fixture.fixedSeconds);
  const replacementStat = await fs.stat(path.join(fixture.workPath, 'Virtual.mp3.strm'));
  assert.equal(replacementStat.size, firstStat.size);
  assert.equal(Math.round(replacementStat.mtimeMs), Math.round(firstStat.mtimeMs));
  await fixture.utils.syncWorkTracks(101, fixture.loc);
  const changedRow = await fixture.trackStore.getTrackRow(101, strmTrack.seq);
  assert.notEqual(changedRow.pointer_fingerprint, firstFingerprint);
  assert.equal(changedRow.duration, null);
  assert.equal(changedRow.lufs, null);
  assert.equal(changedRow.transcode, null);
  assert.equal(changedRow.waveform_path, null);
  assert.equal(await fixture.bridge.persistDuration(firstTarget, 999), false, 'an old pointer probe cannot write after fingerprint replacement');
  assert.equal(await fixture.bridge.persistLufs(firstTarget, -1), false, 'an old LUFS task cannot write after fingerprint replacement');
  assert.ok(fixture.invalidateCalls.some(call => call.kind === 'task' && call.fingerprint === firstFingerprint));
  assert.ok(fixture.invalidateCalls.some(call => call.kind === 'cache' && call.fingerprint === firstFingerprint));

  const secondTarget = await fixture.bridge.resolveTrack(101, strmTrack.seq, 'Browser/1.0');
  const third = 'https://tri.example/c.mp3\n';
  assert.equal(Buffer.byteLength(third), Buffer.byteLength(replacement));
  await fs.writeFile(path.join(fixture.workPath, 'Virtual.mp3.strm'), third);
  await fs.utimes(path.join(fixture.workPath, 'Virtual.mp3.strm'), fixture.fixedSeconds, fixture.fixedSeconds);
  assert.equal(await fixture.bridge.validateTarget(secondTarget), false, 'validation rereads the provider file even before a scan sync');
  const thirdRow = await fixture.trackStore.getTrackRow(101, strmTrack.seq);
  assert.notEqual(thirdRow.pointer_fingerprint, changedRow.pointer_fingerprint);
  assert.equal(thirdRow.duration, null);

  assert.equal(await fixture.bridge.resolveTrack(101, 7, 'Browser/1.0'), null, 'non-STRM native rows are not claimed by the bridge');
  await assert.rejects(fixture.bridge.resolveTrack(101, 999, 'Browser/1.0'), error => error.code === 'TRACK_NOT_FOUND' && error.status === 404,
    'deleted or unknown seq values return 404 instead of falling back to array indexes');
  await fs.rm(path.join(fixture.workPath, 'Virtual.mp3.strm'));
  await fixture.utils.syncWorkTracks(101, fixture.loc);
  await assert.rejects(fixture.bridge.resolveTrack(101, strmTrack.seq, 'Browser/1.0'), error => error.code === 'TRACK_NOT_FOUND' && error.status === 404);
  assert.equal(fixture.cacheDeleteCalls.some(call => call.workId === 101 && call.seq === strmTrack.seq), true);

  const remoteLoc = { provider: { kind: 'openlist' }, rootFolderName: 'open', workRelPath: 'remote' };
  await assert.rejects(fixture.utils.syncWorkTracks(900, remoteLoc), /local STRM sync must use native bridge/,
    'OpenList continues through its original native sync path');
  assert.equal(await fixture.bridge.prepareTargetByPath(remoteLoc.provider, 'remote/Virtual.mp3.strm'), null);
});

test('duration probe queue honors disable and persists only fingerprint-bound retry codes', {
  skip: !knexFactory || !LocalProvider ? 'run with the 0.6.17 image dependencies' : false,
}, async t => {
  const fixture = await makeFixture({ strmText: 'https://one.example/a.mp3\n' });
  t.after(() => fixture.close());
  await ensurePointerFingerprintColumn(fixture.knex);
  const tracks = await fixture.utils.getTrackList(101, fixture.loc, { sync: true });
  const track = tracks.find(item => item.isStrm);
  const rows = await fixture.trackStore.getTrackRows(101);
  fixture.runtime.resolveStrmRedirect = async (_runtime, target) => ({ final: new URL(target.pointer.url), userAgent: 'StableHelper/1.0' });
  fixture.bridge = createTrackBridge(APP_ROOT, fixture.runtime, {
    knex: fixture.knex,
    trackStore: fixture.trackStore,
    registry: fixture.registry,
    config: fixture.config,
    audioCache: { deleteTrackCacheFiles() {} },
    resolveStrmRedirect: fixture.runtime.resolveStrmRedirect,
    probeRemoteDuration: async () => {
      const error = new Error('sensitive https://signed.example/private?token=never-log');
      error.code = 'HELPER_RATE_LIMITED';
      throw error;
    },
    logger: { warn(message) { fixture.warningMessages.push(String(message)); }, info() {} },
  });
  fixture.utils = makeUtils(fixture.trackStore);
  fixture.bridge.installUtils(fixture.utils);
  const progress = [];
  const failed = await fixture.utils.scanWorkDurations(fixture.loc, rows, 1, value => progress.push(value));
  assert.deepEqual(failed, { scanned: 1, succeeded: 0, failed: 1 });
  const target = await fixture.bridge.resolveTrack(101, track.seq);
  const state = await fixture.runtime.store.get(target.key);
  assert.equal(state.probeStatus, 'error');
  assert.equal(state.probeFingerprint, target.pointerFingerprint);
  assert.equal(state.probeError, 'HELPER_RATE_LIMITED');
  assert.ok(state.probeRetryAt > Date.now());
  assert.equal(Object.hasOwn(state, 'duration'), false);
  assert.equal(fixture.warningMessages.some(message => message.includes('signed.example') || message.includes('never-log')), false);
  assert.equal(fixture.utils.rowsMissingDuration(await fixture.trackStore.getTrackRows(101)), false,
    'a matching error retry window suppresses an immediate rescan');

  fixture.runtime.options.durationProbe.enabled = false;
  const disabled = await fixture.utils.scanWorkDurations(fixture.loc, rows, 1);
  assert.deepEqual(disabled, { scanned: 0, succeeded: 0, failed: 0 });
});

test('legacy state import is keyed, fingerprint checked, read-only, and resumes after interruption', {
  skip: !knexFactory || !LocalProvider ? 'run with the 0.6.17 image dependencies' : false,
}, async t => {
  const fixture = await makeFixture({
    strmText: 'https://one.example/a.mp3\n',
  });
  t.after(() => fixture.close());
  await ensurePointerFingerprintColumn(fixture.knex);
  const tracks = await fixture.utils.getTrackList(101, fixture.loc, { sync: true });
  const strmTrack = tracks.find(track => track.isStrm);
  const row = await fixture.trackStore.getTrackRow(101, strmTrack.seq);
  const rootRelativePath = 'work/Virtual.mp3.strm';
  const validKey = makeRecordKey('library', rootRelativePath);
  const wrongKey = 'not-the-record-key';
  const statePath = path.join(fixture.root, 'strm-state.json');
  fixture.runtime.options.legacyStatePath = statePath;
  const legacyState = {
    version: 1,
    records: {
      [validKey]: {
        key: validKey,
        rootFolder: 'library',
        relativePath: rootRelativePath,
        pointerFingerprint: row.pointer_fingerprint,
        pointerMtimeMs: row.mtime,
        probeStatus: 'ok',
        duration: 81.25,
        loudnessStatus: 'ready',
        loudnessReady: true,
        loudnorm: { input_i: '-15.75' },
      },
      [wrongKey]: {
        key: wrongKey,
        rootFolder: 'library',
        relativePath: rootRelativePath,
        pointerFingerprint: row.pointer_fingerprint,
        probeStatus: 'ok',
        duration: 999,
      },
      badFingerprint: {
        key: validKey,
        rootFolder: 'library',
        relativePath: rootRelativePath,
        pointerFingerprint: 'f'.repeat(64),
        probeStatus: 'ok',
        duration: 999,
      },
      badStatus: {
        key: validKey,
        rootFolder: 'library',
        relativePath: rootRelativePath,
        pointerFingerprint: row.pointer_fingerprint,
        probeStatus: 'pending',
        duration: 999,
      },
    },
  };
  const sourceBytes = `${JSON.stringify(legacyState, null, 2)}\n`;
  await fs.writeFile(statePath, sourceBytes);
  assert.equal(resolveLegacyStatePath(fixture.runtime), statePath);

  let interrupted = false;
  const common = {
    runtime: fixture.runtime,
    workId: 101,
    loc: fixture.loc,
    rows: await fixture.trackStore.getTrackRows(101),
    targetForRow: current => fixture.bridge.resolveTrack(101, current.seq),
    persistDuration: async (target, value, options) => {
      if (!interrupted) {
        interrupted = true;
        throw new Error('simulated migration interruption');
      }
      return fixture.bridge.persistDuration(target, value, options);
    },
    persistLufs: (target, value, options) => fixture.bridge.persistLufs(target, value, options),
    logger: { warn() {} },
  };
  await assert.rejects(migrateLegacyState(common), /simulated migration interruption/);
  const resumed = await migrateLegacyState(common);
  assert.equal(resumed.durationMigrated, 1);
  assert.equal(resumed.lufsMigrated, 1);
  const migrated = await fixture.trackStore.getTrackRow(101, strmTrack.seq);
  assert.equal(migrated.duration, 81.25);
  assert.equal(migrated.lufs, -15.75);

  const repeats = await migrateLegacyState({
    ...common,
    persistDuration: (target, value, options) => fixture.bridge.persistDuration(target, value, options),
  });
  assert.equal(repeats.durationMigrated, 0);
  assert.equal(repeats.lufsMigrated, 0);
  assert.equal(await fs.readFile(statePath, 'utf8'), sourceBytes, 'the sole legacy source remains unchanged');
  assert.equal(await fixture.knex('t_track').where('work_id', 101).count({ count: '*' }).first().then(row => Number(row.count)), 2);
});

test('legacy playback cache rootFolder objects migrate by name only and reject wrong name, key, or fingerprint', {
  skip: !knexFactory || !LocalProvider ? 'run with the 0.6.17 image dependencies' : false,
}, async t => {
  const fixture = await makeFixture({ strmText: 'https://one.example/a.mp3\n' });
  t.after(() => fixture.close());
  await ensurePointerFingerprintColumn(fixture.knex);
  await fs.writeFile(path.join(fixture.workPath, 'ObjectRoot.mp3.strm'), 'https://two.example/b.mp3\n');
  await fs.writeFile(path.join(fixture.workPath, 'BadFingerprint.mp3.strm'), 'https://three.example/c.mp3\n');
  const tracks = await fixture.utils.getTrackList(101, fixture.loc, { sync: true });
  const objectTrack = tracks.find(track => track.title === 'ObjectRoot.mp3.strm');
  const badFingerprintTrack = tracks.find(track => track.title === 'BadFingerprint.mp3.strm');
  assert.ok(objectTrack && badFingerprintTrack);
  const objectRow = await fixture.trackStore.getTrackRow(101, objectTrack.seq);
  const wrongFingerprintRow = await fixture.trackStore.getTrackRow(101, badFingerprintTrack.seq);
  const objectRelativePath = 'work/ObjectRoot.mp3.strm';
  const badFingerprintPath = 'work/BadFingerprint.mp3.strm';
  const objectKey = makeRecordKey('library', objectRelativePath);
  const badFingerprintKey = makeRecordKey('library', badFingerprintPath);
  const wrongRootKey = makeRecordKey('other-library', objectRelativePath);
  const statePath = path.join(fixture.root, 'strm-state.json');
  fixture.runtime.options.legacyStatePath = statePath;
  const legacyState = {
    version: 1,
    records: {
      [objectKey]: {
        key: objectKey,
        rootFolder: { name: 'library', path: fixture.libraryPath, secret: 'private-root-metadata' },
        relativePath: objectRelativePath,
        pointerFingerprint: objectRow.pointer_fingerprint,
        loudnessReady: true,
        loudnessStatus: 'ready',
        loudnorm: { input_i: '-14.25' },
      },
      [wrongRootKey]: {
        key: wrongRootKey,
        rootFolder: { name: 'other-library', path: '/private/other/root' },
        relativePath: objectRelativePath,
        pointerFingerprint: objectRow.pointer_fingerprint,
        loudnessReady: true,
        loudnessStatus: 'ready',
        loudnorm: { input_i: '-1.00' },
      },
      badKeyRecord: {
        key: 'wrong-key',
        rootFolder: { name: 'library', path: '/private/ignored/path' },
        relativePath: objectRelativePath,
        pointerFingerprint: objectRow.pointer_fingerprint,
        loudnessReady: true,
        loudnessStatus: 'ready',
        loudnorm: { input_i: '-2.00' },
      },
      [badFingerprintKey]: {
        key: badFingerprintKey,
        rootFolder: { name: 'library', path: '/private/ignored/path' },
        relativePath: badFingerprintPath,
        pointerFingerprint: 'f'.repeat(64),
        loudnessReady: true,
        loudnessStatus: 'ready',
        loudnorm: { input_i: '-3.00' },
      },
    },
  };
  const sourceBytes = `${JSON.stringify(legacyState, null, 2)}\n`;
  await fs.writeFile(statePath, sourceBytes);
  const rows = await fixture.trackStore.getTrackRows(101);
  const migrated = await migrateLegacyState({
    runtime: fixture.runtime,
    workId: 101,
    loc: fixture.loc,
    rows,
    targetForRow: row => fixture.bridge.resolveTrack(101, row.seq),
    persistDuration: (target, value, options) => fixture.bridge.persistDuration(target, value, options),
    persistLufs: (target, value, options) => fixture.bridge.persistLufs(target, value, options),
    logger: { warn() {} },
  });

  assert.equal(migrated.lufsMigrated, 1);
  // Records for a different library are outside this migration scope; only
  // the in-scope invalid key and fingerprint count as skipped.
  assert.equal(migrated.skipped, 2);
  assert.equal((await fixture.trackStore.getTrackRow(101, objectTrack.seq)).lufs, -14.25);
  assert.equal((await fixture.trackStore.getTrackRow(101, badFingerprintTrack.seq)).lufs, null);
  assert.equal(await fs.readFile(statePath, 'utf8'), sourceBytes, 'migration leaves the only legacy state source unchanged');
  const target = await fixture.bridge.resolveTrack(101, objectTrack.seq);
  const newState = await fixture.runtime.store.get(target.key);
  assert.equal(JSON.stringify(newState || {}).includes(fixture.libraryPath), false);
  assert.equal(JSON.stringify(newState || {}).includes('private-root-metadata'), false);
});

test('legacy state path never aliases the new v2 file', () => {
  assert.equal(resolveLegacyStatePath({ options: { statePath: '/data/strm-state-v2.json' } }), '/data/strm-state.json');
  assert.equal(resolveLegacyStatePath({ options: { statePath: '/data/custom-state.json' } }), null);
});

test('legacy memo duration requires a matching pointer fingerprint', async () => {
  const calls = [];
  const row = { id: 1, work_id: 101, seq: 8, rel_path: 'Virtual.mp3.strm', ext: '.strm', duration: null, pointer_fingerprint: 'a'.repeat(64) };
  const migrated = await migrateLegacyMemo({
    oldMemo: {
      duration: { 'Virtual.mp3.strm': 55, 'Other.mp3.strm': 66 },
      strm: { 'Virtual.mp3.strm': { pointerFingerprint: 'a'.repeat(64) }, 'Other.mp3.strm': { pointerFingerprint: 'b'.repeat(64) } },
    },
    rows: [row],
    targetForRow: async current => ({ pointerFingerprint: current.pointer_fingerprint }),
    persistDuration: async (_target, duration) => { calls.push(duration); return true; },
  });
  assert.equal(migrated, 1);
  assert.deepEqual(calls, [55]);
});
