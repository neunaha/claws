// v0.7.9 worker reliability — regression suite.
//
// Static-analysis smoke tests over mcp_server.js + scripts/install.sh that
// catch accidental reverts of the small set of correctness fixes that ship
// in v0.7.9. The worker behavior is otherwise the v0.7.4 contract: the
// mission goes directly into Claude Code's input as a normal user prompt.
//
// EXPLICIT NON-FIXES (do not add tests asserting these — they were tried and
// rejected by the project owner):
//   - file-referrer pattern (mission written to /tmp + "Read <file>..." sent)
//   - boot_retries (typed `claude ...` into already-booted TUI as user input)
//   - run_token / mission_file return-value fields
//
// If a future contributor reintroduces any of those, this file has no opinion
// — but the rule is "missions are user prompts, period."

const fs = require('fs');
const path = require('path');

const MCP = fs.readFileSync(
  path.join(__dirname, '..', '..', 'mcp_server.js'),
  'utf8',
);
const INSTALL_SH = fs.readFileSync(
  path.join(__dirname, '..', '..', 'scripts', 'install.sh'),
  'utf8',
);

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail || '' });
}

// ─── runBlockingWorker correctness ───────────────────────────────────────────

// boot_marker default must match the Claude Code v2.x bypass-mode footer.
// Legacy 'Claude Code' (with space) never matched the ANSI-stripped banner,
// so every spawn burned its full boot_wait_ms before falling through.
check(
  "boot_marker default is 'bypass permissions'",
  /boot_marker:\s*'bypass permissions'/.test(MCP),
);

// Marker scan offset — the poll loop must scan a slice of pty bytes that
// EXCLUDES the input echo of the mission text. Otherwise any complete_marker
// substring in the user's mission triggers a false-complete in 1-2 polls.
check(
  'markerScanFrom variable declared',
  /\bmarkerScanFrom\b/.test(MCP),
);
check(
  'markerScanFrom is captured AFTER the payload send (so the mission echo is excluded from the scan)',
  // W8k-1 refactor: send + markerScanFrom now live inside _sendAndSubmitMission.
  // The invariant is the same — markerScanFrom is set after the mission is sent.
  // We verify: (a) the helper function exists, (b) it sends the payload, and
  // (c) it sets markerScanFrom from the post-mission log snapshot.
  /async function _sendAndSubmitMission[\s\S]{0,3000}cmd:\s*'send'[\s\S]{0,2000}markerScanFrom\s*=/.test(MCP),
);
check(
  'poll loop scans scanText slice for completion marker (NOT the full text)',
  /scanText\s*=\s*text\.length\s*>\s*markerScanFrom\s*\?\s*text\.slice\(markerScanFrom\)/.test(MCP) &&
  /detectCompletion\(scanText,\s*opt/.test(MCP),
);

// Mission must be sent as a direct user prompt to Claude Code's input. No
// file abstractions. The payload assignment chain is plain: hasMission -> mission,
// hasCommand -> command. The single-line mission goes through `claws_send`
// which auto-wraps multi-line in bracketed paste; trailing CR is sent
// separately after a sleep so Claude Code v2.x's paste-detect window closes.
check(
  'mission is sent directly as user prompt (no file referrer)',
  // payload derives from args.mission: either directly (payload = args.mission) or
  // via a processing variable (safeMission = ...args.mission...; payload = safeMission).
  // Both forms satisfy "no file-abstraction layer" — the mission is args.mission itself.
  (/const\s+payload\s*=\s*hasMission\s*\?\s*args\.mission/.test(MCP) ||
   (/const\s+safeMission\s*=\s*hasMission[\s\S]{0,300}args\.mission/.test(MCP) &&
    /const\s+payload\s*=\s*hasMission\s*\?\s*safeMission/.test(MCP))),
);
check(
  'NO file-referrer pattern in mcp_server.js (forbidden by project owner)',
  !/claws-mission-/.test(MCP) &&
  !/Read\s+\$\{missionFile\}/.test(MCP) &&
  !/Read\s+\$\{[a-zA-Z_]*[Ff]ile\}\s+and\s+follow/.test(MCP),
);

// Single boot attempt — never send the launch command twice. Sending it a
// second time would type `claude ...` into an already-booted Claude Code TUI
// as a user prompt, which is harmful and confusing. v0.7.4 contract.
check(
  'NO boot retry loop (single attempt, best-effort)',
  !/\bboot_retries\b/.test(MCP) &&
  !/maxAttempts/.test(MCP),
);

// ─── install.sh correctness ─────────────────────────────────────────────────

// Self-collision guard. When TARGET == INSTALL_DIR (e.g. ~/.claws-src
// symlinked to project root), the skill-copy loop's `rm -rf` deleted the
// source before `cp -r` could read it, aborting install.sh at step 6.
// `-ef` (same-inode) test makes the loop skip the rm+cp pair when src == dest.
check(
  'install.sh skill loop has -ef self-collision guard',
  /if\s*\[\s*"\$_skill_src"\s*-ef\s*"\$TARGET\/\.claude\/skills\/\$_skill_name"\s*\];\s*then\s*continue;\s*fi/.test(INSTALL_SH),
);
check(
  'install.sh prompt-templates rename has -ef self-collision guard',
  // The general skill-copy loop's -ef guard covers claws-prompt-templates via
  // $_skill_name (refactored from a specific guard in v0.7.14 sweep).
  /-ef\s*"\$TARGET\/\.claude\/skills\/(?:\$_skill_name|claws-prompt-templates)"/.test(INSTALL_SH),
);

// Uncommitted-work guard before git reset --hard. install.sh Step 1 used to
// silently destroy local edits when INSTALL_DIR is a contributor's working
// repo. The guard refuses to reset on a dirty tree unless CLAWS_FORCE_RESET=1.
check(
  'install.sh has uncommitted-work guard before git reset --hard',
  /CLAWS_FORCE_RESET/.test(INSTALL_SH) &&
  /uncommitted changes — refusing to git reset/.test(INSTALL_SH),
);

// ─── MCP main-loop concurrent dispatch (v0.7.10) ─────────────────────────────
// The MCP tools/call branch must NOT await handleTool — that serializes every
// tool call, defeating fan-out (3 parallel claws_worker, wave armies, etc.)
// because each blocking call holds the main loop for up to timeout_ms.
// v0.7.10 dispatches via .then/.catch so the loop reads the next message
// while the previous handler runs.
check(
  'MCP tools/call dispatches concurrently (no await on handleTool)',
  // The handleTool call inside tools/call must be followed by .then( and .catch(
  // — and there must be NO `const result = await handleTool(...)` pattern.
  /handleTool\(params\.name\s*\|\|\s*''\s*,\s*params\.arguments\s*\|\|\s*\{\}\)\s*\.then\(\(result\)\s*=>\s*respond\(id,\s*result\)\)\s*\.catch\(/.test(MCP) &&
  !/const\s+result\s*=\s*await\s+handleTool\(/.test(MCP),
);

check(
  'claws_fleet handler present (v0.7.10 parallel via Promise.allSettled)',
  /if\s*\(\s*name\s*===\s*'claws_fleet'\s*\)/.test(MCP) &&
  /Promise\.allSettled\s*\(\s*fleetWorkers\.map/.test(MCP),
);
check(
  'claws_fleet zod schema present in gen-mcp-tools.mjs',
  /tool\(['"]claws_fleet['"]/.test(
    fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'codegen', 'gen-mcp-tools.mjs'), 'utf8'),
  ),
);
check(
  'markerScanFrom uses poll-for-settle (NOT a fixed 400ms sleep)',
  // W8k-1 refactor: settle logic moved into _sendAndSubmitMission.
  // Invariant: submission is verified by a deadline-based polling loop, not a
  // fixed sleep. We check: (a) helper exists, (b) it uses a deadline variable,
  // (c) it uses a verified flag instead of a blind wait.
  /_sendAndSubmitMission/.test(MCP) &&
  /_submitDeadline\s*=\s*Date\.now\(\)\s*\+\s*15000/.test(MCP) &&
  /_submitVerified/.test(MCP),
);

// claws_fleet must NOT pass undefined keys through to runBlockingWorker.
// The original implementation wrote `{ cwd: args.cwd, model: args.model, ... }`
// unconditionally; when the caller omitted a key, the spread propagated
// `undefined` and clobbered the runBlockingWorker DEFAULTS — the launch line
// became `claude --model undefined`, breaking the spawn and leaving the
// orchestrator blocked on a hung worker.
check(
  'claws_fleet sharedDefaults filters undefined keys (no --model undefined regression)',
  /const\s+sharedDefaults\s*=\s*\{\s*\}/.test(MCP) &&
  /if\s*\(\s*args\[k\]\s*!==\s*undefined\s*\)\s*sharedDefaults\[k\]\s*=\s*args\[k\]/.test(MCP),
);

check(
  'claws_fleet supports detach mode (additive — default behavior unchanged)',
  /const\s+detach\s*=\s*args\.detach\s*!==\s*false/.test(MCP) &&
  /detach\s*\?\s*\{\s*detach:\s*true\s*\}/.test(MCP),
);
check(
  'claws_workers_wait handler present (non-blocking companion to detach)',
  // Handler uses detectCompletion(scanText, detectOpt, ...) which wraps
  // findStandaloneMarker — higher-level abstraction added in v0.7.10+.
  /if\s*\(\s*name\s*===\s*'claws_workers_wait'\s*\)/.test(MCP) &&
  /detectCompletion\(scanText,\s*detect/.test(MCP),
);

// ─── Final report ────────────────────────────────────────────────────────────

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
console.log(`\nPASS: ${pass} worker-fixes-v079 checks`);
if (fail > 0) {
  console.log(`FAIL: ${fail} checks failed`);
  process.exit(1);
}
