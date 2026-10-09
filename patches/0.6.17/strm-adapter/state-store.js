'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LOCK_WAIT_MS = 30 * 1000;
const LOCK_STALE_MS = 2 * 60 * 1000;
const LOCK_POLL_MS = 25;
const SNAPSHOT_RETRIES = 3;

function makeRecordKey(rootFolder, relativePath) {
  return crypto.createHash('sha256')
    .update(`${String(rootFolder)}\0${String(relativePath).replace(/\\/g, '/')}`)
    .digest('hex');
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function emptyState() {
  return { version: 1, records: {} };
}

function stateError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function numeric(value) {
  return typeof value === 'bigint' ? Number(value) : Number(value || 0);
}

function makeStamp(stat) {
  return stat ? {
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
    size: Number(stat.size),
    ino: numeric(stat.ino),
  } : null;
}

function sameStamp(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.size === right.size
    && left.ino === right.ino;
}

async function statStamp(filePath) {
  try {
    return makeStamp(await fs.promises.stat(filePath));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function parseState(content, filePath) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw stateError('STATE_CORRUPT', `STRM state JSON is invalid: ${filePath}`, error);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || !parsed.records || typeof parsed.records !== 'object' || Array.isArray(parsed.records)) {
    throw stateError('STATE_INVALID', `STRM state shape is invalid: ${filePath}`);
  }
  return { version: 1, records: parsed.records };
}

/** Read a coherent snapshot, retrying if an atomic replacement races the read. */
async function readDiskState(filePath) {
  for (let attempt = 0; attempt < SNAPSHOT_RETRIES; attempt += 1) {
    const before = await statStamp(filePath);
    let content;
    try {
      content = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (!before) return { state: emptyState(), stamp: null };
        continue;
      }
      throw error;
    }
    const after = await statStamp(filePath);
    if (!after || (before && !sameStamp(before, after))) continue;
    const state = parseState(content, filePath);
    const finalStamp = await statStamp(filePath);
    if (!finalStamp || !sameStamp(after, finalStamp)) continue;
    return { state, stamp: finalStamp };
  }
  throw stateError('STATE_CHANGED_DURING_READ', `STRM state changed while reading: ${filePath}`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function isStaleLock(lockPath) {
  const stamp = await statStamp(lockPath);
  return !stamp || Date.now() - stamp.mtimeMs > LOCK_STALE_MS;
}

async function acquireLock(lockPath) {
  const startedAt = Date.now();
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
  while (true) {
    const token = crypto.randomBytes(16).toString('hex');
    let handle = null;
    let created = false;
    try {
      handle = await fs.promises.open(lockPath, 'wx', 0o600);
      created = true;
      await handle.writeFile(`${JSON.stringify({ version: 1, pid: process.pid, createdAt: Date.now(), token })}\n`);
      await handle.sync();
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          let closeError = null;
          try {
            await handle.close();
          } catch (error) {
            closeError = error;
          }
          try {
            const current = JSON.parse(await fs.promises.readFile(lockPath, 'utf8'));
            if (current && current.token === token) await fs.promises.unlink(lockPath);
          } catch (error) {
            if (error.code !== 'ENOENT' && !closeError) closeError = error;
          }
          if (closeError) throw closeError;
        },
      };
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (created) await fs.promises.rm(lockPath, { force: true }).catch(() => undefined);
      if (error.code !== 'EEXIST') throw error;
    }

    if (await isStaleLock(lockPath)) {
      await fs.promises.unlink(lockPath).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      continue;
    }
    if (Date.now() - startedAt >= LOCK_WAIT_MS) {
      throw stateError('STATE_LOCK_TIMEOUT', `timed out waiting for STRM state lock: ${lockPath}`);
    }
    await delay(LOCK_POLL_MS);
  }
}

async function writeAtomic(filePath, state) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let handle = null;
  try {
    handle = await fs.promises.open(tempPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(tempPath, filePath);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Atomic JSON state shared by the main process and scanner forks. Every
 * mutation obtains an exclusive lock, rereads the latest disk snapshot, and
 * atomically replaces the file with a process-unique temporary file.
 */
class StrmStateStore {
  constructor(filePath) {
    this.filePath = path.resolve(String(filePath));
    this.lockPath = `${this.filePath}.lock`;
    this.state = emptyState();
    this.loaded = false;
    this.initPromise = null;
    this.diskStamp = null;
    this.writeChain = Promise.resolve();
  }

  _setSnapshot(snapshot) {
    this.state = snapshot.state;
    this.diskStamp = snapshot.stamp;
    this.loaded = true;
  }

  async init() {
    if (this.loaded) return this;
    if (!this.initPromise) {
      this.initPromise = readDiskState(this.filePath)
        .then(snapshot => {
          this._setSnapshot(snapshot);
          return this;
        })
        .finally(() => { this.initPromise = null; });
    }
    return this.initPromise;
  }

  async _refresh() {
    const currentStamp = await statStamp(this.filePath);
    if (sameStamp(currentStamp, this.diskStamp)) return;
    this._setSnapshot(await readDiskState(this.filePath));
  }

  async _prepareRead() {
    await this.init();
    // A failed mutation is reported to its caller; do not let it permanently
    // poison later writes or prevent reads of the last valid disk snapshot.
    await this.writeChain.catch(() => undefined);
    await this._refresh();
  }

  _enqueueWrite(mutator) {
    const operation = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        const lock = await acquireLock(this.lockPath);
        try {
          const latest = await readDiskState(this.filePath);
          const result = await mutator(latest.state);
          if (result.changed) {
            await writeAtomic(this.filePath, result.state);
            const stamp = await statStamp(this.filePath);
            if (!stamp) throw stateError('STATE_WRITE_MISSING', `STRM state disappeared after write: ${this.filePath}`);
            this._setSnapshot({ state: result.state, stamp });
          } else {
            this._setSnapshot(latest);
          }
          return result.value;
        } finally {
          await lock.release();
        }
      });
    this.writeChain = operation;
    return operation;
  }

  async get(key) {
    await this._prepareRead();
    return clone(this.state.records[String(key)]) || null;
  }

  async getByPath(rootFolder, relativePath) {
    return this.get(makeRecordKey(rootFolder, relativePath));
  }

  async upsert(key, patchOrRecord) {
    await this.init();
    const normalizedKey = String(key);
    return this._enqueueWrite(state => {
      const current = state.records[normalizedKey] || { key: normalizedKey };
      const record = Object.assign({}, current, clone(patchOrRecord), {
        key: normalizedKey,
        updatedAt: Date.now(),
      });
      state.records[normalizedKey] = record;
      return { changed: true, value: clone(record), state };
    });
  }

  /**
   * Update a record only while its pointer identity still matches the caller's
   * snapshot. The comparison and write share the file lock, so scanner forks
   * cannot interleave a newer pointer generation between them.
   *
   * Returns `{ updated, record }`; a probe-only record uses its probe
   * fingerprint as the identity until a cache record adds pointerFingerprint.
   */
  async compareAndUpsert(key, expectedFingerprint, patchOrRecord) {
    await this.init();
    const normalizedKey = String(key);
    const expected = expectedFingerprint == null ? null : String(expectedFingerprint);
    return this._enqueueWrite(state => {
      const current = state.records[normalizedKey] || null;
      let actual = null;
      if (current && Object.prototype.hasOwnProperty.call(current, 'pointerFingerprint')) {
        actual = current.pointerFingerprint == null ? null : String(current.pointerFingerprint);
      } else if (current && current.probeFingerprint != null) {
        actual = String(current.probeFingerprint);
      }
      if (actual !== expected) {
        return { changed: false, value: { updated: false, record: clone(current) }, state };
      }
      const record = Object.assign({}, current || { key: normalizedKey }, clone(patchOrRecord), {
        key: normalizedKey,
        updatedAt: Date.now(),
      });
      state.records[normalizedKey] = record;
      return { changed: true, value: { updated: true, record: clone(record) }, state };
    });
  }

  async remove(key) {
    await this.init();
    const normalizedKey = String(key);
    return this._enqueueWrite(state => {
      const existed = Object.prototype.hasOwnProperty.call(state.records, normalizedKey);
      if (existed) delete state.records[normalizedKey];
      return { changed: existed, value: existed, state };
    });
  }

  async list() {
    await this._prepareRead();
    return Object.values(this.state.records).map(clone);
  }

  async clear() {
    await this.init();
    return this._enqueueWrite(state => {
      state.records = {};
      return { changed: true, value: undefined, state };
    });
  }
}

module.exports = { StrmStateStore, makeRecordKey };
