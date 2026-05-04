#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const mcp = fs.readFileSync(path.resolve(__dirname, '../../mcp_server.js'), 'utf8');

// 1. Subscription registered for worker.+.complete wildcard
assert.ok(
  mcp.includes("'worker.+.complete'") || mcp.includes('"worker.+.complete"'),
  'mcp_server.js must subscribe to worker.+.complete wildcard'
);

// 2. Set populated on receipt — _workerCompletedViaBusSet
assert.ok(
  mcp.includes('_workerCompletedViaBusSet'),
  'mcp_server.js must track bus-based completions in _workerCompletedViaBusSet'
);

// 3. detectCompletion checks bus signal BEFORE marker scraping
const detectMatch = mcp.match(/function detectCompletion\([^)]+\)\s*\{([\s\S]*?)^function /m);
assert.ok(detectMatch, 'detectCompletion function not found');
const detectBody = detectMatch[1];
const busIdx = detectBody.indexOf('busCompletedSet');
const markerIdx = detectBody.indexOf('findStandaloneMarker');
assert.ok(busIdx > -1, 'detectCompletion must reference busCompletedSet');
assert.ok(markerIdx > -1, 'detectCompletion must reference findStandaloneMarker');
assert.ok(busIdx < markerIdx, 'detectCompletion must check bus signal BEFORE marker scraping');

// 4. pub_complete_v2 signal returned for bus completion
assert.ok(
  mcp.includes("signal: 'pub_complete_v2'"),
  "detectCompletion must return signal: 'pub_complete_v2' for bus completion"
);

// 5. All 5 detectCompletion callers pass _workerCompletedViaBusSet.
// Count occurrences of the call pattern (exclude function definition line).
// Each caller looks like: detectCompletion(..., _workerTerminatedSet, _workerCompletedViaBusSet)
const busArgOccurrences = [...mcp.matchAll(/_workerTerminatedSet,\s*_workerCompletedViaBusSet\)/g)].length;
assert.ok(busArgOccurrences >= 5, `expected at least 5 detectCompletion callers with _workerCompletedViaBusSet, found ${busArgOccurrences}`);

// 6. Mission injection includes Phase 4a publish guidance
assert.ok(
  mcp.includes('worker.${termId}.complete') || mcp.includes("worker.${termId}.complete"),
  'mission injection must include Phase 4a publish guidance with worker.<termId>.complete'
);

// 7. _workerBusCompletedSubscribed reset on disconnect
assert.ok(
  mcp.includes('_workerBusCompletedSubscribed = false'),
  '_pconnHandleClose must reset _workerBusCompletedSubscribed'
);

console.log('phase-4a-bus-completion.test.js: 7/7 PASS');
