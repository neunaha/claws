#!/usr/bin/env node
// Mac event-driven boot UX invariants (locked in by user directive 2026-05-16).
// See memory: feedback_mac_event_driven_boot_ux_invariant
// See audit:  .local/audits/peer-connected-blackout-root-cause.md
// If a regression here fails, do NOT update the test to make it pass —
// fix the source and preserve the UX. This file is a contract, not a snapshot.
//
// Run: node extension/test/mac-event-driven-boot.test.js
// Exits 0 on all-pass, 1 on any failure.
// Tri-platform: fs.readFileSync + regex only — no fork, no child_process, no platform paths.

'use strict';

const fs = require('fs');
const path = require('path');

const MCP_SERVER = path.resolve(__dirname, '..', '..', 'mcp_server.js');
const SERVER_TS = path.resolve(__dirname, '..', 'src', 'server.ts');

const assertions = [];

function check(name, ok, detail) {
  assertions.push({ name, ok: !!ok, detail: detail || '' });
}

const src = fs.readFileSync(MCP_SERVER, 'utf8');
const serverSrc = fs.readFileSync(SERVER_TS, 'utf8');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractTopLevelFn(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) return null;
  const end = source.indexOf('\nasync function ', start + 1);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

function extractMainEagerHelloBlock(source) {
  const mainIdx = source.indexOf('async function main()');
  if (mainIdx === -1) return null;
  const mainSlice = source.slice(mainIdx, mainIdx + 5000);
  const ifIdx = mainSlice.indexOf('if (process.env.CLAWS_TERMINAL_CORR_ID)');
  if (ifIdx === -1) return null;
  // Start from the `if` statement itself — the comments before it are not included,
  // so mentions of fs.existsSync in those comments do not pollute the code check.
  return mainSlice.slice(ifIdx, ifIdx + 500);
}

// ─── I1: mcp_server.js main() eager-hello block ──────────────────────────────

// I1.a — main() block guarded on process.env.CLAWS_TERMINAL_CORR_ID
check(
  'I1.a: main() eager-hello block guarded on process.env.CLAWS_TERMINAL_CORR_ID',
  (function () {
    const mainIdx = src.indexOf('async function main()');
    if (mainIdx === -1) return false;
    const tail = src.slice(mainIdx, mainIdx + 5000);
    return /if\s*\(\s*process\.env\.CLAWS_TERMINAL_CORR_ID\s*\)/.test(tail);
  })(),
);

// I1.b — that block calls _pconnEnsureRegistered inside setImmediate
check(
  'I1.b: eager-hello block calls _pconnEnsureRegistered inside setImmediate',
  (function () {
    const block = extractMainEagerHelloBlock(src);
    if (!block) return false;
    return /setImmediate/.test(block) && /_pconnEnsureRegistered/.test(block);
  })(),
);

// I1.c — that block does NOT call fs.existsSync (AE-1.1 win32 regression guard)
check(
  'I1.c: eager-hello block does NOT call fs.existsSync (AE-1.1 win32 named-pipe regression guard)',
  (function () {
    const block = extractMainEagerHelloBlock(src);
    if (!block) return false;
    // Strip // comments to avoid false positives from doc comments that describe
    // the removed guard (e.g. "do NOT pre-check fs.existsSync(socket)").
    const codeOnly = block.replace(/\/\/.*$/gm, '');
    return !codeOnly.includes('fs.existsSync(');
  })(),
);

// ─── I2: server.ts hasRootOrchestrator + hello-handler gate ──────────────────

// I2.a — hasRootOrchestrator() excludes peers with waveId AND correlationId (AE-1.2)
check(
  'I2.a: hasRootOrchestrator() excludes peers with !p.waveId AND !p.correlationId (AE-1.2)',
  (function () {
    const start = serverSrc.indexOf('private hasRootOrchestrator()');
    if (start === -1) return false;
    const end = serverSrc.indexOf('\n  private ', start + 1);
    const body = end === -1 ? serverSrc.slice(start) : serverSrc.slice(start, end);
    return /!p\.waveId/.test(body) && /!p\.correlationId/.test(body);
  })(),
);

// I2.b — hello-handler root-rejection gate exempts orchestrators carrying correlation_id
check(
  'I2.b: hello-handler root-rejection gate exempts orchestrators with correlation_id (AE-1)',
  /!\(typeof r\.correlation_id === ['"]string['"] && r\.correlation_id\.length > 0\)/.test(serverSrc),
);

// ─── I3: _gatePasteOnClaudeClaim has no regex/pty-log fallback ───────────────

// I3.a — helper body does NOT contain claudeMarkers
check(
  'I3.a: _gatePasteOnClaudeClaim body does NOT reference claudeMarkers (regex fallback removed)',
  (function () {
    const body = extractTopLevelFn(src, 'async function _gatePasteOnClaudeClaim');
    if (!body) return false;
    return !/claudeMarkers/.test(body);
  })(),
);

// I3.b — helper body does NOT contain shellErrorMarkers
check(
  'I3.b: _gatePasteOnClaudeClaim body does NOT reference shellErrorMarkers (regex fallback removed)',
  (function () {
    const body = extractTopLevelFn(src, 'async function _gatePasteOnClaudeClaim');
    if (!body) return false;
    return !/shellErrorMarkers/.test(body);
  })(),
);

// I3.c — helper body does NOT contain pty_tail
check(
  'I3.c: _gatePasteOnClaudeClaim body does NOT reference pty_tail (pty-log fallback removed)',
  (function () {
    const body = extractTopLevelFn(src, 'async function _gatePasteOnClaudeClaim');
    if (!body) return false;
    return !/pty_tail/.test(body);
  })(),
);

// I3.d — helper body contains cause: 'event_driven_boot_timeout'
check(
  "I3.d: _gatePasteOnClaudeClaim body contains cause: 'event_driven_boot_timeout'",
  (function () {
    const body = extractTopLevelFn(src, 'async function _gatePasteOnClaudeClaim');
    if (!body) return false;
    return /cause:\s*['"]event_driven_boot_timeout['"]/.test(body);
  })(),
);

// ─── I4: exactly one sleep(200) in _gatePasteOnClaudeClaim ───────────────────

// I4.a — exactly ONE await sleep( call in the helper body (no creeping sleeps)
check(
  'I4.a: _gatePasteOnClaudeClaim body has exactly ONE await sleep( call (no creeping sleeps)',
  (function () {
    const body = extractTopLevelFn(src, 'async function _gatePasteOnClaudeClaim');
    if (!body) return false;
    const hits = body.match(/await sleep\s*\(/g);
    return hits !== null && hits.length === 1;
  })(),
);

// I4.b — that sleep is await sleep(200), the 200ms safety buffer only
check(
  'I4.b: the single sleep in _gatePasteOnClaudeClaim is await sleep(200) (200ms safety buffer)',
  (function () {
    const body = extractTopLevelFn(src, 'async function _gatePasteOnClaudeClaim');
    if (!body) return false;
    return /await sleep\s*\(\s*200\s*\)/.test(body);
  })(),
);

// ─── I5: _waitForWorkerReady uses a generous safety ceiling (AE-6.b) ─────────

// I5.a — ceilingMs default is >= 60000 (generous for slow VMs; NOT a tight boot budget)
check(
  'I5.a: _waitForWorkerReady ceilingMs default is >= 60000 (AE-6.b event-driven ceiling)',
  /const ceilingMs\s*=\s*opts\.timeoutMs\s*\|\|\s*(6[0-9]{4}|[1-9][0-9]{5,})/.test(src),
);

// ─── I6: AE-7 event-driven submit confirmation invariants ────────────────────

// I6.a — _waitForSubmitEvent helper is defined
check(
  'I6.a: _waitForSubmitEvent function is defined in mcp_server.js',
  /async function _waitForSubmitEvent\s*\(/.test(src),
);

// I6.b — SUBMIT_STRATEGIES array exists, '\r' is first element, and >= 3 entries
check(
  "I6.b: SUBMIT_STRATEGIES contains >= 3 entries with '\\r' as first (AE-7 escalating retry)",
  (function () {
    const firstIsR = /SUBMIT_STRATEGIES\s*=\s*\[\s*'\\r'/.test(src);
    const match = src.match(/SUBMIT_STRATEGIES\s*=\s*\[([\s\S]*?)\]/);
    const count = match ? match[1].split(',').filter(s => s.trim().length > 0).length : 0;
    return firstIsR && count >= 3;
  })(),
);

// I6.c — _sendAndSubmitMission contains NO pty-content regex (● or ⏺ patterns removed)
check(
  'I6.c: _sendAndSubmitMission has NO pty-content regex (● and ⏺ patterns absent — AE-7)',
  (function () {
    const fnStart = src.indexOf('async function _sendAndSubmitMission');
    if (fnStart === -1) return false;
    const nextFn = src.indexOf('\nasync function ', fnStart + 1);
    const body = nextFn === -1 ? src.slice(fnStart) : src.slice(fnStart, nextFn);
    return !body.includes('●') && !body.includes('⏺');
  })(),
);

// ─── Report ───────────────────────────────────────────────────────────────────

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
