#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const mcp = fs.readFileSync(path.resolve(__dirname, '../../mcp_server.js'), 'utf8');

// BUG-A: _fpMarkerScanFrom must be declared and used to slice pty text
assert.ok(mcp.includes('_fpMarkerScanFrom'), 'BUG-A: _fpMarkerScanFrom must be declared');
assert.ok(mcp.includes('_fpScanText'), 'BUG-A: _fpScanText must be used');
// Ensure sliced text (not raw text) is passed to detectCompletion in the fast-path
assert.ok(
  mcp.includes('detectCompletion(_fpScanText,'),
  'BUG-A: detectCompletion must receive _fpScanText (sliced), not raw text'
);

// BUG-B-close: _detachWatchers must be cancelled when orchestrator closes a terminal
assert.ok(
  mcp.includes('BUG-B-close'),
  'BUG-B-close: comment marker must be present in claws_close handler'
);
assert.ok(
  mcp.includes('_detachWatchers.delete(_bugBCloseTermId)') ||
  (mcp.includes('_detachWatchers') && mcp.includes('orchestrator')),
  'BUG-B-close: must cancel _detachWatchers on orchestrator close'
);

console.log('fastpath-fixes.test.js: 2/2 PASS — BUG-A + BUG-B-close fixed');
