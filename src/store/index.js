'use strict';
// Picks the storage adapter for this deployment.
// STORE=file (default) -> JSON file in DATA_DIR. Future: STORE=dynamodb for AWS.
const { createFileStore } = require('./file');

function createStore(env = process.env) {
  const kind = (env.STORE || 'file').toLowerCase();
  if (kind === 'file') return createFileStore(env.DATA_DIR || './data');
  throw new Error(`Unknown STORE "${kind}". Supported: file`);
}

module.exports = { createStore };
