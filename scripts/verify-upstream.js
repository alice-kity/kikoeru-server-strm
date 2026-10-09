'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const EXPECTED_VERSION = '0.6.17';
const DEFAULT_MANIFEST_DIR = path.resolve(__dirname, '..', 'patches');

function loadManifest(version = EXPECTED_VERSION, manifestDir = DEFAULT_MANIFEST_DIR) {
  const manifestPath = path.join(path.resolve(manifestDir), version, 'upstream-fingerprints.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`fingerprint manifest is missing for version ${version}`);
    throw new Error(`fingerprint manifest is invalid for version ${version}`);
  }
  if (!manifest || manifest.version !== version || !manifest.fingerprints
      || typeof manifest.fingerprints !== 'object' || Array.isArray(manifest.fingerprints)
      || !Object.keys(manifest.fingerprints).length) {
    throw new Error(`fingerprint manifest is invalid for version ${version}`);
  }
  return { manifestPath, fingerprints: manifest.fingerprints };
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function verify(rootDir, options = {}) {
  const root = path.resolve(rootDir || process.cwd());
  const version = String(options.version || EXPECTED_VERSION);
  const manifestDir = options.manifestDir || DEFAULT_MANIFEST_DIR;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid upstream version: ${version}`);

  const { manifestPath, fingerprints } = loadManifest(version, manifestDir);
  const packagePaths = [path.join(root, 'dist/package.json'), path.join(root, 'package.json')];
  const packagePath = packagePaths.find(filePath => fs.existsSync(filePath));
  if (!packagePath) throw new Error('upstream package.json was not found');
  const actualVersion = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
  if (actualVersion !== version) {
    throw new Error(`unsupported Kikoeru version: ${actualVersion}; expected ${version}`);
  }

  for (const [relative, expected] of Object.entries(fingerprints)) {
    if (path.isAbsolute(relative) || path.normalize(relative).startsWith('..')) {
      throw new Error(`invalid fingerprint path in ${version} manifest`);
    }
    const filePath = path.join(root, relative);
    if (!fs.existsSync(filePath)) throw new Error(`required upstream file is missing: ${relative}`);
    const actual = sha256(filePath);
    if (actual !== expected) {
      throw new Error(`upstream fingerprint mismatch for ${relative}: ${actual} (expected ${expected})`);
    }
  }
  if (!fs.existsSync(path.join(root, 'dist/src/app.js'))) throw new Error('upstream entry point is missing');
  return { version, fingerprints, manifestPath };
}

function parseArguments(args) {
  const options = { version: EXPECTED_VERSION, manifestDir: DEFAULT_MANIFEST_DIR };
  let rootDir = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--version') {
      if (!args[index + 1]) throw new Error('--version requires a value');
      options.version = args[++index];
    } else if (arg.startsWith('--version=')) {
      options.version = arg.slice('--version='.length);
    } else if (arg === '--manifest-dir') {
      if (!args[index + 1]) throw new Error('--manifest-dir requires a value');
      options.manifestDir = args[++index];
    } else if (arg.startsWith('--manifest-dir=')) {
      options.manifestDir = arg.slice('--manifest-dir='.length);
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else if (rootDir === null) {
      rootDir = arg;
    } else {
      throw new Error('only one upstream root directory may be supplied');
    }
  }
  return { rootDir: rootDir || process.cwd(), options };
}

if (require.main === module) {
  try {
    const { rootDir, options } = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: node scripts/verify-upstream.js [--version VERSION] [--manifest-dir DIR] [UPSTREAM_ROOT]');
      console.log(`Default version: ${EXPECTED_VERSION}; use --version 0.6.15 to check the preserved baseline.`);
    } else {
      const result = verify(rootDir, options);
      console.log(`upstream verified: Kikoeru ${result.version}; ${Object.keys(result.fingerprints).length} fingerprints match`);
    }
  } catch (error) {
    console.error(`upstream verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}

const exported = {
  DEFAULT_MANIFEST_DIR,
  EXPECTED_VERSION,
  loadManifest,
  parseArguments,
  verify,
};

Object.defineProperty(exported, 'EXPECTED', {
  enumerable: true,
  get() { return Object.freeze(loadManifest(EXPECTED_VERSION).fingerprints); },
});

module.exports = exported;
