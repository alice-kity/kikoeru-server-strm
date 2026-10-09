'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  EXPECTED,
  EXPECTED_VERSION,
  loadManifest,
  parseArguments,
  verify,
} = require('../scripts/verify-upstream');
const { startUpstreamApp } = require('../scripts/strm-entrypoint');

test('default upstream manifest is 0.6.17 and guards release-sensitive modules', () => {
  assert.equal(EXPECTED_VERSION, '0.6.17');
  for (const relative of [
    'dist/src/database/trackStore.js',
    'dist/src/database/db.js',
    'dist/src/database/views.js',
    'dist/src/database/schema.js',
    'dist/src/filesystem/backend/localProvider.js',
    'dist/src/filesystem/backend/registry.js',
    'dist/src/filesystem/audioCache.js',
    'dist/src/filesystem/audioProcessor.js',
    'dist/src/routes/media-process.js',
    'dist/src/routes/caniuse.js',
    'dist/src/routes/metadata.js',
    'dist/src/utils/TaskQueue.js',
    'dist/src/socket.js',
    'dist/src/database/migrations/20260929120000_audio_cache_t_track.js',
    'dist/src/public/js/app.326cfdef.js',
    'dist/src/app.js',
  ]) assert.equal(typeof EXPECTED[relative], 'string', `${relative} is fingerprinted`);
});

test('0.6.15 fingerprint manifest preserves the existing baseline', () => {
  const old = loadManifest('0.6.15');
  assert.equal(Object.keys(old.fingerprints).length, 14);
  assert.equal(old.fingerprints['dist/src/filesystem/audioProcessor.js'],
    'a5cb43f9997cf1c560c4e2edb1239f323c38098fed78d03d2569259d8ce643a9');
  assert.equal(old.fingerprints['dist/src/auth/utils.js'],
    '56d8e1e74efc5bd35ed3f09722b4df80d8c25e5cdb15f2f2a7a7f51b89098516');
  assert.equal(old.fingerprints['dist/src/app.js'],
    '59e7074714063e460ddb880d7001e01bc4ef9903ae7217916ec3d1f9fcf9bff8');
});

test('upstream verifier parses explicit baseline selection and defaults to the new release', () => {
  assert.deepEqual(parseArguments([]), {
    rootDir: process.cwd(),
    options: { version: '0.6.17', manifestDir: path.resolve(__dirname, '..', 'patches') },
  });
  assert.deepEqual(parseArguments(['--version', '0.6.15', '/upstream']), {
    rootDir: '/upstream',
    options: { version: '0.6.15', manifestDir: path.resolve(__dirname, '..', 'patches') },
  });
  assert.throws(() => parseArguments(['--version']), /requires a value/);
});

test('strm entrypoint invokes the upstream exported main function', () => {
  let called = 0;
  const startup = Promise.resolve('listening');
  assert.equal(startUpstreamApp({ main() { called += 1; return startup; } }), startup);
  assert.equal(called, 1);
  assert.throws(() => startUpstreamApp({}), error => error.code === 'UPSTREAM_MAIN_UNAVAILABLE');
});

const reviewRoot = path.resolve(__dirname, '../tmp/upstream-0.6.17-review/usr/src/kikoeru');
test('0.6.17 extracted image matches its reviewed manifest when available', { skip: !fs.existsSync(reviewRoot) }, () => {
  const result = verify(reviewRoot);
  assert.equal(result.version, '0.6.17');
  assert.equal(Object.keys(result.fingerprints).length, 40);
});

test('copied verifier uses an explicit external manifest directory', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kikoeru-verifier-copy-'));
  try {
    const scriptDir = path.join(tempRoot, 'scripts');
    const manifestDir = path.join(tempRoot, 'fingerprints', '0.6.17');
    const upstreamRoot = path.join(tempRoot, 'upstream');
    const upstreamDist = path.join(upstreamRoot, 'dist');
    const upstreamSrc = path.join(upstreamDist, 'src');
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.mkdirSync(upstreamSrc, { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../scripts/verify-upstream.js'), path.join(scriptDir, 'verify-upstream.js'));
    const appSource = 'exports.main = function main() {};\n';
    fs.writeFileSync(path.join(upstreamDist, 'package.json'), JSON.stringify({ version: '0.6.17' }));
    fs.writeFileSync(path.join(upstreamSrc, 'app.js'), appSource);
    fs.writeFileSync(path.join(manifestDir, 'upstream-fingerprints.json'), JSON.stringify({
      version: '0.6.17',
      fingerprints: {
        'dist/src/app.js': crypto.createHash('sha256').update(appSource).digest('hex'),
      },
    }));

    const result = spawnSync(process.execPath, [
      path.join(scriptDir, 'verify-upstream.js'),
      '--version', '0.6.17',
      '--manifest-dir', path.join(tempRoot, 'fingerprints'),
      upstreamRoot,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Kikoeru 0\.6\.17; 1 fingerprints match/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
