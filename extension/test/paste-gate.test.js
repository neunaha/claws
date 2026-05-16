#!/usr/bin/env node
// AD-2 — paste-gate regression suite (static analysis).
//
// Locks in the AD-1 anti-pattern absence + helper presence without requiring
// a live claude binary. Runs against mcp_server.js only — extension files are
// untouched by AD-1.
//
// Eight assertions:
//   1. Helper _gatePasteOnClaudeClaim defined, takes (sock, termId, corrId, opts),
//      references _waitForWorkerReady.
//   2. Anti-pattern absent — NO "best-effort: assume booted, proceed" comment.
//   3. Slow path (runBlockingWorker) uses helper with _bCorrId exactly once.
//   4. Fast path (claws_worker) uses helper with _fpCorrId exactly once.
//   5. Dispatch path (claws_dispatch_subworker) uses helper with _dswCorrId/_dswSock exactly once.
//   6. system.worker.boot_failed topic published with required payload fields.
//   7. Tri-platform fallback regex covers darwin/linux/win32 signatures.
//   8. boot_wait_ms: 8000 unchanged in DEFAULTS.
//
// Run: node extension/test/paste-gate.test.js
// Exits 0 on all-pass, 1 on any failure.
// Tri-platform: fs.readFileSync + regex only — no fork, no child_process, no platform paths.

'use strict';

const fs = require('fs');
const path = require('path');

const MCP_SERVER = path.resolve(__dirname, '..', '..', 'mcp_server.js');

const assertions = [];

function check(name, ok, detail) {
  assertions.push({ name, ok: !!ok, detail: detail || '' });
}

const src = fs.readFileSync(MCP_SERVER, 'utf8');

// 1. Helper present — function defined, takes (sock, termId, corrId, opts), references _waitForWorkerReady.
check(
  'helper: _gatePasteOnClaudeClaim function defined',
  /async function _gatePasteOnClaudeClaim\s*\(/.test(src),
);
check(
  'helper: _gatePasteOnClaudeClaim takes (sock, termId, corrId, opts)',
  /async function _gatePasteOnClaudeClaim\s*\(\s*sock\s*,\s*termId\s*,\s*corrId\s*,\s*opts\s*\)/.test(src),
);
check(
  'helper: _gatePasteOnClaudeClaim body references _waitForWorkerReady',
  (function () {
    const helperStart = src.indexOf('async function _gatePasteOnClaudeClaim');
    if (helperStart === -1) return false;
    const snippet = src.slice(helperStart, helperStart + 2000);
    return /\b_waitForWorkerReady\b/.test(snippet);
  })(),
);

// 2. Anti-pattern absent — NO "best-effort: assume booted, proceed" comment.
check(
  'anti-pattern absent: no "best-effort: assume booted, proceed" comment',
  !src.includes('best-effort: assume booted, proceed'),
);

// 3. Slow path uses helper — runBlockingWorker body contains the call exactly once.
check(
  'slow-path: runBlockingWorker calls _gatePasteOnClaudeClaim with _bCorrId exactly once',
  (function () {
    const fnStart = src.indexOf('async function runBlockingWorker');
    if (fnStart === -1) return false;
    // Find the next top-level async function after runBlockingWorker to bound the slice.
    const nextFn = src.indexOf('\nasync function ', fnStart + 1);
    const body = nextFn === -1 ? src.slice(fnStart) : src.slice(fnStart, nextFn);
    const matches = body.match(/await _gatePasteOnClaudeClaim\s*\(\s*sock\s*,\s*termId\s*,\s*_bCorrId\s*,/g);
    return matches && matches.length === 1;
  })(),
);

// 4. Fast path uses helper — claws_worker section contains the call exactly once.
check(
  'fast-path: claws_worker calls _gatePasteOnClaudeClaim with _fpCorrId exactly once',
  (function () {
    // claws_worker fast path is not a top-level function; match by unique variable names.
    const occurrences = (src.match(/await _gatePasteOnClaudeClaim\s*\(\s*sock\s*,\s*termId\s*,\s*_fpCorrId\s*,/g) || []).length;
    return occurrences === 1;
  })(),
);

// 5. Dispatch path uses helper — claws_dispatch_subworker contains the call exactly once.
check(
  'dispatch-path: claws_dispatch_subworker calls _gatePasteOnClaudeClaim with _dswSock/_dswCorrId exactly once',
  (function () {
    const occurrences = (src.match(/await _gatePasteOnClaudeClaim\s*\(\s*_dswSock\s*,\s*termId\s*,\s*_dswCorrId\s*,/g) || []).length;
    return occurrences === 1;
  })(),
);

// 6. system.worker.boot_failed published with required payload fields.
check(
  'boot_failed: system.worker.boot_failed topic present in source',
  /['"]system\.worker\.boot_failed['"]/.test(src),
);
check(
  'boot_failed: payload contains cause field',
  (function () {
    const topicIdx = src.indexOf('system.worker.boot_failed');
    if (topicIdx === -1) return false;
    const snippet = src.slice(topicIdx, topicIdx + 800);
    return /\bcause\b/.test(snippet);
  })(),
);
check(
  'boot_failed: payload contains pty_tail field',
  (function () {
    const topicIdx = src.indexOf('system.worker.boot_failed');
    if (topicIdx === -1) return false;
    const snippet = src.slice(topicIdx, topicIdx + 800);
    return /pty_tail/.test(snippet);
  })(),
);
check(
  'boot_failed: payload contains timeout_ms field',
  (function () {
    const topicIdx = src.indexOf('system.worker.boot_failed');
    if (topicIdx === -1) return false;
    const snippet = src.slice(topicIdx, topicIdx + 800);
    return /timeout_ms/.test(snippet);
  })(),
);
check(
  'boot_failed: payload contains correlation_id field',
  (function () {
    const topicIdx = src.indexOf('system.worker.boot_failed');
    if (topicIdx === -1) return false;
    const snippet = src.slice(topicIdx, topicIdx + 800);
    return /correlation_id/.test(snippet);
  })(),
);

// 7. Tri-platform fallback regex covers darwin/linux/win32 signatures.
check(
  'tri-platform: claudeMarkers regex includes "bypass permissions"',
  /claudeMarkers\s*=.*bypass permissions/.test(src),
);
check(
  'tri-platform: claudeMarkers regex includes "Claude Code v"',
  /claudeMarkers\s*=.*Claude Code v/.test(src),
);
check(
  'tri-platform: shellErrorMarkers regex includes "command not found"',
  /shellErrorMarkers\s*=.*command not found/.test(src),
);
check(
  'tri-platform: shellErrorMarkers regex includes "is not recognized as" (win32)',
  /shellErrorMarkers\s*=.*is not recognized as/.test(src),
);
check(
  'tri-platform: shellErrorMarkers regex includes "bad pattern:" (zsh)',
  /shellErrorMarkers\s*=.*bad pattern:/.test(src),
);

// 8. boot_wait_ms: 8000 unchanged in DEFAULTS (no silent bump).
check(
  'defaults: boot_wait_ms is 8000 in DEFAULTS',
  /boot_wait_ms:\s*8000/.test(src),
);

// ── Report ────────────────────────────────────────────────────────────────────

for (const a of assertions) {
  console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + (a.detail || 'FAILED')}`);
}

const passed = assertions.filter(a => a.ok).length;
const total = assertions.length;
console.log(`\n${passed === total ? 'PASS' : 'FAIL'}: ${passed}/${total} checks`);

if (passed < total) {
  const failed = assertions.filter(a => !a.ok);
  console.error(`\nFailed checks (${failed.length}):`);
  for (const f of failed) console.error(`  ✗ ${f.name}`);
  process.exit(1);
}
process.exit(0);
