'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(1, ms)));
}

function nonNegativeInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(0, Math.floor(number)));
}

function normalizeOptions(options = {}) {
  return {
    path: path.resolve(String(options.path || path.join(process.cwd(), 'sqlite', 'strm-helper-budget.json'))),
    minIntervalMs: nonNegativeInt(options.minIntervalMs, 1000, 60 * 1000),
    perMinute: Math.max(1, nonNegativeInt(options.perMinute, 30, 100000)),
    perHour: Math.max(1, nonNegativeInt(options.perHour, 1800, 1000000)),
    lockTimeoutMs: Math.max(1000, nonNegativeInt(options.lockTimeoutMs, 30000, 5 * 60 * 1000)),
  };
}

async function readBudget(filePath) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    return { starts: Array.isArray(parsed && parsed.starts) ? parsed.starts.map(Number).filter(Number.isFinite) : [] };
  } catch (error) {
    if (error.code !== 'ENOENT') return { starts: [] };
    return { starts: [] };
  }
}

async function writeBudget(filePath, starts) {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(tempPath, `${JSON.stringify({ version: 1, starts })}\n`, { mode: 0o600 });
    await fs.promises.rename(tempPath, filePath);
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function withFileLock(lockPath, timeoutMs, task) {
  const startedAt = Date.now();
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
  while (true) {
    let handle;
    try {
      handle = await fs.promises.open(lockPath, 'wx', 0o600);
      try {
        return await task();
      } finally {
        await handle.close().catch(() => undefined);
        await fs.promises.unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (error.code !== 'EEXIST') throw error;
      const stat = await fs.promises.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > timeoutMs) {
        await fs.promises.unlink(lockPath).catch(() => undefined);
      }
      if (Date.now() - startedAt > timeoutMs * 2) {
        const timeout = new Error('shared Helper rate lock timed out');
        timeout.code = 'SHARED_HELPER_LOCK_TIMEOUT';
        throw timeout;
      }
      await sleep(25);
    }
  }
}

function nextDelay(starts, now, options) {
  const hourCutoff = now - 60 * 60 * 1000;
  const minuteCutoff = now - 60 * 1000;
  const recent = starts.filter(value => value > hourCutoff).sort((a, b) => a - b);
  const minute = recent.filter(value => value > minuteCutoff);
  let delay = 0;
  if (recent.length >= options.perHour) delay = Math.max(delay, recent[0] + 60 * 60 * 1000 - now);
  if (minute.length >= options.perMinute) delay = Math.max(delay, minute[0] + 60 * 1000 - now);
  if (recent.length) delay = Math.max(delay, recent[recent.length - 1] + options.minIntervalMs - now);
  return { starts: recent, delay };
}

async function acquireSharedHelperSlot(options = {}) {
  const normalized = normalizeOptions(options);
  const lockPath = `${normalized.path}.lock`;
  while (true) {
    const result = await withFileLock(lockPath, normalized.lockTimeoutMs, async () => {
      const now = Date.now();
      const state = await readBudget(normalized.path);
      const budget = nextDelay(state.starts, now, normalized);
      if (budget.delay > 0) return budget;
      budget.starts.push(now);
      await writeBudget(normalized.path, budget.starts);
      return { starts: budget.starts, delay: 0, granted: true };
    });
    if (result.granted) return normalized;
    await sleep(Math.min(60 * 1000, Math.max(25, result.delay)));
  }
}

async function withSharedHelperRate(options, task) {
  if (!options || !options.path) return task();
  await acquireSharedHelperSlot(options);
  return task();
}

async function sharedHelperStatus(options = {}) {
  const normalized = normalizeOptions(options);
  const state = await readBudget(normalized.path);
  const budget = nextDelay(state.starts, Date.now(), normalized);
  const now = Date.now();
  const minuteCutoff = now - 60 * 1000;
  return {
    minuteUsed: budget.starts.filter(value => value > minuteCutoff).length,
    hourUsed: budget.starts.length,
    minuteRemaining: Math.max(0, normalized.perMinute - budget.starts.filter(value => value > minuteCutoff).length),
    hourRemaining: Math.max(0, normalized.perHour - budget.starts.length),
    nextAvailableInMs: Math.max(0, budget.delay),
    lastStartedAt: budget.starts.length ? budget.starts[budget.starts.length - 1] : 0,
  };
}

module.exports = {
  normalizeOptions,
  acquireSharedHelperSlot,
  withSharedHelperRate,
  sharedHelperStatus,
};
