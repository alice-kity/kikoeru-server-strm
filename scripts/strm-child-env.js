'use strict';

const path = require('path');

/**
 * Make the versioned bootstrap available to forked Kikoeru scanner workers.
 * NODE_OPTIONS is inherited by child_process.fork without changing upstream
 * scanner source or its module paths.
 */
function withOverlayNodeOptions(appRoot, currentValue = process.env.NODE_OPTIONS || '') {
  const bootstrap = path.resolve(appRoot, 'strm-adapter/bootstrap.js');
  const current = String(currentValue || '').trim();
  if (current.includes(bootstrap)) return current;
  return `${current} --require=${bootstrap}`.trim();
}

module.exports = { withOverlayNodeOptions };
