/**
 * HB-L7 static verification: POST_WORK→COMPLETE fires kind=mission_complete heartbeat.
 * These tests check mcp_server.js contains the required patterns without executing the server.
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

console.log('HB-L7: mission_complete heartbeat static checks');

// 1. Guard variable declared
check(
  '_fpMissionCompletePublished guard declared',
  /let _fpMissionCompletePublished\s*=\s*false/.test(src)
);

// 2. Transitions captured from observe()
check(
  'observe() return value captured as _fpTransitions',
  /const _fpTransitions\s*=\s*_fpHbState\.observe\(text\)/.test(src)
);

// 3. POST_WORK→COMPLETE transition detected
check(
  "transition detection: from=POST_WORK to=COMPLETE",
  /_fpTransitions\.some\(t\s*=>\s*t\.from\s*===\s*['"]POST_WORK['"]\s*&&\s*t\.to\s*===\s*['"]COMPLETE['"]/.test(src)
);

// 4. Guard checked before publishing
check(
  'guard prevents double-publish',
  /_fpCompleteThisTick\s*&&\s*!_fpMissionCompletePublished/.test(src)
);

// 5. Guard set to true after first publish
check(
  'guard set to true after publish',
  /_fpMissionCompletePublished\s*=\s*true/.test(src)
);

// 6. kind=mission_complete in payload
check(
  "kind: 'mission_complete' present in payload",
  /kind:\s*['"]mission_complete['"]/.test(src)
);

// 7. total_tool_calls in payload
check(
  'total_tool_calls field in mission_complete payload',
  /total_tool_calls:\s*fpMcSnap\.toolCount/.test(src)
);

// 8. current_action is 'COMPLETE'
check(
  "current_action: 'COMPLETE' in mission_complete payload",
  /current_action:\s*['"]COMPLETE['"]/.test(src)
);

// 9. Correlation ID threaded through (was check #10 — check #9 removed after L8 landed)
check(
  'correlation_id in mission_complete payload',
  /correlation_id:\s*_fpCorrId/.test(src)
);

console.log('');
console.log(`HB-L7: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
