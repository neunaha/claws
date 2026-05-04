#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const mcp = fs.readFileSync(path.resolve(__dirname, '../../mcp_server.js'), 'utf8');

// Extract the claws_workers_wait handler block.
const handlerStart = mcp.indexOf("if (name === 'claws_workers_wait')");
assert.ok(handlerStart !== -1, 'claws_workers_wait handler not found');
// Find the closing brace of the if block by scanning for the matching '}'.
let depth = 0;
let handlerEnd = handlerStart;
for (let i = handlerStart; i < mcp.length; i++) {
  if (mcp[i] === '{') depth++;
  else if (mcp[i] === '}') {
    depth--;
    if (depth === 0) { handlerEnd = i + 1; break; }
  }
}
const waitBody = mcp.slice(handlerStart, handlerEnd);

// 1. marker signal — via detectCompletion call.
const hasMarker = waitBody.includes('detectCompletion');
assert.ok(hasMarker, 'workers_wait must check marker signal via detectCompletion');

// 2. pub_complete signal — detectCompletion already checks [CLAWS_PUB] topic=worker.<id>.complete.
//    Verify we pass termId to detectCompletion so it can build the pub topic.
const hasPubComplete = waitBody.includes('detectCompletion') &&
  (waitBody.includes('s.id') || waitBody.includes('termId'));
assert.ok(hasPubComplete, 'workers_wait must pass terminal id to detectCompletion for pub_complete signal');

// 3. terminated signal — detectCompletion checks _workerTerminatedSet.
//    Verify _workerTerminatedSet is passed to detectCompletion.
const hasTerminated = waitBody.includes('_workerTerminatedSet');
assert.ok(hasTerminated, 'workers_wait must pass _workerTerminatedSet to detectCompletion for terminated signal');

// 4. min_complete parameter.
const hasMinComplete = waitBody.includes('min_complete') || waitBody.includes('minComplete');
assert.ok(hasMinComplete, 'workers_wait must support min_complete parameter');

// 5. per-worker results structure with signal field.
const hasResults = waitBody.includes('results') && waitBody.includes('signal');
assert.ok(hasResults, 'workers_wait must return per-worker results structure with signal field');

// 6. pending array in response.
const hasPending = waitBody.includes('pending');
assert.ok(hasPending, 'workers_wait must return pending array of unfinished terminal ids');

// 7. top-level complete + target counts.
const hasCounts = waitBody.includes('complete') && waitBody.includes('target');
assert.ok(hasCounts, 'workers_wait must return complete and target counts');

console.log('workers-wait-signals.test.js: 7/7 PASS');
