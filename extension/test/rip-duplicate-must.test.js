#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const tplProject = fs.readFileSync(path.resolve(__dirname, '../../templates/CLAUDE.project.md'), 'utf8');

// The duplicate "MUST follow — no exceptions" rules block should be GONE
assert.ok(!/MUST follow.*no exceptions/i.test(tplProject),
  'duplicate "MUST follow — no exceptions" block must be removed');

// File should reference machine-wide rules location
assert.ok(/CLAUDE\.md|machine-wide|~\/\.claude/i.test(tplProject),
  'project template should reference machine-wide rules location');

console.log('rip-duplicate-must.test.js: 2/2 PASS');
