'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(process.env.KIKOERU_ROOT || '/usr/src/kikoeru');
const configDir = path.resolve(process.env.KIKOERU_CONFIG_DIR || path.join(appRoot, 'config'));
const configPath = path.join(configDir, 'config.json');
const passwordFile = path.resolve(process.env.KIKOERU_ADMIN_PASSWORD_FILE || path.join(configDir, 'admin-password'));
const mediaPath = process.env.KIKOERU_STRM_MEDIA_PATH || '/usr/src/kikoeru/VoiceWork';
const sqlitePath = process.env.KIKOERU_SQLITE_DIR || path.join(appRoot, 'sqlite');
const coversPath = process.env.KIKOERU_COVERS_DIR || path.join(appRoot, 'covers');
const cachePath = process.env.STRM_CACHE_ROOT || path.join(sqlitePath, 'strm-cache');
const { withOverlayNodeOptions } = require('./strm-child-env');
const FINAL_ALLOWED_HOSTS = Object.freeze(['.115cdn.net']);

function configuredHelperHosts(value = process.env.STRM_ALLOWED_HOSTS) {
  if (value == null || String(value).trim() === '') return [];
  return String(value).split(',').map(item => item.trim());
}

function assertHelperConfiguration() {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    const error = new Error('STRM configuration could not be read');
    error.code = 'STRM_CONFIG_READ_FAILED';
    throw error;
  }
  const configured = process.env.STRM_ALLOWED_HOSTS == null
    || String(process.env.STRM_ALLOWED_HOSTS).trim() === ''
    ? config && config.strm && config.strm.allowedHosts
    : configuredHelperHosts();
  const values = Array.isArray(configured)
    ? configured.map(value => String(value).trim())
    : configuredHelperHosts(configured);
  if (!values.length) {
    const error = new Error('STRM_ALLOWED_HOSTS is required; configure one or more Helper hosts');
    error.code = 'HELPER_HOST_REQUIRED';
    throw error;
  }
  if (values.some(value => !value || value.includes('*'))) {
    const error = new Error('STRM_ALLOWED_HOSTS contains an empty or wildcard pattern');
    error.code = 'HELPER_HOST_INVALID';
    throw error;
  }
  return values;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function defaultRootFolders() {
  try {
    const folders = fs.readdirSync(mediaPath, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => ({ name: entry.name, path: path.join(mediaPath, entry.name) }))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (folders.length) return folders;
  } catch {
    // The media mount may not be available during a first-start test.  Keep
    // the historical single-root fallback so config creation remains safe.
  }
  return [{ name: '自行收集', path: mediaPath }];
}

function writeSecretFile(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${value}\n`, { mode: 0o600, flag: 'wx' });
}

function makeIndependentConfig() {
  ensureDir(configDir);
  ensureDir(sqlitePath);
  ensureDir(coversPath);
  let adminPassword;
  try {
    adminPassword = fs.readFileSync(passwordFile, 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    adminPassword = process.env.KIKOERU_ADMIN_PASSWORD || crypto.randomBytes(24).toString('base64url');
    writeSecretFile(passwordFile, adminPassword);
  }
  if (!fs.existsSync(configPath)) {
    const config = {
      version: '0.6.17',
      production: true,
      auth: true,
      dbUseDefaultPath: false,
      databaseFolderDir: sqlitePath,
      coverUseDefaultPath: false,
      coverFolderDir: coversPath,
      rootFolders: defaultRootFolders(),
      enableFileWatcher: false,
      listenPort: 8888,
      offloadMedia: false,
      md5secret: crypto.randomBytes(32).toString('hex'),
      jwtsecret: crypto.randomBytes(32).toString('hex'),
      strm: {
        enabled: true,
        redirectMode: 'direct',
        extension: '.strm',
        filenameMode: 'media-extension-before-strm',
        allowedSchemes: ['http', 'https'],
        allowedHosts: configuredHelperHosts(),
        finalAllowedHosts: FINAL_ALLOWED_HOSTS.slice(),
        maxPointerBytes: 65536,
        durationProbe: {
          enabled: true, intervalMs: 2000, maxConcurrent: 1,
          timeoutMs: 60000, maxQueue: 1000, retryDelayMs: 3600000,
        },
        redirectResolve: {
          method: 'HEAD', timeoutMs: 10000, maxConcurrent: 1,
          minIntervalMs: 1000, maxQueue: 32, perMinute: 30, perHour: 1800,
          cacheTtlMs: 10000, cooldownMs: 1000, severeCooldownMs: 60000,
          severeAfter429: 3, max429Retries: 3, retryBaseMs: 1000,
          retryMaxMs: 60000, retryJitterMs: 250, calibrationVersion: 3,
        },
        // Purpose/Sec-Purpose is observed by default.  Client media requests
        // can carry those markers too, so interruption is explicit opt-in.
        preloadGuard: { enabled: true, mode: 'observe', detectHead: false, calibrationVersion: 2 },
        coldCache: {
          enabled: true, rootDir: cachePath, maxTotalBytes: 21474836480,
          maxFileBytes: 2147483648, maxVideoBytes: 536870912,
          cleanupPolicy: 'lru+ttl', maxAgeMs: 2592000000,
          cleanupIntervalMs: 3600000, downloadTimeoutMs: 900000,
        },
        loudness: { enabled: true, audioOnly: true, method: 'ebur128', timeoutMs: 900000 },
        statePath: path.join(sqlitePath, 'strm-state.json'),
      },
    };
    const tempPath = `${configPath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, configPath);
  }
  migrateRedirectConfig();
  // Keep this migration independent from redirect migration: the latter may
  // return early when its v2 fields are already present.
  migratePreloadConfigFile();
  // The bridge reads this value without logging it.  It is exported only to
  // the child process and can be rotated by replacing the independent file.
  process.env.KIKOERU_ADMIN_PASSWORD_FILE = passwordFile;
}

function migrateRedirectConfig() {
  let current;
  try {
    current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return;
  }
  const result = migrateRedirectConfigValue(current);
  if (!result.changed) return;
  const tempPath = `${configPath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(result.config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, configPath);
}

const REDIRECT_DEFAULTS = Object.freeze({
  maxConcurrent: 1,
  minIntervalMs: 1000,
  maxQueue: 32,
  perMinute: 30,
  perHour: 1800,
  cacheTtlMs: 10000,
  cooldownMs: 1000,
  severeCooldownMs: 60000,
  severeAfter429: 3,
  max429Retries: 3,
  retryBaseMs: 1000,
  retryMaxMs: 60000,
  retryJitterMs: 250,
});

/** Pure redirect budget migration shared by startup tests and file migration. */
function migrateRedirectConfigValue(config) {
  if (!config || typeof config !== 'object' || !config.strm || typeof config.strm !== 'object') {
    return { config, changed: false };
  }
  const strm = config.strm;
  const raw = strm.redirectResolve && typeof strm.redirectResolve === 'object'
    ? strm.redirectResolve : {};
  const migrated = Object.assign({}, REDIRECT_DEFAULTS, raw);
  const calibration = Number(raw.calibrationVersion || 0);
  const minInterval = Number(raw.minIntervalMs);
  const perHour = Number(raw.perHour);
  const hasPerMinute = Object.prototype.hasOwnProperty.call(raw, 'perMinute');
  const hasPerHour = Object.prototype.hasOwnProperty.call(raw, 'perHour');
  const legacyNoBudget = !hasPerMinute && !hasPerHour && (minInterval === 150 || minInterval === 400);
  const legacyCalibrated = calibration <= 2 && perHour === 120 && (minInterval === 150 || minInterval === 400);
  if (legacyNoBudget || legacyCalibrated) {
    migrated.minIntervalMs = 1000;
    migrated.perHour = 1800;
    if (legacyNoBudget && Number(raw.maxQueue) === 64) migrated.maxQueue = 32;
  }
  migrated.calibrationVersion = 3;
  const changed = !strm.redirectResolve
    || JSON.stringify(migrated) !== JSON.stringify(raw)
    || legacyNoBudget
    || legacyCalibrated;
  if (!changed) return { config, changed: false };
  return {
    config: Object.assign({}, config, {
      strm: Object.assign({}, strm, { redirectResolve: migrated }),
    }),
    changed: true,
  };
}

/**
 * Pure, copy-on-write migration for the preload guard. The old overlay's
 * implicit/default shape was short-circuit + detectHead=false (or omitted).
 * Preserve explicit observe/off or detectHead=true choices, while moving only
 * that known legacy default to observe and stamping calibrationVersion=2.
 */
function migratePreloadConfig(config) {
  if (!config || typeof config !== 'object' || !config.strm || typeof config.strm !== 'object') {
    return { config, changed: false };
  }
  const strm = config.strm;
  const raw = strm.preloadGuard && typeof strm.preloadGuard === 'object'
    ? strm.preloadGuard : {};
  const migrated = Object.assign({ enabled: true, mode: 'observe', detectHead: false }, raw);
  const hasV2 = Number(raw.calibrationVersion) >= 2;
  const mode = String(raw.mode == null ? 'short-circuit' : raw.mode).trim().toLowerCase();
  const detectHead = raw.detectHead == null ? false : Boolean(raw.detectHead);
  const legacyDefault = !hasV2 && mode === 'short-circuit' && !detectHead;
  if (legacyDefault) migrated.mode = 'observe';
  migrated.calibrationVersion = 2;
  const changed = !strm.preloadGuard
    || JSON.stringify(migrated) !== JSON.stringify(raw)
    || legacyDefault;
  if (!changed) return { config, changed: false };
  return {
    config: Object.assign({}, config, {
      strm: Object.assign({}, strm, { preloadGuard: migrated }),
    }),
    changed: true,
  };
}

function migratePreloadConfigFile() {
  let current;
  try {
    current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return false;
  }
  const result = migratePreloadConfig(current);
  if (!result.changed) return false;
  const tempPath = `${configPath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(result.config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, configPath);
  return true;
}

function main() {
  makeIndependentConfig();
  assertHelperConfiguration();
  // Kikoeru starts scanner.js/workFileScanner.js with child_process.fork().
  // Propagate the same versioned bootstrap to those children without editing
  // the upstream compiled scanner files.
  process.env.NODE_OPTIONS = withOverlayNodeOptions(appRoot, process.env.NODE_OPTIONS);
  require(path.join(appRoot, 'strm-adapter/bootstrap.js'));
  const upstreamApp = require(path.join(appRoot, 'dist/src/app.js'));
  return startUpstreamApp(upstreamApp);
}

function startUpstreamApp(upstreamApp) {
  if (!upstreamApp || typeof upstreamApp.main !== 'function') {
    const error = new Error('upstream main export is unavailable');
    error.code = 'UPSTREAM_MAIN_UNAVAILABLE';
    throw error;
  }
  return upstreamApp.main();
}

function reportStartupFailure(error) {
  const candidate = error && typeof error.code === 'string' ? error.code : '';
  const code = /^[A-Z0-9_]+$/.test(candidate) ? candidate : 'KIKOERU_STARTUP_FAILED';
  console.error(`[STRM] startup failed (${code})`);
  process.exitCode = 1;
}

if (require.main === module) Promise.resolve().then(main).catch(reportStartupFailure);

module.exports = {
  FINAL_ALLOWED_HOSTS,
  configuredHelperHosts,
  assertHelperConfiguration,
  migrateRedirectConfigValue,
  migratePreloadConfig,
  migratePreloadConfigFile,
  startUpstreamApp,
  reportStartupFailure,
};
