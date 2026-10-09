'use strict';
// Run inside the built overlay image with fixture.115cdn.net mapped to 127.0.0.1.
// No production mounts. All data and credentials are disposable fixture values.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const appRoot = '/usr/src/kikoeru';
const localRequire = createRequire(path.join(appRoot, 'package.json'));
const SQLite = localRequire('better-sqlite3');
const root = fs.mkdtempSync('/tmp/strm-native-0617-');
const mediaRoot = path.join(root, 'media');
const workDir = path.join(mediaRoot, 'RJ00000001');
fs.mkdirSync(workDir, { recursive: true });
const wav = path.join(root, 'fixture.wav');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'pcm_s16le', wav]);
const body = fs.readFileSync(wav);
fs.copyFileSync(wav, path.join(workDir, 'b-local.wav'));
const pointer = path.join(workDir, 'a-remote.wav.strm');
const pointerUrl = 'http://127.0.0.1:19081/helper/one?fixture_signature=never-persist-this';
fs.writeFileSync(pointer, pointerUrl + '\n');
let heads = 0, gets = 0, mismatch = 0;
const expectedColdUA = require(path.join(appRoot, 'strm-adapter/http')).DEFAULT_HELPER_USER_AGENT;
const helper = http.createServer((req, res) => {
  if (req.url.startsWith('/helper/')) {
    assert.equal(req.method, 'HEAD'); heads++;
    if (req.url.startsWith('/helper/bad')) return res.writeHead(302, { Location: 'http://evil.example/file' }).end();
    if (req.url.startsWith('/helper/rate')) return res.writeHead(429, { 'Retry-After': '0' }).end();
    const ua = req.headers['user-agent'];
    res.writeHead(302, { Location: 'http://fixture.115cdn.net:19081/media?consumer=' + encodeURIComponent(ua) }).end();
    return;
  }
  if (req.url.startsWith('/media')) {
    const consumer = new URL(req.url, 'http://fixture.115cdn.net').searchParams.get('consumer');
    if (consumer !== req.headers['user-agent']) { mismatch++; return res.writeHead(403).end(); }
    if (req.method === 'GET') gets++;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]), end = Math.min(body.length - 1, range[2] ? Number(range[2]) : body.length - 1);
      if (start > end) return res.writeHead(416, { 'Content-Range': 'bytes */' + body.length }).end();
      const part = body.subarray(start, end + 1);
      res.writeHead(206, { 'Content-Type': 'audio/wav', 'Content-Length': part.length,
        'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Accept-Ranges': 'bytes' });
      return res.end(req.method === 'HEAD' ? undefined : part);
    }
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': body.length, 'Accept-Ranges': 'bytes' });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  res.writeHead(404).end();
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = [];
let app, db;
let log = '';
let adminToken;
async function api(url, { method = 'GET', data, token = adminToken, ua = 'FixtureBrowser/1', headers = {}, redirect = 'manual' } = {}) {
  return fetch('http://127.0.0.1:8888/api' + url, {
    method, redirect, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'User-Agent': ua,
      ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: data ? JSON.stringify(data) : undefined,
  });
}
async function json(url, options) { const res = await api(url, options); assert.equal(res.status, 200, url); return res.json(); }
async function eventually(fn, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await sleep(100); }
  throw new Error('fixture timeout: ' + label);
}
async function main() {
  await new Promise(resolve => helper.listen(19081, '0.0.0.0', resolve));
  const env = { ...process.env, NODE_ENV: 'production', KNEX_ENV: 'development', IS_DOCKER: 'true', PORT: '8888',
    KIKOERU_DATA_DIR: root, KIKOERU_CONFIG_DIR: path.join(root, 'config'), KIKOERU_SQLITE_DIR: path.join(root, 'sqlite'),
    KIKOERU_COVERS_DIR: path.join(root, 'covers'), KIKOERU_STRM_MEDIA_PATH: mediaRoot,
    STRM_CACHE_ROOT: path.join(root, 'cache'), STRM_ALLOWED_HOSTS: '127.0.0.1:19081',
    STRM_REDIRECT_MIN_INTERVAL_MS: '0', STRM_DURATION_PROBE_INTERVAL_MS: '0', STRM_REDIRECT_CACHE_TTL_MS: '0',
    STRM_REDIRECT_COOLDOWN_MS: '10', STRM_REDIRECT_SEVERE_COOLDOWN_MS: '50',
    STRM_REDIRECT_MAX_429_RETRIES: '1', STRM_REDIRECT_RETRY_BASE_MS: '10', STRM_REDIRECT_RETRY_MAX_MS: '50', STRM_REDIRECT_RETRY_JITTER_MS: '0',
    KIKOERU_ADMIN_PASSWORD: 'fixture-admin-password', STRM_LOUDNESS_METHOD: 'ebur128' };
  let legacySourceContent;
  if (process.env.FIXTURE_OLD_DB) {
    fs.mkdirSync(path.join(root, 'sqlite'), { recursive: true });
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.copyFileSync(process.env.FIXTURE_OLD_DB, path.join(root, 'sqlite', 'db.sqlite3'));
    const oldConfig = { version: '0.6.15', production: true, auth: true, dbUseDefaultPath: false,
      databaseFolderDir: path.join(root, 'sqlite'), coverUseDefaultPath: false, coverFolderDir: path.join(root, 'covers'),
      rootFolders: [{ name: 'fixture', type: 'local', path: mediaRoot }], enableFileWatcher: false,
      md5secret: 'synthetic-md5-secret', jwtsecret: 'synthetic-jwt-secret',
      strm: { enabled: true, allowedHosts: ['127.0.0.1:19081'], statePath: path.join(root, 'sqlite', 'strm-state.json') } };
    fs.writeFileSync(path.join(root, 'config', 'config.json'), JSON.stringify(oldConfig));
    const key = require(path.join(appRoot, 'strm-adapter/state-store')).makeRecordKey('fixture', 'RJ00000001/a-remote.wav.strm');
    const fingerprint = require(path.join(appRoot, 'strm-adapter/pointer')).pointerFingerprint(pointerUrl + '\n');
    legacySourceContent = JSON.stringify({ version: 1, records: { [key]: { key, rootFolder: process.env.FIXTURE_OLD_ROOT_OBJECT === '1' ? { name: 'fixture', path: mediaRoot } : 'fixture',
      relativePath: 'RJ00000001/a-remote.wav.strm', pointerFingerprint: fingerprint,
      probeStatus: 'ok', duration: 2.5, loudnessReady: true, loudnessStatus: 'ready', loudnorm: { input_i: '-19.40' } } } });
    fs.writeFileSync(path.join(root, 'sqlite', 'strm-state.json'), legacySourceContent);
  }
  app = spawn(process.execPath, [path.join(appRoot, 'strm-entrypoint.js')], { cwd: appRoot, env });
  app.stdout.on('data', data => { log += data; }); app.stderr.on('data', data => { log += data; });
  await eventually(async () => { try { return (await api('/health', { token: null })).status === 200; } catch { return false; } }, 'health');
  evidence.push('health and explicit app.main startup');
  const login = await json('/auth/me', { method: 'POST', data: { name: 'admin', password: 'fixture-admin-password' }, token: null });
  adminToken = login.token; assert.ok(adminToken);
  assert.equal((await api('/admin/strm', { token: null })).status, 401);
  db = new SQLite(path.join(root, 'sqlite', 'db.sqlite3'));
  db.pragma('busy_timeout = 3000');
  db.prepare("INSERT OR IGNORE INTO t_circle(id,name) VALUES(1,'Fixture')").run();
  db.prepare("INSERT INTO t_work(id,root_folder,dir,title,circle_id,lyric_status) VALUES(1,?,?,?,?,?)").run('RJ00000001', 'RJ00000001', 'Fixture work', 1, 'none');
  // First-run wrapper chooses immediate media subdirectories as libraries.
  const configFile = path.join(root, 'config', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(configFile));
  const library = cfg.rootFolders[0];
  if (library.path === workDir) db.prepare('UPDATE t_work SET root_folder=?,dir=? WHERE id=1').run(library.name, '');
  else db.prepare('UPDATE t_work SET root_folder=? WHERE id=1').run(library.name);
  const md5 = crypto.createHash('md5').update('fixture-user-password' + cfg.md5secret).digest('hex');
  db.prepare('INSERT INTO t_user(name,password,"group") VALUES(?,?,?)').run('fixtureuser', md5, 'user');
  const user = await json('/auth/me', { method: 'POST', token: null, data: { name: 'fixtureuser', password: 'fixture-user-password' } });
  assert.equal((await api('/admin/strm', { token: user.token })).status, 403);
  evidence.push('native login, JWT and admin permissions');
  await json('/scan/work-queue', { method: 'POST', data: {} });
  await eventually(async () => { const q = await json('/scan/work-queue'); return !q.busy; }, 'scan queue');
  let rows = db.prepare('SELECT * FROM t_track WHERE work_id=1 ORDER BY seq').all();
  let remote = rows.find(r => r.rel_path === 'a-remote.wav.strm'); const ordinary = rows.find(r => r.rel_path === 'b-local.wav');
  assert.ok(remote && ordinary); assert.equal(remote.ext, '.strm'); assert.ok(remote.pointer_fingerprint); assert.ok(remote.duration > 1.9);
  const seq = remote.seq;
  if (process.env.FIXTURE_OLD_DB) {
    assert.equal(remote.duration, 2.5); assert.equal(remote.lufs, -19.4);
    assert.equal(fs.readFileSync(path.join(root, 'sqlite', 'strm-state.json'), 'utf8'), legacySourceContent);
    await json('/scan/work-queue', { method: 'POST', data: {} });
    await eventually(async () => !(await json('/scan/work-queue')).busy, 'repeat migration');
    const repeated = db.prepare('SELECT * FROM t_track WHERE work_id=1 AND seq=?').get(seq);
    assert.equal(repeated.duration, 2.5); assert.equal(repeated.lufs, -19.4);
    assert.equal(repeated.pointer_fingerprint, remote.pointer_fingerprint);
    assert.equal(fs.readFileSync(path.join(root, 'sqlite', 'strm-state.json'), 'utf8'), legacySourceContent);
    console.log(JSON.stringify({ passed: ['copied synthetic 0.6.15 database upgraded by native migrations',
      'legacy state matches root/work/physical path/fingerprint', 'duration and LUFS moved to native track',
      'repeat migration stable and old source byte-for-byte retained'], root }, null, 2));
    return;
  }
  assert.ok(db.prepare('SELECT total_duration FROM staticMetadata WHERE id=1').get().total_duration > 3.8);
  await json('/works?order=total_duration&sort=desc');
  const tree = await json('/tracks/1');
  assert.ok(JSON.stringify(tree).includes('a-remote.wav')); assert.ok(JSON.stringify(tree).includes('\"isStrm\":true')); assert.ok(!JSON.stringify(tree).includes('fixture_signature'));
  const internal = await json('/work/1/trackinfo'); assert.ok(internal.tracks.some(t => t.seq === seq && t.relPath === 'a-remote.wav.strm' && t.duration > 1.9));
  evidence.push('native scan queue, physical t_track path, stable hash, duration and total_duration sorting');
  const route = '/media/task/loudnorm';
  const before = await json(route + '/status/1/' + seq); assert.equal(before.task, 'loudnorm');
  const getCount = gets;
  const started = await Promise.all([json(route + '/start/1/' + seq, { method: 'POST' }), json(route + '/start/1/' + seq, { method: 'POST' }), api('/media/stream/1/' + seq)]);
  assert.ok(['started', 'ready'].includes(started[0].status));
  assert.equal(started[2].status, 200); assert.equal((await started[2].arrayBuffer()).byteLength, body.length);
  await eventually(() => db.prepare('SELECT lufs FROM t_track WHERE work_id=1 AND seq=?').get(seq).lufs !== null, 'LUFS');
  assert.equal(gets - getCount, 1, 'one full cold download');
  const result = await json(route + '/result/1/' + seq); assert.ok(Number.isFinite(Number(result.loudnorm.input_i)));
  const legacy = await json('/media/calculate/loudnorm/1/' + seq); assert.ok(Number.isFinite(Number(legacy.loudnorm.input_i)));
  const notify = await api(route + '/stream_notify/1/' + seq); assert.equal(notify.status, 200); assert.match(await notify.text(), /done/);
  const hot = await api('/media/stream/1/' + seq, { ua: 'FixtureBrowser/2' }); assert.equal(hot.status, 302);
  const location = hot.headers.get('location'); assert.equal(new URL(location).hostname, 'fixture.115cdn.net');
  const redirected = await fetch(location, { headers: { 'User-Agent': 'FixtureBrowser/2' } }); assert.equal(redirected.status, 200);
  const cdnRange = await fetch(location, { headers: { 'User-Agent': 'FixtureBrowser/2', Range: 'bytes=100-131' } }); assert.equal(cdnRange.status, 206); assert.equal((await cdnRange.arrayBuffer()).byteLength, 32);
  assert.equal(mismatch, 0); evidence.push('new/legacy loudness, native LUFS, single download, SSE terminal event, hot 302 and matching UA');
  for (const task of ['waveform', 'transcode']) {
    for (const operation of ['status', 'start', 'result', 'stream_notify']) {
      const res = await api('/media/task/' + task + '/' + operation + '/1/' + seq, { method: operation === 'start' ? 'POST' : 'GET' });
      const text = await res.text();
      assert.ok(res.status === 409 || (operation === 'stream_notify' && res.status === 200 && /failed|unsupported/.test(text)), task + operation);
    }
  }
  assert.equal((await api('/media/transcode/1/' + seq)).status, 409);
  const capabilities = await json('/caniuse?apiName=waveform,total_duration_order,loudnorm_version_2,transcode_version_2'); assert.ok(capabilities.results.every(r => r.supported)); evidence.push('all generic unsupported task operations terminate; global native capabilities retained');
  await json('/media/task/waveform/start/1/' + ordinary.seq, { method: 'POST' });
  await eventually(() => db.prepare('SELECT waveform_path FROM t_track WHERE work_id=1 AND seq=?').get(ordinary.seq).waveform_path !== null, 'ordinary waveform');
  const ordinaryWaveform = await api('/media/task/waveform/result/1/' + ordinary.seq); assert.equal(ordinaryWaveform.status, 200);
  assert.ok((await ordinaryWaveform.arrayBuffer()).byteLength > 0);
  await json('/media/task/transcode/start/1/' + ordinary.seq + '?bitRate=64', { method: 'POST' });
  await eventually(async () => (await json('/media/task/transcode/status/1/' + ordinary.seq + '?bitRate=64')).ready, 'ordinary transcode');
  const ordinaryTranscode = await api('/media/task/transcode/result/1/' + ordinary.seq + '?bitRate=64'); assert.equal(ordinaryTranscode.status, 200);
  assert.ok((await ordinaryTranscode.arrayBuffer()).byteLength > 0);
  evidence.push('ordinary waveform and transcode native task regression');
  const status = await json('/admin/strm');
  await json('/admin/strm', { method: 'PUT', data: { redirectMode: 'local' } });
  const ranged = await api('/media/stream/1/' + seq, { headers: { Range: 'bytes=0-31' } });
  assert.equal(ranged.status, 206); assert.equal((await ranged.arrayBuffer()).byteLength, 32);
  const localPlayback = await api('/media/stream/1/' + ordinary.seq, { headers: { Range: 'bytes=0-31' } }); assert.equal(localPlayback.status, 206);
  evidence.push('local compatibility mode Range/seek and ordinary local regression');
  const savedLufs = db.prepare('SELECT lufs FROM t_track WHERE work_id=1 AND seq=?').get(seq).lufs;
  await json('/admin/strm', { method: 'PUT', data: { redirectMode: 'direct', coldCache: { maxAgeMs: 1 } } });
  await sleep(20);
  await json('/admin/strm/cleanup', { method: 'POST' });
  assert.equal(db.prepare('SELECT lufs FROM t_track WHERE work_id=1 AND seq=?').get(seq).lufs, savedLufs);
  app.kill('SIGTERM');
  await new Promise(resolve => app.once('exit', resolve));
  app = spawn(process.execPath, [path.join(appRoot, 'strm-entrypoint.js')], { cwd: appRoot, env });
  app.stdout.on('data', data => { log += data; }); app.stderr.on('data', data => { log += data; });
  await eventually(async () => { try { return (await api('/health')).status === 200; } catch { return false; } }, 'fixture restart');
  const afterRestart = await json(route + '/result/1/' + seq);
  assert.equal(Number(afterRestart.loudnorm.input_i), Number(savedLufs.toFixed(2)));
  evidence.push('native LUFS survives complete-media TTL cleanup and fixture-only process restart');
  const queueBeforeSubtitle = await json('/scan/work-queue');
  fs.writeFileSync(path.join(workDir, 'b-local.lrc'), '[00:00.00]fixture subtitle\n');
  await json('/tracks/1');
  await eventually(async () => { const q = await json('/scan/work-queue'); return !q.busy && q.finishedWorks > queueBeforeSubtitle.finishedWorks; }, 'subtitle-only native scan request');
  assert.equal(db.prepare('SELECT lyric_status FROM t_work WHERE id=1').get().lyric_status, 'local');
  evidence.push('subtitle-only change requests native scan and updates local lyric status');
  fs.unlinkSync(path.join(workDir, 'b-local.wav'));
  fs.copyFileSync(wav, path.join(workDir, '0-added.wav'));
  await json('/scan/work-queue', { method: 'POST', data: {} });
  await eventually(async () => !(await json('/scan/work-queue')).busy, 'rescan stable seq');
  remote = db.prepare('SELECT * FROM t_track WHERE work_id=1 AND rel_path=?').get('a-remote.wav.strm'); assert.equal(remote.seq, seq);
  const added = db.prepare('SELECT * FROM t_track WHERE work_id=1 AND rel_path=?').get('0-added.wav'); assert.ok(added.seq > ordinary.seq);
  assert.equal((await api('/media/stream/1/' + ordinary.seq)).status, 404);
  const stamp = fs.statSync(pointer);
  const changed = pointerUrl.replace('/one?', '/two?'); assert.equal(changed.length, pointerUrl.length);
  fs.writeFileSync(pointer, changed + '\n'); fs.utimesSync(pointer, stamp.atime, stamp.mtime);
  await json('/scan/work-queue', { method: 'POST', data: {} });
  await eventually(async () => !(await json('/scan/work-queue')).busy, 'pointer rescan');
  const invalidated = db.prepare('SELECT * FROM t_track WHERE work_id=1 AND seq=?').get(seq);
  assert.equal(invalidated.lufs, null); assert.notEqual(invalidated.pointer_fingerprint, remote.pointer_fingerprint);
  evidence.push('delete/add/reorder retain identities; same-size/same-mtime pointer invalidates native LUFS');
  await json('/admin/strm', { method: 'PUT', data: { loudness: { enabled: false } } });
  fs.writeFileSync(pointer, 'http://127.0.0.1:19081/helper/bad\n');
  const rejectedCdn = await api('/media/stream/1/' + seq); assert.equal(rejectedCdn.status, 403);
  fs.writeFileSync(pointer, 'http://127.0.0.1:19081/helper/rate\n');
  const rateLimited = await api('/media/stream/1/' + seq); assert.equal(rateLimited.status, 429);
  fs.writeFileSync(pointer, 'http://unconfigured.example/pointer\n');
  const rejectedPointer = await api('/media/stream/1/' + seq); assert.ok([403, 409].includes(rejectedPointer.status));
  fs.writeFileSync(pointer, changed + '\n');
  await json('/admin/strm', { method: 'PUT', data: { loudness: { enabled: true } } });
  const skipVideo = path.join(workDir, 'c-video.mp4.strm');
  fs.writeFileSync(skipVideo, changed + '\n');
  await json('/scan/work-queue', { method: 'POST', data: {} });
  await eventually(async () => !(await json('/scan/work-queue')).busy, 'video policy scan');
  const videoRow = db.prepare('SELECT * FROM t_track WHERE work_id=1 AND rel_path=?').get('c-video.mp4.strm');
  const videoTask = await json(route + '/start/1/' + videoRow.seq, { method: 'POST' });
  assert.equal(videoTask.ready, true); assert.equal(videoTask.skipped, true); assert.equal(videoRow.lufs, null);
  evidence.push('non-allowlisted CDN and pointer rejected, bounded Helper 429, video loudness terminal skip');
  assert.ok(!log.includes('never-persist-this')); assert.ok(!log.includes(adminToken)); assert.ok(!log.includes('fixture-admin-password'));
  const persisted = db.prepare('SELECT * FROM t_track').all(); assert.ok(!JSON.stringify(persisted).includes('fixture_signature'));
  for (const table of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    const quoted = '"' + table.name.replace(/"/g, '""') + '"';
    const storedRows = JSON.stringify(db.prepare('SELECT * FROM ' + quoted).all());
    assert.ok(!storedRows.includes('never-persist-this')); assert.ok(!storedRows.includes(adminToken));
    assert.ok(!storedRows.includes('fixture-admin-password')); assert.ok(!storedRows.includes('fixture-user-password'));
  }
  for (const file of fs.readdirSync(path.join(root, 'sqlite'))) {
    if (!file.endsWith('.json') || /config/.test(file)) continue;
    const text = fs.readFileSync(path.join(root, 'sqlite', file), 'utf8');
    assert.ok(!text.includes('never-persist-this')); assert.ok(!text.includes(adminToken));
  }
  evidence.push('fixture query/signature/JWT/password absent from logs and track/state persistence');
  console.log(JSON.stringify({ passed: evidence, fixtureCounts: { heads, gets, mismatch }, root, statusKeys: Object.keys(status) }, null, 2));
  if (process.env.FIXTURE_HOLD === '1') await new Promise(resolve => process.once('SIGTERM', resolve));
}
main().catch(error => { console.error('FIXTURE FAILED:', error.stack); console.error(log.slice(-10000).replace(/https?:\/\/\S+/g, '[url]')); process.exitCode = 1; }).finally(async () => {
  if (db) db.close();
  if (app) { app.kill('SIGTERM'); await new Promise(resolve => { app.once('exit', resolve); setTimeout(resolve, 3000).unref(); }); }
  await new Promise(resolve => helper.close(resolve));
});
