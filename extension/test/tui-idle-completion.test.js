/**
 * HB-L8 static verification: POST_WORK→COMPLETE fires system.worker.completed
 * with completion_signal:"tui_idle" + clears watcher + marks lifecycle + auto-closes.
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

console.log('HB-L8: tui_idle completion static checks');

// 1. Guard variable declared
check(
  '_fpTuiIdleCompleted guard declared',
  /let _fpTuiIdleCompleted\s*=\s*false/.test(src)
);

// 2. completion_signal: 'tui_idle' present
check(
  "completion_signal: 'tui_idle' in system.worker.completed payload",
  /completion_signal:\s*['"]tui_idle['"]/.test(src)
);

// 3. system.worker.completed published in L8 path
// Extract block starting at _fpTuiIdleCompleted = true
const l8Start = src.indexOf('_fpTuiIdleCompleted = true');
const l8Block = l8Start !== -1 ? src.slice(l8Start, l8Start + 1000) : '';
check(
  'system.worker.completed published in L8 cleanup block',
  l8Block.includes('system.worker.completed')
);

// 4. clearInterval called in L8 block
check(
  'clearInterval(_fpIntervalId) called in L8 block',
  l8Block.includes('clearInterval(_fpIntervalId)')
);

// 5. _detachWatchers.delete called in L8 block
check(
  '_detachWatchers.delete(termId) called in L8 block',
  l8Block.includes('_detachWatchers.delete(termId)')
);

// 6. lifecycle mark-worker-status → completed in L8 block
check(
  "lifecycle.mark-worker-status 'completed' in L8 block",
  /lifecycle\.mark-worker-status[\s\S]{0,200}status.*completed/.test(l8Block)
);

// 7. close_on_complete auto-close cascade present in L8 block
check(
  'close_on_complete auto-close cascade in L8 block',
  l8Block.includes('close_on_complete') && l8Block.includes("cmd: 'close'")
);

// 8. detectCompletion block gated by !_fpTuiIdleCompleted
check(
  'detectCompletion block gated with !_fpTuiIdleCompleted (no double-publish)',
  /!\s*_fpTuiIdleCompleted\s*&&\s*_fpStatus\s*!==\s*null/.test(src)
);

console.log('');
console.log(`HB-L8: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
