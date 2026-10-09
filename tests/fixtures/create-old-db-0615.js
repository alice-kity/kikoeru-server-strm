'use strict';
// Run in immutable 0.6.15 image with a writable disposable /fixture-output mount.
const fs = require('node:fs');
fs.mkdirSync('/usr/src/kikoeru/config', { recursive: true });
fs.writeFileSync('/usr/src/kikoeru/config/config.json', JSON.stringify({
  version: '0.6.15', production: true, auth: true, rootFolders: [],
  dbUseDefaultPath: false, databaseFolderDir: '/fixture-output',
  coverUseDefaultPath: false, coverFolderDir: '/fixture-output/covers',
  md5secret: 'synthetic-md5-secret', jwtsecret: 'synthetic-jwt-secret', enableFileWatcher: false,
}));
const appRoot = '/usr/src/kikoeru';
(async () => {
  await require(appRoot + '/dist/src/database/init').initDatabase();
  const knex = require(appRoot + '/dist/src/database/db').knex;
  if (await knex.schema.hasTable('t_track')) throw new Error('old fixture unexpectedly has t_track');
  await knex.destroy();
  console.log('synthetic 0.6.15 SQLite fixture created; no production data accessed');
})().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
