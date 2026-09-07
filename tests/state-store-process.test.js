'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const stateStorePath = path.resolve(__dirname, '../patches/0.6.15/strm-adapter/state-store.js');
const { StrmStateStore } = require(stateStorePath);

const workerSource = `
  const fs = require('node:fs');
  const { StrmStateStore } = require(${JSON.stringify(stateStorePath)});
  (async () => {
    const store = new StrmStateStore(process.env.STRM_STATE_PATH);
    await store.init();
    fs.writeFileSync(process.env.STRM_READY_PATH, process.env.STRM_KEY);
    while (!fs.existsSync(process.env.STRM_GO_PATH)) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await store.upsert(process.env.STRM_KEY, JSON.parse(process.env.STRM_PATCH));
  })().catch(error => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
`;

function spawnWorker({ statePath, readyPath, goPath, key, patch }) {
  const child = spawn(process.execPath, ['-e', workerSource], {
    env: Object.assign({}, process.env, {
      STRM_STATE_PATH: statePath,
      STRM_READY_PATH: readyPath,
      STRM_GO_PATH: goPath,
      STRM_KEY: key,
      STRM_PATCH: JSON.stringify(patch),
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stderr }));
  });
  return { child, done };
}

async function waitForFiles(files, workers, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (workers.some(worker => worker.child.exitCode !== null)) {
      throw new Error('state worker exited before the barrier was released');
    }
    if (await Promise.all(files.map(file => fs.access(file).then(() => true).catch(() => false))).then(values => values.every(Boolean))) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for state workers: ${files.join(', ')}`);
}

async function stopWorkers(workers) {
  for (const worker of workers) {
    if (worker.child.exitCode === null) worker.child.kill();
  }
  await Promise.all(workers.map(worker => worker.done.catch(() => undefined)));
}

test('state store merges concurrent worker upserts for different keys', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kikoeru-strm-state-process-'));
  const statePath = path.join(tempRoot, 'state.json');
  const goPath = path.join(tempRoot, 'go');
  const workers = [
    spawnWorker({ statePath, goPath, key: 'worker-a', patch: { worker: 'a' }, readyPath: path.join(tempRoot, 'ready-a') }),
    spawnWorker({ statePath, goPath, key: 'worker-b', patch: { worker: 'b' }, readyPath: path.join(tempRoot, 'ready-b') }),
  ];
  try {
    await waitForFiles([path.join(tempRoot, 'ready-a'), path.join(tempRoot, 'ready-b')], workers);
    await fs.writeFile(goPath, 'go');
    const results = await Promise.all(workers.map(worker => worker.done));
    assert.deepEqual(results.map(result => result.code), [0, 0], results.map(result => result.stderr).join('\n'));
    const records = await new StrmStateStore(statePath).list();
    assert.deepEqual(new Set(records.map(record => record.key)), new Set(['worker-a', 'worker-b']));
    assert.deepEqual(new Set(records.map(record => record.worker)), new Set(['a', 'b']));
  } finally {
    await stopWorkers(workers);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('state store atomically merges same-key patches and refreshes readers', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kikoeru-strm-state-refresh-'));
  const statePath = path.join(tempRoot, 'state.json');
  const goPath = path.join(tempRoot, 'go');
  const workers = [
    spawnWorker({ statePath, goPath, key: 'shared', patch: { fromA: true }, readyPath: path.join(tempRoot, 'ready-a') }),
    spawnWorker({ statePath, goPath, key: 'shared', patch: { fromB: true }, readyPath: path.join(tempRoot, 'ready-b') }),
  ];
  try {
    await waitForFiles([path.join(tempRoot, 'ready-a'), path.join(tempRoot, 'ready-b')], workers);
    await fs.writeFile(goPath, 'go');
    const results = await Promise.all(workers.map(worker => worker.done));
    assert.deepEqual(results.map(result => result.code), [0, 0], results.map(result => result.stderr).join('\n'));
    const first = new StrmStateStore(statePath);
    const second = new StrmStateStore(statePath);
    await first.init();
    assert.equal((await first.get('shared')).fromA || (await first.get('shared')).fromB, true);
    assert.equal((await second.get('shared')).fromA, true);
    assert.equal((await second.get('shared')).fromB, true);

    await first.upsert('remove-me', { value: 1 });
    assert.equal(await second.remove('remove-me'), true);
    assert.equal(await first.remove('remove-me'), false);
    await second.clear();
    assert.deepEqual(await first.list(), []);
  } finally {
    await stopWorkers(workers);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('state store recovers a stale lock without overwriting a corrupt state file', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kikoeru-strm-state-lock-'));
  const statePath = path.join(tempRoot, 'state.json');
  const lockPath = `${statePath}.lock`;
  try {
    await fs.writeFile(lockPath, JSON.stringify({ pid: 1, token: 'stale' }));
    const old = new Date(Date.now() - 5 * 60 * 1000);
    await fs.utimes(lockPath, old, old);
    const store = new StrmStateStore(statePath);
    await store.upsert('fresh', { value: true });
    assert.equal((await store.get('fresh')).value, true);

    await fs.writeFile(statePath, '{not-json');
    await assert.rejects(store.upsert('must-fail', { value: true }), error => error.code === 'STATE_CORRUPT');
    const raw = await fs.readFile(statePath, 'utf8');
    assert.equal(raw, '{not-json');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
