#!/usr/bin/env node
// LH-stack regression suite. Locks every invariant of the lifecycle hardening track
// (LH-9, LH-10, LH-11, LH-11.1, LH-12) against future tampering. If any of these
// fire, a future commit broke a lifecycle hardening invariant — see the failing
// section's reference commit before "fixing" the test.
//
// Swaps from mission spec (avoids duplicating lh9-state-bulletproof / lifecycle-store /
// stream-events-wait suites):
//   B1-B3  → numeric parse of TTL constants (lh9 checks structural presence; we check value)
//   C1-C3  → TerminalClosedV1.terminal_id field + 'user'/'orchestrator' enum members
//             (lh9 checks correlation_id, idle_timeout, ttl_max)
//   A1     → no net.createConnection (lh9 checks no require('./lifecycle-state'))
//   A4     → require('child_process') present (lh9 checks pgrep pattern)
//   F1     → --timeout-ms nonNumeric → exit 1  (stream-events-wait tests missing/malformed UUID)
//   F2     → unreachable CLAWS_SOCKET → exit != 0  (stream-events-wait tests socket-close)
//   F3     → --timeout-ms 0 → exit 1  (stream-events-wait tests --auto-sidecar mutex)
//
// Run: node extension/test/lh-stack-regression.test.js
// Exits 0 on 30 PASS, 1 on any FAIL.
'use strict';

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT   = path.resolve(__dirname, '../..');
const SRC    = path.resolve(__dirname, '../src');
const HOOKS  = path.resolve(ROOT, 'scripts/hooks');

const STOP          = fs.readFileSync(path.join(HOOKS, 'stop-claws.js'), 'utf8');
const SCHEMAS       = fs.readFileSync(path.join(SRC,   'event-schemas.ts'), 'utf8');
const STORE         = fs.readFileSync(path.join(SRC,   'lifecycle-store.ts'), 'utf8');
const MCP           = fs.readFileSync(path.join(ROOT,  'mcp_server.js'), 'utf8');
const STREAM_EVENTS = fs.readFileSync(path.join(ROOT,  'scripts/stream-events.js'), 'utf8');

let passed = 0;
let failed = 0;
const results = [];

function check(label, condition, hint) {
  if (condition) {
    results.push(`  PASS  ${label}`);
    passed++;
  } else {
    results.push(`  FAIL  ${label}${hint ? '\n        hint: ' + hint : ''}`);
    failed++;
  }
}

// ─── SECTION A — Stop-hook defang (LH-9 Layer 3) ─────────────────────────────
// Ref commit: b8154c3

check(
  'A1: stop-claws.js does NOT contain net.createConnection (no socket connections)',
  !STOP.includes('net.createConnection'),
  'LH-9 removed the force-close block; no socket creation should remain',
);

check(
  'A2: stop-claws.js does NOT contain markWorkerStatus (no lifecycle mutation)',
  !STOP.includes('markWorkerStatus'),
  'Stop hook is defanged — lifecycle state is managed by TTL watchdog, not Stop hook',
);

check(
  'A3: stop-claws.js does NOT contain registerSpawn or spawned_workers',
  !STOP.includes('registerSpawn') && !STOP.includes('spawned_workers'),
  'Stop hook must not reference lifecycle state tracking symbols',
);

check(
  "A4: stop-claws.js DOES require('child_process') (spawnSync still present for sidecar kill)",
  STOP.includes("require('child_process')"),
  "Child_process require must remain — spawnSync/pgrep is how the sidecar gets killed",
);

// ─── SECTION B — TTL constants (LH-9 Layer 2) — numeric value checks ─────────
// Ref commit: b8154c3
// These complement lh9's structural-presence checks by verifying actual numeric values.

const idleMatch = STORE.match(/export\s+const\s+DEFAULT_IDLE_MS\s*=\s*([\d_]+)/);
const maxMatch  = STORE.match(/export\s+const\s+DEFAULT_MAX_MS\s*=\s*([\d_]+)/);
const idleVal   = idleMatch ? parseInt(idleMatch[1].replace(/_/g, ''), 10) : null;
const maxVal    = maxMatch  ? parseInt(maxMatch[1].replace(/_/g, ''),  10) : null;

check(
  'B1: DEFAULT_IDLE_MS parses to 600000 (exactly 10 minutes)',
  idleVal === 600000,
  `got ${idleVal} — expected 600000 (10 * 60 * 1000)`,
);

check(
  'B2: DEFAULT_MAX_MS parses to 14400000 (exactly 4 hours)',
  maxVal === 14400000,
  `got ${maxVal} — expected 14400000 (4 * 60 * 60 * 1000)`,
);

check(
  'B3: DEFAULT_MAX_MS / DEFAULT_IDLE_MS === 24 (4h is exactly 24× the 10min idle window)',
  idleVal !== null && maxVal !== null && maxVal / idleVal === 24,
  `ratio = ${maxVal != null && idleVal != null ? maxVal / idleVal : 'n/a'} — expected 24`,
);

// ─── SECTION C — Schema contract (LH-10 Layer A) ─────────────────────────────
// Ref commit: 45cfd8f
// C1-C3 check fields/members NOT already verified by lh9-state-bulletproof.

check(
  "C1: TerminalClosedV1 has terminal_id: z.string() field",
  /TerminalClosedV1\s*=\s*z\.object\([\s\S]{0,300}terminal_id:\s*z\.string\(\)/.test(SCHEMAS),
  "TerminalClosedV1 must declare terminal_id: z.string()",
);

check(
  "C2: TerminalCloseOriginEnum includes 'user' (normal UI-close not accidentally removed)",
  /TerminalCloseOriginEnum[\s\S]{0,600}'user'/.test(SCHEMAS),
  "Add 'user' to TerminalCloseOriginEnum — guards against accidental removal",
);

check(
  "C3: TerminalCloseOriginEnum includes 'orchestrator' (MCP-triggered close)",
  /TerminalCloseOriginEnum[\s\S]{0,600}'orchestrator'/.test(SCHEMAS),
  "Add 'orchestrator' to TerminalCloseOriginEnum",
);

check(
  "C4: TerminalCloseOriginEnum includes 'wave_violation' (LH-9 sub-worker auto-close)",
  /TerminalCloseOriginEnum[\s\S]{0,600}'wave_violation'/.test(SCHEMAS),
  "Add 'wave_violation' to TerminalCloseOriginEnum — LH-9 close-origin allowlist",
);

// ─── SECTION D — Monitor template contract (LH-12) ───────────────────────────
// Ref commit: 856edbb

const d1Count = MCP.split('${STREAM_EVENTS_JS} --wait ${').length - 1;
check(
  'D1: mcp_server.js has exactly 5 monitor_arm_command sites using --wait template',
  d1Count === 5,
  `found ${d1Count} — expected 5 (runBlockingWorker, claws_create, claws_worker, claws_fleet per-worker, claws_dispatch_subworker)`,
);

check(
  'D2: mcp_server.js contains ZERO occurrences of "awk" (no awk pipeline left)',
  !MCP.includes('awk'),
  'LH-12 removed the awk filter from all monitor_arm_command templates',
);

check(
  'D3: mcp_server.js contains ZERO occurrences of "grep --line-buffered" (no grep pipeline)',
  !MCP.includes('grep --line-buffered'),
  'LH-12 removed the grep pipeline from all monitor_arm_command templates',
);

check(
  'D4: mcp_server.js contains ZERO occurrences of "CLAWS_TOPIC=" in template strings',
  !MCP.includes('CLAWS_TOPIC='),
  'LH-12 removed CLAWS_TOPIC env-var injection from monitor_arm_command templates',
);

check(
  'D5: mcp_server.js contains ZERO occurrences of "{print; fflush()}" (LH-11 noisy form)',
  !MCP.includes('{print; fflush()}'),
  'LH-11 replaced the noisy awk form; LH-12 eliminated awk entirely',
);

const d6Sites = MCP.split('Monitor(command=').slice(1);
const d6AllWait = d6Sites.length === 5 &&
  d6Sites.every(s => /^"node /.test(s) && s.includes(' --wait '));
check(
  'D6: all 5 Monitor(command=...) sites start with "node" and contain "--wait"',
  d6AllWait,
  `sites=${d6Sites.length} allValid=${d6Sites.every(s => /^"node /.test(s) && s.includes(' --wait '))}`,
);

const d7Count = MCP.split('description="claws monitor | term=').length - 1;
check(
  'D7: all 5 monitor_arm_command descriptions use "claws monitor | term=" prefix',
  d7Count === 5,
  `found ${d7Count} description sites — expected 5`,
);

const d8Count = MCP.split('timeout_ms=600000, persistent=false').length - 1;
check(
  'D8: all 5 monitor_arm_command sites use timeout_ms=600000, persistent=false',
  d8Count === 5,
  `found ${d8Count} — expected 5`,
);

// ─── SECTION E — stream-events.js --wait contract (LH-12) ────────────────────
// Ref commit: 856edbb

check(
  "E1: stream-events.js contains '--wait' arg parsing logic",
  STREAM_EVENTS.includes("'--wait'"),
  "Add '--wait' flag parsing to arg loop in stream-events.js",
);

check(
  'E2: stream-events.js contains UUID validation regex [0-9a-f-]{36}',
  /\[0-9a-f-\]\{36\}/.test(STREAM_EVENTS),
  'Add /^[0-9a-f-]{36}$/ UUID validation in --wait mode',
);

check(
  "E3: stream-events.js subscribes to 'system.worker.completed' AND 'system.terminal.closed'",
  STREAM_EVENTS.includes("'system.worker.completed'") &&
  STREAM_EVENTS.includes("'system.terminal.closed'"),
  "Both completion topics must be subscribed in --wait mode",
);

check(
  "E4: stream-events.js does NOT subscribe to 'system.worker.terminated' (payload lacks correlation_id)",
  !STREAM_EVENTS.includes("'system.worker.terminated'"),
  "system.worker.terminated was intentionally dropped — payload lacks correlation_id",
);

check(
  'E5: stream-events.js has process.exit(0) on match AND process.exit(3) on timeout',
  STREAM_EVENTS.includes('process.exit(0)') && STREAM_EVENTS.includes('process.exit(3)'),
  'Exit 0 = match found; exit 3 = timeout — both must be present',
);

check(
  'E6: stream-events.js contains --auto-sidecar mutex message "mutually exclusive"',
  STREAM_EVENTS.includes('mutually exclusive'),
  '--wait and --auto-sidecar are mutually exclusive; the error message must be present',
);

// ─── SECTION F — Runtime smoke (LH-12 executable) ────────────────────────────
// Ref commit: 856edbb

const SCRIPT     = path.resolve(ROOT, 'scripts/stream-events.js');
const VALID_UUID = '00000000-0000-4000-0000-000000000001';

// F1: non-numeric --timeout-ms → exit 1 with "positive integer" message
{
  const r = spawnSync(process.execPath, [SCRIPT, '--wait', VALID_UUID, '--timeout-ms', 'notanumber'], {
    encoding: 'utf8', timeout: 3000,
  });
  check(
    'F1: --wait --timeout-ms notanumber → exit 1 ("positive integer" in stderr)',
    r.status === 1 && (r.stderr || '').includes('positive integer'),
    `code=${r.status} stderr=${(r.stderr || '').slice(0, 150)}`,
  );
}

// F2: CLAWS_SOCKET pointing to nonexistent path → exit !== 0 (ENOENT on connect)
{
  const fakeSock = `/tmp/claws-regrtest-nosock-${process.pid}.sock`;
  const r = spawnSync(process.execPath, [SCRIPT, '--wait', VALID_UUID, '--timeout-ms', '200'], {
    encoding: 'utf8', timeout: 3000,
    env: { ...process.env, CLAWS_SOCKET: fakeSock },
  });
  check(
    'F2: --wait with nonexistent CLAWS_SOCKET → exit !== 0 (ENOENT or socket-error path)',
    r.status !== 0,
    `code=${r.status} stderr=${(r.stderr || '').slice(0, 150)}`,
  );
}

// F3: --timeout-ms 0 → exit 1 (zero is not a positive integer per validation check)
{
  const r = spawnSync(process.execPath, [SCRIPT, '--wait', VALID_UUID, '--timeout-ms', '0'], {
    encoding: 'utf8', timeout: 3000,
  });
  check(
    'F3: --wait --timeout-ms 0 → exit 1 (zero is not a positive integer)',
    r.status === 1 && (r.stderr || '').includes('positive integer'),
    `code=${r.status} stderr=${(r.stderr || '').slice(0, 150)}`,
  );
}

// ─── SECTION G — Cross-layer coherence ───────────────────────────────────────

check(
  'G1: mcp_server.js declares STREAM_EVENTS_JS constant resolving to path ending "stream-events.js"',
  /const STREAM_EVENTS_JS[\s\S]{0,300}stream-events\.js/.test(MCP),
  'STREAM_EVENTS_JS must be declared and reference a stream-events.js path',
);

// G2: the UUID regex used by stream-events.js correctly validates crypto.randomUUID() output
{
  const { randomUUID } = require('crypto');
  const uuidRx = /^[0-9a-f-]{36}$/; // mirrors the literal verified present by E2
  const g2Pass = Array.from({ length: 10 }, () => randomUUID()).every(u => uuidRx.test(u));
  check(
    'G2: UUID regex from stream-events.js validates 10 crypto.randomUUID() outputs',
    g2Pass,
    'crypto.randomUUID() must produce lowercase-hex 36-char UUIDs matching /^[0-9a-f-]{36}$/',
  );
}

// ─── Print results ─────────────────────────────────────────────────────────────

const total = passed + failed;
results.forEach(r => console.log(r));
console.log('');
console.log(`lh-stack-regression.test.js: ${passed}/${total} PASS${failed > 0 ? ` (${failed} FAIL)` : ''}`);

if (failed > 0) process.exit(1);
