'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const installScript = path.join(projectRoot, 'scripts', 'install.sh');
const manageScript = path.join(projectRoot, 'scripts', 'manage.sh');
const upstreamDigest = 'sha256:e78de6e4ac3eb8dbddffc84b31b3f10b809cb2baf3944fd3a5bfe0e5daa77391';

function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { mode: 0o700 });
  fs.chmodSync(filePath, 0o700);
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kikoeru-install-tools-'));
  const bin = path.join(root, 'bin');
  const media = path.join(root, 'media');
  fs.mkdirSync(bin);
  fs.mkdirSync(media);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'docker-compose.yml'), 'services:\n  kikoeru-strm:\n    image: test\n');
  writeExecutable(path.join(root, 'scripts', 'build-overlay.sh'), `#!/usr/bin/env bash
printf 'build-overlay %s %s\\n' "$KIKOERU_UPSTREAM_IMAGE" "$KIKOERU_STRM_IMAGE" >> "$MOCK_LOG"
`);
  writeExecutable(path.join(bin, 'docker'), `#!/usr/bin/env bash
set -eu
printf 'docker' >> "$MOCK_LOG"
for arg in "$@"; do printf ' <%s>' "$arg" >> "$MOCK_LOG"; done
printf '\\n' >> "$MOCK_LOG"
if [[ "\${1:-}" == compose ]]; then
  if [[ "\${2:-}" == --env-file ]]; then shift 2; fi
  [[ "\${1:-}" == version ]] && exit 0
  exit 0
fi
if [[ "\${1:-}" == image && "\${2:-}" == inspect ]]; then
  [[ "\${MOCK_MISSING_IMAGE:-}" == "\${3:-}" ]] && exit 1
  exit 0
fi
if [[ "\${1:-}" == inspect ]]; then
  for arg in "$@"; do
    if [[ "$arg" == *Health.Status* ]]; then printf 'healthy'; fi
  done
  exit 0
fi
exit 0
`);
  writeExecutable(path.join(bin, 'npm'), `#!/usr/bin/env bash
printf 'npm' >> "$MOCK_LOG"
for arg in "$@"; do printf ' <%s>' "$arg" >> "$MOCK_LOG"; done
printf '\\n' >> "$MOCK_LOG"
`);
  writeExecutable(path.join(bin, 'curl'), `#!/usr/bin/env bash
printf 'curl' >> "$MOCK_LOG"
for arg in "$@"; do printf ' <%s>' "$arg" >> "$MOCK_LOG"; done
printf '\\n' >> "$MOCK_LOG"
`);
  writeExecutable(path.join(bin, 'ss'), `#!/usr/bin/env bash
if [[ -n "\${MOCK_LISTEN_PORT:-}" ]]; then
  printf 'LISTEN 0 128 0.0.0.0:%s 0.0.0.0:*\\n' "$MOCK_LISTEN_PORT"
fi
`);
  const log = path.join(root, 'commands.log');
  fs.writeFileSync(log, '');
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    MOCK_LOG: log,
    KIKOERU_PROJECT_DIR: root,
    KIKOERU_HEALTH_TIMEOUT_SEC: '2',
  };
  return { root, bin, media, log, env };
}

function run(script, args, fixture, extraEnv = {}) {
  return spawnSync(script, args, {
    cwd: fixture.root,
    env: { ...fixture.env, ...extraEnv },
    encoding: 'utf8',
  });
}

function logText(fixture) {
  return fs.readFileSync(fixture.log, 'utf8');
}

test('install generates a private env and scopes mocked lifecycle commands', () => {
  const fixture = makeFixture();
  try {
    const result = run(installScript, [
      '--media', fixture.media,
      '--helper', 'helper.example.test:13258',
      '--port', '32123',
      '--image', 'kikoeru-strm:test-20260907',
    ], fixture);
    assert.equal(result.status, 0, result.stderr);

    const envPath = path.join(fixture.root, '.env');
    const envText = fs.readFileSync(envPath, 'utf8');
    assert.match(envText, new RegExp('KIKOERU_UPSTREAM_IMAGE=number17/kikoeru@' + upstreamDigest.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')));
    assert.match(envText, /KIKOERU_STRM_IMAGE=kikoeru-strm:test-20260907/);
    assert.match(envText, /KIKOERU_STRM_PORT=32123/);
    assert.match(envText, /KIKOERU_STRM_MEDIA_DIR='.*media'/);
    assert.match(envText, /STRM_ALLOWED_HOSTS='helper\.example\.test:13258'/);
    assert.doesNotMatch(envText, /FINAL_ALLOWED_HOSTS/);
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
    for (const dir of ['config', 'sqlite', 'covers', 'cache']) {
      assert.equal(fs.statSync(path.join(fixture.root, 'deploy', 'runtime', dir)).isDirectory(), true);
    }

    const log = logText(fixture);
    assert.match(log, /npm <test>/);
    assert.match(log, /docker <compose> .*<config>/);
    assert.match(log, /docker <compose> .*<up> <-d> <--no-build> <--force-recreate> <kikoeru-strm>/);
    assert.doesNotMatch(log, /<kikoeru>\s/);
    assert.doesNotMatch(log, /<down>|<rm>|<prune>/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('install defaults to the 0.2.6 image', () => {
  const fixture = makeFixture();
  try {
    const result = run(installScript, [
      '--media', fixture.media,
      '--helper', 'helper.example.test:13258',
      '--port', '32123',
    ], fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(path.join(fixture.root, '.env'), 'utf8'),
      /KIKOERU_STRM_IMAGE=kikoeru-strm:0\.2\.6/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('install refuses overwrite, invalid helper/port, and occupied port before Docker work', () => {
  const fixture = makeFixture();
  try {
    const invalidHelper = run(installScript, ['--media', fixture.media, '--helper', 'https://helper.test:1'], fixture);
    assert.notEqual(invalidHelper.status, 0);
    assert.match(invalidHelper.stderr, /host\[:port\]|scheme|path/i);
    assert.equal(logText(fixture), '');

    const invalidPort = run(installScript, ['--media', fixture.media, '--helper', 'helper.test', '--port', '65536'], fixture);
    assert.notEqual(invalidPort.status, 0);
    assert.match(invalidPort.stderr, /1 to 65535/);

    const occupied = run(installScript, ['--media', fixture.media, '--helper', 'helper.test', '--port', '32123'], fixture, { MOCK_LISTEN_PORT: '32123' });
    assert.notEqual(occupied.status, 0);
    assert.match(occupied.stderr, /already in use/);
    assert.equal(fs.existsSync(path.join(fixture.root, '.env')), false);

    const first = run(installScript, ['--media', fixture.media, '--helper', 'helper.test', '--port', '32123'], fixture);
    assert.equal(first.status, 0, first.stderr);
    const envPath = path.join(fixture.root, '.env');
    const before = fs.readFileSync(envPath, 'utf8');
    const second = run(installScript, ['--media', fixture.media, '--helper', 'other.test', '--port', '32124'], fixture);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /already exists|--force/);
    assert.equal(fs.readFileSync(envPath, 'utf8'), before);
    const forced = run(installScript, ['--force', '--media', fixture.media, '--helper', 'other.test', '--port', '32124'], fixture);
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(fs.readFileSync(envPath, 'utf8'), /STRM_ALLOWED_HOSTS='other\.test'/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('manage lifecycle commands update only the target image/service and refuse purge', () => {
  const fixture = makeFixture();
  try {
    const install = run(installScript, ['--media', fixture.media, '--helper', 'helper.test', '--port', '32123'], fixture);
    assert.equal(install.status, 0, install.stderr);
    fs.writeFileSync(fixture.log, '');

    for (const command of [['status'], ['start'], ['stop']]) {
      const result = run(manageScript, command, fixture);
      assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    }
    const envPath = path.join(fixture.root, '.env');
    const oldTag = 'kikoeru-strm:0.1.4';
    fs.writeFileSync(envPath, fs.readFileSync(envPath, 'utf8').replace(
      'KIKOERU_STRM_IMAGE=kikoeru-strm:0.2.6', `KIKOERU_STRM_IMAGE=${oldTag}`,
    ));
    fs.writeFileSync(fixture.log, '');
    const defaultUpgrade = run(manageScript, ['upgrade'], fixture);
    assert.equal(defaultUpgrade.status, 0, defaultUpgrade.stderr);
    assert.match(fs.readFileSync(envPath, 'utf8'), /KIKOERU_STRM_IMAGE=kikoeru-strm:0\.2\.6/);
    assert.match(logText(fixture), /build-overlay .*kikoeru-strm:0\.2\.6/);
    assert.doesNotMatch(logText(fixture), /build-overlay .*kikoeru-strm:0\.1\.4/);

    const upgraded = run(manageScript, ['upgrade', '--image', 'kikoeru-strm:older-20260907'], fixture);
    assert.equal(upgraded.status, 0, upgraded.stderr);
    assert.match(fs.readFileSync(envPath, 'utf8'), /KIKOERU_STRM_IMAGE=kikoeru-strm:older-20260907/);

    const missing = run(manageScript, ['rollback', '--image', 'kikoeru-strm:not-present'], fixture, { MOCK_MISSING_IMAGE: 'kikoeru-strm:not-present' });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /does not exist/);
    assert.match(fs.readFileSync(envPath, 'utf8'), /KIKOERU_STRM_IMAGE=kikoeru-strm:older-20260907/);

    const rollback = run(manageScript, ['rollback', '--image', 'kikoeru-strm:rollback-20260907'], fixture);
    assert.equal(rollback.status, 0, rollback.stderr);
    const beforeUninstall = logText(fixture);
    const uninstall = run(manageScript, ['uninstall'], fixture);
    assert.equal(uninstall.status, 0, uninstall.stderr);
    const afterUninstall = logText(fixture);
    assert.match(afterUninstall, /docker <compose> .*<down>/);
    assert.doesNotMatch(afterUninstall, /<-v>|<--remove-orphans>|<rm>|<prune>/);
    assert.equal(fs.existsSync(path.join(fixture.root, 'deploy', 'runtime')), true);
    assert.notEqual(beforeUninstall, afterUninstall);

    const purge = run(manageScript, ['uninstall', '--purge-data'], fixture);
    assert.notEqual(purge.status, 0);
    assert.match(purge.stderr, /refused|never deleted/i);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('compose and env templates expose only configurable Helper hosts', () => {
  const compose = fs.readFileSync(path.join(projectRoot, 'docker-compose.yml'), 'utf8');
  const envExample = fs.readFileSync(path.join(projectRoot, '.env.example'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(projectRoot, 'Dockerfile'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.match(compose, /KIKOERU_STRM_PORT/);
  assert.match(compose, /KIKOERU_STRM_MEDIA_DIR/);
  assert.match(compose, /STRM_ALLOWED_HOSTS/);
  assert.match(compose, /STRM_LOUDNESS_METHOD: ebur128/);
  assert.match(envExample, /STRM loudness always uses native read-only ebur128/);
  assert.doesNotMatch(compose, /STRM_FINAL_ALLOWED_HOSTS/);
  assert.doesNotMatch(envExample, /STRM_FINAL_ALLOWED_HOSTS/);
  assert.match(envExample, /KIKOERU_STRM_PORT=12346/);
  assert.match(envExample, /KIKOERU_STRM_IMAGE=kikoeru-strm:0\.2\.6/);
  assert.match(compose, /kikoeru-strm:0\.2\.6/);
  assert.match(compose, /sha256:e78de6e4ac3eb8dbddffc84b31b3f10b809cb2baf3944fd3a5bfe0e5daa77391/);
  assert.match(dockerfile, /COPY patches\/0\.6\.17\/strm-adapter/);
  assert.match(dockerfile, /--version 0\.6\.17/);
  assert.equal(packageJson.version, '0.2.6');
  assert.match(envExample, /host\[:port\].*no|host\[:port\]/i);
});

test('shell syntax is valid for lifecycle tools', () => {
  execFileSync('bash', ['-n', path.join(projectRoot, 'scripts', 'install.sh')]);
  execFileSync('bash', ['-n', path.join(projectRoot, 'scripts', 'manage.sh')]);
});
