'use strict';

/*
 * Keep the upstream distribution intact while decorating the three stable
 * 0.6.17 module boundaries used by the STRM adapter. The flags are set before
 * loading integration.js because its installers may recursively require one
 * of the decorated modules.
 */
const Module = require('module');
const path = require('path');
const { installAdminUiHooks } = require('./admin-ui');

const appRoot = path.resolve(process.env.KIKOERU_ROOT || path.join(__dirname, '..'));
const utilsFile = path.resolve(appRoot, 'dist/src/filesystem/utils.js');
const localProviderFile = path.resolve(appRoot, 'dist/src/filesystem/backend/localProvider.js');
const routesFile = path.resolve(appRoot, 'dist/src/routes/index.js');
const originalLoad = Module._load;
let integration;
let utilsInstalled = false;
let localProviderInstalled = false;
let routesInstalled = false;

function getIntegration() {
  if (!integration) integration = require('./integration');
  return integration;
}

function resolved(request, parent) {
  try { return path.resolve(Module._resolveFilename(request, parent)); } catch { return ''; }
}

Module._load = function strmLoad(request, parent, isMain) {
  const value = originalLoad.call(this, request, parent, isMain);
  const filename = resolved(request, parent);

  if (!utilsInstalled && filename === utilsFile) {
    utilsInstalled = true;
    getIntegration().installUtils(value, appRoot);
  }
  if (!localProviderInstalled && filename === localProviderFile) {
    localProviderInstalled = true;
    getIntegration().installProvider(value, appRoot);
  }
  if (!routesInstalled && filename === routesFile) {
    routesInstalled = true;
    const router = value && value.default ? value.default : value;
    getIntegration().installRoutes(router, appRoot);
  }
  return value;
};

// The upstream first-run database seed is still admin/admin. Map only the
// configured bootstrap password to that seed hash while preserving Kikoeru's
// native login route, password hashing and JWT validation.
function installFirstRunPasswordBridge() {
  const password = process.env.KIKOERU_ADMIN_PASSWORD || (() => {
    const passwordFile = process.env.KIKOERU_ADMIN_PASSWORD_FILE;
    if (!passwordFile) return '';
    try {
      return require('fs').readFileSync(passwordFile, 'utf8').trim();
    } catch (cause) {
      if (cause && cause.code === 'ENOENT') return '';
      const error = new Error('STRM admin password file could not be read');
      error.code = 'STRM_ADMIN_PASSWORD_READ_FAILED';
      throw error;
    }
  })();
  if (!password) return false;

  try {
    const authPath = path.resolve(appRoot, 'dist/src/auth/utils.js');
    const auth = require(authPath);
    if (auth.__strmPasswordBridge) return true;
    if (typeof auth.md5 !== 'function') {
      const error = new Error('native auth hash function is unavailable');
      error.code = 'STRM_AUTH_HASH_UNAVAILABLE';
      throw error;
    }
    const originalMd5 = auth.md5;
    auth.md5 = value => originalMd5(value === password ? 'admin' : value);
    Object.defineProperty(auth, '__strmPasswordBridge', { value: true, enumerable: false });
    return true;
  } catch (cause) {
    const error = new Error('STRM first-run password bridge could not be installed');
    error.code = cause && cause.code === 'STRM_AUTH_HASH_UNAVAILABLE'
      ? cause.code : 'STRM_PASSWORD_BRIDGE_FAILED';
    throw error;
  }
}

installFirstRunPasswordBridge();

// Forked workers load the same adapter hooks through NODE_OPTIONS. They need
// the native filesystem/provider hooks, but must not install browser hooks.
if (!process.send) installAdminUiHooks();

module.exports = {
  appRoot,
  localProviderFile,
  routesFile,
  utilsFile,
};
