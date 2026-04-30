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
  // The capture block must appear AFTER the `if (payload)` send block. We
  // match this structurally: there's a "send" call wrapped in `if (payload)`,
  // then a sleep, then `markerScanFrom = initSnap.bytes.length`.
  /if\s*\(\s*payload\s*\)[\s\S]*?cmd:\s*'send'[\s\S]*?await\s+sleep\s*\(\s*\d+\s*\)[\s\S]*?markerScanFrom\s*=\s*initSnap\.bytes\.length/.test(MCP),
);
check(
  'poll loop scans scanText slice for completion marker (NOT the full text)',
  /scanText\s*=\s*text\.length\s*>\s*markerScanFrom\s*\?\s*text\.slice\(markerScanFrom\)/.test(MCP) &&
  /scanText\.includes\(opt\.complete_marker\)/.test(MCP),
);

// Mission must be sent as a direct user prompt to Claude Code's input. No
// file abstractions. The payload assignment chain is plain: hasMission -> mission,
// hasCommand -> command. The single-line mission goes through `claws_send`
// which auto-wraps multi-line in bracketed paste; trailing CR is sent
// separately after a sleep so Claude Code v2.x's paste-detect window closes.
check(
  'mission is sent directly as user prompt (no file referrer)',
  /const\s+payload\s*=\s*hasMission\s*\?\s*args\.mission/.test(MCP),
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
  /-ef\s*"\$TARGET\/\.claude\/skills\/claws-prompt-templates"/.test(INSTALL_SH),
);

// Uncommitted-work guard before git reset --hard. install.sh Step 1 used to
// silently destroy local edits when INSTALL_DIR is a contributor's working
// repo. The guard refuses to reset on a dirty tree unless CLAWS_FORCE_RESET=1.
check(
  'install.sh has uncommitted-work guard before git reset --hard',
  /CLAWS_FORCE_RESET/.test(INSTALL_SH) &&
  /uncommitted changes — refusing to git reset/.test(INSTALL_SH),
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
