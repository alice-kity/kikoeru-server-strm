'use strict';

/*
 * A tiny CommonJS load hook keeps the upstream distribution intact.  The
 * versioned build copies this directory beside dist/ and loads this file
 * before the upstream entry point.  Only two known module boundaries are
 * decorated: filesystem/utils.js and routes/index.js.
 */
const Module = require('module');
const path = require('path');
const integration = require('./integration');
const { installAdminUiHooks } = require('./admin-ui');

const appRoot = path.resolve(process.env.KIKOERU_ROOT || path.join(__dirname, '..'));
const utilsFile = path.resolve(appRoot, 'dist/src/filesystem/utils.js');
const routesFile = path.resolve(appRoot, 'dist/src/routes/index.js');
const originalLoad = Module._load;
let utilsInstalled = false;
let routesInstalled = false;

function resolved(request, parent) {
  try { return path.resolve(Module._resolveFilename(request, parent)); } catch { return ''; }
}

Module._load = function strmLoad(request, parent, isMain) {
  const value = originalLoad.call(this, request, parent, isMain);
  const filename = resolved(request, parent);
  if (!utilsInstalled && filename === utilsFile) {
    utilsInstalled = true;
    integration.installUtils(value, appRoot);
  }
  if (!routesInstalled && filename === routesFile) {
    routesInstalled = true;
    const router = value && value.default ? value.default : value;
    integration.installRoutes(router, appRoot);
  }
  return value;
};

// The first-run wrapper creates the independent config/database directories.
// Keep the credential bridge here so the upstream init path's historical
// admin/admin seed can be replaced by a generated password without modifying
// the upstream source file.
function installFirstRunPasswordBridge() {
  const password = process.env.KIKOERU_ADMIN_PASSWORD || (() => {
    try { return require('fs').readFileSync(process.env.KIKOERU_ADMIN_PASSWORD_FILE, 'utf8').trim(); } catch { return ''; }
  })();
  if (!password) return;
  const authPath = path.resolve(appRoot, 'dist/src/auth/utils.js');
  try {
    const auth = require(authPath);
    if (auth.__strmPasswordBridge) return;
    const originalMd5 = auth.md5;
    auth.md5 = value => originalMd5(value === password ? 'admin' : value);
    Object.defineProperty(auth, '__strmPasswordBridge', { value: true, enumerable: false });
  } catch (error) {
    // The app will still boot with its normal auth path if this optional
    // bridge is unavailable; never print the password or an URL.
    console.warn('[STRM] password bridge unavailable:', error.code || error.message);
  }
}

installFirstRunPasswordBridge();

// Scanner workers inherit this bootstrap through NODE_OPTIONS but never
// construct the HTTP app.  Keep the browser hook on the main app only.
if (!process.send) installAdminUiHooks();

// Exported for smoke tests.  The production command below loads the original
// app only after all hooks are installed.
module.exports = { appRoot, utilsFile, routesFile };
