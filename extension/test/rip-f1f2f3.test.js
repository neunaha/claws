#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const tplGlobal = fs.readFileSync(path.resolve(__dirname, '../../templates/CLAUDE.global.md'), 'utf8');
const tplProject = fs.readFileSync(path.resolve(__dirname, '../../templates/CLAUDE.project.md'), 'utf8');
const hook = fs.readFileSync(path.resolve(__dirname, '../../scripts/hooks/session-start-claws.js'), 'utf8');

// F1/F2/F3 convention should be GONE from all three files
assert.ok(!/F1:.*git status.*F2:.*git log.*F3:.*printf/s.test(tplGlobal),
  'F1/F2/F3 convention must be removed from CLAUDE.global.md');
assert.ok(!/F1:.*git status.*F2:.*git log.*F3:.*printf/s.test(tplProject),
  'F1/F2/F3 convention must be removed from CLAUDE.project.md');
assert.ok(!/F3.*printf.*MARK/i.test(hook),
  'F3 reminder must be removed from session-start hook');

console.log('rip-f1f2f3.test.js: 3/3 PASS');
