/**
 * HB-L8 DISARMED verification: confirms the destructive tui_idle auto-close
 * cascade is commented out. Re-enabling requires removing the DISARMED block
 * and restoring proper detection logic (distinguishes Claude deep-thinking from
 * genuine idle). See lifecycle-master-plan wave army for audit + redesign.
 */

'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../../mcp_server.js'), 'utf8');

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

console.log('HB-L8: tui_idle DISARMED static checks');

// 1. DISARMED sentinel comment is present — re-enable requires acknowledging audit
check(
  'HB-L8 DISARMED comment block present',
  src.includes('HB-L8 DISARMED')
);

// 2. Confirm tui_idle completion_signal is NOT active (disarmed, not live code)
// The string may appear in comments; verify it does NOT appear outside a comment line
const tui_idle_lines = src.split('\n').filter(l => /completion_signal.*tui_idle/.test(l));
const tui_idle_live = tui_idle_lines.filter(l => !/^\s*\/\//.test(l));
check(
  "completion_signal:'tui_idle' is NOT live (only in comments)",
  tui_idle_live.length === 0
);

// 3. _fpTuiIdleCompleted guard still declared (needed for detectCompletion gate)
check(
  '_fpTuiIdleCompleted guard variable still declared',
  /let _fpTuiIdleCompleted\s*=\s*false/.test(src)
);

// 4. detectCompletion block gated by !_fpTuiIdleCompleted (no double-publish guard intact)
check(
  'detectCompletion block gated with !_fpTuiIdleCompleted (no double-publish)',
  /!\s*_fpTuiIdleCompleted\s*&&\s*_fpStatus\s*!==\s*null/.test(src)
);

// 5. L7 mission_complete heartbeat publish still present (observability intact)
check(
  "L7 kind:'mission_complete' heartbeat publish is still active",
  /kind:\s*['"]mission_complete['"]/.test(src)
);

// 6. _fpTuiIdleCompleted = true NOT live (only inside disarmed comment)
const setGuard_lines = src.split('\n').filter(l => /_fpTuiIdleCompleted\s*=\s*true/.test(l));
const setGuard_live = setGuard_lines.filter(l => !/^\s*\/\//.test(l));
check(
  '_fpTuiIdleCompleted = true NOT in live code (only in disarmed comment)',
  setGuard_live.length === 0
);

console.log('');
console.log(`HB-L8: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
