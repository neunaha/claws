#!/usr/bin/env node
// AE-3 — installer hygiene static-analysis test.
//
// Asserts that all three install entry points contain the stale-process cleanup
// logic introduced by Wave AE-3. Pure fs.readFileSync — no forks, no platform
// branches, runs identically on darwin/linux/win32.
//
// Checks:
//   1.  install.ps1 contains Stop-Process
//   2.  install.ps1 contains Win32_Process (CIM query)
//   3.  install.ps1 filters on mcp_server.js path
//   4.  install.sh contains pgrep mcp_server.js call
//   5.  install.sh contains kill command
//   6.  install.sh filters by CLAWS_TERMINAL_CORR_ID
//   7.  lib/install.js defines _cleanStaleWorkerProcesses
//   8.  lib/install.js filters by mcpServerPath (full path match)
//   9.  lib/install.js checks CLAWS_TERMINAL_CORR_ID
//   10. lib/install.js contains Stop-Process (Windows branch)
//
// Run: node extension/test/install-cleanup.test.js

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
let passed = 0;
let failed = 0;

function check(label, ok) {
  if (ok) {
    process.stdout.write(`  PASS  ${label}\n`);
    passed++;
  } else {
    process.stdout.write(`  FAIL  ${label}\n`);
    failed++;
  }
}

function assertContains(content, pattern, label) {
  const ok = (pattern instanceof RegExp) ? pattern.test(content) : content.includes(pattern);
  check(label, ok);
}

// ── install.ps1 ──────────────────────────────────────────────────────────────
const ps1 = fs.readFileSync(path.join(ROOT, 'scripts', 'install.ps1'), 'utf8');
assertContains(ps1, 'Stop-Process',   'install.ps1: contains Stop-Process');
assertContains(ps1, 'Win32_Process',  'install.ps1: contains Win32_Process (CIM query)');
assertContains(ps1, 'mcp_server.js',  'install.ps1: filters on mcp_server.js path');

// ── install.sh ───────────────────────────────────────────────────────────────
const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'install.sh'), 'utf8');
assertContains(sh, /pgrep.*mcp_server/,           'install.sh: pgrep mcp_server.js call present');
assertContains(sh, /kill.*-TERM|kill\s+-KILL/,     'install.sh: kill -TERM / -KILL present');
assertContains(sh, 'CLAWS_TERMINAL_CORR_ID',       'install.sh: filters by CLAWS_TERMINAL_CORR_ID');

// ── lib/install.js ───────────────────────────────────────────────────────────
const js = fs.readFileSync(path.join(ROOT, 'lib', 'install.js'), 'utf8');
assertContains(js, '_cleanStaleWorkerProcesses',   'lib/install.js: defines _cleanStaleWorkerProcesses');
assertContains(js, 'mcpServerPath',                'lib/install.js: filters processes by full mcpServerPath');
assertContains(js, 'CLAWS_TERMINAL_CORR_ID',       'lib/install.js: checks CLAWS_TERMINAL_CORR_ID env');
assertContains(js, 'Stop-Process',                 'lib/install.js: contains Stop-Process (Windows branch)');

// ── Summary ───────────────────────────────────────────────────────────────────
const total = passed + failed;
process.stdout.write(`\n${failed === 0 ? 'All' : `${failed} of`} ${total} install-cleanup checks ${failed === 0 ? 'passed' : 'FAILED'}.\n`);
if (failed > 0) process.exitCode = 1;
