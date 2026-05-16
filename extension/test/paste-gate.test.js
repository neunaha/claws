#!/usr/bin/env node
// AD-2 + AE-1 — paste-gate regression suite (static analysis).
//
// Locks in event-driven boot detection (AE-1) — the regex/pty-log fallback
// path was removed 2026-05-16 after user rejected it as "not stable across
// platforms" (see .local/audits/peer-connected-blackout-root-cause.md §4).
//
// Assertions:
//   1. Helper _gatePasteOnClaudeClaim defined, takes (sock, termId, corrId, opts),
//      references _waitForWorkerReady.
//   2. Anti-pattern absent — NO "best-effort: assume booted, proceed" comment.
//   3. Slow path (runBlockingWorker) uses helper with _bCorrId exactly once.
//   4. Fast path (claws_worker) uses helper with _fpCorrId exactly once.
//   5. Dispatch path (claws_dispatch_subworker) uses helper with _dswCorrId/_dswSock exactly once.
//   6. system.worker.boot_failed topic published with required payload fields.
//   7. AE-1: regex/pty-log fallback REMOVED from helper body — no claudeMarkers / shellErrorMarkers / pty_tail.
//   8. AE-1: mcp_server.js main() has eager-hello block guarded on CLAWS_TERMINAL_CORR_ID.
//   9. boot_wait_ms: 8000 unchanged in DEFAULTS.
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
    const topicMatch = src.match(/topic:\s*['"]system\.worker\.boot_failed['"]/);
    const topicIdx = topicMatch ? topicMatch.index : -1;
    if (topicIdx === -1) return false;
    const snippet = src.slice(topicIdx, topicIdx + 800);
    return /\bcause\b/.test(snippet);
  })(),
);
check(
  'boot_failed: payload contains timeout_ms field',
  (function () {
    const topicMatch = src.match(/topic:\s*['"]system\.worker\.boot_failed['"]/);
    const topicIdx = topicMatch ? topicMatch.index : -1;
    if (topicIdx === -1) return false;
    const snippet = src.slice(topicIdx, topicIdx + 800);
    return /timeout_ms/.test(snippet);
  })(),
);
check(
  'boot_failed: payload contains correlation_id field',
  (function () {
    const topicMatch = src.match(/topic:\s*['"]system\.worker\.boot_failed['"]/);
    const topicIdx = topicMatch ? topicMatch.index : -1;
    if (topicIdx === -1) return false;
    const snippet = src.slice(topicIdx, topicIdx + 800);
    return /correlation_id/.test(snippet);
  })(),
);
check(
  'boot_failed: cause is event_driven_boot_timeout (AE-1)',
  /cause:\s*['"]event_driven_boot_timeout['"]/.test(src),
);

// 7. AE-1: regex/pty-log fallback REMOVED from helper body.
check(
  'AE-1 fallback removed: no claudeMarkers regex in mcp_server.js',
  !/\bclaudeMarkers\s*=/.test(src),
);
check(
  'AE-1 fallback removed: no shellErrorMarkers regex in mcp_server.js',
  !/\bshellErrorMarkers\s*=/.test(src),
);
check(
  'AE-1 fallback removed: helper no longer references pty_tail',
  (function () {
    const helperStart = src.indexOf('async function _gatePasteOnClaudeClaim');
    if (helperStart === -1) return false;
    const helperEnd = src.indexOf('\nasync function ', helperStart + 1);
    const body = helperEnd === -1 ? src.slice(helperStart) : src.slice(helperStart, helperEnd);
    return !/pty_tail/.test(body);
  })(),
);

// 8. AE-1: mcp_server.js main() has eager-hello block guarded on CLAWS_TERMINAL_CORR_ID.
check(
  'AE-1 eager-hello: main() block guarded on process.env.CLAWS_TERMINAL_CORR_ID',
  /process\.env\.CLAWS_TERMINAL_CORR_ID[\s\S]{0,400}_pconnEnsureRegistered/.test(src),
);
check(
  'AE-1 eager-hello: block uses setImmediate (non-blocking startup)',
  (function () {
    const mainIdx = src.indexOf('async function main()');
    if (mainIdx === -1) return false;
    const tail = src.slice(mainIdx, mainIdx + 4000);
    return /CLAWS_TERMINAL_CORR_ID[\s\S]{0,800}setImmediate/.test(tail);
  })(),
);

// 9. boot_wait_ms: 8000 unchanged in DEFAULTS (no silent bump).
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
