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

// ─── SECTION H — LH-14 completion convention (5 checks) ─────────────────────
// Ref commit: LH-14 — __CLAWS_DONE__ canonical marker + claws_publish PRIMARY

// H1: Phase 4a header contains 'claws_publish' AND 'PRIMARY' in the same window
{
  const headerIdx = MCP.indexOf('Completion signaling');
  const window = headerIdx >= 0 ? MCP.slice(headerIdx, headerIdx + 800) : '';
  check(
    'H1: mcp_server.js Phase 4a header contains claws_publish AND PRIMARY together',
    headerIdx >= 0 && window.includes('claws_publish') && window.includes('PRIMARY'),
    'Phase 4a header must contain "Completion signaling", "claws_publish", and "PRIMARY" together',
  );
}

// H2: mcp_server.js references __CLAWS_DONE__ canonical marker
check(
  'H2: mcp_server.js contains the canonical marker __CLAWS_DONE__',
  MCP.includes('__CLAWS_DONE__'),
  'Canonical marker __CLAWS_DONE__ must be present in mcp_server.js',
);

// H3: mcp_server.js does NOT use MISSION_COMPLETE as a default marker value
check(
  "H3: mcp_server.js does NOT contain || 'MISSION_COMPLETE' as default marker",
  !/\|\| ['"]MISSION_COMPLETE['"]/.test(MCP),
  "Default complete_marker must be '__CLAWS_DONE__', not 'MISSION_COMPLETE'",
);

// H4: CLAUDE.md (project root) contains __CLAWS_DONE__ AND claws_publish AND F3 AND F4 AND F5
{
  const CLAUDE_MD = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  check(
    'H4: CLAUDE.md contains __CLAWS_DONE__, claws_publish, F3, F4, and F5',
    CLAUDE_MD.includes('__CLAWS_DONE__') &&
    CLAUDE_MD.includes('claws_publish') &&
    CLAUDE_MD.includes('F3') &&
    CLAUDE_MD.includes('F4') &&
    CLAUDE_MD.includes('F5'),
    'CLAUDE.md must document the 5-layer convention with all required elements',
  );
}

// H5: both templates contain __CLAWS_DONE__
{
  const GLOBAL_TPL = fs.readFileSync(path.join(ROOT, 'templates/CLAUDE.global.md'), 'utf8');
  const PROJECT_TPL = fs.readFileSync(path.join(ROOT, 'templates/CLAUDE.project.md'), 'utf8');
  check(
    'H5: templates/CLAUDE.global.md AND templates/CLAUDE.project.md both contain __CLAWS_DONE__',
    GLOBAL_TPL.includes('__CLAWS_DONE__') && PROJECT_TPL.includes('__CLAWS_DONE__'),
    'Both templates must reference __CLAWS_DONE__ so future installs get the new convention',
  );
}

// ─── SECTION I — LH-15 marker tolerance + auto-wrap (4 checks) ──────────────
// Ref commit: LH-15 — zsh wrap-artifact regex fix + server-side wrapShellCommand

// I1: findStandaloneMarker regex contains backslash-tolerant leading class
check(
  'I1: findStandaloneMarker regex contains backslash-tolerant leading class [\\t \\\\]*',
  /\[\\\\t \\\\\\\\\]\*/.test(MCP) || MCP.includes('[\\\\t \\\\\\\\]*') || /\[\\t \\\\\]\*/.test(MCP) ||
  // check the actual source string that was written
  MCP.includes('[\\t \\\\]*'),
  'findStandaloneMarker leading class must match backslashes to tolerate zsh wrap artifact (LH-15)',
);

// I2: mcp_server.js declares wrapShellCommand function
check(
  'I2: mcp_server.js declares function wrapShellCommand',
  MCP.includes('function wrapShellCommand'),
  'wrapShellCommand must be declared in mcp_server.js (LH-15 auto-wrap for shell workers)',
);

// I3: mcp_server.js calls wrapShellCommand(args.command, ...) at least once
check(
  'I3: mcp_server.js calls wrapShellCommand(args.command, ...) at least once',
  MCP.includes('wrapShellCommand(args.command,'),
  'Auto-wrap must be wired — wrapShellCommand(args.command, ...) call must appear in mcp_server.js',
);

// I4: no bare args.command in payload assignment outside wrapShellCommand definition
{
  // Find all lines containing 'args.command' excluding the definition of wrapShellCommand itself
  const lines = MCP.split('\n');
  const suspiciousLines = lines.filter(line => {
    if (!line.includes('args.command')) return false;
    // Allow: inside wrapShellCommand body (rawCommand param used here)
    if (line.includes('function wrapShellCommand')) return false;
    // Allow: wrapShellCommand call (wrapping properly)
    if (line.includes('wrapShellCommand(args.command')) return false;
    // Allow: hasCommand declaration (typeof check, no send)
    if (line.includes('typeof args.command')) return false;
    // Allow: fileExec call (different code path, not worker payload)
    if (line.includes('fileExec(')) return false;
    // Allow: log/comment lines
    if (/^\s*\/\//.test(line)) return false;
    // Any remaining 'args.command' in a payload context is suspicious
    if (line.includes('? args.command') || line.includes(': args.command')) return true;
    return false;
  });
  check(
    'I4: no bare args.command in payload assignment outside wrapShellCommand',
    suspiciousLines.length === 0,
    `Found ${suspiciousLines.length} bare args.command payload site(s):\n` +
      suspiciousLines.map(l => '        ' + l.trim()).join('\n'),
  );
}

// ─── SECTION J — LH-14.1: loose worker-complete schema + mode-aware detach ────
// Ref commit: LH-14.1

const WORKER_COMPLETE_SCHEMA = fs.readFileSync(
  path.join(ROOT, 'schemas/json/worker-complete-v1.json'), 'utf8',
);
const GEN_MCP_TOOLS = fs.readFileSync(
  path.join(ROOT, 'scripts/codegen/gen-mcp-tools.mjs'), 'utf8',
);

// J1: worker-complete-v1.json required array contains exactly ["result"]
{
  let j1Pass = false;
  try {
    const schema = JSON.parse(WORKER_COMPLETE_SCHEMA);
    const def = schema.definitions?.['worker-complete-v1'] || schema.definitions?.['WorkerCompleteV1'];
    const required = def?.required || schema?.required;
    j1Pass = Array.isArray(required) && required.length === 1 && required[0] === 'result';
  } catch (e) { /* parse error — j1Pass stays false */ }
  check(
    'J1: worker-complete-v1.json required array contains exactly ["result"]',
    j1Pass,
    'required array must be ["result"] — all other fields are now optional',
  );
}

// J2: event-schemas.ts WorkerCompleteV1 has all fields except result marked .optional()
{
  const wcMatch = SCHEMAS.match(/export\s+const\s+WorkerCompleteV1\s*=\s*z\.object\(([\s\S]*?)\);\s*export\s+type\s+WorkerComplete/);
  const wcBlock = wcMatch ? wcMatch[1] : '';
  const optionalCount = (wcBlock.match(/\.optional\(\)/g) || []).length;
  // Check only the result: line itself — not the entire 60-char window
  const resultLineHasOptional = /result:[^\n]*\.optional\(\)/.test(wcBlock);
  check(
    'J2: event-schemas.ts WorkerCompleteV1 has all 6 non-result fields marked .optional()',
    wcBlock.length > 0 && optionalCount >= 6 && !resultLineHasOptional,
    `wcBlock found=${wcBlock.length > 0}, optionals=${optionalCount} (need ≥6), result-line.optional=${resultLineHasOptional} (must be false)`,
  );
}

// J3: mcp_server.js claws_worker handler uses mode-aware detach default
{
  const j3WorkerMatch = MCP.match(
    /if\s*\(\s*name\s*===\s*'claws_worker'\s*\)([\s\S]*?)(?=\n\s*if\s*\(\s*name\s*===)/,
  );
  const j3WorkerBlock = j3WorkerMatch ? j3WorkerMatch[1] : '';
  check(
    'J3: mcp_server.js claws_worker handler uses mode-aware detach default (hasCommand in expression)',
    j3WorkerBlock.length > 0 &&
    /const\s+detach\s*=\s*args\.detach\s*!==\s*undefined[\s\S]{0,200}!hasCommand/.test(j3WorkerBlock),
    'claws_worker handler must contain: const detach = args.detach !== undefined ? ... : !hasCommand',
  );
}

// J4: gen-mcp-tools.mjs detach description reflects mode-aware default
check(
  'J4: gen-mcp-tools.mjs detach description reflects mode-aware default',
  GEN_MCP_TOOLS.includes('Default depends on mode'),
  'detach describe() string must include "Default depends on mode" (updated in LH-14.1)',
);

// ─── Print results ─────────────────────────────────────────────────────────────

const total = passed + failed;
results.forEach(r => console.log(r));
console.log('');
console.log(`lh-stack-regression.test.js: ${passed}/${total} PASS${failed > 0 ? ` (${failed} FAIL)` : ''} (target: 43/43)`);

if (failed > 0) process.exit(1);
