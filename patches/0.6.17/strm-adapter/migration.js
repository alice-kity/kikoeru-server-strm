'use strict';

const fs = require('fs');
const path = require('path');
const { makeRecordKey } = require('./state-store');

const LEGACY_STATE_BASENAME = 'strm-state.json';
const NEW_STATE_BASENAME = 'strm-state-v2.json';
const snapshotCache = new Map();

function normalizeRelPath(value) {
  const raw = String(value || '').replace(/\\/g, '/');
  if (!raw || raw === '.') return '';
  return path.posix.normalize(raw).replace(/^\.\//, '');
}

function resolveLegacyStatePath(runtime = {}) {
  const explicit = runtime.options && runtime.options.legacyStatePath;
  if (explicit) return path.resolve(String(explicit));
  const current = runtime.options && runtime.options.statePath;
  if (!current) return null;
  const resolved = path.resolve(String(current));
  if (path.basename(resolved) !== NEW_STATE_BASENAME) return null;
  return path.join(path.dirname(resolved), LEGACY_STATE_BASENAME);
}

function fileStamp(stat) {
  return stat ? [Number(stat.mtimeMs), Number(stat.ctimeMs), Number(stat.size), Number(stat.ino || 0)].join(':') : null;
}

async function readLegacyStateFile(filePath) {
  if (!filePath) return { records: {}, sourcePath: null };
  let before;
  let after;
  try {
    before = await fs.promises.stat(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { records: {}, sourcePath: filePath };
    throw error;
  }
  const stamp = fileStamp(before);
  const cached = snapshotCache.get(filePath);
  if (cached && cached.stamp === stamp) return cached.snapshot;

  const content = await fs.promises.readFile(filePath, 'utf8');
  after = await fs.promises.stat(filePath).catch(() => null);
  if (!after || fileStamp(after) !== stamp) {
    const error = new Error('legacy STRM state changed while reading');
    error.code = 'LEGACY_STATE_CHANGED_DURING_READ';
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    const error = new Error('legacy STRM state is invalid JSON');
    error.code = 'LEGACY_STATE_CORRUPT';
    error.cause = cause;
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || !parsed.records || typeof parsed.records !== 'object' || Array.isArray(parsed.records)) {
    const error = new Error('legacy STRM state has an invalid shape');
    error.code = 'LEGACY_STATE_INVALID';
    throw error;
  }
  const snapshot = { records: parsed.records, sourcePath: filePath };
  snapshotCache.set(filePath, { stamp, snapshot });
  return snapshot;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeLegacyRootFolder(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  // 0.6.15 playback records stored the resolved root-folder object, while
  // scanner records stored only its name. Use only `name`; path and other
  // metadata must never affect matching or enter the new database/state.
  return typeof value.name === 'string' ? value.name : '';
}

function isUnderWorkDir(workDir, rootRelativePath) {
  const base = normalizeRelPath(workDir);
  const full = normalizeRelPath(rootRelativePath);
  if (!base) return !!full && full !== '.' && !full.startsWith('../');
  return full === base || full.startsWith(`${base}/`);
}

function relativeToWorkDir(workDir, rootRelativePath) {
  const base = normalizeRelPath(workDir);
  const full = normalizeRelPath(rootRelativePath);
  if (!isUnderWorkDir(base, full)) return null;
  const relative = path.posix.relative(base || '.', full);
  return relative && relative !== '.' && !relative.startsWith('../') ? relative : null;
}

function legacyLufs(record) {
  if (!record || record.loudnessReady !== true || record.loudnessStatus !== 'ready') return null;
  const result = record.loudnorm;
  if (!result || typeof result !== 'object') return null;
  return finiteNumber(result.input_i);
}

function legacyDuration(record) {
  if (!record || record.probeStatus !== 'ok') return null;
  return finiteNumber(record.duration);
}

function logSkip(logger, code) {
  const safeCode = String(code || 'LEGACY_STATE_READ_FAILED').replace(/[^A-Z0-9_-]/gi, '').slice(0, 64) || 'LEGACY_STATE_READ_FAILED';
  logger?.warn?.(`[STRM migration] legacy state not imported (${safeCode})`);
}

/**
 * Import matching 0.6.15 JSON records into native t_track columns. The source
 * stays untouched; native rows are the durable state and make retries safe.
 */
async function migrateLegacyState(options = {}) {
  const { runtime = {}, workId, loc, rows = [], targetForRow, persistDuration, persistLufs, logger } = options;
  if (!loc || !loc.provider || loc.provider.kind !== 'local') {
    return { matched: 0, durationMigrated: 0, lufsMigrated: 0, skipped: 0, sourcePath: null };
  }
  const sourcePath = resolveLegacyStatePath(runtime);
  if (!sourcePath) return { matched: 0, durationMigrated: 0, lufsMigrated: 0, skipped: 0, sourcePath: null };

  let snapshot;
  try {
    snapshot = await (options.readState || readLegacyStateFile)(sourcePath);
  } catch (error) {
    logSkip(logger, error && error.code);
    return { matched: 0, durationMigrated: 0, lufsMigrated: 0, skipped: 1, sourcePath };
  }

  const rootFolderName = String(loc.rootFolderName || '');
  const rowsByPath = new Map(rows
    .filter(row => String(row.ext || '').toLowerCase() === '.strm')
    .map(row => [normalizeRelPath(row.rel_path), row]));
  const counts = { matched: 0, durationMigrated: 0, lufsMigrated: 0, skipped: 0, sourcePath };
  const records = Object.entries(snapshot.records || {});
  for (const [recordKey, record] of records) {
    if (!record || normalizeLegacyRootFolder(record.rootFolder) !== rootFolderName) continue;
    const rootRelativePath = normalizeRelPath(record.relativePath);
    const expectedKey = makeRecordKey(rootFolderName, rootRelativePath);
    if (!record.key || String(record.key) !== expectedKey || String(recordKey) !== expectedKey) {
      counts.skipped += 1;
      continue;
    }
    const relPath = relativeToWorkDir(loc.workRelPath, rootRelativePath);
    if (!relPath) continue;
    const row = rowsByPath.get(relPath);
    if (!row || !record.pointerFingerprint
        || String(record.pointerFingerprint) !== String(row.pointer_fingerprint || '')) {
      counts.skipped += 1;
      continue;
    }
    counts.matched += 1;
    const target = targetForRow ? await targetForRow(row) : null;
    if (!target || target.pointerFingerprint !== String(record.pointerFingerprint)) {
      counts.skipped += 1;
      continue;
    }
    const duration = legacyDuration(record);
    if (duration !== null && (row.duration === null || row.duration === undefined) && typeof persistDuration === 'function') {
      if (await persistDuration(target, duration, { onlyIfEmpty: true, migrated: true })) counts.durationMigrated += 1;
    }
    const lufs = legacyLufs(record);
    if (lufs !== null && (row.lufs === null || row.lufs === undefined) && typeof persistLufs === 'function') {
      if (await persistLufs(target, lufs, { onlyIfEmpty: true, migrated: true })) counts.lufsMigrated += 1;
    }
  }
  return counts;
}

/**
 * Migrate legacy work.memo duration entries. The 0.6.15 adapter stored the
 * exact pointer fingerprint in memo.strm; mtime alone is not sufficient.
 */
async function migrateLegacyMemo(options = {}) {
  const { oldMemo = {}, rows = [], targetForRow, persistDuration } = options;
  const memoDurations = oldMemo.duration && typeof oldMemo.duration === 'object' ? oldMemo.duration : {};
  const memoStrm = oldMemo.strm && typeof oldMemo.strm === 'object' ? oldMemo.strm : {};
  const rowsByPath = new Map(rows
    .filter(row => String(row.ext || '').toLowerCase() === '.strm')
    .map(row => [normalizeRelPath(row.rel_path), row]));
  let migrated = 0;
  for (const [relPathRaw, rawDuration] of Object.entries(memoDurations)) {
    const relPath = normalizeRelPath(relPathRaw);
    const row = rowsByPath.get(relPath);
    const meta = memoStrm[relPathRaw] || memoStrm[relPath];
    if (!row || !meta || !meta.pointerFingerprint
        || String(meta.pointerFingerprint) !== String(row.pointer_fingerprint || '')
        || (row.duration !== null && row.duration !== undefined)) continue;
    const duration = finiteNumber(rawDuration);
    if (duration === null || typeof persistDuration !== 'function') continue;
    const target = targetForRow ? await targetForRow(row) : null;
    if (!target || target.pointerFingerprint !== String(meta.pointerFingerprint)) continue;
    if (await persistDuration(target, duration, { onlyIfEmpty: true, migrated: true })) migrated += 1;
  }
  return migrated;
}

/** Idempotently add the native pointer identity column after t_track exists. */
async function ensurePointerFingerprintColumn(knex, options = {}) {
  if (!knex || !knex.schema) throw new TypeError('knex schema is required');
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 30000));
  const pollMs = Math.max(10, Number(options.pollMs ?? 100));
  const startedAt = Date.now();
  while (!(await knex.schema.hasTable('t_track'))) {
    if (Date.now() - startedAt >= timeoutMs) {
      const error = new Error('t_track is not ready for STRM fingerprint migration');
      error.code = 'TRACK_SCHEMA_NOT_READY';
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  if (await knex.schema.hasColumn('t_track', 'pointer_fingerprint')) return true;
  try {
    await knex.schema.alterTable('t_track', table => {
      table.string('pointer_fingerprint', 64).nullable();
    });
  } catch (error) {
    // Another app process may have completed the same idempotent change.
    if (!(await knex.schema.hasColumn('t_track', 'pointer_fingerprint'))) throw error;
  }
  return true;
}

module.exports = {
  LEGACY_STATE_BASENAME,
  NEW_STATE_BASENAME,
  resolveLegacyStatePath,
  readLegacyStateFile,
  migrateLegacyState,
  normalizeLegacyRootFolder,
  migrateLegacyMemo,
  ensurePointerFingerprintColumn,
};
