'use strict';

// HB-L6: Static checks — verify kind=approach and kind=error heartbeat guards
// and publish blocks are present in mcp_server.js.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../../mcp_server.js'), 'utf8');

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) {
    console.log(`  ok - ${label}`);
    passed++;
  } else {
    console.error(`  FAIL - ${label}`);
    failed++;
  }
}

console.log('TAP version 13');
console.log('# HB-L6: kind=approach + kind=error heartbeat guards');

check("kind: 'approach' publish block present", src.includes("kind: 'approach'"));
check("kind: 'error' publish block present", src.includes("kind: 'error'"));
check('_fpLastTodoSig guard variable declared', src.includes('_fpLastTodoSig'));
check('_fpLastPublishedErrorsCount guard variable declared', src.includes('_fpLastPublishedErrorsCount'));
check('approach_detail field present', src.includes('approach_detail'));
check('error_detail field present', src.includes('error_detail'));
check('todoSig compare guard (_fpTodoSig !== _fpLastTodoSig)', src.includes('_fpTodoSig !== _fpLastTodoSig'));
check('errorsCount compare guard (errorsCount > _fpLastPublishedErrorsCount)', src.includes('_fpL6Snap.errorsCount > _fpLastPublishedErrorsCount'));
check('hb-l6 approach log label present', src.includes('hb-l6 approach publish failed'));
check('hb-l6 error log label present', src.includes('hb-l6 error publish failed'));

console.log(`\n1..${passed + failed}`);
console.log(`# passed: ${passed}`);
if (failed > 0) {
  console.error(`# failed: ${failed}`);
  process.exit(1);
}
