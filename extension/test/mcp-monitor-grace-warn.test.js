#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const mcp = fs.readFileSync(path.resolve(__dirname, '../../mcp_server.js'), 'utf8');

// T4: all three spawn paths must include the grace warning
assert.ok(
  mcp.includes('T4-warn'),
  'mcp_server.js must include T4-warn monitor-arm grace warning log entries',
);

const t4WarnCount = (mcp.match(/T4-warn/g) || []).length;
assert.ok(
  t4WarnCount >= 3,
  `mcp_server.js must have T4-warn in at least 3 spawn paths (runBlockingWorker, claws_worker fp, claws_dispatch_subworker), found: ${t4WarnCount}`,
);

assert.ok(
  mcp.includes('_fpMonitorGraceMs') || mcp.includes('_bMonitorGraceMs') || mcp.includes('_dswMonitorGraceMs'),
  'mcp_server.js must define MonitorGraceMs constant(s) for the T4 grace window',
);

// BUG-28 PreToolUse spawn-class hooks should no longer be in inject-settings-hooks.js.
// Note: PostToolUse spawn-class entries (Wave C) are legitimate and should remain.
const hookScript = fs.readFileSync(path.resolve(__dirname, '../../scripts/inject-settings-hooks.js'), 'utf8');
// Extract only PreToolUse lines to avoid false-positives from PostToolUse (Wave C hooks)
const preToolUseLines = hookScript.split('\n').filter(l => l.includes("'PreToolUse'") || l.includes('"PreToolUse"'));
const preToolUseBlock = preToolUseLines.join('\n');
assert.ok(
  !preToolUseBlock.includes("mcp__claws__claws_worker"),
  'inject-settings-hooks.js must not register BUG-28 claws_worker PreToolUse hook (replaced by T4 server gate)',
);
assert.ok(
  !preToolUseBlock.includes("mcp__claws__claws_fleet"),
  'inject-settings-hooks.js must not register BUG-28 claws_fleet PreToolUse hook (replaced by T4 server gate)',
);
assert.ok(
  !preToolUseBlock.includes("mcp__claws__claws_dispatch_subworker"),
  'inject-settings-hooks.js must not register BUG-28 claws_dispatch_subworker PreToolUse hook (replaced by T4 server gate)',
);

console.log('mcp-monitor-grace-warn.test.js: 6/6 PASS');
