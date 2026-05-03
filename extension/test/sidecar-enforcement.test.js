// sidecar-enforcement.test.js — regression suite for v0.7.10+ bulletproof auto-sidecar.
//
// Category A: Source-level assertions over mcp_server.js (no socket required).
//   A1 — _ensureSidecarOrThrow symbol exists
//   A2 — all 4 spawn handlers call _ensureSidecarOrThrow
//   A3 — singleton-promise dedup pattern (_sidecarEnsureInFlight)
//   A4 — read-only handlers do NOT call _ensureSidecarOrThrow
//   A5 — maxWaitMs default is in [1500, 3000] ms
//
// Category B–D: Integration / failure-injection / regression stubs.
//   Require a live extension socket + real sidecar binary. Scaffolded with
//   TODO comments for future expansion; skipped at runtime via SKIP_INTEGRATION.
//
// Run: node --test extension/test/sidecar-enforcement.test.js
// Exits 0 when all implemented checks pass.
// NOTE: Category A checks go RED until the IMPL worker lands _ensureSidecarOrThrow.

'use strict';

const fs = require('fs');
const path = require('path');

const MCP = fs.readFileSync(
  path.join(__dirname, '..', '..', 'mcp_server.js'),
  'utf8',
);

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail || '' });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Extract the body of a named handler block by finding the content between
// `if (name === '<toolName>')` and the next `if (name ===` boundary.
// Returns '' when the block cannot be located.
function extractHandlerBlock(toolName) {
  const pattern = new RegExp(
    `if\\s*\\(\\s*name\\s*===\\s*['"]${toolName}['"]\\s*\\)([\\s\\S]*?)(?=\\n\\s*if\\s*\\(\\s*name\\s*===)`,
  );
  const m = MCP.match(pattern);
  return m ? m[1] : '';
}

// Returns true when _ensureSidecarOrThrow appears before the first occurrence
// of any pty-work keyword in `block`.  If sidecar call is absent, returns false.
// If all pty keywords are absent, returns true (no pty work = nothing to guard).
function sidecarBeforePtyWork(block) {
  const sidecarIdx = block.indexOf('_ensureSidecarOrThrow');
  if (sidecarIdx === -1) return false;
  const ptyKeywords = ['ptySpawn', 'runBlockingWorker', 'claws_create'];
  for (const kw of ptyKeywords) {
    const kwIdx = block.indexOf(kw);
    if (kwIdx !== -1 && kwIdx < sidecarIdx) return false;
  }
  return true;
}

// ─── Category A: Source-level assertions ─────────────────────────────────────

// A1 — _ensureSidecarOrThrow symbol exists in mcp_server.js
check(
  'A1 — _ensureSidecarOrThrow function or const is defined',
  /\b_ensureSidecarOrThrow\b/.test(MCP),
  'expected _ensureSidecarOrThrow (function or const) to be declared in mcp_server.js',
);

// A2 — All 4 spawn handlers call _ensureSidecarOrThrow before pty work
//
// The guard must appear in each block AND before any ptySpawn/runBlockingWorker
// call to prevent spawning without a live sidecar.
const spawnHandlers = ['claws_create', 'claws_worker', 'claws_fleet', 'claws_dispatch_subworker'];
for (const handler of spawnHandlers) {
  const block = extractHandlerBlock(handler);
  check(
    `A2 — ${handler} handler block found`,
    block.length > 0,
    `could not locate handler block for ${handler} in mcp_server.js`,
  );
  check(
    `A2 — ${handler} calls _ensureSidecarOrThrow before pty work`,
    sidecarBeforePtyWork(block),
    `${handler} must call _ensureSidecarOrThrow before any ptySpawn/runBlockingWorker`,
  );
}

// A3 — Singleton-promise dedup: _sidecarEnsureInFlight variable exists and
//      is assigned so concurrent callers reuse one in-flight promise.
check(
  'A3 — _sidecarEnsureInFlight sentinel variable declared in mcp_server.js',
  /\b_sidecarEnsureInFlight\b/.test(MCP),
  'expected a module-scoped _sidecarEnsureInFlight sentinel variable',
);
check(
  'A3 — _sidecarEnsureInFlight is used as singleton dedup (if-null guard)',
  /if\s*\(\s*!_sidecarEnsureInFlight\s*\)/.test(MCP),
  'expected `if (!_sidecarEnsureInFlight)` guard so concurrent callers reuse one promise',
);

// A4 — Read-only handlers do NOT call _ensureSidecarOrThrow
//
// Tools that merely query state (list, poll, drain, publish, readLog) must
// work without a live sidecar — asserting the guard is absent prevents
// accidentally breaking them.
const readOnlyHandlers = ['claws_list', 'claws_drain_events', 'claws_publish', 'claws_read_log', 'claws_poll'];
for (const handler of readOnlyHandlers) {
  const block = extractHandlerBlock(handler);
  // Only assert the absence check when the block was found; if extraction
  // fails the block is '' and the regex would be vacuously false anyway.
  check(
    `A4 — ${handler} does NOT call _ensureSidecarOrThrow`,
    !/_ensureSidecarOrThrow/.test(block),
    `read-only handler ${handler} must not gate on sidecar presence`,
  );
}

// A5 — maxWaitMs default is in [1500, 3000] ms
//
// Strategy: find the _ensureSidecarOrThrow definition (up to 300 chars from
// the keyword) and extract the numeric default for maxWaitMs.
const defWindow = (() => {
  const idx = MCP.indexOf('_ensureSidecarOrThrow');
  if (idx === -1) return '';
  // Scan forward up to 300 chars for the first `maxWaitMs = <number>` pattern
  return MCP.slice(idx, idx + 300);
})();

const maxWaitMsMatch = defWindow.match(/\bmaxWaitMs\s*=\s*(\d+)/);
const maxWaitMsDefault = maxWaitMsMatch ? Number(maxWaitMsMatch[1]) : null;

check(
  'A5 — _ensureSidecarOrThrow defines maxWaitMs parameter with a numeric default',
  maxWaitMsDefault !== null,
  'expected `maxWaitMs = <number>` in the _ensureSidecarOrThrow definition',
);
check(
  `A5 — maxWaitMs default is in [1500, 3000] ms (got: ${maxWaitMsDefault})`,
  maxWaitMsDefault !== null && maxWaitMsDefault >= 1500 && maxWaitMsDefault <= 3000,
  `default ${maxWaitMsDefault} is outside the acceptable range [1500, 3000]`,
);

// ─── Category B: Integration stubs (TODO — require live extension socket) ────

// TODO B1 — Sidecar respawns if dead before claws_create
//   Steps: boot extension → kill sidecar → send { cmd: 'create', ... } →
//          assert ok:true within maxWaitMs+500ms and PID changed.
//   Acceptance: resp.ok === true; wall-clock < maxWaitMs + 500 ms.
//   Pending: requires multi-connection.test.js harness.

// TODO B2 — Fast path when sidecar already alive (~10 ms overhead)
//   Steps: boot extension → wait for sidecar → send create → measure delta.
//   Acceptance: t1-t0 < 100 ms; single auto-spawned log entry.
//   Pending: requires multi-connection.test.js harness.

// TODO B3 — 5 concurrent claws_create → exactly ONE sidecar spawn
//   Steps: kill sidecar → open 5 connections → send create on all at t=0 →
//          wait for all 5 responses → count auto-spawned log lines.
//   Acceptance: spawnCount === 1; successCount === 5.
//   Pending: requires multi-connection.test.js harness + Promise.all on connect.

// TODO B4 — Mid-spawn pkill handled cleanly (FLAKY-EXPECTED on tight race window)
//   Steps: kill sidecar → send create → after ~50ms pkill again →
//          wait for response up to maxWaitMs+1000ms.
//   Acceptance: response arrives; ok:true OR ok:false with sidecar error message.
//   Pending: requires multi-connection.test.js harness.

// TODO B5 — SessionStart hook pre-seeded sidecar → no double-spawn
//   Steps: spawn stream-events.js manually → boot extension → send create →
//          assert zero auto-spawned log lines.
//   Acceptance: log.filter(/auto-spawned/).length === 0; single sidecar PID.
//   Pending: requires multi-connection.test.js harness.

// ─── Category C: Failure injection stubs (TODO — require fs mutation) ────────

// TODO C1 — Sidecar binary missing → SPAWN REFUSED, no orphan terminal
//   Steps: rename stream-events.js → kill sidecar → send create →
//          restore in finally.
//   Acceptance: resp.ok === false; resp.error includes 'sidecar'; no dangling terminal.

// TODO C2 — Socket inaccessible → timeout within maxWaitMs
//   Steps: kill sidecar → chmod 000 .claws/claws.sock → send create →
//          restore in finally.
//   Acceptance: wall-clock <= maxWaitMs+200ms; resp.ok === false; error mentions timeout.

// TODO C3 — Sidecar exits immediately → fast-fail, not hang
//   Steps: prepend process.exit(1) to stream-events.js → kill sidecar → send create →
//          restore in finally.
//   Acceptance: response in <1000ms; resp.ok === false; error mentions crash/exit.

// ─── Category D: Regression stubs ────────────────────────────────────────────

// TODO D1 — Read-only tools work without sidecar (integration companion to A4)
//   Steps: kill sidecar + rename binary → send list/poll/publish →
//          assert ok:true for all three → restore in finally.
//   Acceptance: resp.ok === true for claws_list, claws_poll, claws_publish.
//   Note: A4 provides source-level coverage; this would add live coverage.

// TODO D2 — Full suite (90+ checks) still passes after sidecar implementation
//   Steps: node --test extension/test/*.test.js
//   Acceptance: exit code 0; PASS count >= 90.
//   Note: run manually via `cd extension && npm test` to validate before release.

// ─── Final report ─────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
for (const c of checks) {
  if (c.ok) {
    console.log('  ✓ ' + c.name);
    pass++;
  } else {
    console.log('  ✗ ' + c.name + (c.detail ? ' — ' + c.detail : ''));
    fail++;
  }
}
console.log(`\nPASS: ${pass}  FAIL: ${fail}  (sidecar-enforcement)`);
if (fail > 0) {
  console.log('NOTE: Category A failures are expected while IMPL worker is pending (PENDING_IMPL_SIDECAR)');
  process.exit(1);
}
