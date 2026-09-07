'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const adapterDir = path.resolve(__dirname, '../patches/0.6.15/strm-adapter');
const {
  FINAL_ALLOWED_HOSTS,
  RUNTIME_SYMBOL,
  createRuntime,
  defaultStrmConfig,
  mergePublicStrmConfig,
  normalizeHelperHosts,
  publicStrmConfig,
} = require(path.join(adapterDir, 'integration'));
const {
  FINAL_ALLOWED_HOSTS: POINTER_FINAL_ALLOWED_HOSTS,
  hostMatches,
  parsePointerText,
} = require(path.join(adapterDir, 'pointer'));
const { configuredHelperHosts } = require(path.resolve(__dirname, '../scripts/strm-entrypoint'));

function rememberEnv(names) {
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  return () => {
    for (const name of names) {
      if (saved[name] == null) delete process.env[name];
      else process.env[name] = saved[name];
    }
  };
}

async function writeConfigRoot(config) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kikoeru-strm-config-contract-'));
  await fs.promises.mkdir(path.join(root, 'dist/src'), { recursive: true });
  await fs.promises.writeFile(path.join(root, 'dist/src/config.js'), [
    `const config = ${JSON.stringify(config)};`,
    'module.exports = { config, setNewConfigValue() {} };',
  ].join('\n'));
  return root;
}

async function closeRuntime(runtime) {
  if (!runtime) return;
  await runtime.ready.catch(() => undefined);
  runtime.cache.close();
  runtime.queue.close();
  delete global[RUNTIME_SYMBOL];
}

test('Helper configuration is deployment-owned and the CDN boundary is fixed', async () => {
  const restoreEnv = rememberEnv(['STRM_ALLOWED_HOSTS', 'STRM_FINAL_ALLOWED_HOSTS']);
  const root = await writeConfigRoot({
    databaseFolderDir: '', rootFolders: [],
    strm: { allowedHosts: ['config.helper'], finalAllowedHosts: ['evil.example'] },
  });
  let runtime;
  try {
    delete process.env.STRM_ALLOWED_HOSTS;
    delete process.env.STRM_FINAL_ALLOWED_HOSTS;
    const defaults = defaultStrmConfig(root, { databaseFolderDir: root, strm: {} });
    assert.deepEqual(defaults.allowedHosts, []);
    assert.deepEqual(defaults.finalAllowedHosts, ['.115cdn.net']);
    assert.deepEqual(configuredHelperHosts(), []);
    assert.deepEqual(configuredHelperHosts('one.example, TWO.example'), ['one.example', 'TWO.example']);

    process.env.STRM_ALLOWED_HOSTS = 'env.helper, ENV-TWO.helper';
    process.env.STRM_FINAL_ALLOWED_HOSTS = 'evil.example';
    runtime = createRuntime(root);
    assert.deepEqual(runtime.options.allowedHosts, ['env.helper', 'env-two.helper']);
    assert.deepEqual(runtime.options.finalAllowedHosts, FINAL_ALLOWED_HOSTS);
    assert.deepEqual(runtime.config.strm.allowedHosts, ['env.helper', 'env-two.helper']);
    assert.deepEqual(runtime.config.strm.finalAllowedHosts, FINAL_ALLOWED_HOSTS);
    assert.deepEqual(runtime.redirectOptions().finalAllowedHosts, FINAL_ALLOWED_HOSTS);
    assert.deepEqual(publicStrmConfig({ finalAllowedHosts: ['evil.example'] }).finalAllowedHosts, FINAL_ALLOWED_HOSTS);
  } finally {
    await closeRuntime(runtime);
    restoreEnv();
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('Missing or unsafe Helper allowlists fail closed at startup and API boundaries', async () => {
  const restoreEnv = rememberEnv(['STRM_ALLOWED_HOSTS', 'STRM_FINAL_ALLOWED_HOSTS']);
  const missingRoot = await writeConfigRoot({ databaseFolderDir: '', rootFolders: [], strm: {} });
  const invalidRoot = await writeConfigRoot({ databaseFolderDir: '', rootFolders: [], strm: { allowedHosts: ['*'] } });
  try {
    delete process.env.STRM_ALLOWED_HOSTS;
    assert.throws(() => createRuntime(missingRoot), error => error.code === 'HELPER_HOST_REQUIRED');
    assert.throws(() => createRuntime(invalidRoot), error => error.code === 'HELPER_HOST_INVALID');
    assert.throws(() => normalizeHelperHosts([]), error => error.code === 'HELPER_HOST_REQUIRED');
    assert.throws(() => normalizeHelperHosts(['*']), error => error.code === 'HELPER_HOST_INVALID');
    assert.throws(() => normalizeHelperHosts(['https://helper.example/path']), error => error.code === 'HELPER_HOST_INVALID');
    assert.throws(() => normalizeHelperHosts(['helper.example:70000']), error => error.code === 'HELPER_HOST_INVALID');

    const current = { allowedHosts: ['helper.example'], finalAllowedHosts: FINAL_ALLOWED_HOSTS };
    assert.throws(() => mergePublicStrmConfig(current, { finalAllowedHosts: ['evil.example'] }), error => (
      error.code === 'FINAL_HOSTS_FIXED' && error.status === 400
    ));
    assert.throws(() => mergePublicStrmConfig(current, { allowedHosts: [] }), error => error.code === 'HELPER_HOST_REQUIRED');
    assert.throws(() => mergePublicStrmConfig(current, { allowedHosts: ['*'] }), error => error.code === 'HELPER_HOST_INVALID');
    assert.deepEqual(mergePublicStrmConfig(current, { allowedHosts: ['NEW.Helper'] }).allowedHosts, ['new.helper']);
  } finally {
    delete global[RUNTIME_SYMBOL];
    restoreEnv();
    await fs.promises.rm(missingRoot, { recursive: true, force: true });
    await fs.promises.rm(invalidRoot, { recursive: true, force: true });
  }
});

test('Pointer host matching fails closed for empty and wildcard lists', () => {
  assert.deepEqual(FINAL_ALLOWED_HOSTS, POINTER_FINAL_ALLOWED_HOSTS);
  assert.equal(hostMatches('https://helper.example/path', []), false);
  assert.equal(hostMatches('https://helper.example/path', ['*']), false);
  assert.throws(() => parsePointerText('https://helper.example/path', { allowedHosts: [] }), error => error.code === 'HOST_ALLOWLIST_REQUIRED');
  assert.throws(() => parsePointerText('https://helper.example/path', { allowedHosts: ['*'] }), error => error.code === 'HOST_ALLOWLIST_INVALID');
});
