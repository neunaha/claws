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
  // AE-7 update: deadline now uses SUBMIT_CEILING_MS constant (60s) instead of
  // hardcoded 15000 literal. Invariant: (a) helper exists, (b) uses a deadline
  // variable, (c) uses a verified flag.
  /_sendAndSubmitMission/.test(MCP) &&
  /_submitDeadline\s*=\s*Date\.now\(\)\s*\+\s*(?:15000|SUBMIT_CEILING_MS)/.test(MCP) &&
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

// ─── Wave I — top-level error guards + safeInvoke (v0.7.9 / W7-5) ───────────

check(
  'W7-5a unhandledRejection top-level handler exists',
  /process\.on\(['"]unhandledRejection['"]/.test(MCP),
);
check(
  'W7-5b uncaughtException top-level handler exists',
  /process\.on\(['"]uncaughtException['"]/.test(MCP),
);
check(
  'W7-5c safeInvoke helper defined',
  /(function|const)\s+safeInvoke\b/.test(MCP),
);

// ─── Wave J — Monitor timeout clamp + eventsLogPath win32 (W8j) ──────────────

check(
  'W8j-1 Monitor timeout clamped to 3600000 in spawn responses (at least 5)',
  (MCP.match(/timeout_ms=3600000/g) || []).length >= 5,
);
check(
  'W8j-2 _eventsLogPath helper exists and handles win32',
  /function\s+_eventsLogPath\s*\([^)]*\)\s*\{[\s\S]{0,500}win32/.test(MCP),
);

// ─── Wave K/L — _sendAndSubmitMission shared helper (W8k) ────────────────────

check(
  'W8k-1 _sendAndSubmitMission helper exists with bracketed paste + 300ms + explicit \\r',
  // text: '\r' may appear directly or via a _submitKey variable — either is correct.
  /async function _sendAndSubmitMission[\s\S]{0,2000}paste:\s*true[\s\S]{0,500}sleep\(300\)[\s\S]{0,500}['"]\\r['"]/.test(MCP),
);
check(
  'W8k-2 claws_dispatch_subworker uses shared _sendAndSubmitMission helper',
  /claws_dispatch_subworker[\s\S]{0,5000}_sendAndSubmitMission/.test(MCP),
);

// ─── Wave M — STREAM_EVENTS_JS_FOR_CMD constant (W8m) ────────────────────────

check(
  'W8m-1 STREAM_EVENTS_JS_FOR_CMD declared and used in spawn responses (1 decl + 4+ usages)',
  /const\s+STREAM_EVENTS_JS_FOR_CMD/.test(MCP) && (MCP.match(/STREAM_EVENTS_JS_FOR_CMD/g) || []).length >= 5,
);

// ─── Wave R — Windows sidecar eventsLog + fileExec + wrapShellCommand (W8Q3) ─

check(
  'W8Q3-1 _spawnAndVerifySidecar uses _eventsLogPath(socketPath) for events.log',
  /const eventsLogFilePath = _eventsLogPath\(socketPath\)/.test(MCP),
);
check(
  'W8Q3-2 fileExec branches to PowerShell wrapper on win32',
  /process\.platform === ['"]win32['"][\s\S]{0,200}\*>/.test(MCP) &&
  /Out-File -FilePath '\$\{donePath\}'/.test(MCP),
);
check(
  'W8Q3-4 wrapShellCommand branches to Write-Output on win32',
  /process\.platform === ['"]win32['"][\s\S]{0,200}Write-Output '\[CLAWS_PUB\]/.test(MCP),
);

// ─── Wave V — Windows sidecar pid-file dedup (W8Q3-3) ────────────────────────

check(
  'W8Q3-3 _spawnAndVerifySidecar has win32 pid-file dedup branch',
  /process\.platform === ['"]win32['"][\s\S]{0,400}sidecar\.pid/.test(MCP) &&
  /process\.kill\(existingPid, 0\)/.test(MCP),
);

// ─── Wave AC-1 — correlation_id event substrate (W8ac-1) ─────────────────────

(function () {
  const EXT_SRC = path.join(__dirname, '..', 'src');
  const clawsPtySrc   = fs.readFileSync(path.join(EXT_SRC, 'backends', 'vscode', 'claws-pty.ts'), 'utf8');
  const vscodeBkSrc   = fs.readFileSync(path.join(EXT_SRC, 'backends', 'vscode', 'vscode-backend.ts'), 'utf8');
  const serverSrc     = fs.readFileSync(path.join(EXT_SRC, 'server.ts'), 'utf8');
  const peerRegSrc    = fs.readFileSync(path.join(EXT_SRC, 'peer-registry.ts'), 'utf8');
  const protocolSrc   = fs.readFileSync(path.join(EXT_SRC, 'protocol.ts'), 'utf8');

  check(
    'W8ac-1 correlation_id substrate present in extension — protocol fields (CreateRequest + HelloRequest)',
    // CreateRequest must have the field
    /correlation_id\?:\s*string/.test(protocolSrc) &&
    // HelloRequest must also have the field (appears after the monitorCorrelationId block)
    (protocolSrc.match(/correlation_id\?:\s*string/g) || []).length >= 2,
  );
  check(
    'W8ac-1 correlation_id substrate present in extension — claws-pty.ts CLAWS_TERMINAL_CORR_ID injection',
    /CLAWS_TERMINAL_CORR_ID/.test(clawsPtySrc) &&
    /correlationId/.test(clawsPtySrc),
  );
  check(
    'W8ac-1 correlation_id substrate present in extension — vscode-backend.ts terminal:ready emission',
    /terminal:ready/.test(vscodeBkSrc) &&
    /onFirstOutput/.test(vscodeBkSrc),
  );
  check(
    'W8ac-1 correlation_id substrate present in extension — peer-registry.ts PeerConnection.correlationId field',
    /correlationId\?:\s*string/.test(peerRegSrc),
  );
  check(
    'W8ac-1 correlation_id substrate present in extension — server.ts system.peer.connected + system.terminal.ready emission',
    /system\.peer\.connected/.test(serverSrc) &&
    /system\.terminal\.ready/.test(serverSrc) &&
    /corrIdForHello/.test(serverSrc),
  );
})();

// ─── Wave AC-2 — event-driven boot via correlation_id (W8ac-2) ───────────────

check(
  'W8ac-2 _waitForWorkerReady helper exists with topic+timeoutMs',
  /async function _waitForWorkerReady[\s\S]{0,600}system\.peer\.connected/.test(MCP) &&
  /async function _waitForWorkerReady[\s\S]{0,600}system\.terminal\.ready/.test(MCP),
);

check(
  'W8ac-2 mcp_server.js self-hello includes correlation_id when env set',
  // Both hello sites must reference the env var
  (MCP.match(/process\.env\.CLAWS_TERMINAL_CORR_ID/g) || []).length >= 2,
);

check(
  'W8ac-2 slow-path boot uses _waitForWorkerReady (no _hasPrompt poll)',
  // Positive: _waitForWorkerReady or its AD-1 wrapper _gatePasteOnClaudeClaim is invoked inside runBlockingWorker
  (/async function runBlockingWorker[\s\S]{0,10000}_waitForWorkerReady/.test(MCP) ||
   /async function runBlockingWorker[\s\S]{0,10000}_gatePasteOnClaudeClaim/.test(MCP)) &&
  // Negative: the ❯+cost:$ polling gate is gone from the file entirely
  !/\bconst _hasPrompt\b/.test(MCP),
);

check(
  'W8ac-2 fast-path boot uses _waitForWorkerReady (no _hasPrompt poll)',
  // Positive: fast path (claws_worker handler) uses _waitForWorkerReady or its AD-1 wrapper _gatePasteOnClaudeClaim
  (/if \(name === 'claws_worker'\)[\s\S]{0,12000}_waitForWorkerReady/.test(MCP) ||
   /if \(name === 'claws_worker'\)[\s\S]{0,12000}_gatePasteOnClaudeClaim/.test(MCP)) &&
  // Negative: old polling variables are gone
  !/\b_fpBootDeadline\b/.test(MCP) &&
  !/\b_fpStable\b/.test(MCP),
);

check(
  'W8ac-2 5000ms post-boot settle removed in both paths',
  // All three boot-context sleep(5000) calls are gone
  (MCP.match(/await sleep\(5000\)/g) || []).length === 0,
);

check(
  'AE-6.b fast-path boot gate has no hardcoded sub-ceiling fallback (event-driven)',
  // After AE-6.b the fast path passes args.boot_wait_ms as-is; no platform branch or
  // hardcoded fallback — the 120s safety ceiling lives in _waitForWorkerReady.
  /timeoutMs:\s*args\.boot_wait_ms/.test(MCP) &&
  !/args\.boot_wait_ms\s*\|\|\s*(?:\d{1,4}|process\.platform)/.test(MCP),
);

// ─── Wave AC-1.1 — spawn-helper executable mode (W8ac-1.1) ───────────────────

(function () {
  const NATIVE_PREBUILDS = path.join(__dirname, '..', 'native', 'node-pty', 'prebuilds');
  const BUNDLE_NATIVE = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'bundle-native.mjs'), 'utf8');

  // Belt: verify bundle-native.mjs contains the chmod step so every future VSIX
  // build ships spawn-helper with the correct mode.
  check(
    'W8ac-1.1 bundle-native.mjs chmods spawn-helper to 0o755',
    /chmodSync/.test(BUNDLE_NATIVE) &&
    /spawn-helper/.test(BUNDLE_NATIVE) &&
    /0o755/.test(BUNDLE_NATIVE),
  );

  // Suspenders: verify the source-tree spawn-helper binaries are actually +x
  // so the next VSIX rebuild ships a correctly-moded file even if the chmod
  // step in bundle-native.mjs were ever bypassed.
  if (process.platform === 'win32') {
    check('W8ac-1.1 spawn-helper preserved as executable in source tree (skip on win32)', true);
  } else {
    const platDirs = fs.existsSync(NATIVE_PREBUILDS)
      ? fs.readdirSync(NATIVE_PREBUILDS).filter((d) => d.startsWith('darwin-') || d.startsWith('linux-'))
      : [];
    const nonExecFiles = platDirs
      .map((d) => path.join(NATIVE_PREBUILDS, d, 'spawn-helper'))
      .filter((p) => fs.existsSync(p) && (fs.statSync(p).mode & 0o111) === 0);
    check(
      'W8ac-1.1 spawn-helper preserved as executable in source tree',
      platDirs.length > 0 && nonExecFiles.length === 0,
      nonExecFiles.length ? `non-executable: ${nonExecFiles.join(', ')}` : '',
    );
  }
})();

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
