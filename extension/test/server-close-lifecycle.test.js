#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const server = fs.readFileSync(path.resolve(__dirname, '../src/server.ts'), 'utf8');

// Extract close handler block: everything between cmd === 'close' and the next top-level if/cmd block
const closeStart = server.indexOf("cmd === 'close'");
assert.ok(closeStart !== -1, 'close handler not found in server.ts');

// Find a reasonable window that covers the close handler body (~80 lines)
const closeWindow = server.slice(closeStart, closeStart + 2500);

assert.ok(
  closeWindow.includes('markWorkerStatus'),
  'close handler must call lifecycleStore.markWorkerStatus — T4 lifecycle parity missing',
);
assert.ok(
  closeWindow.includes('onWorkerEvent'),
  'close handler must call lifecycleEngine.onWorkerEvent — T4 lifecycle parity missing',
);
assert.ok(
  closeWindow.includes("'claws-close:'"),
  'onWorkerEvent call must use claws-close: prefix for traceability',
);

console.log('server-close-lifecycle.test.js: 3/3 PASS');
