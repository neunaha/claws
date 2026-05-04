#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const mcp = fs.readFileSync(path.resolve(__dirname, '../../mcp_server.js'), 'utf8');

// Extract _dswTick function body — from _dswTick = async through to the closing }; line
const dswFnMatch = mcp.match(/const _dswTick = async[\s\S]*?catch \(e\) \{ log\('dsw watcher tick error/);
assert.ok(dswFnMatch, '_dswTick function not found');
const dswBody = dswFnMatch[0];

// BUG-F: _dswTick boot detection must NOT use stale 'trust' substring
// Also verify the boot loop now uses the ❯ + cost:$ ready-state signal
const bootSection = mcp.match(/BUG-F fix[\s\S]*?await sleep\(5000\)/);
assert.ok(bootSection, 'BUG-F fix boot section not found');
assert.ok(!bootSection[0].includes("includes('trust')"), 'BUG-F: _dswTick must not use stale trust substring boot detection');
assert.ok(bootSection[0].includes('❯'), 'BUG-F: _dswTick boot detection must use ❯ prompt signal');
assert.ok(bootSection[0].includes('cost:$') || bootSection[0].includes('cost: $'), 'BUG-F: _dswTick boot detection must check cost:$ idle indicator');

// BUG-C: _dswTick must use markerScanFrom offset for detectCompletion
assert.ok(dswBody.includes('_dswMarkerScanFrom') || dswBody.includes('_dswDetText'),
  'BUG-C: _dswTick must scan completion from markerScanFrom offset, not full log');
assert.ok(mcp.includes('_dswMarkerScanFrom'),
  'BUG-C: _dswMarkerScanFrom variable must exist');

// BUG-E: _dswTick must instantiate WorkerHeartbeatStateMachine
assert.ok(mcp.includes('_dswHbState') && mcp.includes('new WorkerHeartbeatStateMachine'),
  'BUG-E: _dswTick must instantiate WorkerHeartbeatStateMachine for sub-worker observability');
assert.ok(dswBody.includes('_dswHbState.observe(text)'),
  'BUG-E: _dswTick must call _dswHbState.observe(text) on each tick');
assert.ok(dswBody.includes("worker.${termId}.heartbeat"),
  'BUG-E: _dswTick must publish heartbeat events');

console.log('dswtick-fixes.test.js: 3/3 PASS — BUG-F + BUG-C + BUG-E fixed');
