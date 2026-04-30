// v0.7.9 worker reliability fixes — regression suite.
//
// Static-analysis smoke tests over mcp_server.js to catch accidental reverts of
// the four worker fixes. A full behavioral integration test (booting a real
// claws server + simulating pty streams) is deferred to v0.7.10.

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

// Fix 4 — boot_marker default must be the Claude Code v2.x bypass-mode footer
// substring. The legacy 'Claude Code' (with space) never matched the
// ANSI-stripped "ClaudeCodev2.1.123" banner, so every spawn burned its full
// boot_wait_ms.
check(
  'boot_marker default is "bypass permissions" (Fix 4)',
  /boot_marker:\s*'bypass permissions'/.test(MCP),
);

// Fix 1 — marker scan offset. The poll loop must scan `scanText` (a slice of
// the pty buffer starting at markerScanFrom), NOT the full `text`. Otherwise
// the marker substring matches on the input echo of the mission and the
// worker false-completes within 1-2 polls.
check(
  'markerScanFrom variable declared (Fix 1)',
  /\bmarkerScanFrom\b/.test(MCP),
);
check(
  'poll loop uses scanText slice, not raw text, for completion marker (Fix 1)',
  /scanText\s*=\s*text\.length\s*>\s*markerScanFrom\s*\?\s*text\.slice\(markerScanFrom\)/.test(MCP) &&
  /scanText\.includes\(effectiveCompleteMarker\)/.test(MCP),
);
check(
  'effectiveCompleteMarker variable declared (Fix 1+2)',
  /\beffectiveCompleteMarker\b/.test(MCP),
);

// Fix 2 — file-referrer pattern for Claude Code missions. When launching
// Claude Code with the default marker, mission body is written to a tmp file
// with a per-spawn random run-token; worker sends a single-line referrer to
// avoid Claude Code v2.x's auto-paste-collapse and the marker-collision bug.
check(
  'run_token uses "CLAWS_DONE_" prefix for uniqueness (Fix 2)',
  /CLAWS_DONE_/.test(MCP) && /runToken/.test(MCP),
);
check(
  'mission file path uses os.tmpdir() for cross-platform safety (Fix 2)',
  /path\.join\(\s*os\.tmpdir\(\)/.test(MCP) && /claws-mission-/.test(MCP),
);
check(
  'useFileReferrer guard skips when user explicitly sets complete_marker (Fix 2 — backwards compat)',
  /useFileReferrer\s*=\s*launchClaude\s*&&\s*hasMission\s*&&\s*!userExplicitMarker/.test(MCP),
);
check(
  'mission file is cleaned up via fs.unlinkSync after worker close (Fix 2 — hygiene)',
  /if\s*\(\s*missionFile\s*\)\s*{\s*try\s*{\s*fs\.unlinkSync\(missionFile\)/.test(MCP),
);
check(
  'file-write failure falls back to direct send (Fix 2 — graceful degradation)',
  /falling back to direct send/.test(MCP),
);

// Fix 5 — boot retry. If the first boot attempt times out without seeing
// boot_marker, the worker re-sends the launch command up to boot_retries times.
check(
  'boot_retries default in DEFAULTS (Fix 5)',
  /boot_retries:\s*2/.test(MCP),
);
check(
  'boot loop iterates over maxAttempts with retry log (Fix 5)',
  /boot attempt \$\{attempt\}\/\$\{maxAttempts\} timed out/.test(MCP),
);

// Worker return value surfaces new fields for debugging.
check(
  'worker return value includes mission_file (v0.7.9 introspection)',
  /mission_file:\s*missionFile/.test(MCP),
);
check(
  'worker return value includes run_token (v0.7.9 introspection)',
  /run_token:\s*runToken/.test(MCP),
);

// Backwards-compat — userExplicitMarker is checked, not coerced.
check(
  'userExplicitMarker detected via args.complete_marker presence (backwards compat)',
  /userExplicitMarker\s*=\s*typeof\s+args\.complete_marker\s*===\s*'string'/.test(MCP),
);

// v0.7.9 follow-up Fix B — file-nonce / run-token decouple.
// The initial v0.7.9 fix embedded runToken in the mission file path → the path
// was in the input echo → marker false-matched on echo. New behavior keeps
// runToken only inside the file content; path uses an independent fileNonce.
check(
  'fileNonce variable declared, separate from runToken (v0.7.9 Fix B)',
  /\bfileNonce\b/.test(MCP) &&
  /const\s+fileNonce\s*=\s*Math\.random/.test(MCP),
);
check(
  'mission file path uses fileNonce (NOT runToken) so the run-token never appears in the input echo (v0.7.9 Fix B)',
  /claws-mission-\$\{termId\}-\$\{fileNonce\}\.md/.test(MCP) &&
  // sanity: ensure the OLD (buggy) pattern is gone
  !/claws-mission-\$\{termId\}-\$\{runToken\}\.md/.test(MCP),
);

// install.sh Fix A — skill-loop self-collision guard. When TARGET == INSTALL_DIR
// (e.g. ~/.claws-src symlinked to project root), the skill-copy loop's rm -rf
// would delete the source before cp could read it. The -ef test (same-inode)
// makes the loop skip the rm+cp pair when source and dest resolve to the same
// path.
const INSTALL_SH = fs.readFileSync(
  path.join(__dirname, '..', '..', 'scripts', 'install.sh'),
  'utf8',
);
check(
  'install.sh skill loop has -ef self-collision guard (v0.7.9 Fix A)',
  /if\s*\[\s*"\$_skill_src"\s*-ef\s*"\$TARGET\/\.claude\/skills\/\$_skill_name"\s*\];\s*then\s*continue;\s*fi/.test(INSTALL_SH),
);
check(
  'install.sh prompt-templates rename has -ef self-collision guard (v0.7.9 Fix A)',
  /-ef\s*"\$TARGET\/\.claude\/skills\/claws-prompt-templates"/.test(INSTALL_SH),
);

// install.sh Fix C — uncommitted-work guard before git reset --hard. install.sh
// Step 1 forces $INSTALL_DIR to origin/main, which silently destroys local edits
// when INSTALL_DIR is a contributor's working repo (via symlink). The guard
// detects dirty tree and refuses to reset unless CLAWS_FORCE_RESET=1.
check(
  'install.sh has uncommitted-work guard before git reset --hard (v0.7.9 Fix C)',
  /CLAWS_FORCE_RESET/.test(INSTALL_SH) &&
  /uncommitted changes — refusing to git reset/.test(INSTALL_SH),
);

// Final report
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
