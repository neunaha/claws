#!/usr/bin/env node
// RIP F1 + RIP F4 + HOOK P3: verify advisory text removed from hook scripts and
// stop hook now performs auto-close action (deterministic, not advisory).
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const sessionStart = fs.readFileSync(path.join(ROOT, 'scripts/hooks/session-start-claws.js'), 'utf8');
const stopHook     = fs.readFileSync(path.join(ROOT, 'scripts/hooks/stop-claws.js'), 'utf8');

// All hooks must still parse
execFileSync('node', ['--check', path.join(ROOT, 'scripts/hooks/session-start-claws.js')]);
execFileSync('node', ['--check', path.join(ROOT, 'scripts/hooks/stop-claws.js')]);

// RIP F1 — boot-sequence advisory steps must be GONE
assert.ok(!/Step 1.*claws_create.*Step 2.*claws_send.*Step 7/s.test(sessionStart),
  'session-start: advisory Step 1-7 boot sequence must be removed');
assert.ok(!/Wave Army Discipline Contract/i.test(sessionStart),
  'session-start: Wave Army Discipline Contract must be removed');
assert.ok(!/MUST follow these rules/i.test(sessionStart),
  'session-start: "MUST follow these rules" advisory must be removed');

// session-start should still drain stdin (Claude Code hook contract)
assert.ok(/process\.stdin/.test(sessionStart),
  'session-start: must still drain stdin');

// RIP F4 — advisory "you must close terminals" stderr must be GONE
assert.ok(!/identify terminals you own/i.test(stopHook),
  'stop: "identify terminals you own" advisory must be removed');
assert.ok(!/Close them with claws_close before ending/i.test(stopHook),
  'stop: "close them before ending" advisory must be removed');
assert.ok(!/Write your reflect summary/i.test(stopHook),
  'stop: REFLECT advisory text must be removed');

// HOOK P3 — stop hook must contain auto-close action (socket call)
assert.ok(/cmd:\s*'close'/.test(stopHook),
  'stop: must call cmd:close on the socket (auto-close)');
assert.ok(/createConnection\s*\(\s*socketPath/.test(stopHook),
  'stop: must connect to socket to issue close');

console.log('rip-hook-advisory.test.js: 9/9 PASS');
