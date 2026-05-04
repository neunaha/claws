// non-blocking-defaults.test.js — regression suite for v0.7.10+ non-blocking defaults.
//
// Source-level assertions over mcp_server.js that lock in the three-part
// contract introduced to prevent the orchestrator from hanging on any
// single claws_fleet or claws_worker call:
//
//   (1) claws_fleet detach defaults to TRUE  (opt-out, not opt-in)
//   (2) claws_worker blocking mode is opt-in via wait=true
//   (3) withMaxHold() 8 s ceiling exists in the tool dispatcher
//
// These tests go RED until Worker A lands the implementation — that is
// intentional. The suite runs with zero dependencies: node --test.

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

// ─── (1) claws_fleet: detach defaults to true ────────────────────────────────
//
// Old guard: `const detach = args.detach === true;`  — opt-in (false by default).
// New guard: `const detach = args.detach !== false;` — opt-out (true by default).
//
// The test locates the claws_fleet handler block by finding the content between
// the `if (name === 'claws_fleet')` line and the next else-if boundary, then
// asserts the new semantics are in place and the old opt-in guard is gone.

const fleetBlockMatch = MCP.match(
  /if\s*\(\s*name\s*===\s*'claws_fleet'\s*\)([\s\S]*?)(?=\n\s*if\s*\(\s*name\s*===)/,
);
const fleetBlock = fleetBlockMatch ? fleetBlockMatch[1] : '';

check(
  'claws_fleet handler block was found in mcp_server.js',
  fleetBlock.length > 0,
  'could not locate block between claws_fleet and next if(name===)',
);

check(
  'claws_fleet detach uses !== false (default-true opt-out semantics)',
  /const\s+detach\s*=\s*args\.detach\s*!==\s*false/.test(fleetBlock),
  'expected: const detach = args.detach !== false',
);

check(
  'claws_fleet does NOT use args.detach === true as the gating condition (old opt-in guard removed)',
  !/const\s+detach\s*=\s*args\.detach\s*===\s*true/.test(fleetBlock),
  'found old opt-in guard: const detach = args.detach === true — remove it',
);

// ─── (2) claws_worker: blocking is opt-in via wait=true ──────────────────────
//
// Old behaviour: claws_worker always blocks (calls runBlockingWorker unconditionally).
// New behaviour: blocking only when args.wait === true. The default path spawns
// and returns immediately with { terminal_id, hint } so the orchestrator is
// never stalled.

const workerBlockMatch = MCP.match(
  /if\s*\(\s*name\s*===\s*'claws_worker'\s*\)([\s\S]*?)(?=\n\s*if\s*\(\s*name\s*===)/,
);
const workerBlock = workerBlockMatch ? workerBlockMatch[1] : '';

check(
  'claws_worker handler block was found in mcp_server.js',
  workerBlock.length > 0,
  'could not locate block between claws_worker and next if(name===)',
);

check(
  'claws_worker uses args.wait === true as the opt-in gate for blocking',
  /args\.wait\s*===\s*true/.test(workerBlock),
  'expected: if (args.wait === true) { ... block ... } else { spawn-and-return }',
);

check(
  'claws_worker non-blocking path returns terminal_id and hint',
  // The fast path must return an object that contains terminal_id and some
  // human-readable hint key so the caller knows how to observe the worker.
  /terminal_id[\s\S]{0,200}hint/.test(workerBlock) ||
  /hint[\s\S]{0,200}terminal_id/.test(workerBlock),
  'non-blocking return value must include terminal_id and a hint field',
);

// ─── (2b) claws_worker: mode-aware detach default ────────────────────────────
//
// LH-14.1: detach default is now mode-aware.
//   mission mode (no command):  detach defaults to true  (fire-and-return)
//   command mode (has command): detach defaults to false (blocking via !detach)
//
// The implementation declares `const hasCommand` before the blocking gate and
// uses `!hasCommand` as the detach default when args.detach is not explicit.

check(
  'claws_worker handler contains hasCommand-based detach default',
  /const\s+detach\s*=\s*args\.detach\s*!==\s*undefined[\s\S]{0,200}!hasCommand/.test(workerBlock),
  'expected: const detach = args.detach !== undefined ? args.detach !== false : !hasCommand',
);

check(
  'mission-mode default remains detach=true (!hasCommand is false when no command → detach=true)',
  /!\s*hasCommand/.test(workerBlock),
  'detach default expression must contain !hasCommand so mission mode defaults to detach=true',
);

check(
  'command-mode default flips to detach=false (hasCommand=true → !hasCommand=false → detach=false)',
  /!\s*hasCommand/.test(workerBlock) &&
  /args\.detach\s*!==\s*undefined/.test(workerBlock),
  '!hasCommand in the detach ternary ensures command mode defaults to detach=false',
);

// ─── (3) withMaxHold helper exists with Promise.race guard ───────────────────
//
// The main tool dispatcher wraps every handler call in withMaxHold(8000) so
// that no single slow tool can block the event loop for more than 8 seconds
// from the caller's perspective — the tool still runs to completion, but the
// dispatcher returns a "still-running" stub after the hold window expires.

check(
  'withMaxHold function is defined in mcp_server.js',
  /\bwithMaxHold\b/.test(MCP),
  'expected a withMaxHold function (or const withMaxHold = ...) in mcp_server.js',
);

check(
  'withMaxHold uses Promise.race with setTimeout for the ceiling',
  /Promise\.race\s*\([\s\S]*?setTimeout/.test(MCP),
  'expected: Promise.race([promise, new Promise(res => setTimeout(res, ms))])',
);

// ─── (4) withMaxHold ceiling is 8000 ms ──────────────────────────────────────
//
// Extract the 10-line window around the first `withMaxHold` definition and
// assert the literal 8000 appears within it.

const lines = MCP.split('\n');
const holdDefLine = lines.findIndex((l) => /\bwithMaxHold\b/.test(l) && /function|const|=/.test(l));
const holdWindow = holdDefLine >= 0
  ? lines.slice(holdDefLine, holdDefLine + 10).join('\n')
  : '';

check(
  'withMaxHold definition found (needed for 8000 ms ceiling check)',
  holdDefLine >= 0,
  'could not find withMaxHold definition line',
);

check(
  'withMaxHold ceiling is 8000 ms (within 10 lines of definition)',
  /\b8000\b/.test(holdWindow),
  `8000 not found in the 10 lines starting at withMaxHold definition (line ${holdDefLine + 1})`,
);

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
console.log(`\nPASS: ${pass}  FAIL: ${fail}  (non-blocking-defaults)`);
if (fail > 0) {
  console.log('NOTE: failures are expected while Worker A implementation is pending (PENDING_WORKER_A)');
  process.exit(1);
}
