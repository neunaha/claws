'use strict';
// HB-L5: static verification that kind=progress burst aggregation is wired in mcp_server.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../../mcp_server.js'), 'utf8');

let passed = 0;

function check(label, cond) {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`  ok  ${label}`);
  passed++;
}

check('kind=progress literal present', src.includes("kind: 'progress'"));
check('burst window constant 5000 present', src.includes('>= 5000'));
check('_fpLastPublishedToolCount variable declared', src.includes('_fpLastPublishedToolCount'));
check('_fpProgressBurst array declared', src.includes('_fpProgressBurst'));
check('_fpProgressBurstStart timestamp declared', src.includes('_fpProgressBurstStart'));
check('burst total reduce present', src.includes('_fpBurstTotal'));
check('progress publish uses worker.<termId>.heartbeat topic', src.includes('`worker.${termId}.heartbeat`'));
check('progress payload has summary field', src.includes("summary: `${_fpBurstTotal}"));
check('hb-l5 error log present', src.includes("hb-l5 progress publish failed"));
check('burst array reset after flush', src.includes('_fpProgressBurst = [];'));

console.log(`\nhb-l5 static checks: ${passed}/10 passed`);
