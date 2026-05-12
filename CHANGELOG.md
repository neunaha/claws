# Changelog

All notable changes to Claws will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.14] - 2026-05-12

### Changed
- **Bug 13 arm-race observability** — `stream-events.js --wait` now logs a stderr line when the `monitorCorrelationId` hello is dispatched (`hello sent | corrId=… | t=…`). Permanent observability trace; no logic change. Enables comparing arm-dispatch time against the L2 30s window during future arm-race investigations. Root cause documented in `.local/plans/v0714/investigations/bug13-arm-race.md`.

## [0.7.14] - 2026-05-11

### Changed
- **Layer 2 debug instrumentation** — `mcp_server.js` all 4 Layer 2 `setTimeout` callbacks now emit `L2-DEBUG:` lines at every decision branch (callback-entered, rpc-result, skip-publish, about-to-publish, pconn-registered, publish-succeeded/failed, outer-error). A new `_logL2File()` helper writes in parallel to `.claws/l2-debug.log` for file-based capture. Investigation-only; no logic changes. Covered sites: `runBlockingWorker`, `claws_create`, `claws_worker-fast-path`, `claws_dispatch_subworker`.

## [0.7.14] - 2026-05-08

### Fixed
- **Bug 1** — `install.sh` now sweeps stale `claws-*.md` / `claws.md` command files from `$TARGET/.claude/commands` before copying. Prior installs accumulated every renamed/deleted command (PEDI had 27; installer ships 8). User-added commands (no `claws-` prefix) are untouched.
- **Bug 2** — `install.sh` now sweeps stale `claws-*` skill directories from `$TARGET/.claude/skills` before copying. Retired skill `claws-orchestration-engine` (renamed to `claws-prompt-templates` in v0.7.13) no longer lingers after upgrade.
- **Rules idempotence** — `claws-default-behavior.md` is now removed before re-copy so a stale version can never survive an upgrade.

### Added
- **`extension/test/install-sweep.test.sh`** (8 checks) — verifies command sweep, skill sweep, user-content preservation, and source markers; registered in `npm test` chain.
- **Bug 3 — cold-start preamble in entry-point slash commands** — models deliberated over plan mode / TodoWrite / pre-verification on first `/claws-do` invocation, stalling or falling back to Bash. MANDATORY ordered preamble added to all entry-point commands (`claws.md`, `claws-do.md`, `claws-fix.md`, `claws-help.md`, `claws-status.md`): acknowledge → skip plan mode → skip TodoWrite → trust sidecar → classify → spawn immediately → arm Monitor verbatim from `monitor_arm_command` → wait. Also covers Bug 6 Layer 0: Monitor arming imperative explicitly says "MUST be the very next tool call after spawn."
- **Bug 8 — fast-path BUG-26 analog for shell workers** — `_dispatchTool` (claws_worker, detach=true) was running the 15s TUI-specific submit-verification loop for shell workers (`launch_claude=false`), causing `_fpMarkerScanFrom` to land past the already-printed `__CLAWS_DONE__` marker; detach watcher scanned an empty slice forever and auto-close never fired. Applied the BUG-26 guard (present in `runBlockingWorker` since LH-15) to the fast-path: verification loop and post-mission offset snapshot are now wrapped in `if (launchClaude)`; shell workers keep `_fpMarkerScanFrom=0` so the watcher scans the full log.
- **Bug 4 — worker binary alias UX** — two new MCP tools (`claws_set_bin`, `claws_get_bin`) surface the existing `.claws/claude-bin` / `CLAWS_CLAUDE_BIN` plumbing. New `/claws-bin` slash command (set/reset/get). Natural-language imperative added to `CLAUDE.global.md` so "use claude-neu for workers" resolves automatically. Schema regenerated (39 → 41 tools). `install.sh` post-install banner now lists the three override mechanisms.
- **Bug 5 — Monitor in-process rearm** — `stream-events.js --wait` now supports `--keep-alive-on <termId>`. When the inner timer fires, a 3-check decision runs: (1) `system.worker.completed` in events.log → exit 0; (2) `system.terminal.closed` / `system.worker.terminated` in events.log → exit 0; (3) `eventsSeen(termId, staleMs)` — terminal active on bus within threshold → rearm in place. Otherwise exit 2 (truly stuck). New flags: `--stale-threshold <ms>` (default 120 s) and `--rearm-cycle <ms>` (default = `--timeout-ms`). All 5 `monitor_arm_command` emission sites in `mcp_server.js` updated: `--keep-alive-on` appended, `timeout_ms` raised from 600 000 → 7 200 000 (2 h). `extension/test/monitor-rearm.test.js` (6 unit branches) registered in `npm test` chain.
- **Bug 7 — `system.worker.terminated` identity fix** — `server.ts` now attaches `correlation_id` (already in scope from the `system.terminal.closed` lookup) to the `system.worker.terminated` payload when lifecycle state has it. `terminal_id` is a session-local integer VS Code recycles on extension reload; `correlation_id` is a UUID globally unique across sessions. `stream-events.js` rearmDecisionLoop Check 2 simultaneously drops its `terminal_id` fallback (`system.worker.terminated` matched by `termId`) and replaces it with corrId-only matching for both `system.terminal.closed` and `system.worker.terminated`, eliminating false-positive Monitor exits caused by prior-session log entries with the same numeric terminal ID.
- **Bug 9 — `claws-wave-lead/SKILL.md` instruction quality** — step 0 ("Arm Monitor on .claws/events.log via Bash run_in_background") replaced with a note that the sidecar is already running. Explicit Monitor()-only prohibition added (no Bash backgrounding for event observation). Sub-worker dispatch section expanded with a worked `Monitor(command=r.monitor_arm_command)` example. Obsolete BUG-03 capabilities comment removed from step 1 (auto-granted since v0.7.13).
- **Bug 6 Layer 1 — per-worker Monitor pgrep watcher** — `lifecycle.monitors[]` is pre-populated by `mcp_server.js` atomically at spawn time, so the PostToolUse hook's `monitors.some()` check is vacuously satisfied even when no OS-level `stream-events.js` process is arming. New `scripts/monitor-arm-watch.js` sleeps `grace_ms` (10 s default), runs `pgrep -f 'stream-events.js.*--wait <corrId>'`, and publishes `system.monitor.unarmed` to the bus if no match. `post-tool-use-claws.js` wired with `extractWorkerEntries()` + `spawnWatchers()` — spawns one detached watcher per worker for every spawn-class tool call (`claws_worker` / `claws_fleet` / `claws_dispatch_subworker` / `claws_create`); hook stays under 100 ms. Unit tests in `extension/test/monitor-arm-watch.test.js` (2 branches). Layer 2 (`hello`-with-`monitorCorrelationId`) closes the loophole structurally.
- **Bug 6 Layer 2 — `hello`-with-`monitorCorrelationId`** — closes the structural loophole where `lifecycle.monitors[]` pre-population makes per-worker Monitor verification vacuously satisfied. `stream-events.js --wait <corrId>` now includes `monitorCorrelationId: corrId` in its `hello` frame. Server (`peer-registry.ts`: new `PeerRegistry` class with `armedCorrelations Map<corrId,peerId>`; `server.ts`: `hello` handler records the claim, `handleDisconnect` removes it on peer close) tracks which corrIds have an active Monitor process. New `monitors.is-corr-armed` RPC (`{ correlation_id }` → `{ ok, armed, peerId }`) exposes the state. Spawn handlers (`claws_worker`, `runBlockingWorker`/fleet, `claws_dispatch_subworker`, `claws_create`) each fire a parallel 30 s grace `setTimeout` calling `monitors.is-corr-armed`; if the corrId is not claimed, logs a Layer-2-specific warning and publishes `system.monitor.unarmed` (same topic as Layer 1; consumers dedupe on `corrId`). `extension/test/monitor-corr-arm.test.js` (9 checks) covers claim, no-claim, disconnect-cleanup, RPC before/after hello, and error case.

### Internal
- **Bug 6 forensic trace** — `post-tool-use-claws.js` now appends a one-line entry to `/tmp/claws-hook-trace.log` at the very top (before any logic) and dumps the raw PostToolUse stdin to `/tmp/claws-hook-stdin-<pid>.json` at the top of `run()`. Both writes are in try/catch and never throw. Added as permanent observability to detect future `tool_response` format regressions; see `.local/plans/v0714/investigations/bug6-hook-nested-context.md`.

### Fixed (runtime)
- **Bug 6 Layer 1 — watcher subprocess publish reliability** — sim pass 3 (`.local/audits/v0714-validation-report-pass3-recovered.md`, Sim 4) found 0 `system.monitor.unarmed` events for real workers. Root cause: `.claude/settings.json` has a `hooks.PostToolUse` array (Bash dev-hooks), and Claude Code treats project settings as authoritative for hook types present there, overriding the global `~/.claude/settings.json` PostToolUse entries entirely. The `mcp__claws__claws_worker` (and sibling) matchers existed only in the global settings, so the PostToolUse hook process was never spawned and `monitor-arm-watch.js` was never launched. Fix: mirror the four claws MCP PostToolUse entries from global settings into `.claude/settings.json`. Also hardened `monitor-arm-watch.js` (absolute `/usr/bin/pgrep` path; startup + per-exit stderr lines with corrId/socket/cwd/reason — never exits silently) and `post-tool-use-claws.js` (watcher stdio redirected from `'ignore'` to per-corrId `/tmp/claws-monitor-arm-watch-<corrId>.log`; explicit `cwd=project-root` on spawn). Validated via manual E2E trigger: watcher log shows `exit 1 | reason=unarmed-published`; `system.monitor.unarmed` event appears in `events.log` for the real worker corrId.
- **Bug 6 Layer 1 — missing `.claws-bin/monitor-arm-watch.js` deploy** — `scripts/monitor-arm-watch.js` (added in commit 1849ee9) was never deployed to `.claws-bin/`. The `post-tool-use-claws.js` hook resolves the watcher path as `path.join(__dirname, '..', 'monitor-arm-watch.js')` → `.claws-bin/monitor-arm-watch.js`; the file did not exist → spawn silently failed → 0 Layer 1 events fired at runtime. Fix: created `.claws-bin/monitor-arm-watch.js` as a symlink to `../scripts/monitor-arm-watch.js`, mirroring the existing `mcp_server.js` / `stream-events.js` pattern. `install.sh` updated to create the same symlink (and `cp` equivalent for non-dev installs) on every fresh install.
- **Bug 6 enforcement runtime — Layer 1 + Layer 2 publish reliability** — sim pass 2 (`.local/audits/v0714-validation-report-pass2.md`) found both enforcement layers silently failing in live MCP fast-path context. Layer 1 (`post-tool-use-claws.js`): Claude Code passes MCP tool responses as `{ content: [{ type: 'text', text: '<JSON>' }] }`; the hook checked `resp.ok` directly on the wrapper (undefined), short-circuiting before spawning `monitor-arm-watch.js`. Fixed with `unwrapMcpResponse()` helper that parses the text content first. Layer 2 (`mcp_server.js`): the 30 s `setTimeout` callbacks called `_pconnWrite()` without `_pconnEnsureRegistered()` — if `_pconn` was not registered at fire time (e.g., after a 25 s Claude boot), the write threw and was silently swallowed. Fixed by adding `_pconnEnsureRegistered(sock)` before every Layer 2 `_pconnWrite` at all four sites (`claws_worker` fast-path, `runBlockingWorker`, `claws_create`, `claws_dispatch_subworker`). Silent `catch` replaced with logged `catch` at all sites. Smoke test: `extension/test/bug6-enforcement-runtime.test.js` (4 checks).

### Tests
- **Stale assertion alignment** — three pre-existing test assertions encoding old pre-v0.7.14 behavior updated: `monitor-rearm.test.js` (c) now injects `correlation_id` in the synthetic `system.worker.terminated` event (matching Bug 7 corrId-only Check 2 path); `lh-stack-regression.test.js` D8 updated from `timeout_ms=600000` → `7200000` with `--keep-alive-on` presence check (Bug 5 cascade); E4 rewritten to verify Option A (stream-events.js references `system.worker.terminated` and `system.terminal.closed`, both matched by corrId) instead of the rejected Option B. lh-stack: 51/51 PASS.

## [0.7.13] - 2026-05-05

### Added
- **`claws_done()`** (LH-18) — zero-arg MCP tool, primary worker-completion primitive. Reads `CLAWS_TERMINAL_ID` from worker env, publishes `system.worker.completed`, closes terminal. Mission preambles trimmed to single line.
- **LH-stack regression suite** (`lh-stack-regression.test.js`, 51 checks across 7 sections) — locks LH-9/10/11/12 + LH-18/18.1 invariants. No overlap with existing lifecycle-store (58), lh9-state-bulletproof (40), or stream-events-wait (8) suites.
- **LH-12 `--wait` mode** in `scripts/stream-events.js` — native `--wait <uuid>` replaces 5-layer awk/grep Monitor pipeline; direct `correlation_id` equality match, no regex, no shell quoting. Exit codes: 0 match, 1 connect failure, 2 socket close, 3 timeout.
- **LH-10 `correlation_id`** on `system.terminal.closed` + `monitors[]` reconcile-on-boot in lifecycle-store.
- **LH-9 bulletproof state management** — single-writer TTL watchdog (10 min idle / 4 h max), reconcile-on-boot, Stop-hook defang; `markActivity` + `findExpiredWorkers` + slot reuse for stale CLOSED entries.
- **LH-1 wave violation auto-close** — silent sub-workers auto-closed at 25s threshold via `wave_violation` close origin.
- **Phase 4a bus-based completion** — workers publish `worker.<id>.complete`; orchestrator subscribes via `_pconn` wildcard; pty marker remains fallback.
- **`claws_marketing/`** workshop folder + 6 AI-generated README images (fal.ai Nano Banana Pro, 2K 16:9): social-preview, before-after, install-flow, architecture, wrapped-terminal, claws-done-completion.
- **`scripts/test-template-enforcement.sh`** — 10-assertion CI test for CLAUDE.md injection chain (tool list, phases, idempotence, sentinel migration).
- **`scripts/dev-vsix-install.sh`** + `npm run install:vsix` — full VSIX reinstall for VS Code extension refresh (~25s); complements fast `deploy:dev` path.

### Changed
- **LH-13 consolidation** — 27→8 commands, 6→3 skills; `claws_worker`/`claws_fleet`/`claws_dispatch_subworker` replace manual 7-step boot; 5 daily + 3 system command mental model.
- **LH-14 completion convention** — `__CLAWS_DONE__` canonical marker replaces per-worker variants; 5-layer F1–F5 convention; `claws_publish` elevated to PRIMARY in mission preambles.
- **LH-14.1 mode-aware `detach`** — mission-mode `claws_worker(mission=...)` → `detach:true`; command-mode `claws_worker(command=...)` → `detach:false`.
- **LH-11 silent Monitor template** — awk filter flipped to silent-until-pattern; one notification per worker at terminal state; `system.worker.terminated` added to alternation.
- **Worker boot detection** — `❯` + `cost:$` stable for 3 polls replaces legacy `bypass permissions` string match (v0.7.9).
- **CLAUDE.md injection** now parametric: tool list from `mcp_server.js` dispatch handlers, phases from `lifecycle-store.ts`, version from `package.json`; versioned sentinels for clean cross-version upgrades.
- **Templates** (`CLAUDE.global.md`, `CLAUDE.project.md`) rewritten new-user-first with `claws_done()` primary, per-worker Monitor pattern, full 11-phase lifecycle.
- **Extension README** rewritten marketplace-focused (137 lines from 295); **Root README** refreshed with 39-tool grouped table, Wave Army section, behavioral injection enforcement section.
- **Extension `package.json`** v0.7.13, categories `[Other,AI,Machine Learning]`, +keywords `mcp`/`wave-army`/`workers`, galleryBanner `#111318`, `screenshots[]` added.
- **Skill rename** `claws-orchestration-engine` → `claws-prompt-templates` in cli.js + 4 doc files; F3 updated from `claws_publish(...)` to `claws_done()` across all mission templates.

### Fixed
- **LH-18.1** — `claws_done()` publish path: replaced broken `clawsRpcStateful` with `_pconnEnsureRegistered` + `_pconnWrite` (`protocol: claws/2`); `system.worker.completed` now lands on bus with `completion_signal:'claws_done'`.
- **LH-15** — shell-worker marker: regex tolerates zsh `\` line-wrap artifact; server-side auto-wrap adds `[CLAWS_PUB]` bus event + `__CLAWS_DONE__` marker after every `claws_worker(command=...)`.
- **LH-11.1** — awk `\\.` → `[.]` fix; LH-11 silent Monitors were matching nothing due to regex literal misparse across all 5 spawn sites.
- **LH-3** — `claws_dispatch_subworker` paste-collapse submit parity with `runBlockingWorker` (signal-based predicates, 15s deadline, 5-nudge retry).
- **Worker boot paste-collapse** (latent v0.7.11 bug, 9fd97ac) — submit verification polls buffer growth or placeholder removal rather than byte-count comparison.
- **T9** — FAILED lifecycle phase now recoverable: `plan()` from FAILED resets arrays, increments `mission_n`, preserves `failure_cause`.
- **T8** — `claws_workers_wait` checks all 4 completion signals (marker, error_marker, pub_complete, terminated); adds `min_complete` parameter and per-worker `signal` field.
- **`uninstall-cleanup.ts`** skill array expanded: `claws-wave-lead` + `claws-wave-subworker` added; `claws-orchestration-engine` retained for backward-compat cleanup.
- **install.sh** `EXPECTED_MIN_VERSION` + **fix.sh** `EXT_VERSION` fallbacks bumped to 0.7.13.

## [0.7.12] - 2026-05-03 — Install UX hardening + heartbeat parser foundation

### In Progress (heartbeat v0.7.12)

- HB-L1 (in progress for v0.7.12): heartbeat parser primitives added — pure functions in mcp_server.js for TUI state detection. No runtime change yet; foundation for state machine in HB-L3+. Functions: parseToolIndicators, parseCostFooter, parseSpinnerActivity, parsePromptIdle, parseTodoWrite, parseErrorIndicators. Anchor: docs/heartbeat-architecture.md §V.E.
- HB-L2 (in progress for v0.7.12): WorkerHeartbeatV1 extended with optional kind/summary/cost/etc fields. Backward-compat additive. No runtime change yet.
- HB-L3 (in progress for v0.7.12): WorkerHeartbeatStateMachine class added to mcp_server.js. Tracks BOOTING/READY/WORKING/POST_WORK/COMPLETE transitions from pty observation. Not yet wired (L4 next).
- HB-L4 fix: heartbeat wiring moved from runBlockingWorker → fast-path watcher (the default for claws_worker). L4 verification now works. Reload VS Code + /mcp + spawn a claws_worker to see kind=heartbeat events every 30s.
- HB-L4 polish: dropped cost_usd from heartbeat (was bogus — showed orchestrator's overall session cost ~$2376, not per-worker cost). Tokens (in/out) remain. Fixed BOOTING→READY transition to fire on bypass-permissions detection alone (was waiting for prompt-idle which never happens during active work).
- HB-L4 cascade fix: READY→WORKING now uses cumulative toolCount (idempotent across ticks), no longer stuck at READY when boot+tool land in the same observe() tick.
- FIX-MON: canonical monitor pattern streams heartbeats + auto-exits on completion — orchestrator's `monitor_arm_command` now subscribes to `worker.<termId>.heartbeat,system.worker.*` and uses `awk '{print; fflush()} /system\.worker\.completed/{exit}'` instead of a completion-only `grep -m1`. Eliminates the blind window between spawn and completion; single awk wrapper emits each heartbeat line immediately AND exits cleanly on completion via SIGPIPE cascade. Five sites updated; new test: `extension/test/monitor-pattern.test.js`.
- FIX-MON-V2: monitor pattern v2 — switched CLAWS_TOPIC from comma-separated `worker.<id>.heartbeat,system.worker.*` to `'**'` wildcard. `scripts/stream-events.js:43` reads CLAWS_TOPIC as one literal string and passes it directly to the server's subscribe call; the comma-separated form was treated as a single invalid topic name, silently dropping all heartbeat notifications. Fix: subscribe to `'**'` (everything) and let the existing `grep --line-buffered correlation_id` filter narrow to the target worker. Verified live. Test: `extension/test/monitor-pattern.test.js` updated to 4/4 assertions.
- FIX-CLOSE-CALLBACK: `TerminalManager.close()` now invokes the close callback synchronously before deleting from the `byTerminal` map. Root cause of the lifecycle silent-mutation bug (audit 6e68a76): `close()` called `terminal.dispose()` then immediately deleted the `byTerminal` entry; VS Code's async `onDidCloseTerminal` fired after the entry was gone, so `onTerminalClosed()` bailed at its early-return guard and `system.worker.terminated` was never emitted. Every programmatic close (claws_close, fast-path watcher) was silently skipping the bus event. Monitors waiting on `system.worker.completed/terminated` hung indefinitely. Fix: call `this.onTerminalClose?.(key, rec.wrapped)` BEFORE `dispose()` and `byTerminal.delete()`. The existing `if (!id) return` guard in `onTerminalClosed()` is now idempotent — it means "already cleaned up". Test: `extension/test/terminal-manager.test.js` (4 checks).
- FIX-PARSER: `parseToolIndicators` regex `\s+` → `\s*` — Claude TUI renders `⏺Bash(args)` with zero whitespace between `⏺` and the tool name (hex: `e2 8f ba 42 61 73 68`). The `\s+` requirement caused 0/124 ticker matches in real pty samples; `this.toolCount` stayed at 0 forever; state machine never transitioned READY→WORKING. Fix is backward-compatible: `\s*` still accepts the documented `⏺ Bash(args)` form. Verified against 62KB captured pty fixture. Test: `extension/test/parse-tool-indicators.test.js` (5 checks, audit 6c1bd43).
- HB-L7: POST_WORK detection now publishes `kind=mission_complete` heartbeats. When the state machine fires POST_WORK→COMPLETE (spinner gone + prompt idle + bytes idle ≥20s), the fast-path watcher emits a one-shot heartbeat with `kind=mission_complete`, rich summary (`Xm Ys · N tool calls`), duration_ms, total_tool_calls, and tokens. Guard `_fpMissionCompletePublished` prevents double-fire. Test: `extension/test/mission-complete-heartbeat.test.js` (9 checks).
- HB-L8 (BIG FIX): when state machine detects sustained TUI idle (POST_WORK→COMPLETE), watcher now publishes `system.worker.completed` with `completion_signal:"tui_idle"`, clears interval, marks lifecycle completed, and auto-closes the terminal (per `close_on_complete: true`, default). Solves M15 marker-skip pattern: Claude finishes work + reaches `❯` prompt without running F3 printf → previously hung until 180s timeout, now completes in ~25-30s. Guard `_fpTuiIdleCompleted` gates `detectCompletion` path to prevent double-publish. Existing completion paths (marker, error_marker, pub_complete, Wave D terminated) remain primary. Test: `extension/test/tui-idle-completion.test.js` (8 checks).
- v0.7.12 prompt-idle fix: `parsePromptIdle` now scans the last 10 lines for the `❯` prompt instead of just the last non-empty line. Required for L7/L8 to actually fire — Claude TUI renders the prompt above the bypass-permissions footer, not as the last line. Test: `extension/test/parse-prompt-idle.test.js` (4 checks).
- v0.7.12 prompt-idle v2: `parsePromptIdle` now detects the `"⏵⏵ bypass permissions on"` footer instead of the `❯` char. ANSI strip collapses the `❯` prompt onto a multi-component single line (box-drawing border + ❯ + border), defeating the previous regex even with 10-line scan. Scans last 30 lines for the bypass-permissions substring — plain text that survives strip cleanly. Test: `parse-prompt-idle.test.js` rewritten with 4 cases (real TUI layout, working state, empty, stale-history).
- v0.7.12 post-work gate fix: dropped `bytesIdle` requirement from WORKING→POST_WORK transition. Claude Code's prompt suggestion feature emits pty bytes when idle, blocking the previous `bytesIdle` gate. Now: spinner-stopped + prompt-visible is sufficient. Test: new `WORKING→POST_WORK fires even with recent pty bytes` check in `heartbeat-state-machine.test.js`.
- HB-L5: kind=progress heartbeats with 5s burst aggregation. Fast-path watcher publishes activity bursts in real-time, collapsed to one summary per window. Richer orchestrator visibility between 30s backstop ticks.
- HB-L6: kind=approach + kind=error heartbeats. Fast-path watcher publishes TodoWrite plans (deduped by JSON.stringify compare) and Bash errors (deduped by errorsCount). Richer orchestrator observability.
- v0.7.12 hotfix: DISARMED L8 tui_idle auto-close. Destructive false-positives killed long-thinking workers (audit, deep edits). L7 mission_complete heartbeat publish stays for observability. Marker/error_marker/timeout/Wave-D paths unchanged.

---

### Fixed

#### Fix #1 (P0): ESM project crash — `mcp_server.js` fails to start in projects with `"type":"module"`
- **Impact**: ~50% of modern Node projects (Next.js, Vite, ESM-default tooling) hit `ReferenceError: require is not defined in ES module scope` on MCP server startup. Install appeared to succeed but Claws never functioned.
- **Root cause**: Node inherits `"type":"module"` from the nearest parent `package.json`. `.claws-bin/` had no own `package.json`, so `mcp_server.js` (CommonJS) was loaded as ESM.
- **Fix**: `scripts/install.sh` now writes `<project>/.claws-bin/package.json` with `{"type":"commonjs"}` to scope the override to `.claws-bin/` only. User's project files are unaffected. `update.sh` and `fix.sh` auto-restore the file so existing installs without it get fixed automatically.

#### Fix #2 (P1): dev-hooks leak into every user project — SessionStart hook spam
- **Impact**: every Claude Code session in a user project fired `SessionStart:startup hook error` for contributor diagnostic scripts (`check-stale-main.js`, `check-tag-pushed.js`, etc.) that have no relevance outside a Claws contributor environment.
- **Root cause**: `scripts/install.sh` unconditionally copied `scripts/dev-hooks/*.js` and registered them in `<project>/.claude/settings.json` for every install.
- **Fix**: dev-hooks install is now gated behind `CLAWS_INSTALL_DEV_HOOKS=1` env var. Default install path skips them entirely. Contributors installing into the Claws source tree (`scripts/install.sh` + `extension/src/` detected) get dev-hooks automatically without the flag.

#### Fix #3 (P1): `monitor_arm_command` pointed at wrong `stream-events.js` path in user installs
- **Impact**: orchestrators received a `monitor_arm_command` referencing `<project>/scripts/stream-events.js`, which doesn't exist in user installs (the file is at `<project>/.claws-bin/stream-events.js`). Per-worker Monitor commands failed immediately, forcing fallback to deprecated `tail -F events.log` (anti-pattern A1).
- **Root cause**: 5 occurrences in `mcp_server.js` computed the path from the socket location (`path.dirname(path.resolve(sock))`) instead of from `__dirname`, producing the wrong result outside the dev source tree.
- **Fix**: extracted a `STREAM_EVENTS_JS` constant at module load time using a multi-candidate resolver anchored to `__dirname` (same logic as the existing `_ensureSidecarOrThrow` resolver). All 5 `monitor_arm_command` generators now use it.

#### Fix #5 (P2): `uninstall.sh` — clarify that `code --uninstall-extension` is machine-wide
- **Impact**: users running `uninstall.sh` from one project folder followed the printed `code --uninstall-extension neunaha.claws` instruction, not realising it removes Claws from their editor globally — breaking Claws in any other project they had it installed in.
- **Fix**: added two-line warning above the printed command explaining the machine-wide scope and advising against running it if Claws is active in other projects.

### Deferred
- **Bug #4** (shell-mode `claws_worker` command-path pipe-mode anomaly) deferred to v0.7.13 — fix scope unknown, needs investigation.

## [0.7.11] - 2026-05-03 — Install Just Works™ (UX-first install)

### Changed
- **`scripts/install.sh`: removed the v0.7.9 dirty-tree guard from default install path.** `~/.claws-src` is install.sh's working directory — not a user dev clone — and treating it as protected was wrong UX. The script now hard-resets `~/.claws-src` to `origin/main` on every run, so install.sh just works in any folder for any user (new install or upgrading from v0.7.9/v0.7.10) with no manual stash/force-reset/CLAWS_FORCE_RESET dance.
- **Contributor escape hatch unchanged**: contributors who want a protected dev clone use `CLAWS_DIR=/path/to/dev/claws bash <(curl ...)` to point install at a different working dir. The default `~/.claws-src` is now treated as throwaway by design.
- **Opt-in protection**: `CLAWS_DEV_PROTECT=1 bash <(curl ...)` re-enables the old v0.7.9 dirty-tree guard for the rare case someone wants safety on the default `~/.claws-src` path. Most users should use `CLAWS_DIR=` instead.
- **Net effect for users**: zero friction. Run `bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)` in any folder, get Claws.

### Why this changed
v0.7.9 added a guard meant to protect contributors from accidentally losing in-flight work via `git reset --hard`. But the guard fired on auto-generated tracked files (e.g., `extension/native/.metadata.json` bundledAt timestamp), blocking every user's second install. v0.7.10's hotfix gitignored the metadata file, but existing v0.7.9 users still hit the guard during upgrade because their old `~/.claws-src` was at v0.7.9 commit (pre-gitignore). v0.7.11 removes the guard entirely — the architectural insight is that install.sh OWNS its working directory and should hard-reset freely.

## [0.7.10] - 2026-05-03 — 10-phase lifecycle (Wave A+B+C+D) + auto-advance engine + event-driven completion

### Fixed (post-release hotfix, force-tagged)
- **Install blocker**: `extension/native/.metadata.json` was tracked in git but rewritten with a fresh `bundledAt` timestamp on every native rebuild. Every user's second install hit the P3 hygiene guard ("uncommitted changes — refusing to git reset --hard"). Now gitignored and untracked. `git rm --cached` removes it from the index; existing installs that pull this fix will silently drop the tracked copy. Per ARCHITECTURE.md P4 (build artifacts shouldn't be tracked).

### Added
- **`docs/ARCHITECTURE.md`** (NEW): comprehensive canonical architecture anchor — 10 principles, system map (extension ↔ MCP server ↔ lifecycle engine), anti-patterns catalog (A1–A5), known-gaps roadmap §IX. Commit d831820. All architectural changes must pass §X anchoring protocol before landing.
- **Wave C closure — PostToolUse hook fail-closes spawn → monitor race** (`scripts/hooks/post-tool-use-claws.js`, NEW): after every spawn-class MCP tool call returns, waits up to ~5 s for `lifecycle.monitors[terminal_id]` to be registered. If missing, publishes `wave.violation` event (kind=monitor-missing) and auto-closes the orphaned terminal with a stderr warning. `inject-settings-hooks.js` registers four explicit PostToolUse matchers (claws_create/worker/fleet/dispatch_subworker), tagged `_source:'claws'`, dual-form canonical+fallback. Closes the spawn → monitor race window flagged in ARCHITECTURE.md §VI. New `extension/test/post-tool-use-monitor-gate.test.js` (15 checks): no-socket bail, non-spawn-class no-op, no-terminal-id no-op, monitor registered → pass, monitor missing → violate+close, 5 s self-kill.
- **Task #58 — multi-signal completion detection in detach watchers.** Adds three backup signals beyond the printf marker: explicit `[CLAWS_PUB] topic=worker.<id>.complete` line, idle-timeout (no pty activity for `idle_timeout_ms` after `min_runtime_ms` warm-up), and existing error-marker remains. ANY signal fires → publish system.worker.completed → auto-close → mark-worker-status('closed') → engine cascade. Payload now includes `completion_signal`. Defaults: idle_timeout_ms=30000, min_runtime_ms=30000.
- **Wave D — LifecycleEngine** (`extension/src/lifecycle-engine.ts`, NEW): in-process auto-advance state machine. Wired into the three lifecycle mutation handlers (`register-spawn`, `register-monitor`, `mark-worker-status`). On each worker state change, calls `nextAutoPhase()` from `lifecycle-rules.ts`; if a transition is recommended and passes `canTransition` + gate checks, calls `store.setPhase(next)` and emits `lifecycle.phase-changed` on the bus. Cascades safely (safety loop of 10) for multi-step transitions (DEPLOY→OBSERVE→HARVEST in a single call). Eliminates orchestrator camping in SPAWN — phases self-progress as work happens.
- **Lifecycle schema v3** (`extension/src/lifecycle-store.ts`): SESSION-BOOT through SESSION-END phases (10), `worker_mode` (single|fleet|army), `expected_workers`, `spawned_workers` map, `monitors` map, `registerSpawn`/`registerMonitor`/`markWorkerStatus` methods.
- **`extension/src/lifecycle-rules.ts`** (NEW): pure validators for transitions, gates, auto-advance decisions.
- **New lifecycle commands**: `lifecycle.register-spawn`, `lifecycle.register-monitor`, `lifecycle.mark-worker-status`.
- **D+F integration (Wave A — all spawn-class tools)**: `claws_create`, `claws_worker` fast-path, `runBlockingWorker` (+ `claws_fleet` which routes through it), and `claws_dispatch_subworker` all generate `correlation_id` + atomically call `lifecycle.register-spawn` + `lifecycle.register-monitor`. All detach watchers include `correlation_id` in `system.worker.spawned` / `system.worker.completed` event payloads and call `lifecycle.mark-worker-status` on every terminal transition (completed / failed / timeout). `lifecycle.spawned_workers` + `lifecycle.monitors` maps now populate for every worker regardless of which spawn-class tool was used.
- feat(v0.7.10) — Wave D part 1: extension now publishes `system.worker.terminated` on `onDidCloseTerminal` for any Claws-tracked wrapped terminal. `TerminalManager.setTerminalCloseCallback` wired from `ClawsServer` constructor; fires only for `wrapped=true` terminals. New test `test:ondidclose-publish` (8 checks) verifies publish + payload + unwrapped suppression. Per ARCHITECTURE.md P1 + Wave D roadmap. Adds `'terminated'` to `WorkerStatus` type + `TERMINAL_WORKER_STATUSES` set.
- feat(v0.7.10) — Wave D part 2: detach watchers in `mcp_server.js` recognize `system.worker.terminated` as 4th completion signal (alongside marker/error/pub_complete). `detectCompletion` extended with `terminatedSet` param; `_pconn` subscribes to `system.worker.terminated` on first registration; `_workerTerminatedSet` updated on every push frame. When worker's terminal closes, watcher fires `system.worker.completed` with `completion_signal:'terminated'` without waiting for marker. Closes the M15 marker-skip gap (`.local/audits/m15-marker-skip-gap.md`). `multisignal-completion.test.js` extended with 3 `terminated` cases. Also fixes pre-existing bug: detach-watcher `detectCompletion` callsite was passing `_msState` object as `termId` arg, breaking `pub_complete` signal in that path; corrected to `String(termId)`.
- docs(v0.7.10) — `templates/CLAUDE.global.md`: codified F1/F2/F3 numbered-final-actions worker convention (per `.local/audits/m15-marker-skip-gap.md`). Reduces marker-skip rate by framing final Bash calls as a numbered checklist with rationale.
- scripts(v0.7.10) — `scripts/install.sh`: dev-mode symlinks, `scripts/uninstall.sh` (NEW), Linux ABI support for bundled node-pty, install backup pruning (keeps last 3 only).
- 60 unit tests covering lifecycle-store + lifecycle-rules.

### Changed
- **Wave B — bus-stream Monitor primitive in all spawn-class tool responses**: `monitor_arm_command` strings returned by `claws_create`, `claws_worker`, `runBlockingWorker`/`claws_fleet`, and `claws_dispatch_subworker` now use the canonical `Monitor + stream-events.js` pattern (CLAUDE.md principle #5). Subscribes directly to the pub/sub bus, filters by `correlation_id`, exits on first `system.worker.completed` event (`grep -m1`). Sub-100ms latency, immune to SIGURG idle-kill, appears as 'monitor' in the Claude Code task panel. The old `Bash(until grep -qE…events.log)` passive polling pattern is fully removed.
- **Wave C enforcement** (`pre-tool-use-claws.js`, `session-start-claws.js`): SessionStart now auto-spawns the `stream-events.js` sidecar on boot; PreToolUse Monitor arm gate hard-blocks spawn-class tools until a Monitor is armed; both hooks recognize the canonical bus-stream sidecar pattern and no longer demand the deprecated `tail -F` satisfier.
- templates (`templates/CLAUDE.project.md`, `templates/CLAUDE.global.md`): updated Monitor arm command, peerId heartbeat interval, and sidecar boot instructions to match canonical Wave B/C pattern.
- `.claude/commands/` + `.claude/skills/`: all 24 slash commands and orchestration-engine skill aligned with non-blocking defaults and canonical `monitor_arm_command` shape.
- `claws_lifecycle_plan` now requires `worker_mode` + `expected_workers` args (declares mission shape upfront).

### Fixed
- **CRITICAL: claws_worker fast-path boot detection.** The default `detach:true` code path had only `sleep(400)` before sending mission paste — too short for Claude TUI to boot. Multi-line missions landed in shell prompt before Claude was ready, sat in input box without ever submitting. Now polls for `❯` + `cost:$` stable for 3 polls, then waits 5000ms post-readiness settle. Mirrors `runBlockingWorker` pattern. Verified end-to-end with real Claude worker test.
- fix(v0.7.10) — Wave C SIGURG resolution (Task #63): `pre-tool-use-claws.js` now accepts the canonical `stream-events.js` sidecar (auto-spawned by SessionStart) as a valid Monitor satisfier. Eliminates the recurring "Hook satisfier failed exit 144" task notifications. Old `tail -F` check kept as deprecated fallback for one release. Per ARCHITECTURE.md P9 + anti-pattern A1. New regression test: `test:pre-tool-use-sidecar-recognized` (7 assertions).
- **BUG-A** — `nextAutoPhase` had cases for SPAWN, DEPLOY, OBSERVE, CLEANUP but missing HARVEST. Engine cascaded 4 transitions then stopped. Now adds HARVEST→CLEANUP transition (gated by `canCleanup`), enabling 5-transition auto-cascade through the mission cycle.
- **BUG-B** — Detach watchers in `mcp_server.js` (4 callsites: runBlockingWorker, blocking-worker happy-path, fast-path watcher, dispatch_subworker) auto-closed terminals on marker match but never notified the lifecycle store of closure. `workers[].closed` stayed false, blocking `canReflect` gate forever. Fix: after successful close, call `lifecycle.mark-worker-status` with `status='closed'` so the lifecycle store flips the flag. Now CLEANUP→REFLECT can auto-advance once all spawns are closed.
- **M20 install.sh calibration** — step 8 verification now checks PostToolUse spawn-class hooks in addition to PreToolUse, so a partial Wave C install is surfaced at install time instead of silently running without the monitor race-close gate.
- **M20 update.sh calibration** — post-update health check extended with PostToolUse spawn-class hook presence check; warns with auto-fix command if Wave C entries are absent.
- **M20 fix.sh calibration** — check 8b detects and auto-repairs missing PostToolUse entries (pre-Wave C installs); check 9 hook probe now covers `post-tool-use-claws.js` alongside session-start/pre-tool-use/stop.

## [0.7.10-pre] - 2026-05-01 — Direct-prompt missions (revert v0.7.9 file-referrer + boot retry)

v0.7.10 deletes the two new abstractions v0.7.9 introduced (file-referrer mission delivery and boot retry) and returns to the v0.7.4 contract: **the mission text becomes Claude Code's input as if a human typed it.** No /tmp file. No "Read /tmp/.../mission.md and follow it precisely." prompt. The v0.7.9 marker false-match is still fixed, but via a much simpler mechanism: capture the pty scan offset *after* the payload + echo settle, so the user's mission text never re-matches the completion marker.

### Fixed — claws_fleet sharedDefaults undefined-key bug

The first claws_fleet implementation wrote `sharedDefaults = { cwd: args.cwd, model: args.model, ... }` unconditionally — when the caller omitted any of those keys, the spread `{ ...sharedDefaults, ...w }` propagated `undefined` values into `runBlockingWorker`. Inside, `{ ...DEFAULTS, ...args }` let the undefined clobber the model default, producing a launch line of `claude --dangerously-skip-permissions --model undefined` that broke the spawn and left workers hanging at `pid=-1`. Fix: build `sharedDefaults` by INCLUDING ONLY keys the caller actually set. Same defensive filter for per-worker overrides via `wClean`. Regression test added.

### Removed (rolled back from v0.7.9)

- **File-referrer pattern.** No mission file in `/tmp`. No `runToken`. No `fileNonce`. No `mission_file` / `run_token` worker return-value fields. Mission goes directly to Claude Code's input prompt.
- **Boot retry** (`boot_retries`). Sending the launch command a second time was harmful — it typed `claude ...` into an already-booted Claude Code TUI as a user prompt, which the user saw as a confusing "second claude command". Now: single launch attempt, proceed best-effort if `boot_marker` isn't seen within `boot_wait_ms`.

### Kept (the only correctness fix that survived from v0.7.9)

- **Marker scan offset** — `markerScanFrom` is captured **after** the payload is sent and the echo lands (400ms sleep), so the poll loop only scans bytes produced by Claude *after* the mission was submitted. The user's mission text (now echoed in the pty log) cannot false-match the completion marker.
- **`boot_marker` default** — `'bypass permissions'` (matches the Claude Code v2.x bypass-mode footer; legacy `'Claude Code'` never matched the ANSI-stripped banner).
- **`scripts/install.sh` skill-loop self-collision guard** — `-ef` (same-inode) test prevents the loop from `rm`-ing the source when `TARGET == INSTALL_DIR` on dev machines.
- **`scripts/install.sh` uncommitted-work guard** — Step 1's `git reset --hard origin/main` refuses to run on a dirty tree unless `CLAWS_FORCE_RESET=1` is set, so contributor edits are no longer silently destroyed.

### Added — claws_fleet detach mode + claws_workers_wait

`claws_fleet` now accepts `detach=true`, which returns immediately after spawning each worker terminal (no marker poll) — the default blocking behavior is completely unchanged. Detached fleets are meant to be observed by a follow-up call to the new `claws_workers_wait` tool, which polls an array of terminal ids until each emits its `complete_marker` or `error_marker` (or times out). The two together enable a fire-and-monitor pattern where the orchestrator can do other work between spawning and harvesting. `claws_fleet` also migrated internally from `Promise.all` to `Promise.allSettled` so a single failed worker no longer aborts the entire fleet — each result is individually wrapped and the summary always covers all N workers. Tool count grows 37 → 38.

### Added — `claws_fleet` (real parallel orchestration)

`claws_fleet({ workers: [{name, mission, …}] })` is the new MCP tool for true parallel worker fan-out. Internally calls `runBlockingWorker` for each entry inside `Promise.all`, so all workers spawn and run concurrently within a **single MCP tool/call**. This bypasses Claude Code's MCP client-side serialization (which awaits each tool/call response before sending the next) — calling `claws_worker` N times from one assistant message still serializes, but `claws_fleet` returns one consolidated result with `wall_clock_ms`, `max_individual_ms`, `sum_individual_ms`, and per-worker results. Tool count grows 36 → 37.

### Fixed — bulletproof marker scan offset

`runBlockingWorker`'s `markerScanFrom` capture replaced the timing-fragile 400ms fixed sleep with a **poll-for-settle loop** (up to 5s): waits until either the pty buffer grows by 200+ bytes past pre-send length OR a TUI indicator appears (`Pasted text`, `tokens`, `thinking`, `Synthesizing`, `Combobulating`, `Brewed`, etc.), then captures the offset. Eliminates the false-completion that hit `para-auditor` in the v0.7.10 parallel test, where Claude Code v2.x delayed the input echo past the 400ms window and the marker substring in the mission body false-matched on echo.

### Added — `docs/mcp-tools-guide.md` (calibration matrix)

Comprehensive when-to-use-which guide for all 37 MCP tools. TL;DR decision matrix, mission-style cookbook (single / fleet / wave army), lifecycle gates table, anti-patterns, and the concurrent-dispatch caveats explaining why `claws_fleet` exists.

### Fixed — MCP main-loop concurrent dispatch (the critical fan-out fix)

`mcp_server.js:1304` — the MCP `tools/call` branch used to `await handleTool(...)` inside the main `while (true)` loop. That made the loop **strictly serial**: every tool call blocked the next message read. When `claws_worker` sat in its poll loop for up to `timeout_ms`, the next tool call couldn't even start until the first either matched its marker or timed out. Three "parallel" `claws_worker` calls actually queued up sequentially — fan-out and wave-army patterns were broken.

Now the dispatch is fire-and-forget: `handleTool(...).then(respond).catch(respond)`. The main loop reads the next message immediately, multiple handlers interleave on the JS event loop, and N parallel `claws_worker` calls actually run concurrently with their own pty terminals. JSON-RPC responses can arrive out-of-order relative to requests (allowed by spec; each response carries the matching id). State sharing is safe — `_pconn.pending` uses unique rids, `_eventBuffer` push is single-statement-atomic, `_circuitBreaker` reads/writes are racy but benign.

### Tests

`extension/test/worker-fixes-v079.test.js` rewritten to lock down v0.7.10's contract: 11 static-analysis checks covering the four correctness fixes plus **explicit assertions that the file-referrer pattern and boot-retry loop are NOT present, AND that `tools/call` dispatches concurrently (no `await` on `handleTool`)**. Future contributors who try to reintroduce the broken patterns will fail this test.

### Added — single-source-of-truth version

- **`scripts/bump-version.sh <X.Y.Z>`** — the only blessed way to change the project version. Updates root `package.json`, `extension/package.json`, and `extension/package-lock.json` (root + nested `packages[""]`) atomically. Validates SemVer 2.0 strictness (rejects four-segment versions like `0.7.7.1` that VS Code's manifest validator can't parse).
- **`extension/test/version-drift.test.js`** — fails the suite if any of the four version fields disagree, or if the version isn't SemVer 2.0 compliant. Wired into `npm test`. Catches the class of bug that left `extension/package-lock.json` stale at `0.7.5` for three releases without anyone noticing.

### Backwards compatibility

`claws_worker(name, mission)` API is unchanged. All call patterns from v0.7.4 onward continue to work as they did pre-v0.7.9. The worker return value drops `mission_file` and `run_token` (those fields were introduced in v0.7.9 and are gone with the file-referrer they belonged to).

## [0.7.9] - 2026-04-30 — claws_worker reliability overhaul

**`claws_worker` v0.7.8 was effectively unusable** for any caller passing a multi-line `mission` to Claude Code: workers either false-completed in 1–2 seconds (marker collision on input echo) or sat forever in collapsed-paste limbo (Claude Code v2.x auto-detects multi-line bursts as paste). The only working pattern was hand-rolling a single-line file referrer with a token never present in the mission text. v0.7.9 makes that pattern automatic, and adds boot retry + a correct boot marker.

> **Follow-up patches (post-tag, force-pushed onto v0.7.9):**
> - **Fix A** — `scripts/install.sh` skill-copy loop: added `-ef` (same-inode) guard so the loop skips the `rm -rf` + `cp -r` pair when source and destination resolve to the same directory. Without this, dev machines where `~/.claws-src` symlinks to the project root had install.sh wipe the source skill before it could be copied — install.sh aborted at step 6, never running steps 7–9.
> - **Fix B** — `mcp_server.js` `runBlockingWorker` file-referrer: decoupled the mission file path nonce from the run-token. The initial v0.7.9 implementation embedded `runToken` directly in the file path; the path was in the single-line referrer payload, which was echoed into the pty log on send, where the marker scanner false-matched. New behavior: independent `fileNonce` for the path, `runToken` lives only inside the file content (where Claude's Read tool ingests it but the pty never sees it).
> - **Fix C** — `scripts/install.sh` Step 1: added an uncommitted-work guard before the `git reset --hard origin/main`. install.sh used to silently destroy local edits on dev boxes where INSTALL_DIR == project root. The guard refuses to reset on a dirty tree unless `CLAWS_FORCE_RESET=1` is set; clear error explains the three escape hatches (commit, force, or use a different `CLAWS_DIR`).
> - Regression test: `extension/test/worker-fixes-v079.test.js` grew from 14 → 19 static-analysis checks covering all three follow-ups.

**No API change.** Existing `claws_worker(name, mission)` calls just work. Existing `command:` / `launch_claude=false` / explicit `complete_marker` paths preserve v0.7.8 behavior exactly.

### Fixed

- **Bug 1 — Marker false-match on input echo (`mcp_server.js:531`)** The poll loop did `text.includes(complete_marker)` over the entire pty buffer including the echo of the mission text the worker just sent. Any marker substring referenced in the mission triggered immediate false-completion. v0.7.9 captures `markerScanFrom = pty_log_length` after the payload is sent and only scans bytes added *after* that point.
- **Bug 2 — Bracketed-paste mission never submits in Claude Code v2.x** Claude Code auto-detects multi-line bursts as paste and collapses to `[Pasted text #N +M lines] paste again to expand`. The trailing CR `runBlockingWorker` sent did not escape that collapsed state, so the mission never ran. v0.7.9 introduces a **file-referrer pattern** for Claude Code missions: the mission body is written to a temp file with a per-spawn random run-token, and the worker sends a single-line referrer (`Read /tmp/claws-mission-…md and follow it precisely.`) that fits on one line and bypasses paste detection entirely. Mission file is cleaned up on auto-close.
- **Bug 4 — Boot marker default never matched** `boot_marker` defaulted to `'Claude Code'` (with a space), but the ANSI-stripped Claude Code v2.x banner renders as `ClaudeCodev2.1.123` — no space. Worker burned the full 8s `boot_wait_ms` on every spawn before falling through. New default: `'bypass permissions'`, which matches the bypass-mode footer reliably.

### Added

- **Boot retry** (`boot_retries`, default 2) — if the first boot attempt times out without seeing the boot marker, `runBlockingWorker` re-sends the launch command and waits another `boot_wait_ms`. Caps at the configured retry count, then proceeds best-effort.
- **`mission_file` and `run_token` in the worker return value** — surfaces the file path and per-spawn token used by the file-referrer pattern, for debugging and inspection. Both are `null` when the legacy path is used (explicit marker, `command:` mode, or `launch_claude=false`).

### Compatibility

The file-referrer pattern is **opt-out, not opt-in**:
- Default for `claws_worker(name, mission)` with `launch_claude=true` (the common case).
- **Skipped** when the caller passes an explicit `complete_marker` — the user signalled they want their own marker semantics; v0.7.9 just adds the scan-offset fix to make that marker bulletproof against echo-match.
- **Skipped** for `command:` mode (shell workers, no Claude Code). Scan-offset still applies.
- **Skipped** when `launch_claude=false`. Mission goes directly to whatever shell or REPL is running.
- File-write failure (e.g. `/tmp` readonly) falls back to the v0.7.8 direct-send path — degraded but matches prior contract.

### Out-of-scope (deferred to v0.7.10)

- **Bug 3 — `claws_send` first-character duplication** (cosmetic: `cclaude`, `eecho`). Visual artifact in pty echo only; bytes arriving at the shell are correct. Needs byte-level pty trace to root-cause.
- Send-retry on stuck paste (would require activity-detection heuristic).
- `[Pasted text]` detection + auto-recovery (re-send as single-line with file referrer).

## [0.7.8] - 2026-04-30 — Re-release of v0.7.7.1 with semver-compliant version

**Hot-fix replacing v0.7.7.1.** v0.7.7.1 used a four-segment version (`MAJOR.MINOR.PATCH.BUILD`) which is not valid per the [SemVer 2.0 spec](https://semver.org/spec/v2.0.0.html) — only `MAJOR.MINOR.PATCH` is allowed. VS Code's extension manifest validator rejected the `0.7.7.1` extension with "Extension version is not semver compatible" and disabled it for users who updated. v0.7.8 contains the same fixes as v0.7.7.1 with a properly-incremented PATCH segment so VS Code accepts and enables the extension.

### Action required for users hit by 0.7.7.1

Run `/claws-update` again — install.sh will deploy the v0.7.8 VSIX over the disabled v0.7.7.1 entry. Reload VS Code (Developer: Reload Window) and the extension activates again. No manual cleanup needed.

### Fixed

- **Banner suppression bug** `scripts/shell-hook.sh:24` — dropped `export` from `CLAWS_BANNER_SHOWN=1`. The variable was meant to scope to the current shell only (suppress re-paint on `source`), but `export` made it leak into every child process. When VS Code was launched from a banner-painted shell, every terminal it spawned inherited `CLAWS_BANNER_SHOWN=1` pre-set and the banner never painted. With `export` removed, each new interactive shell starts with no flag, paints once, and child processes get a clean slate. Verified: banner paints reliably with `v0.7.8` in fresh terminals.
- **Worker spawn cwd + model defaults** `mcp_server.js` `runBlockingWorker` — `claws_worker` now passes `cwd` to the create RPC (defaulting to the MCP server's `process.cwd()` so workers land in the project root, not `$HOME`) and launches Claude Code with `--model claude-sonnet-4-6` by default. Both overridable via new `cwd` and `model` args. Previously, workers landed in `$HOME`, hit the trust dialog, failed the project MCP socket walk-up, and booted whichever model the user's shell defaulted to (often Opus xhigh). Schema regenerated; codegen test still passes (36 tools).
- **GAP-3** `scripts/install.sh` — when update.sh's `--ff-only` pull diverged and exported `GIT_PULL_OK=0`, install.sh's own `git reset --hard origin/main` would succeed, leaving the source fresh but with the stale `GIT_PULL_OK=0` flag still gating CLAUDE.md re-injection. install.sh now flips `GIT_PULL_OK=1` after a successful force-reset so the new template + tool list lands.
- **GAP-1** `scripts/install.sh:559` — `EXPECTED_MIN_VERSION` bumped from `"0.7.4"` to `"0.7.7"`.
- **GAP-2** `scripts/install.sh:1182-1185` — corrected misleading comment about hook bin path. Documentation only.

## [0.7.7.1] - 2026-04-30 — WITHDRAWN (invalid semver)

This version was published with a four-segment string (`0.7.7.1`) which is not valid per [SemVer 2.0](https://semver.org/spec/v2.0.0.html). VS Code disabled the extension. **Use [v0.7.8](#078---2026-04-30--re-release-of-v0771-with-semver-compliant-version) instead** — same fixes, valid version.

## [0.7.7] - 2026-04-30 — Development Discipline Hooks

### Fixed (v0.7.7-bulletproof)

- **P0-1** `scripts/fix.sh` — added explicit `~/.claude/settings.json` JSON validity check (check 7b). Malformed settings caused ALL hooks to fail silently per session. Fix.sh now detects the issue, backs up the file, and re-injects Claws hooks via `inject-settings-hooks.js`.
- **P1-2** `scripts/inject-dev-hooks.js` — replaced raw `JSON.parse` + `writeFileSync` with `json-safe.mjs` `mergeIntoFile` (JSONC-tolerant, atomic, abort-on-malformed). Previously, a comment in `.claude/settings.json` caused silent parse failure, `{}` fallback, and full overwrite — destroying all pre-existing project hooks.
- **P1-1** `scripts/inject-settings-hooks.js` — legacy array hooks (early Claude Code) now migrated to object format before remove+add. Previously, adding named properties to a JS array caused new hooks to be silently dropped by `JSON.stringify`. Both `--update` and add-only paths now migrate array→object first.
- **D-2** `.claude/settings.json` (dev-box) — migrated dev-hook command paths from `scripts/dev-hooks/` (source path) to `.claws-bin/dev-hooks/` (canonical production path). Removed legacy inner-`_source` format entries that the inject script could not update automatically due to format mismatch.
- **P3-6** `scripts/update.sh` — added `--dry-run` flag. When passed, skips the installer step and instead prints the git diff stat from `origin/main` plus pending local commits — useful for previewing what an update would change before applying it.
- **P3-5** `scripts/install.sh` — VSIX post-install stale cleanup now polls up to 1s (5×200ms) for the extracted extension directory to appear before deciding it's absent. Previously, VS Code's async VSIX extraction could cause the cleanup to skip and warn on every install.
- **P3-1/2/3** `scripts/install.sh` — three hygiene fixes: (1) deploy `schemas/client-types.d.ts` to `.claws-bin/schemas/` for typed SDK consumers; (2) replace 5 hardcoded `if [ -d .claude/skills/<name> ]` blocks with a `for _skill_src in .claude/skills/claws-* dev-protocol-*` loop so new skills are picked up automatically; (3) emit `warn` when `claws-sdk.js` is absent instead of silently skipping.
- **P2-4** `scripts/fix.sh` — when the socket is LIVE, now probes terminal list for wrapped terminals with missing `logPath` (indicates `script(1)` failed at pty allocation time). On Linux, also checks `command -v script` and suggests `bsdutils` install if absent.
- **P2-3** `scripts/fix.sh` — MCP handshake failure now triggers auto-recovery: copies `mcp_server.js` from `$INSTALL_DIR` to `.claws-bin/` and re-probes the handshake once. Previously the script reported the failure and stopped.
- **P2-1** `scripts/shell-hook.sh` — now exports `CLAWS_DIR` at source time (detected from script location, falls back to `~/.claws-src`). Updated `/claws-fix` and `/claws-update` slash commands to use `${CLAWS_DIR:-$HOME/.claws-src}` instead of hardcoded `~/.claws-src`, so a `CLAWS_DIR` override is honored end-to-end.
- **P2-2** `scripts/install.sh` and `scripts/fix.sh` — added `.claws-bin` symlink guard before `mkdir -p`. Detects and removes dangling or unexpected symlinks at `$PROJECT_ROOT/.claws-bin` before creating the directory, preventing silent deployment to the wrong target path.
- **P1-5** `scripts/fix.sh` — added shell-hook sourcing check (check 6b). Greps `.zshrc` / `.bashrc` for a `shell-hook.sh` source line; if absent, appends one automatically so `claws-ls`, `claws-new`, `claws-run`, and `claws-log` functions are available in new terminals.
- **P1-4** `scripts/fix.sh` — added unconditional `.claws-bin` integrity check (check 4c), independent of the `.mcp.json` registration gate. Detects missing directory, missing `mcp_server.js`, and dangling symlinks, then auto-repairs by copying from `$INSTALL_DIR`. Previously, a broken `.claws-bin` was only repaired when `.mcp.json` was also missing.
- **P1-3** `scripts/fix.sh` — replaced `ls … | head -1` with a full `for inst` loop over all `neunaha.claws-*` entries per editor dir. Added post-scan duplicate detection that warns when multiple copies exist in the same editor, preventing silent load-order conflicts.
- **D-1** `schemas/mcp-tools.json` — registered 5 missing MCP tools: `claws_drain_events`, `claws_pipeline_create`, `claws_pipeline_list`, `claws_pipeline_close`, `claws_dispatch_subworker`. These handlers existed in `mcp_server.js` but were invisible to AI orchestrators because `tools/list` reads from the schema file.
- **A-5** `scripts/install.sh` — `STEP_TOTAL` bumped from 8 to 9 to match actual step count (cosmetic — install used to render `9/8 Verifying`).

### Added

- **Five dev-hook scripts** in `scripts/dev-hooks/`: `check-stale-main`, `check-tag-pushed`, `check-tag-vs-main`, `check-open-claws-terminals`, `check-extension-dirs` — each exits 0 (warn-only, never blocks), logs to `/tmp/claws-dev-hooks.log`.
- **`scripts/inject-dev-hooks.js`** — idempotent safe-merge hook registration; tags all entries with `_source:"claws-dev-hooks"` for clean removal; skips re-registration if hook already present.
- **`install.sh` and `update.sh`** — now deploy dev hooks to `<project>/.claws-bin/dev-hooks/` and register them via `inject-dev-hooks.js` on both fresh install and update paths.
- **`scripts/shell-hook.sh` runtime version** — banner version is now read at runtime from `CLAWS_VERSION` env var or nearest `package.json` (walks up from CWD); no more hardcoded `v0.x.y` that drifts across releases. Banner also detects pipe-mode (non-interactive) and suppresses the command list in that context.
- **`templates/CLAUDE.project.md`** — new "Development Discipline (enforced by hooks)" section with 7 best-practice bullets covering stale-main pulls, semver compliance, extension-dir safety, CLAUDE.md re-injection, pre-PR drift check, tag discipline, and Claws terminal policy.
- **WaveRegistry lifecycle hardening** — wave lifecycle state machine enforces valid transitions (PLANNED→RUNNING→COMPLETE/FAILED); stale wave entries GC'd after configurable TTL; `claws_wave_status` now returns `phase` + `elapsedMs`.
- **Army-style nested wave harvest** (`extension/src/wave-registry.ts`, `server.ts`) — `WaveRecord` gains `parentWave?`, `subWorkerTerminals[]`, `harvestedAt?`, `orphanedTerminals[]`; `WaveRegistry.trackTerminal()` records TIDs spawned by wave-affiliated peers; `harvestWave()` returns orphaned TIDs for auto-close on `wave.complete`; lead-silence violation timer fires `wave.<id>.violation {kind:"silent_lead_with_active_subs"}` when LEAD goes quiet with active sub-worker terminals.
- **`WaveHarvestedV1` schema** (`event-schemas.ts`) — typed schema for `wave.*.harvested` events; registered in `SCHEMA_BY_NAME` and `TOPIC_REGISTRY`.
- **`claws_wave_status` nested tree** (`mcp_server.js`) — response now includes `lead: {peerId, peerName, terminalId, status, lastSeenMs}` and `subWorkers[].terminalId`; `subWorkerTerminals` flat array exposed.
- **`PeerConnection`** (`peer-registry.ts`) — gains `waveId?` and `subWorkerRole?` to persist wave affiliation from `hello` across subsequent commands.

### Fixed (carries all v0.7.6.1 patch fixes)

- **P0-1** `mcp_server.js` — `claws_worker` circuit breaker: skips reconnect if last failure < 30 s ago; `_scanAndPublishCLAWSPUB` trips `scanDisabled` after 3 consecutive socket errors; default `timeout_ms` reduced 1 800 000 → 300 000 ms.
- **P0-2** `extension/src/server.ts` — orchestrator peers exempt from per-peer publish rate limit; no self-deadlock during high-volume waves.
- **P1-1** `extension/src/server-config.ts` — `DEFAULT_STRICT_EVENT_VALIDATION` flipped `false` → `true`; W4 validation active by default.
- **P1-2** `mcp_server.js` — `_eventBuffer.maxWaiters=10` cap; excess `wait_ms` requests return error immediately; `system.bus.ring-overflow` event emitted once per eviction batch.
- **P1-5/P1-6** `scripts/install.sh` — deploy blocks for `claws-wave-lead`, `claws-wave-subworker`, `dev-protocol-piafeur` skills.
- **P1-7** `schemas/mcp-tools.json` + `mcp_server.js` — all 5 `claws_task_*` tools (`claws_task_assign`, `claws_task_update`, `claws_task_complete`, `claws_task_cancel`, `claws_task_list`) registered in schemas and MCP handlers.
- **P1-8** `scripts/shell-hook.sh` — banner version no longer drifts across releases (see Added above).

### Known Issues

- `auto-subscribe-cmd.test.js` — emits `envelope:invalid` under `strictEventValidation=true`; pre-existing since v0.7.6.1 P1-1 flip. Not introduced by v0.7.7.
- `claws-v2-rate.test.js` — same `envelope:invalid` root cause. Pre-existing.
- `claws-v2-typed-rpc.test.js` — `rpc.call` timeout on test teardown; pre-existing race condition unrelated to v0.7.7 changes.

## [0.7.6.1] - 2026-04-30 — Bug-fix patch (8 P0/P1 code + 2 hot-fixes)

### Fixed

- **P0-1/P2-3** `mcp_server.js` — circuit breaker: `_pconnEnsureRegistered` skips reconnect if last failure < 30s ago; `_scanAndPublishCLAWSPUB` trips `scanDisabled` after 3 consecutive socket errors, resumes on explicit reconnect; default `timeout_ms` reduced 1,800,000 → 300,000 ms (5 min).
- **P0-2** `extension/src/server.ts` — orchestrator peers exempt from per-peer publish rate limit; orchestrator management commands can no longer be self-rate-limited during high-volume waves. Peer role looked up via `this.peers.get(peerId)?.role` before the bucket check.
- **P1-1** `extension/src/server-config.ts` — `DEFAULT_STRICT_EVENT_VALIDATION` flipped `false` → `true`; the W4 validation guarantee is now active by default; unregistered topics pass through unchecked (the existing `if (dataSchema !== null)` guard in server.ts handles this).
- **P1-2** `mcp_server.js` — `_eventBuffer.maxWaiters=10` cap; excess `wait_ms` requests return an error immediately; `system.bus.ring-overflow` event emitted once per eviction batch (via `setImmediate` dedup guard `_overflowPending`).
- **P1-5/P1-6** `scripts/install.sh` — copy blocks added for `claws-wave-lead`, `claws-wave-subworker`, `dev-protocol-piafeur` skills; existing `claws*.md` glob already covers `claws-wave-lead.md` and `claws-army.md` commands; `claws-update` on existing projects now picks up all three skills.
- **P1-7** `schemas/mcp-tools.json` + `mcp_server.js` — added `claws_task_assign`, `claws_task_update`, `claws_task_complete`, `claws_task_cancel`, `claws_task_list` tool definitions (schemas) and their MCP handler stubs routing to `task.*` protocol commands via the stateful socket; `claws_schema_get` no longer returns not-found for these 5 tools.
- **P1-8** `scripts/shell-hook.sh:66` — banner version updated `v0.6.1` → `v0.7.6`; was 7 releases stale.
- **HOT-FIX A** — ran `inject-claude-md.js` against `/Users/ANISH.NEUNAHA/Desktop/Claws`; `CLAWS:BEGIN` block now present.
- **HOT-FIX B** — removed stale `~/.vscode/extensions/neunaha.claws-0.7.4/` and `neunaha.claws-0.7.5/`; only `neunaha.claws-0.7.6` remains.

## [0.7.6] - 2026-04-30 — Claws TCP — full architectural release (10 waves + embedder)

### Fixed — Ship restoration

- `extension/scripts/deploy-dev.mjs`: deploy loop now copies `README.md`, `CHANGELOG.md`, `icon.png` alongside `dist/` and `native/` — these were previously skipped, causing blank display in the VS Code Extensions panel.
- `extension/CHANGELOG.md`: synced from root CHANGELOG (was stale at v0.5.3, now complete through v0.7.6).
- `scripts/inject-claude-md.js`: `TOOLS_V2` expanded with all v0.7.6 MCP tools — `claws_lifecycle_{plan,advance,snapshot,reflect}`, `claws_wave_{create,status,complete}`, `claws_deliver_cmd`, `claws_cmd_ack`, `claws_schema_{list,get}`, `claws_rpc_call`.

### Added — W10/L18+L19 Token Auth + WebSocket Transport (Wave 10 — FINAL)

- `extension/src/server-config.ts` — `AuthConfig` (`enabled`, `tokenPath`), `WebSocketConfig` (`enabled`, `port`, `certPath`, `keyPath`) sub-configs added to `ServerConfig`; `defaultServerConfig` defaults to both disabled.
- `extension/src/protocol.ts` — `HelloRequest` gains `token?`, `nonce?`, `timestamp?` fields for L18 auth.
- `extension/src/server.ts` — `validateAuthToken()`: HMAC-SHA256 over `peerName:role:nonce:timestamp`; checks token present, timestamp ≤5 min stale, nonce single-use, HMAC `timingSafeEqual`; `usedNonces` Set cleared on `stop()`; auth called at start of `hello` handler before any other logic; `wsTransport.start()` invoked in `start()` chain when `webSocket.enabled`; `wsTransport.stop()` in `stop()`.
- `extension/src/websocket-transport.ts` (new) — `WebSocketTransport` class: `WsSocketAdapter` wraps `ws.WebSocket` in a `net.Socket`-compatible EventEmitter shim (adapts message→data, close→end, write strips `\n` and calls `ws.send`); `WebSocketServer` created over http/https server; TLS when `certPath`+`keyPath` provided; loaded lazily so no cost when WS disabled.
- `extension/src/extension.ts` — `getConfig()` wires `auth.*` and `webSocket.*` from VS Code settings.
- `extension/package.json` — `ws@8` + `@types/ws@8` as optional/dev deps; VS Code config contributions for all 6 new config keys; `test:auth` and `test:ws-transport` scripts; both added to `test` chain.
- `extension/test/claws-auth.test.js` (new) — 6-check auth suite: no-token, wrong-HMAC, valid-HMAC, stale-timestamp, nonce-reuse, auth-disabled.
- `extension/test/claws-ws-transport.test.js` (new) — 5-check WS suite: hello, pub/sub round-trip, shared peer registry with Unix socket, protocol tag, worker auto-subscribe.

### Added — W8/L16+L7 Typed RPC + Schema Registry (Wave 8)

- `extension/src/server.ts` — `rpc.call` command: synchronous blocking RPC — caller's request is held open (like `exec`) until the target peer publishes to `rpc.response.<callerPeerId>.<requestId>` or the timeout fires; `rpcPending` correlation map with `clearTimeout` cleanup on resolution; `schema.list` command returns sorted keys from `SCHEMA_BY_NAME`; `schema.get` command returns a simplified JSON representation via `serializeZodSchema` (recursive Zod `_def` traversal covering object, string, number, boolean, array, record, enum, literal, optional, nullable, unknown).
- `extension/src/event-schemas.ts` — `RpcRequestV1` (requestId uuid, method, params optional, callerPeerId) and `RpcResponseV1` (requestId, ok, result optional, error optional) Zod schemas; both registered in `SCHEMA_BY_NAME` (32 → 35 with PipelineStepV1).
- `extension/src/topic-registry.ts` — `rpc.*.request` and `rpc.response.**` patterns registered; registry grows 32 → 34.
- `extension/src/protocol.ts` — `RpcCallRequest`, `SchemaListRequest`, `SchemaGetRequest` interfaces added to `ClawsRequest` union.
- `mcp_server.js` — `claws_schema_list`, `claws_schema_get`, `claws_rpc_call` handlers.
- `scripts/codegen/gen-mcp-tools.mjs` — descriptions and input schemas for the 3 new tools (`claws_schema_list`, `claws_schema_get`, `claws_rpc_call`); tool count grows 23 → 26; `schemas/mcp-tools.json` is fully generated — no hand-edits needed.
- `schemas/json/rpc-request-v1.json`, `schemas/json/rpc-response-v1.json`, `schemas/json/pipeline-step-v1.json` — generated JSON Schema files (pipeline-step-v1 was missing from prior run).
- `scripts/gen-client-types.mjs` (new) — standalone codegen script: bundles `event-schemas.ts` via esbuild, walks `SCHEMA_BY_NAME`, emits `schemas/client-types.d.ts` with TypeScript interface declarations for all 35 schemas; zero additional deps (uses esbuild already in extension devDeps).
- `schemas/client-types.d.ts` (new) — generated TypeScript client type declarations; one `export interface` per SCHEMA_BY_NAME entry; union/nullable/optional/record/array types all handled.
- `extension/test/claws-v2-typed-rpc.test.js` (new) — 40-check integration suite: round-trip RPC (<500ms), timeout (300ms), unknown-peer error, `schema.list` (checks rpc/worker/cmd names), `schema.get` (positive + negative), validation (missing method/targetPeerId).

### Added — W9/L11+L17 Pipeline Composition + Workflow DAG Foundation (Wave 9)

- `extension/src/pipeline-registry.ts` (new) — `PipelineRegistry` with `create`, `get`, `list`, `close`, `findBySource`, `clear`; `PipelineRecord` and `PipelineStep` types; `pipe_NNNN` monotonic IDs; `findBySource` returns only active pipelines for O(n) output-wiring dispatch.
- `extension/src/server.ts` — `pipeline.create` handler (orchestrator-only, ≥2 steps with source+sink required); `pipeline.list` and `pipeline.close` handlers; output→sink wiring in `publish` handler: `output.<id>.*` topics matched by regex, active pipelines found via `findBySource`, text forwarded to sink via pty `writeInjected` or VS Code `sendText`, `pipeline.<id>.step.<stepId>` event emitted for each delivery.
- `extension/src/event-schemas.ts` — `PipelineStepV1` Zod schema (pipelineId, stepId, role, terminalId, state, ts); `SCHEMA_BY_NAME` grows from 34 → 35 (also adds previously-missing `rpc-request-v1` and `rpc-response-v1` entries).
- `extension/src/topic-registry.ts` — `pipeline.*.step.*`, `pipeline.*.created`, `pipeline.*.closed` patterns registered; registry grows 31 → 34.
- `extension/src/protocol.ts` — `PipelineCreateRequest`, `PipelineListRequest`, `PipelineCloseRequest` interfaces added to the `ClawsRequest` union.
- `mcp_server.js` — `claws_pipeline_create`, `claws_pipeline_list`, `claws_pipeline_close` handlers.
- `schemas/mcp-tools.json` — 3 new tool definitions for the pipeline MCP tools.
- `extension/test/claws-v2-pipeline.test.js` (new) — 34-check integration suite: create/list/close lifecycle (pipeline.*.created push, list active, close emits pipeline.*.closed, list shows closed state), output wiring (output.tA.line publish → step event + sink sendText), error cases (empty steps, missing source/sink, unknown pipelineId), topic subscription acceptance.

### Added — W6/L10 Structured Control — deliver-cmd + cmd.ack (Wave 6)

- `extension/src/server.ts` — `deliver-cmd` handler: orchestrator-only; validates target peer exists, deduplicates by `idempotencyKey`, allocates monotonic `seq`, appends to event log, and pushes the command envelope to the worker's auto-subscription topic. `cmd.ack` handler: worker-only; fans out `cmd.<peerId>.ack` to all subscribed orchestrators with the `seq` and `status` fields.
- `extension/src/protocol.ts` — `DeliverCmdRequest` and `CmdAckRequest` interfaces added to the `ClawsRequest` union.
- `extension/src/event-schemas.ts` — `CmdDeliverV1` and `CmdAckV1` Zod schemas; `SCHEMA_BY_NAME` grows from 30 → 32.
- `extension/src/topic-registry.ts` — `cmd.*.ack` pattern registered with `CmdAckV1` schema; registry grows 28 → 29.
- `mcp_server.js` — `claws_deliver_cmd` and `claws_cmd_ack` MCP tool handlers.
- `schemas/mcp-tools.json` — 21 → 23 tools; `schemas/json/cmd-deliver-v1.json` and `schemas/json/cmd-ack-v1.json` generated.
- `scripts/codegen/gen-mcp-tools.mjs` — descriptions and input schemas for the two new tools.
- `extension/test/claws-v2-control.test.js` — 31-check integration suite (6 suites): basic delivery (push frame, seq number), idempotency (duplicate key returns `{ok:true, duplicate:true}` without re-push), unknown peer error, role gating (orchestrator cannot call `cmd.ack`), event-log durability, and `cmd.*.ack` registry subscription.

### Added — W7/L13+L14 Observability and Rate Control (Wave 7)

- `extension/src/event-log.ts` — `lastSequence` getter: returns the last successfully appended sequence number (min 0); used by `system.metrics` heartbeat payload.
- `extension/src/server-config.ts` — `maxPublishRateHz` (default 10 000) and `maxQueueDepth` (default 500) added to `ServerConfig`; `DEFAULT_MAX_PUBLISH_RATE_HZ` and `DEFAULT_MAX_QUEUE_DEPTH` exported.
- `extension/src/extension.ts` — `getConfig()` wires `maxPublishRateHz` and `maxQueueDepth` from `claws.*` VS Code settings.
- `extension/src/server.ts` — L13: heartbeat timer now emits `system.metrics` (publishRate_per_sec, queueDepth, peerCount, eventLogLastSeq, uptimeMs, ts) and `system.peer.metrics.<peerId>` for peers with drops or rate-limit hits; per-heartbeat publish counter resets each tick.
- `extension/src/server.ts` — L14: per-peer sliding 1-second rate limiter; publish requests exceeding `maxPublishRateHz` return `{ok:false,error:'rate-limit-exceeded'}`; `serverInFlight` admission-control counter (incremented synchronously before any `await`) rejects beyond `maxQueueDepth` with `{ok:false,error:'admission-control:backlog'}`; rate check fires before admission so high-rate publishers get the semantically correct error code.
- `extension/src/event-schemas.ts` — `SystemMetricsV1` and `SystemPeerMetricsV1` Zod schemas added; registered in `SCHEMA_BY_NAME`.
- `extension/src/topic-registry.ts` — `system.metrics` and `system.peer.metrics.*` registered with their schemas.
- `schemas/json/system-metrics-v1.json`, `schemas/json/system-peer-metrics-v1.json` — JSON Schema representations of the two new event types.
- `extension/test/claws-v2-rate.test.js` — 19-check integration test suite: system.metrics shape and cadence, burst rate-limit rejection, admission-control:backlog, system.peer.metrics per-peer emission with rateLimitHits, 1s backoff recovery, peerCount tracking.

### Added — W5/L8 Event Log Durability Hardening (Wave 5)

- `extension/src/event-log.ts` — `EventLogWriter.runRetention(retentionDays)`: deletes `.jsonl` segments (and companion `.idx` files) whose mtime is older than `retentionDays` days; closes the open fd before unlinking the active segment so no EBUSY on Linux; removes deleted entries from the in-memory manifest and flushes to disk.
- `extension/src/event-log.ts` — `EventLogWriter.compact()`: on startup, merges all segments smaller than 1 KB (COMPACT_SIZE_THRESHOLD) into a single merged `.jsonl` using atomic tmp-then-rename; preserves event sequence ordering; rebuilds the `.idx` for the merged segment.
- `extension/src/event-log.ts` — Per-segment `.idx` files: `topic<TAB>byte_offset` index written atomically alongside each `.jsonl` on `close()` and `rotate()`; offsets are the exact byte positions of each record's start, enabling O(1) seek for filtered replay. Written via tmp-then-rename for atomicity.
- `extension/src/server-config.ts` — `EventLogConfig` interface with `retentionDays` (default 7) and `compact` (default true); added to `ServerConfig` as `eventLog` field; `DEFAULT_EVENT_LOG_RETENTION_DAYS` and `DEFAULT_EVENT_LOG_COMPACT` constants exported.
- `extension/src/server.ts` — `start()` calls `eventLog.compact()` after `open()` when `eventLog.compact` config is true; heartbeat timer calls `eventLog.runRetention(retentionDays)` each tick.
- `extension/src/extension.ts` — `getConfig()` now populates `eventLog.retentionDays` and `eventLog.compact` from VS Code settings (`claws.eventLog.*`).
- `extension/test/claws-event-log-retention.test.js` — 10-check test suite: retention deletes old segments and keeps recent; manifest updated; fd closed before deletion; `.idx` written and parseable; `compact()` merges 3 small segments into 1; sequence ordering preserved; `scanFrom` replay works after compaction; byte offsets in `.idx` match actual line starts.

### Added — W1/L4 Vehicle State Machine

- `extension/src/protocol.ts` — `TerminalDescriptor` now includes `vehicleState?: 'PROVISIONING' | 'BOOTING' | 'READY' | 'BUSY' | 'IDLE' | 'CLOSING' | 'CLOSED'` so `list` responses expose the current vehicle state.
- `extension/src/event-schemas.ts` — `VehicleStateV1` Zod schema (terminalId, from, to, ts); `VehicleStateEnum` with all 7 states. `SCHEMA_BY_NAME` updated to include `vehicle-state-v1`.
- `extension/src/topic-registry.ts` — three new topic patterns registered: `vehicle.*.state`, `vehicle.*.created`, `vehicle.*.closed`.
- `extension/src/claws-pty.ts` — `ClawsPtyOptions` gains two optional hooks: `onOpenHook` (fires when VS Code calls Pseudoterminal.open()) and `onFirstOutputHook` (fires on the first byte of pty output). These let TerminalManager drive state transitions without coupling to the pty internals.
- `extension/src/terminal-manager.ts` — `TerminalRecord` grows `vehicleState: VehicleStateName`; `TerminalManager` gains `setStateChangeCallback(cb)` and a private `transitionState(rec, to)` that enforces the valid-transition table (PROVISIONING→BOOTING→READY→BUSY/IDLE→CLOSING→CLOSED). `createWrapped` emits PROVISIONING then immediately BOOTING; `onOpenHook` fires BOOTING→READY when the pty opens; `close` and `onTerminalClosed` emit CLOSING→CLOSED.
- `extension/src/server.ts` — wires `setStateChangeCallback` in the constructor; the callback calls `emitSystemEvent('vehicle.<id>.state', {terminalId, from, to, ts})` so every transition is appended to the event log and fanned out to subscribers.
- `extension/test/claws-v2-vehicle-state.test.js` — 19-assertion integration test suite covering: PROVISIONING→BOOTING and BOOTING→READY push frames, close emitting CLOSING→CLOSED, vehicleState in list responses, ordering invariants, payload structure (terminalId, from, to, ts).

### Added — Wave Army Protocol (embedder wave)

The embedder wave introduces the Wave Army Protocol — a structured multi-agent orchestration layer built on the claws/2 pub/sub bus. Every wave has a typed lifecycle (create → sub-workers boot → sub-workers complete → lead emits complete) with violation detection and disciplined per-role obligations.

**Protocol layer (shipped):**
- `extension/src/protocol.ts` — `SubWorkerRole` type (`lead | tester | reviewer | auditor | bench | doc`); `ContractedRoles` constant; `HelloRequest` extended with optional `waveId` and `subWorkerRole`; `WaveCreateRequest`, `WaveCompleteRequest`, `WaveStatusRequest` added to `ClawsRequest` union.
- `extension/src/event-schemas.ts` — 7 new Zod schemas: `WaveLeadBootV1`, `WaveLeadCompleteV1`, `WaveTesterRedCompleteV1`, `WaveReviewFindingV1`, `WaveAuditFindingV1`, `WaveBenchMetricV1`, `WaveDocCompleteV1`. `SCHEMA_BY_NAME` grows from 24 to 31 entries.
- `extension/src/topic-registry.ts` — `wave.**` catch-all pattern registered; specific wave schemas bound in `SCHEMA_BY_NAME`.
- `extension/src/wave-registry.ts` — new `WaveRegistry` class tracking active waves: per-role heartbeat timers fire `wave.<N>.violation` after 25s silence; `createWave`, `recordHeartbeat`, `markSubWorkerComplete`, `completeWave`, `handlePeerDisconnect`, `dispose`.
- `extension/src/server.ts` — `WaveRegistry` wired into `ClawsServer`; handlers for `wave.create`, `wave.status`, `wave.complete`; `hello` records sub-worker heartbeat when `waveId+subWorkerRole` present; `handleDisconnect` notifies registry.

**MCP tools (shipped):** `claws_wave_create`, `claws_wave_status`, `claws_wave_complete`, `claws_dispatch_subworker` added to `mcp_server.js` handler dispatch; `schemas/mcp-tools.json` updated with all 4 tool schemas (total grows by 4).

**Discipline contract embedded (shipped):** `templates/CLAUDE.project.md` and `templates/CLAUDE.global.md` gain "Wave Discipline Contract (mandatory)" sections listing all 8 sub-worker rules (heartbeat, boot event, phase events, error events, no --no-verify, full suite before commit, type check per .ts file, complete event). `scripts/hooks/session-start-claws.js` extended to include wave discipline summary block when Claws socket is detected.

### Fixed — embedder wave reviewer findings (F28/F29)

- `mcp_server.js` `claws_dispatch_subworker` — F28 (MEDIUM): switched mission delivery from `newline:true` to `newline:false` + separate `\r` submit, matching the established `claws_worker` pattern; prevents spurious double-LF in Claude TUI mid-think (reviewer finding F28).
- `mcp_server.js` `claws_dispatch_subworker` — F29 (LOW): boot-poll loop now tracks `nextOffset` from each `readLog` response and passes it as `offset` on the next call; eliminates repeated full-log reads during the 25 s boot window.

**Skills (shipped):** `.claude/skills/claws-wave-lead/SKILL.md` and `.claude/skills/claws-wave-subworker/SKILL.md` — full role contracts, boot sequences, schema references.

**Commands (shipped):** `.claude/commands/claws-wave-lead.md` (LEAD activation flow) and `.claude/commands/claws-army.md` (full army deployment with monitoring and completion criteria).

### Added — W2/L15 Event Log Replay + L9 Observation

- `extension/src/event-log.ts` — `EventLogReader` class: `scanFrom(cursor, topicPattern)` async generator reads segments from a byte-offset cursor position, filters records by topic pattern via `matchTopic()`, handles both manifest-based and directory-scan segment discovery.
- `extension/src/server.ts` — `subscribe` handler now validates `fromCursor` format (`parseCursor` → null = reject with `invalid cursor format`); registers subscription in `subscriptionIndex` **before** replay starts (atomicity — no live events missed during replay); `setImmediate` dispatches `replayFromCursor` so the subscribe ACK is sent first. `replayFromCursor` sends `{push:'message', replayed:true}` frames then a `{push:'caught-up', subscriptionId, replayedCount, resumeCursor}` terminal signal.
- `extension/src/protocol.ts` — `SubscribeResponse` interface adds optional `replayedCount?: number`.
- `extension/src/claws-pty.ts` — `getForegroundProcess()` uses `pgrep -P <shellPid>` + `ps -p <pid> -o comm=` to detect the foreground process basename under the shell; powers L9 content-type observation.
- `extension/src/peer-registry.ts` — `DisconnectedPeer` tombstone interface; `fingerprintPeer(peerName, role, nonce)` derives stable 12-hex sha256 fingerprint for `fp_`-prefixed stable peer IDs on reconnect.
- `extension/src/terminal-manager.ts` — `ContentChangeCallback`; `startContentDetection` polls foreground process every 2 s and fires `onContentChange` on basename transitions; wired via `setContentChangeCallback`.
- `extension/src/wave-registry.ts` — violation timer updates; sub-worker heartbeat tracking improvements.
- `extension/test/claws-event-log-replay.test.js` — 13-assertion integration test: publishes 10 events, subscribes with `fromCursor`, verifies all 10 replayed frames carry `replayed:true`, caught-up frame fires with correct count, live events arrive without `replayed`, invalid cursor rejected (TDD: 6 failing → 13 passing).

### Fixed
- `extension/test/claws-v2-content.test.js` — interrupt foreground process with `\x03` before sending vim and extend wait timeout from 5s to 8s to reduce flakiness on slow machines.
- `extension/test/event-schemas.test.js` — update `SCHEMA_BY_NAME` count from 19 to 20 (added `vehicle-state-v1`).
- `extension/test/topic-registry.test.js` — update `TOPIC_REGISTRY` count from 19 to 22 (added 3 vehicle.* patterns).
- `extension/test/event-schemas.test.js` — align `SCHEMA_BY_NAME` count assertion with current registry: was 19, now 20 after v0.7.5 L1.1+L1.4 schemas added `vehicle-state-v1`; test now derives expected names explicitly and asserts the correct total.
- `scripts/inject-settings-hooks.js` — hook commands must use absolute paths. `CLAWS_BIN` was used as-is when passed as a relative argument (e.g. `"scripts"`), producing hook commands like `node "scripts/hooks/pre-tool-use-claws.js"` that broke with `ERR_MODULE_NOT_FOUND` whenever Claude Code's CWD was not the project root. Fix: wrap the arg with `path.resolve()` before computing script paths. Regression test added: `extension/test/inject-settings-absolute-paths.test.js`.

## [0.7.5] - 2026-04-29 — Bus hardening release

This release hardens the orchestrator↔worker communication bus surfaced by W1–W4 audits. The `.claws/events/default/*.jsonl` was empty on user systems because (a) the MCP server was dropping every push frame from the persistent socket, and (b) default workers never publish.

### L-1 Display fixes (R1, R4, R5, R7) — landed
- `claws-pty.ts` — inject `CLAWS_WRAPPED=1` (real pty) or `CLAWS_PIPE_MODE=1` (degraded) plus `CLAWS_TERMINAL_ID` so the shell hook reports truthful state
- `protocol.ts` — `TerminalDescriptor` now exposes `ptyPid` (real shell pid) and `ptyMode` (`'pty'`/`'pipe'`/`'none'`)
- `terminal-manager.ts` — `describe()` returns `pty.pid` and `pty.mode` from the live `ClawsPty` instance
- `mcp_server.js` — `claws_list` formatter trusts the `wrapped` boolean (was incorrectly keying off `logPath` which is always null in the Pseudoterminal capture model). Pid column shows the real shell pid. Wrapped state labels: `WRAPPED`, `WRAPPED-DEGRADED-pipe-mode`, `WRAPPED-pending`, `unwrapped`

Pre-fix symptoms: `claws_list` always showed `[unwrapped]` and `pid=-1` for wrapped terminals; shell-hook banner always said "unwrapped". All cosmetic-but-misleading; the underlying terminals were real ptys.

### L0 — Push-frame capture (landed)
- `mcp_server.js` — `_pconnHandleData` buffers push frames (no rid) into a 1000-entry ring buffer instead of silently dropping them; each entry carries `absoluteIndex`, `topic`, `from`, `payload`, `sentAt`, `sequence`
- `mcp_server.js` — new `claws_drain_events` MCP tool: drains buffered push frames with `since_index` cursor, optional `wait_ms` blocking, and `max` page size; auto-subscribes to `**` on first call so no explicit subscribe is required
- `mcp_server.js` — `_pconnEnsureRegistered` helper: lazily hellos as `orchestrator / mcp-orchestrator` on the persistent socket (once per process lifetime) so publish/subscribe calls work without a prior `claws_hello`
- `schemas/mcp-tools.json` — added `claws_drain_events` tool schema

### L1.1 — Worker lifecycle events (landed)
- `mcp_server.js` — `runBlockingWorker` publishes `system.worker.spawned` (with `terminal_id`, `name`, `wrapped`, `started_at`) immediately after the terminal is created and `system.worker.completed` (with `terminal_id`, `status`, `duration_ms`, `marker_line`, `booted`) after the poll loop exits; guaranteed for both mission-mode and command-mode workers
- `mcp_server.js` — publishes go via the persistent socket registered as `orchestrator / mcp-orchestrator`; both are best-effort — failure is logged and the worker run continues unaffected

### L1.2 — Lazy .jsonl creation (landed)
- `extension/src/event-log.ts` — `EventLogWriter.openFreshSegment` defers `fs.openSync` until the first `doAppend` call; the segment file is only created when an event is actually written, eliminating empty `.jsonl` files at activation time
- `extension/src/event-log.ts` — `doAppend` performs a lazy open when `fdDeferred` is true; open errors set `degraded` and return gracefully
- `extension/src/event-log.ts` — `append` allows the deferred-open case through (changed guard from `fd === null` to `fd === null && !fdDeferred`)
- `extension/src/event-log.ts` — `tryRecoverFromManifest` handles missing segment files gracefully — if the file doesn't exist (lazy segment never written), it marks `fdDeferred = true` rather than falling back to a full scan
- `extension/src/event-log.ts` — `rotate` clears `fdDeferred` before `openFreshSegment` so rotation always starts with a clean deferred state

### L1.2 rotation regression fix (landed)
- `extension/src/event-log.ts` — `rotate()` now opens the new segment fd eagerly after `openFreshSegment()`; the lazy-open guarantee (no empty `.jsonl` at activation) applied only to the first segment; rotation fires inside `doAppend` so the file is already being written — deferring left `fd=null` which the post-rotate `fd === null` guard treated as degraded mode, returning `sequence=-1` for all subsequent appends; fix: open fd immediately in `rotate()` and clear `fdDeferred`

### L1.4 — Persist task.* + system.malformed.received events (landed)
- `extension/src/server.ts` — new `emitServerEvent(topic, payload)` private async helper: appends to the event log then fans out, mirroring the `publish` handler's persist-then-fanout contract for server-originated events
- `extension/src/server.ts` — all 6 server-side `fanOut` call-sites for `task.assigned.*`, `task.status`, `task.completed`, `task.cancel_requested.*`, and `system.malformed.received` replaced with `await this.emitServerEvent(...)` so these events are now durably persisted to `.claws/events/default/*.jsonl`
- `extension/src/server.ts` — degraded mode: if `eventLog.append` returns sequence -1 the sequence field is omitted from the push frame; on real I/O error the fanOut fires anyway (delivery preserved, persistence skipped)
- `extension/test/task-event-persist.test.js` — new regression test: boots extension, registers orchestrator + worker, drives assign → update → complete, asserts all 3 entries appear in the .jsonl with monotonically-increasing sequences

### L3 — Reverse channel hardening (landed)

#### L3.1 — Monotonic `seq` stamp in `[CLAWS_CMD]` broadcast text
- `extension/src/server.ts` — added `private broadcastSeq = 0` class field; broadcast handler increments it and rewrites text matching `[CLAWS_CMD ` to `[CLAWS_CMD seq=N ` before `writeInjected` and `pushFrame` calls; free-form broadcast text (no `[CLAWS_CMD` prefix) passes through unchanged; makes re-delivered commands idempotent — workers can track the highest seq seen
- `extension/test/broadcast-seq.test.js` — 6 regression checks: seq=1/2/3 inserted correctly on three consecutive broadcasts; free-form text unchanged; seq counter only advances for `[CLAWS_CMD` text

#### L3.2 — Worker auto-subscribe to `cmd.<peerId>.**` on hello
- `extension/src/server.ts` — hello handler now auto-registers a `cmd.${peerId}.**` subscription on the peer's socket when `role=worker`; uses the existing subscription-index mechanism so non-Template-8 workers get the reverse channel at the transport layer without an explicit `subscribe` call
- `extension/test/auto-subscribe-cmd.test.js` — 8 regression checks: worker receives `cmd.<peerId>.approve` push without explicit subscribe; deep wildcard `cmd.<peerId>.sub.nested` also delivered; observer role is NOT auto-subscribed

#### L3.1 test fix — `reverse-channel.test.js` updated for seq= prefix
- `extension/test/reverse-channel.test.js` — two legacy assertions compared injected/pushed text against the original `CMD_TEXT` literal; after L3.1 the server rewrites `[CLAWS_CMD ` to `[CLAWS_CMD seq=N `; switched both assertions to regex `CMD_TEXT_RE = /^\[CLAWS_CMD seq=\d+ r=r1\] approve_request/` — no behavior change, test now correctly validates the seq-stamped output

#### L3.4 — Backpressure on `socket.write` in `pushFrame`
- `extension/src/server.ts` — added `private readonly pausedPeers = new Set<string>()` and `private readonly droppedFrames = new Map<string, number>()`; `pushFrame` checks `socket.write()` return value — if `false`, marks peer as paused, logs `[claws/2] backpressure on push to <peerId>; pausing`, registers a one-shot `drain` listener; while paused, frames are silently dropped with a per-peer counter; drain clears the paused state and logs dropped count (warning if ≥ 100)
- `extension/test/pushframe-backpressure.test.js` — 9 regression checks: normal push arrives before backpressure; publish after subscriber disconnect returns ok (no crash); new subscriber receives pushes normally after prior peer disconnect; no crash logs; graceful disconnection log

### L2 — Lifecycle REFLECT → PLAN cycle reset (landed)
- `extension/src/lifecycle-store.ts` — `hasPlan()` now returns `false` when the current phase is `REFLECT`, closing the lifecycle gate after a completed cycle (was: always true once any plan was logged)
- `extension/src/lifecycle-store.ts` — `plan()` resets the cycle when called from `REFLECT` phase, starting cycle N+1 with fresh `phases_completed=['PLAN']` and the new plan text; idempotency still applies within any active (non-REFLECT) cycle
- `extension/src/server.ts` — `lifecycle.plan` handler sets `idempotent:false` when the previous phase was `REFLECT` (a cycle reset is not an idempotent no-op); `idempotent:true` only for mid-cycle duplicate calls
- `extension/test/lifecycle-reset.test.js` — 8 regression checks covering: gate-closes-at-REFLECT, plan-resets-cycle, phases_completed-reset, hasPlan-reopens, SPAWN-advances-after-reset, mid-cycle-idempotency-preserved, reflect-field-cleared

### L1.3 — Periodic system.heartbeat from the extension (landed)
- `extension/src/server-config.ts` — added `heartbeatIntervalMs` field (default 60 000 ms, 0 = disabled) to `ServerConfig` and `defaultServerConfig`; exported `DEFAULT_HEARTBEAT_INTERVAL_MS`
- `extension/src/server.ts` — new `private async emitSystemEvent(topic, payload)` helper: appends to the event log then fans out with the returned sequence; skips entirely when `eventLog.isDegraded` is true; errors are swallowed so timer failures never crash the extension
- `extension/src/server.ts` — `start()` schedules a `setInterval` after `bind()` resolves; reads `heartbeatIntervalMs` from `getConfig()` at schedule time; 0 = no timer created; stores timer in `private heartbeatTimer`
- `extension/src/server.ts` — `stop()` clears `heartbeatTimer` before closing the event log and socket
- `extension/src/event-log.ts` — added public `get isDegraded(): boolean` accessor so the server can gate heartbeat emissions without accessing a private field
- `extension/src/terminal-manager.ts` — added public `get terminalCount(): number` accessor so heartbeat payload can report the live terminal count without exposing the private `records` Map
- `extension/src/extension.ts` — `getConfig()` now reads `claws.heartbeatIntervalMs` from VS Code settings and passes it to the server
- `extension/package.json` — added `claws.heartbeatIntervalMs` configuration property (type: number, default: 60000, minimum: 0)
- `extension/test/heartbeat.test.js` — new regression test: boots extension with `heartbeatIntervalMs=200ms`, waits 700ms, asserts ≥2 `system.heartbeat` entries in the segment file and validates payload shape (uptimeMs, peers, terminals, from, ts_server, sequence)

### L1.5 — [CLAWS_PUB] line scanner for SDK-less worker publishing (landed)
- `mcp_server.js` — new `_scanAndPublishCLAWSPUB(newText, sockPath)` async helper: scans lines for `[CLAWS_PUB] topic=<topic> key=val ...` markers, parses key=value pairs (quoted strings, bare tokens, numeric, boolean coercion), and calls `_pconnEnsureRegistered` + `_pconnWrite` to publish on the worker's behalf; parse errors and publish failures are logged and never abort the worker run
- `mcp_server.js` — poll loop (step 6) in `runBlockingWorker` now tracks `pubScanOffset` across iterations; each tick slices `text.slice(scanStart)` (new bytes only) into `_scanAndPublishCLAWSPUB` and advances `pubScanOffset = text.length` so each pty line is scanned at most once
- Workers using Templates 1–7 can now emit bus events by printing a single line: `[CLAWS_PUB] topic=worker.<id>.phase kind=DEPLOY step=3` — no socket, SDK, peerId, or env-var injection required
- `extension/test/claws-pub-scanner.test.js` — 12 regression checks: source-level (function defined, MARKER_RE present, called in poll loop, pubScanOffset present, _pconnEnsureRegistered called) + behavioral (3 publishes from 3 markers, duplicate-scan no-re-publish, new-bytes-after-offset published, malformed lines skipped without throw, quoted values, boolean/numeric coercion, non-prefixed lines ignored)

### L4 — Bus correctness (landed)

#### L4.1 — `_pconnWrite` id field collision fix
- `mcp_server.js` — `_pconnWrite` now explicitly destructures and drops any user-supplied `id` before stamping the RPC correlation id (`const { id: _discarded, ...reqBody } = req`). No behaviour change for current callers (none set `id`) but makes the contract auditable and prevents silent misrouting for future stateful commands that use `id` as a routing field.

#### L4.2 — Sequence counter persistence across restarts
- `extension/src/event-log.ts` — `Manifest` interface gains `sequence_counter?: number`
- `extension/src/event-log.ts` — `writeManifest()` persists `sequence_counter: this.sequenceCounter` (the next value to issue) so the counter survives server restarts
- `extension/src/event-log.ts` — `tryRecoverFromManifest()` restores the counter with `+1` offset so the last issued sequence before crash is never re-issued; cost is one detectable gap per restart (acceptable)
- `extension/test/sequence-persist.test.js` — new regression test: writes 5 events, simulates restart with a fresh writer, writes 5 more; asserts second batch is ≥5, monotonically increasing, and spans at most one gap at the restart boundary

#### L4.3 — Peer disconnect fails orphaned tasks
- `extension/src/server.ts` — `handleDisconnect()` now walks `this.tasks` after removing the peer and fails any task whose `assignee === peerId` and `status` is `pending`, `running`, or `blocked`; sets `status='failed'`, `note='assignee disconnected'`, `updatedAt=Date.now()`
- `extension/src/server.ts` — each newly-failed task emits a `task.completed` event via `emitServerEvent` (best-effort, `.catch()` guards so disconnect never throws) so subscribers see the cancellation
- `extension/test/peer-disconnect-fails-tasks.test.js` — new regression test: registers orchestrator + worker, assigns 2 tasks, destroys the worker socket, asserts both tasks are `failed` in `task.list` and `task.completed` push frames fired for both

#### L4.4 — subscribe fromCursor (structural contract, full replay P1 for v0.7.6)
- `extension/src/protocol.ts` — `SubscribeRequest` gains optional `fromCursor?: string` field with inline doc describing the cursor format and the v0.7.6 TODO
- `extension/src/server.ts` — subscribe handler accepts `fromCursor`; logs `[claws/2] fromCursor replay not yet implemented` and continues with live delivery when the field is present; full replay (read event log from cursor, push matching events before live) deferred to v0.7.6 (P1)

### L1.4–L3 (previously landed — see entries above)
Fleet of layered fixes ordered root-up: L0 capture (push frames captured, `claws_drain_events` MCP tool), L1 production (`system.worker.spawned/completed`, lazy `.jsonl`, heartbeat, task event persistence, `[CLAWS_PUB]` line scanner), L2 lifecycle (REFLECT-reset cycle), L3 reverse-channel hardening (idempotent re-delivery, ACK protocol, backpressure), L4 bus correctness (sequence persistence, peer reconnect, replay).

## [0.7.4] - 2026-04-29 — Bulletproof regression fix release

This release closes 50 findings surfaced by a 4-worker parallel audit of the v0.7.2 + v0.7.3 release cycle. After the user reported lifecycle breakage on `/claws-update`, we ran a full Plan→Implement→Review→Audit→Test→Fix→Repeat loop across 5 layers to deliver one bulletproof codebase that absorbs all in-flight unmerged work (γ.1 reverse channel, γ.2 event log core, MCP persistent socket fix) plus 50 regression fixes.

### CRITICAL — confirmed data-loss prevention
- **M-01** `install.sh` awk strip — anchored to Claws-marked block + timestamped dotfile backup before any modification
- **M-02** `.mcp.json` silent reset — JSONC-tolerant safe-merge with abort-on-error; never wipes other MCP servers
- **M-03** `~/.claude/settings.json` silent reset — JSONC-tolerant safe-merge; never wipes user's Claude Code config
- **M-38** `inject-settings-hooks.js` non-atomic write — atomic write via L0 helpers
- **M-39** `cli.js` MCP fallback non-atomic write — atomic write via L0 helpers

### HIGH — silent lifecycle breaks
- **M-04** Hook silent skip → forensic log (`/tmp/claws-hook-misfire.log` + stderr)
- **M-05** Rosetta arch silent miscompile → auto-correct to arm64 (not x64)
- **M-06** Stale-extension cleanup race → gate on `[ -d "$kept_dir" ]` before iterating
- **M-07** `spawnSync` null-status (signal-killed rebuild) → explicit `result.status === null` detection + helpful error
- **M-08** No rebuild timeout → 5-minute ceiling + SIGTERM detection
- **M-09** Hooks dir wipe-then-copy non-atomic → atomic `copyDirAtomic` via L0 helper
- **M-10** Health check 2s timeout → 8s + 3-attempt exponential backoff (8s/12s/16s)
- **M-11** `mcp_server.js` orphan → SIGKILL escalation 500ms after SIGTERM + socket-unlink verify
- **M-31** `fix.sh` `@electron/rebuild` no timeout → mirrored from M-08 (recovery path hardening)
- **M-36** `rebuild-node-pty.sh` no timeout + no TERM_PROGRAM detection → mirrored trifecta
- **M-44** `fix.sh` stale Content-Length framing → newline-delimited frames (MCP check was always false-failing)
- **M-45** `fix.sh` `.mcp.json` repair silent-reset-to-`{}` → safe-merge + atomic write + env-var path (recovery path)

### MEDIUM/LOW (M-12 to M-50 not listed above)
50 total findings — see `.local/audits/regression-master-issues.md` for the complete catalog.

### Foundation utilities (Layer 0)
- `scripts/_helpers/json-safe.mjs` — JSONC parse + safe-merge + abort-on-error; used across install/update/fix/inject paths
- `scripts/_helpers/atomic-file.mjs` — rename-pattern atomic file/dir ops with fsync; used for all config writes

### Test coverage
- 224 baseline → 501 PASS (+277 regression checks across ~40 new test files)
- Every M-XX finding has a regression test that exercises its failure mode

### Includes (rolled forward from open PRs)
- γ.1 reverse channel (was PR #27)
- γ.2 event log core (was PR #28)
- MCP persistent socket fix (was PR #29)

---

## [0.7.4-bulletproof-L4-fix] - 2026-04-29 — Layer 4 fix: code-review findings + audit items (F1–F7, M-44–M-50)

### Fixed

- **F1** `scripts/update.sh` M-10 retry loop: added `_claws_attempt` counter; emits `note "MCP handshake timeout — retry N of 3 (Nms)..."` between attempts so the operator knows progress during the silent ~38s retry window.
- **F4** `extension/src/extension.ts` M-41 `runRebuildPty()`: killTimer now sends SIGTERM first, then SIGKILL after 5s grace, matching the recipe pattern from M-11. Previously sent SIGKILL directly. Regression test: `extension-rebuild-pty-timeout.test.js` updated (SIGTERM-before-SIGKILL check added).
- **F2** `scripts/install.sh`: `inject-global-claude-md.js` now gated on `GIT_PULL_OK` — mirrors the project-level CLAUDE.md gate; avoids rewriting machine-wide policy from stale source when git pull failed. Emits skip note on GIT_PULL_OK=0.
- **F3** `extension/test/update-step6-orphan.test.sh`: added test 5 — behavioral check that a Unix socket server has no active listener after SIGTERM+SIGKILL sequence (process is gone, no orphan socket-holder).
- **F6** `extension/src/extension.ts` plutil candidate loop: added JSDoc noting 4 candidates × 3s timeout = 12s worst-case synchronous block; acceptable for explicit user-triggered rebuild command.
- **F7** `extension/src/event-log.ts` `writeManifest()`: migrated from `writeFileSync` to `openSync+writeSync+fsyncSync+closeSync+renameSync` — mirrors M-29/M-43 fsync-before-rename pattern; manifest survives power-cut or SIGKILL after write.
- **F5** `scripts/inject-settings-hooks.js`: added `withLock()` helper using `fs.openSync(lockPath, 'wx')` exclusive create with 15-attempt/100ms backoff; all three `mergeIntoFile` call sites (REMOVE, UPDATE, add-mode) wrapped — prevents concurrent `install.sh`+`update.sh` invocations from tearing settings.json. Fixed: removed stale `|| attempt === 2` early-throw that caused EEXIST on retry 2 to propagate (leftover from old 3-attempt loop). Regression test: `inject-settings-exclusive-lock.test.js` (6 checks).
- **M-44** `scripts/fix.sh` MCP handshake: replaced Content-Length framing (stale LSP protocol) with `mcp.stdin.write(req + '\n')` — matches mcp_server.js's newline-delimited JSON protocol. Added full `protocolVersion`+`clientInfo` to initialize params. Regression test: `fix-mcp-handshake.test.sh` (5 checks).
- **M-50** `mcp_server.js` `_pconnConnect()`: added `sock.setTimeout(5000)` + `on('timeout', destroy)` — prevents the persistent socket connect phase from hanging forever when VS Code is reloading and the socket is transiently unreachable. `setTimeout(0)` clears the timer once the connection succeeds. Regression test: `mcp-pconn-timeout.test.js` (5 checks).
- **M-49** `scripts/install.sh` `EXPECTED_MIN_VERSION`: bumped from `0.5.7` → `0.7.4` — was stale, causing stale-clone warnings to fire against fully-up-to-date clones at v0.7.4.
- **M-47** `scripts/update.sh` `.mcp.json` sanity check: path now passed via `CLAWS_MCP_CHECK` env var instead of string-interpolation into `node -e` — handles project roots with apostrophes/backslashes without JS syntax errors (mirrors M-20 socket-probe fix). Regression test: `update-mcp-path-quoting.test.sh` (5 checks).
- **M-45+M-46** `scripts/fix.sh` + `scripts/_helpers/fix-repair.js` (new): `.mcp.json` and `.vscode/extensions.json` repair now use `fix-repair.js` which calls `mergeIntoFile` from `json-safe.mjs` — atomic write, abort-on-malformed (never silently resets to `{}`), JSONC-tolerant, path via `CLAWS_REPAIR_TARGET` env var (no injection). Regression test: `fix-mcp-repair.test.sh` (10 checks).

## [0.7.4-bulletproof-L4] - 2026-04-29 — Layer 4: update.sh + extension.ts hardening (M-10, M-11, M-18, M-19, M-20, M-21, M-41, M-42, M-43)

### Fixed

- **M-10** `scripts/update.sh` Step 6 health check: bumped timeout from 2000ms to 8s; added 3-attempt retry loop with exponential timeout series (8s, 12s, 16s) so loaded machines don't see false-positive YELLOW on slow startup. YELLOW only declared after all three attempts fail.
- **M-11** `scripts/update.sh` Step 6 health check: SIGKILL escalation 500ms after SIGTERM — mcp_server.js child is force-killed if SIGTERM is not handled quickly, preventing orphaned socket fd holding the project socket open. mcp_server.js path passed via `CLAWS_MCP_PATH` env var (no embedded path injection). Regression test: `update-step6-orphan.test.sh` (4 checks, includes behavioral SIGTERM-ignore mock).
- **M-19** `scripts/update.sh`: `CLAWS_LOG` now defined and exported before `install.sh` runs, so Step 6 warning "see install log: $CLAWS_LOG" references the actual log path written by install.sh. install.sh inherits via `${CLAWS_LOG:-...}`. Regression test: `update-claws-log.test.sh` (6 checks).
- **M-20** `scripts/update.sh` socket probe: project root path passed via `CLAWS_PROBE_PATH` env var instead of string-interpolation into `node -e` — handles project paths containing apostrophes/backslashes without JS syntax errors. Regression test: `update-probe-path-quoting.test.sh` (5 checks, includes behavioral apostrophe + backslash path tests).
- **M-21** `scripts/update.sh` + `scripts/install.sh`: `GIT_PULL_OK` flag exported on git pull failure; `install.sh` skips `inject-claude-md.js` when `GIT_PULL_OK=0` — avoids rewriting CLAUDE.md tool-set from stale source. Regression test: `update-git-pull-fail.test.sh` (8 checks, behavioral GIT_PULL_OK=0 and GIT_PULL_OK=1 paths).
- **M-18** `scripts/inject-settings-hooks.js` + `scripts/install.sh`: added `--update` mode that removes old Claws hooks and adds new ones in a single atomic `mergeIntoFile` call. `install.sh` now calls `inject-settings-hooks.js --update` instead of two-pass `--remove` + add, eliminating the kill-window where settings.json has zero Claws hooks. Regression test: `update-atomic-hooks.test.sh` (7 checks, behavioral update preserves non-Claws hooks).
- **M-41** `extension/src/extension.ts` `runRebuildPty()`: added 5-minute SIGKILL timer (`setTimeout → proc.kill('SIGKILL')`) to prevent hung `@electron/rebuild` invocations from freezing VS Code indefinitely. Timer cleared on normal exit. Regression test: `extension-rebuild-pty-timeout.test.js` (6 checks).
- **M-42** `extension/src/extension.ts` `execFileSync('plutil', ...)`: added `{ timeout: 3000 }` to prevent synchronous Electron-version detection from blocking the VS Code extension host on network-mounted `/Applications`. Regression test: `extension-plutil-timeout.test.js` (5 checks).
- **M-43** `extension/src/lifecycle-store.ts` `flushToDisk()`: migrated from `writeFileSync` to `openSync+writeSync+fsyncSync+closeSync+renameSync` pattern — mirrors the M-29 hooks-side fix for parity; ensures lifecycle state survives power-cut or SIGKILL after write but before kernel flush. Regression test: `lifecycle-store-fsync.test.js` (7 checks, behavioral compile+run verification).

## [0.7.4-bulletproof-L3-fix] - 2026-04-29 — Layer 3 fix: code-review findings F1+F2+F3

### Fixed

- **F1** `scripts/inject-settings-hooks.js` `isCanonicalInstall()`: now checks both `CLAWS_BIN/hooks/` directory presence AND individual script file existence before emitting bare `node "<path>"`. Previously, a hooks/ dir with missing scripts would produce a `node` invocation that exits non-zero (MODULE_NOT_FOUND), breaking the SAFETY CONTRACT. Falls through to the wrapped `sh -c` misfire-log form instead. [L3.11]
- **F2** `scripts/inject-settings-hooks.js` M-14 comment: corrected to accurately state that `_source === 'claws'` already prevented non-Claws hooks from being matched before M-14; M-14's actual improvement is replacing substring `command.includes(scriptName)` with exact-command equality, making the "already current" vs "stale, upgrade in-place" distinction unambiguous. [L3.12]
- **F3** `scripts/inject-settings-hooks.js` `hookCmd()` non-canonical form: misfire message now also written to stderr (`>&2`) alongside `/tmp/claws-hook-misfire.log` (with `2>/dev/null`). When `/tmp` is unwritable, the message still reaches stderr for forensics while `exit 0` preserves the SAFETY CONTRACT. [L3.13]

## [0.7.4-bulletproof-L3] - 2026-04-29 — Layer 3: hooks + settings.json hardening (M-03, M-04, M-12, M-13, M-14, M-15, M-16, M-24, M-38, M-39)

### Fixed

- **M-03/M-38** `scripts/inject-settings-hooks.js`: replaced `loadSettings()` try/catch-reset-to-`{}` + `fs.writeFileSync` with async `mergeIntoFile()` from `scripts/_helpers/json-safe.mjs`. On malformed JSON: backup created, original untouched, exits non-zero. Never silently wipes user's entire Claude Code config.
- **M-39** `cli.js` MCP fallback: replaced `JSON.parse + writeFileSync` with inline ESM `mergeIntoFile()` call via `spawnSync --input-type=module`. Same atomic + JSONC-tolerant + abort-on-malformed guarantees.
- **M-04** `scripts/inject-settings-hooks.js` `hookCmd()`: missing hook path now appends to `/tmp/claws-hook-misfire.log` with timestamp + path instead of silently exiting 0 with no trace. [L3.2]
- **M-12** `scripts/inject-settings-hooks.js` `hookCmd()`: replaced `[ -f "$0" ] && exec node "$0" || (...)` with explicit `if [ -f "$0" ]; then exec node "$0"; else ...; fi` — `else` branch is reachable even if `exec` fails for unusual reasons (applies to non-canonical paths; canonical paths use direct node per M-15). [L3.3]
- **M-13** `scripts/hooks/{session-start,pre-tool-use,stop}-claws.js`: stdin 'data' and 'end' listeners now registered in a single try block; added 5-second `setTimeout(...).unref()` safety timer so hooks can never hang the parent process. [L3.4]
- **M-14** `scripts/inject-settings-hooks.js` dedup: replaced `command.includes(scriptName)` with exact-command equality + `_source === 'claws'` guard — prevents overwriting non-Claws hooks whose command happens to contain a Claws script name as substring. [L3.5]
- **M-15** `scripts/inject-settings-hooks.js` `hookCmd()`: when `CLAWS_BIN/hooks/` directory exists (canonical install), registers hooks as direct `node "<path>"` invocations (skips the `sh -c` wrapper) — reduces fork overhead on each hook invocation. [L3.6]
- **M-16** `scripts/hooks/pre-tool-use-claws.js` STRICT deny: all `process.stdout.write` calls now end with `\n` so Claude Code's hook protocol parser flushes correctly. [L3.7]
- **M-24** `scripts/hooks/{session-start,pre-tool-use,stop}-claws.js`: `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers gated on `!process.env.CLAWS_DEBUG` — when `CLAWS_DEBUG=1`, errors propagate visibly for debugging. [L3.8]

## [0.7.4-bulletproof-L2-fix] - 2026-04-29 — Layer 2 fix: code-review findings F1+F5 (error-path + env-var path passing)

### Fixed

- **F1** `scripts/install.sh` M-09 + M-02 heredoc blocks: wrapped each `node --input-type=module` heredoc with `set +e` / capture `_exit=$?` / `set -e` so the `die`/`warn` call fires before the shell aborts. Under `set -eo pipefail`, `if [ $? -ne 0 ]` after a heredoc is dead code — the shell terminates at the heredoc line when node exits non-zero.
- **F5** `scripts/install.sh` M-02 block: switched from shell-expanded string literals (`'${PROJECT_MCP}'`) to `process.env.X` for all user-controlled paths. Also changed static `import ... from '...'` to `await import(process.env.INSTALL_DIR + '...')` to avoid JS SyntaxError when any path component contains a single-quote or backslash.
- **F5 test** `extension/test/install-mcp-merge.test.sh`: added apostrophe path test (creates a project dir named `user's-project`, runs M-02 merge via env vars, asserts claws entry written).
- **F1 test** `extension/test/install-error-path.test.sh` (9 checks): static checks that `_hooks_exit` and `_mcp_exit` capture patterns are present; behavioral harness proving the message fires before set-e exit.
- **F2** `extension/test/install-hooks-atomic.test.sh`: replaced polling simulation (1ms interval checks) with a real SIGKILL mid-copy test. Spawns `copyDirAtomic` in a subprocess, sends SIGKILL after 5ms (during the 100-file step-1 copy phase), then asserts dest has either complete OLD content or complete NEW content — never an empty dir or a partial mix.
- **F3** `scripts/inject-claude-md.js`, `scripts/inject-global-claude-md.js`, `scripts/hooks/lifecycle-state.js`, `extension/src/uninstall-cleanup.ts`: replaced `writeFileSync(tmp)` with `openSync(tmp, 'w') → writeSync → fsyncSync → closeSync` in all four inline `writeAtomic` helpers. Adds durability for power-cut scenarios where the OS page cache hasn't been flushed — mirrors the `fd.sync()` call that `scripts/_helpers/atomic-file.mjs` (L0) already does in its async variant.
- **F4** `scripts/install.sh inject_hook`: fixed orphaned-marker edge case. Previous awk `skip { skip=0; next }` stripped the marker AND whatever line followed it, even if the user had manually removed the source line. New pattern: `skip && /source.*shell-hook\.sh/ { skip=0; next }; skip { skip=0; print }` — only strips the following line when it IS the Claws source line; preserves it otherwise. Added F4 orphaned-marker test to `install-awk-anchor.test.sh` (+4 checks, +1 static → 20 total).
- **F6** `CHANGELOG.md`: added missing `[2c99bda]` commit hash to M-28 entry.
- **M-40** `extension/scripts/bundle-native.mjs`: replaced `resetNativeDest()` (wipe-then-copy) with `setupStagingDir()` + atomic rename pattern in `copyRuntimeSlice()`. Files now copy into `NATIVE_DEST.claws-new`, then `rename(NATIVE_DEST → .claws-old)` + `rename(staging → NATIVE_DEST)` + cleanup. Kill during file copy leaves old NATIVE_DEST intact; kill after rename leaves new NATIVE_DEST intact — never an empty dir. `extension/test/bundle-native-copy-atomic.test.js` (10 checks): static pattern verification + behavioral atomic-rename simulation + kill-before-rename invariant.

## [0.7.4-bulletproof-L2] - 2026-04-29 — Layer 2: install.sh data-loss + atomicity fixes (M-01, M-02, M-09, M-17, M-27–M-30)

### Fixed

- **M-01** `scripts/install.sh inject_hook`: removed generic `/source .../shell-hook\.sh/` awk regex that stripped non-Claws tool hooks (oh-my-zsh, asdf, custom dotfiles). awk now strips ONLY lines inside a `# CLAWS terminal hook` marked block. Added timestamped dotfile backup (`$rcfile.claws-bak.<ISO-ts>`) before any modification. [ac1661a]
- **M-02** `scripts/install.sh` `.mcp.json` merge: replaced `try{}catch{}` reset-to-`{}` pattern with `mergeIntoFile()` from `scripts/_helpers/json-safe.mjs`. On parse failure: backup created, original untouched, install.sh exits non-zero with actionable message. Never silently wipes other MCP servers. [cbb447e]
- **M-09** `scripts/install.sh` `.claws-bin/hooks/` copy: replaced `rm -rf + cp` with atomic rename pattern via `copyDirAtomic()` from `scripts/_helpers/atomic-file.mjs`. Kill-window now leaves either full old hooks or full new hooks — never an empty dir. [df0b224]
- **M-17** `scripts/install.sh inject_hook`: fixed awk empty-file edge case. [aa488da] When `.zshrc` contains ONLY the Claws block, awk output is empty; the old `[ -s "$tmp" ]` guard prevented promotion, leaving original intact and causing duplicate blocks on next install. Now always promotes awk output when awk succeeds.
- **M-27** `scripts/inject-claude-md.js`: replaced `fs.writeFileSync` with atomic write pattern (tmp + rename) — prevents partial project `CLAUDE.md` on kill mid-write. [2c99bda]
- **M-28** `scripts/inject-global-claude-md.js`: same atomic write for `~/.claude/CLAUDE.md` — machine-wide config corruption on power-cut prevented. [2c99bda]
- **M-29** `scripts/hooks/lifecycle-state.js writeState()`: replaced `fs.writeFileSync` with atomic tmp+rename pattern — mirrors `extension/src/lifecycle-store.ts` which was already atomic. Prevents partial lifecycle-state.json on hook kill. [9696ecb]
- **M-30** `extension/src/uninstall-cleanup.ts`: replaced both `writeFileSync` calls (`.mcp.json` edit-json + CLAUDE.md edit-markdown) with inline atomic write pattern — partially-uninstalled state no longer possible on kill mid-write.

## [0.7.4-bulletproof-L1-fix] - 2026-04-29 — Layer 1 fix: code-review + similar-bug findings (F1+F2, F3+F4, M-31–M-37)

### Changed

- **F1** `bundle-native.mjs detectElectronVersion()` darwin sort: removed redundant `(tp === 'vscode' && c.key === 'vscode')` sub-expression — semantically identical to `c.key === tp` when `tp==='vscode'`. Now matches the simpler Linux branch form.
- **F2** `install.sh` ABI detection darwin block: replaced `eval "set -- $_claws_darwin_apps"` with bash array (`declare`-compatible `case` + `for` loop) — eliminates eval footgun that would become shell injection if `$_tp` were ever interpolated into the string literal.
- **F3** `extension/test/update-socket-probe.test.js`: replaced regular-file fixture with a real Unix domain socket (server binds, stays open but never responds, probe times out). Faithfully replicates an unresponsive Claws server; satisfies `[ -S ]` check. Server closed in `finally` block post-assertion.
- **F4** `bundle-native.mjs detectElectronVersion()`: added `cursorChannel` (`$CURSOR_CHANNEL`) secondary signal — when `TERM_PROGRAM=vscode` but `CURSOR_CHANNEL` is set (Cursor-specific env), promotes Cursor candidates over VS Code. Covers old Cursor builds that pre-date `TERM_PROGRAM=cursor`. Injected as parameter for testability; test 9 added.
- **M-31** `scripts/fix.sh` `@electron/rebuild` block: wrapped with `timeout 300` / `gtimeout 300` (5-minute ceiling). Exit code 124 → user-actionable "slow Electron headers download" message. Prevents indefinite hang on captive portals.
- **M-36** `scripts/rebuild-node-pty.sh` rebuild step: same timeout pattern as M-31. Exits 1 on timeout with network/proxy hint.
- **M-32** `scripts/fix.sh` ABI detection: TERM_PROGRAM-aware darwin loop (bash array, same F2 pattern); CURSOR_CHANNEL secondary signal for old Cursor builds.
- **M-33** `scripts/fix.sh` ABI detection: Linux Cursor (`/usr/share/cursor/electron`, `/opt/cursor/electron`) + Windsurf paths added; TERM_PROGRAM-ordered.
- **M-36 (editor detect)** `scripts/rebuild-node-pty.sh` detection: TERM_PROGRAM-aware darwin ordering + CURSOR_CHANNEL + Linux Cursor/Windsurf paths.
- **M-34** `scripts/install.sh` arch verify: when bash runs under Rosetta 2 (`uname -m=x86_64` on Apple Silicon), `sysctl.proc_translated` is checked and the expected arch is promoted to `arm64`. Prevents false "pty.node arch mismatch" warning after M-05 build.
- **M-35** `scripts/update.sh` Step 6 ABI check: TERM_PROGRAM-aware darwin ordering for editor detection (cursor/windsurf/default). CURSOR_CHANNEL secondary signal included.
- **M-37** `claws-sdk.js ClawsSDK.connect()`: `sock.setTimeout(5000)` — when the socket file exists but the server doesn't respond within 5s, `sock.destroy(err)` fires with a `/claws-fix` hint. `sock.setTimeout(0)` on connect prevents false fires during normal use.
- **M-37** `claws-sdk.js ClawsSDK._send()`: per-request `timeoutMs` (default 10s) via `setTimeout`/`clearTimeout` — rejects and cleans up the `_pending` Map entry if no response arrives. Prevents unbounded Map growth when the extension is reloading.

## [0.7.4-bulletproof-L1] - 2026-04-29 — Layer 1: ABI/native-bundle fixes (M-05, M-06, M-07, M-08, M-22, M-23, M-25, M-26)

### Fixed

- **M-05** `bundle-native.mjs detectTargetArch()`: Rosetta 2 detection now returns `'arm64'` instead of warning-only. Prevents x64 pty.node being shipped for arm64 VS Code/Cursor.
- **M-07** `bundle-native.mjs runElectronRebuild()`: explicit `result.status === null` check catches signal-killed rebuilds that previously silently passed. `spawnFn`/`failFn` injectable for testability.
- **M-08** `bundle-native.mjs runElectronRebuild()`: 5-minute `spawnSync` timeout (`timeout: 5*60*1000`) prevents indefinite hang on slow Electron headers fetch; SIGTERM → network/proxy hint message.
- **M-22** Editor detection prefers `$TERM_PROGRAM` env (vscode|cursor|windsurf) so the current-shell's editor wins over hardcoded path order. Applied in both `bundle-native.mjs` and `install.sh` ABI drift block.
- **M-23** When Electron version detection returns empty, emits explicit warning recommending `CLAWS_ELECTRON_VERSION` env override.
- **M-25** Linux Cursor/Windsurf install paths added to ABI detection candidates (`/usr/share/cursor/electron`, `/opt/cursor/electron`, `/usr/share/windsurf/electron`, `/opt/windsurf/electron`).
- **M-26** `update.sh` socket probe is now health-check only — never deletes socket on failed probe (races with VS Code hot-reload); defers destructive cleanup to user-explicit `/claws-fix` with actionable hint.
- **M-06** `install.sh` stale-extension cleanup loop gated on `[ -d "$kept_dir" ]`; skips with warning if just-installed directory has not yet extracted (VS Code async VSIX extraction), preventing total extension loss race.

## [0.7.4-bulletproof] - 2026-04-29 — Layer 0: shared helpers (M-02, M-03, M-01, M-09 foundation)

### Added

- `scripts/_helpers/json-safe.mjs` — JSONC-tolerant parse + `mergeIntoFile` that aborts on parse error (never silently resets to `{}`). Supports `//` line comments, `/* block comments */`, and trailing commas. Foundation for M-02 (`.mcp.json` wipe) and M-03 (`settings.json` wipe) fixes.
- `scripts/_helpers/atomic-file.mjs` — rename-pattern atomic write/dir-copy + `backupFile`. Foundation for M-01 (dotfile backup) and M-09 (hooks copy atomicity) fixes. Per-call nonce on tmp filenames ensures correctness under concurrent invocations. `@throws {Error}` documented for ENOENT on `backupFile` (F5).
- `json-safe.mjs` review fixes: `/* block comments */` stripped (F3), pid+nonce tmp suffix (F1), fsync before rename (F2).
- `atomic-file.test.js` test 3 strengthened: asserts all 10 concurrent writes succeed with `Promise.allSettled` + exact content match (F4).

## [0.7.4] - 2026-04-28 — Phase γ (reverse channel + event log) + MCP socket fix

This release integrates Phase γ (γ.1 reverse channel + γ.2 persistent event log)
and fixes a high-severity architectural bug in `mcp_server.js` that made all
stateful claws/2 MCP flows fail silently.

### Fixed (CRITICAL — issue 09)

- **`mcp_server.js` now maintains a single persistent socket** for stateful
  claws/2 commands (`claws_hello`, `claws_subscribe`, `claws_publish`,
  `claws_broadcast`, `claws_peers`). Previously each MCP tool call opened a
  fresh socket, sent one frame, and destroyed it. The claws/2 protocol binds
  peer state to a single connection; hello on socket A registered a peer and
  closed; publish on socket B had no peer and returned "call hello first".
  Stateless claws/1 commands (`list`, `create`, `send`, `close`, `readLog`,
  `poll`, `exec`, `lifecycle.*`) continue to use per-call sockets.
  Fix: module-level `_pconn` object with `_pconnEnsure()` / `_pconnWrite()` /
  `clawsRpcStateful()`. Auto-reconnects on socket close; re-issues hello if a
  prior identity was cached.

### Added (Phase γ.1 — reverse channel, integrated from branch)

- **`[CLAWS_CMD]` reverse channel**: orchestrator can broadcast a command token
  into every worker's terminal via `{ inject: true }` on `claws_broadcast`.
  Extension writes the text directly into the pty using `writeInjected()` with
  bracketed paste. Worker skill (`/claws-streaming-worker`) scans its log for
  the `[CLAWS_CMD]` prefix and routes to a named handler. Slash command
  `/claws-broadcast` exposes the pattern. Integration test: `reverse-channel.test.js`
  (12 checks). Commits: `80893ab`, `36bfece`, `d9c883a`, `4c434f9`.

### Added (Phase γ.2 — persistent event log, integrated from branch)

- **Append-only event log** (`EventLogWriter` in `extension/src/event-log.ts`).
  Every `publish` call is durably written to `.claws/events/default/*.jsonl`
  before fan-out. Segment rotation on size (10 MB) and age (1 hour). Atomic
  manifest updates (`manifest.json`) for crash recovery. Sequence counter
  monotonically increasing across segment boundaries. 15-check test suite:
  `event-log.test.js`. Commits: `37acac1`, `0150572`, `f16f399`.

### Tests

- New: `extension/test/mcp-publish-flow.test.js` — spawns `mcp_server.js` as
  a child process, calls `claws_hello` + `claws_publish` via MCP JSON-RPC,
  asserts ok:true and event record on disk. Guards issue 09 regression.
  Added `test:mcp-publish-flow` script and wired into `npm test`.
- Suite total: 224 checks across 21 suites (was 219 across 20).

### Version markers

- `extension/package.json` → 0.7.4
- `package.json` (root CLI) → 0.7.4
- `mcp_server.js` serverInfo → 0.7.4
- `claws-sdk.js` VERSION → 0.7.4

## [0.7.3] - 2026-04-28 — Bulletproof `/claws-update`

User-reported breakage on a real upgrade: `/claws-update` ran cleanly but
left MCP unable to connect. VS Code reload didn't fix it; running the
installer again in the same project didn't fix it. Root cause was an
Electron-ABI rebuild gap that none of the existing checks covered, plus
a blunt socket-cleanup that destroyed live state.

This release reworks `update.sh`, `install.sh`, and `fix.sh` so a future
`/claws-update` can never produce the same broken state. See
`.local/audits/update-sh-deep-audit.md` for the full bug catalog.

### Fixed (CRITICAL — caused the user-reported breakage)

- **Electron-ABI mismatch is now auto-detected** (`scripts/install.sh`).
  Previously, `needs_rebuild_native` only triggered if the binary was
  missing, the user passed `CLAWS_FORCE_REBUILD_NPTY=1`, or the git SHA
  changed. If the user updated VS Code to a newer Electron version while
  Claws was already installed, install.sh saw the binary present, the
  SHA unchanged, and **skipped the rebuild** — the bundled `pty.node`
  was now ABI-mismatched, the extension silently fell into pipe-mode,
  and wrapped terminals (the entire MCP-driven workflow) broke. Fix:
  read `electronVersion` from `extension/native/.metadata.json`,
  compare against the currently-installed editor's Electron version,
  force a rebuild on mismatch. macOS via `plutil` on Electron Framework
  Info.plist; Linux via `electron --version` from common install paths.
  Audit finding #1.

- **`/claws-fix` now propagates the rebuilt `pty.node` to every installed
  extension dir** (`scripts/fix.sh`). Previously, fix.sh rebuilt
  node-pty in `~/.claws-src/extension/node_modules/node-pty/` but VS Code
  loads the extension from `~/.vscode/extensions/neunaha.claws-X.Y.Z/native/`
  — a different copy. So the rebuild had no visible effect after reload.
  Fix: copy the freshly-built pty.node into the source's `native/`
  bundle AND into every `~/.{vscode,vscode-insiders,cursor,windsurf}/extensions/neunaha.claws-*/native/...`
  directory, then update `native/.metadata.json` so future ABI checks
  see the new version. Audit finding #3.

### Fixed (HIGH)

- **Safe socket cleanup in `update.sh`** (`scripts/update.sh:86`).
  Previously: `find -name claws.sock -mtime +1 -delete`. If the user
  kept VS Code open for >24 hours, the live socket file's mtime was
  stale and `update.sh` deleted it. The running extension still held
  the socket fd internally, but the path was gone — every subsequent
  MCP child process got `ENOENT`. Replaced with a Node-based connect
  probe: only delete the socket if it fails a 800ms `list` ping.
  Live sockets are preserved. Audit finding #2.

- **Visible `git pull` failure in `update.sh`**. The previous version
  treated "no changes" and "git pull failed" identically (same dim
  `note()` output). On network errors / dirty source / merge conflicts,
  the user proceeded silently with stale source. Now: distinguishes
  the two cases, prints the actual git error, and warns when running
  install.sh against a stale local clone. Audit finding #5.

### Added

- **Post-update health check in `update.sh`** (Step 6). After install.sh
  returns, verifies pty.node ABI parity, `.mcp.json` JSON validity, and
  MCP server `initialize` handshake. If any check fails, prints a yellow
  WARNING banner with concrete recovery steps before the success line.
  Stops the user from being surprised an hour later. Audit finding #4.

### Fixed (CRITICAL — "solve hook errors forever" — three-layer fix)

User-reported recurring class of failure: `SessionStart:startup hook
error / Failed with non-blocking status code: file:///.../hooks/X.js:14`
on every Bash tool call. Three distinct trigger paths, each closed:

- **Layer 1 — Hook scripts can never crash.** All three hook scripts
  (`session-start-claws.js`, `pre-tool-use-claws.js`, `stop-claws.js`)
  now have `process.on('uncaughtException')` + `unhandledRejection`
  handlers registered as the first executable lines, plus full
  try/catch wrapping around the body, plus lazy-require for any
  cross-script deps (`stop-claws.js`'s `lifecycle-state` module). Any
  internal error → silent `process.exit(0)`. Garbage stdin, missing
  deps, ESM-loader confusion — all become no-ops instead of visible
  errors. Verified: `printf garbage | node hook.js` → exit 0 for all
  three hooks.

- **Layer 2 — Missing hook paths silent-skip instead of erroring.**
  `inject-settings-hooks.js` now registers each hook command as
  `sh -c '[ -f "$0" ] && exec node "$0" || exit 0' "<scriptPath>"`
  instead of plain `node "<scriptPath>"`. If the path 404s (install
  dir moved, sandbox path leaked, prior install removed), the
  shell sees no file and exits 0 silently. Claude Code never
  surfaces the error. Path-existence is checked at every tool call,
  zero perf cost (sh + test). The injector's `alreadyPresent`
  detection now also recognises and replaces old plain-format
  entries on upgrade — no duplicate accumulation.

- **Layer 3 — `/claws-fix` auto-heals stale hook registrations.**
  Two new checks added to `scripts/fix.sh`:
  - "Hook script paths in `~/.claude/settings.json`" — extracts the
    `.js` path from each Claws hook command (whether wrapped or
    plain), tests `fs.existsSync`, lists any 404s, and re-runs
    `inject-settings-hooks.js --remove + add` to re-register from
    the current install dir. Self-healing.
  - "Hook scripts execute cleanly" — invokes each registered hook
    with synthetic stdin under a Node-based 5s timeout (replaces
    macOS-incompatible `timeout` cmd), and reports any non-zero
    exit. Surfaces pre-v0.7.3 hook scripts that don't have the
    safety wrappers.

  Together: any recurrence of the hook-error class is auto-detected
  and auto-repaired by the next `/claws-fix` run.

This closes a recurring failure class that has bitten users since
the Claws hook chain shipped in v0.6.x.

## [0.7.2] - 2026-04-28 — Audit-driven hardening

User-reported regression on a real ESM project (`/Users/miles/dev/tokenomic/`)
plus the consolidated findings of the four-worker codebase audit
(`.local/audits/audit-{1,2,3,4}-*.md`). Net effect of this release:

- Hooks no longer crash in modern Node/TypeScript projects whose root
  `package.json` declares `"type": "module"`.
- Stale shell-rc source lines from prior installs are reliably cleaned even
  on macOS Monterey (BSD sed pre-Ventura) and on every Linux.
- Files removed from `scripts/hooks/` between releases no longer survive in
  users' `.claws-bin/hooks/`.
- Linux x86_64 installs no longer print a false-positive arch warning every
  time. Zsh-only syntax in `~/.zshrc` no longer triggers a misleading
  "syntax error" warning.
- The `/claws-do` and `/claws-worker` slash commands now route one-shot shell
  commands through `claws_exec` and reserve wrapped terminals for hosting
  Claude Code workers. Closes the user-reported bug where wrapped terminals
  ran shell commands instead of booting a Claude Code instance.

### Fixed (HIGH)

- **ESM-project hook crash** (`scripts/hooks/package.json` new + install.sh).
  In projects whose root `package.json` declares `"type":"module"`, Node
  walked up from the hook script and inherited the ESM type, so the
  CommonJS `require('fs')` at the top of every Claws hook crashed at line 14.
  The user (Miles) saw `Failed with non-blocking status code: file:///…/.claws-bin/hooks/pre-tool-use-claws.js:14` once per Bash tool call. Fix:
  ship a `package.json` shim (`{"type":"commonjs"}`) alongside the hook
  scripts so Node loads them as CJS regardless of the surrounding project's
  ESM type. Audit 4 surfaced this as a follow-up gap (no audit covered ESM
  projects directly — added to the matrix going forward).

- **Stale `.claws-bin/hooks/` overlay** (`scripts/install.sh`). The hooks
  copy step used to overlay new files on top of the existing directory
  without first wiping it. Files removed in a newer release (e.g.
  `post-tool-use-claws.js`, deleted in v0.6.5) survived indefinitely in
  every existing project's `.claws-bin/hooks/`, and `~/.claude/settings.json`
  still referenced them. Fix: `rm -rf "$PROJECT_ROOT/.claws-bin/hooks"`
  before the copy. Audit 4 finding I, audit 2 findings A/B.

- **Multi-project hook displacement** (`scripts/install.sh`,
  `scripts/inject-settings-hooks.js`). Hook registration in
  `~/.claude/settings.json` pointed at `$PROJECT_ROOT/.claws-bin/hooks/`,
  so each new project install silently displaced every prior project's hook
  registration — last install won globally. Deleting a project also orphaned
  its hook commands in settings.json, leaving broken entries that fired on
  every Bash call. Fix: pass `$INSTALL_DIR/scripts` to the hook injector so
  `hookCmd` resolves to `$INSTALL_DIR/scripts/hooks/<script>.js` — the
  committed source-of-truth. One registration now serves all projects;
  `/claws-update` from any project refreshes it; project deletion never
  orphans it. Audit 3 finding A.

- **BSD sed self-heal regression** (`scripts/install.sh:inject_hook`). The
  `# CLAWS terminal hook` cleanup used `sed '/pat/,+1d'` — the `,+N` range
  is a GNU sed extension. macOS ≤ Monterey ships a BSD sed that silently
  treats `+1` as the literal line number 1, so only the marker line was
  deleted and the `source ".../shell-hook.sh"` line on the next line
  survived. Subsequent installs no longer matched the marker (already
  gone) and the orphan source line stayed forever. Fix: replaced sed with
  a portable awk pass that also nukes any standalone orphaned
  `source .../shell-hook.sh` line — heals existing damage on the next
  install. Audit 4 finding G — the single highest-leverage item in that
  audit.

### Fixed (MEDIUM)

- **Linux x86_64 false-positive arch warning** (`scripts/install.sh:431`).
  `uname -m` returns `x86_64` (underscore) but `file(1)` reports the binary
  as `x86-64` (hyphen). Every legitimate Linux x86_64 install used to print
  `pty.node architecture may not match current machine (x86_64)`. Fix:
  match both spellings via `uname -m | sed 's/_/-/g'`. Audit 1 finding H-1.

- **Misleading "zshrc syntax error" warning** (`scripts/install.sh:1068`).
  `bash -n ~/.zshrc` flagged any zsh-specific construct (`setopt`,
  `autoload -Uz`, `zstyle`, …) as a syntax error after every install. Fix:
  prefer `zsh -n` when zsh is installed (it almost always is when
  `~/.zshrc` exists). Audit 1 finding H-2.

### Changed (slash command docs — no code change)

- **`/claws-do` and `/claws-worker`** now require classifying the request
  before creating a terminal:
  - One-shot shell command (`npm test`, `pytest`, `cargo build`) → use
    `claws_exec`. No terminal. No cleanup.
  - Mission-shaped task (refactor, fix bug, multi-step) → 7-step Claude
    Code boot sequence + `MISSION_COMPLETE` marker.
  Closes the user-reported regression where wrapped terminals were hosting
  bare shell commands instead of Claude Code instances. The new
  `/claws-do` doc explicitly forbids the old "send shell command into
  wrapped terminal" pattern.

### Audit findings deferred to v0.7.3+

- Stale VS Code extension dirs after symlink fallback (audit 4 K gap 1) —
  rare, low-impact.
- Lifecycle-state `v` field validation (audit 4 J) — future hardening.
- Offline / corporate-firewall bypass path (audit 4 A) — needs `--no-network`
  flag and `CLAWS_DIR` semantics review; out of scope for a hotfix.

## [0.7.1] - 2026-04-28 — Fresh-install fix

### Fixed (CRITICAL — fresh installs were silently broken)

`scripts/install.sh` was producing a partially-working system on every fresh
project install since v0.6.5+ shipped the lifecycle hook chain. Issue 11 in
`.local/issues/` documents the four layered bugs surfaced by an end-to-end
install test against a clean `/tmp/claws-fresh-install-test/`.

- **Hook source path was wrong.** `install.sh` copied lifecycle hooks from
  `$INSTALL_DIR/.claws-bin/hooks/` — a path that is gitignored and therefore
  missing on every fresh `git clone`. The committed source-of-truth is
  `$INSTALL_DIR/scripts/hooks/`. Fixed: copy from the right source.
  Result: `<project>/.claws-bin/hooks/` is now populated as designed.
- **`inject-settings-hooks.js` got the wrong directory.** It was invoked
  with `$INSTALL_DIR/.claws-bin` (source-clone path), so registered hook
  commands in `~/.claude/settings.json` pointed at non-existent files. Fixed:
  pass `$PROJECT_ROOT/.claws-bin` so registered paths are project-local and
  match the deployed copies. Lifecycle hooks (PreToolUse, SessionStart, Stop)
  now resolve correctly on every fresh install.
- **`schemas/` deployment was incomplete.** Only `schemas/mcp-tools.json`
  was being copied. The 20 `schemas/json/*.json` and the
  `schemas/types/event-protocol.d.ts` were NOT. Fixed: copy the whole
  `schemas/` tree (`mcp-tools.json` + `json/` + `types/`). External schema
  consumers (worker SDKs, validators, IDE hints) now find the artifacts.
- **Verifier flagged missing hooks dir as a warning, not a failure.** With
  the source-path bug fixed, the `.claws-bin/hooks/` directory should always
  be present after install — so its absence is now a hard `_miss`, not a soft
  `warn`. Catches regressions immediately rather than letting them slip past
  the install banner.

### Added

- `CLAWS_NO_GLOBAL_HOOKS=1` env var. When set, `install.sh` skips registering
  Claws hooks in `~/.claude/settings.json`. Useful for testing, CI, and
  sandboxed installs where the user's global Claude Code config should not
  be touched. Surfaced as a need during the issue-11 reproduction (running
  install.sh against a temp dir for testing was clobbering the dev
  environment's hook registration).

## [0.7.0] - 2026-04-28 — Phase β: streaming foundation

### Fixed (post-deploy)

- **`extension/scripts/deploy-dev.mjs`** — also copies `extension/package.json`
  into each `~/.vscode/extensions/<publisher>.<name>-*/` directory. VS Code
  reads the version label from the installed dir's `package.json`, so without
  this copy the Extensions panel keeps showing the pre-deploy version even
  after the bundle has been updated. Surfaced during the v0.7.0 integration
  test (issue 10 in `.local/issues/`).

### Fixed (post-review)

Three issues were found in the Phase β code review and addressed in this
release before merge:

- **BLOCKING-1** — `claws-sdk.js` `hello()` was overwriting `CLAWS_PEER_ID`
  with the server-assigned connection peer id, so SDK publishes were
  routing to `worker.<server-id>.*` instead of the documented
  `worker.<CLAWS_PEER_ID>.*`. The constructor now captures `CLAWS_PEER_ID`
  into an immutable `_topicPeerId` field that all publish methods use for
  topic construction; `hello()` never overwrites it.
- **BLOCKING-2** — `publishBoot`/`publishPhase`/`publishHeartbeat` (and
  others) were constructing payloads whose field names did not match the
  corresponding Zod schemas (`reason` vs `transition_reason`, `phase` vs
  `current_phase`, missing `model`/`parent_peer_id`/`cwd`/`terminal_id`,
  etc.). Every SDK publish was triggering `system.malformed.received` even
  in normal operation. All payload field names now match the schemas
  exactly. Schema names also switched from PascalCase (`WorkerBootV1`) to
  kebab-case (`worker-boot-v1`) to match the `SCHEMA_BY_NAME` convention.
- **MAJOR-1** — `extension/package.json` `build` and `compile` scripts now
  prepend `npm run schemas` so committed artifacts under `schemas/` cannot
  silently fall stale relative to `event-schemas.ts`.

### Added

**Schemas-as-code (Zod → committed JSON, TypeScript, docs)**
- `extension/src/event-schemas.ts`: Zod v3 schema definitions as the single
  source of truth for all 19 event types — `EnvelopeV1`, 5 worker schemas,
  8 cmd schemas, 6 system schemas, enums, and `SCHEMA_BY_NAME` lookup
- `extension/src/topic-registry.ts`: `TOPIC_REGISTRY` (19 entries) and
  `schemaForTopic()` lookup; `topic-utils.ts` extracted to avoid circular deps
- `npm run schemas` codegen pipeline: bundles TS via esbuild, then generates
  `schemas/json/` (20 JSON Schema files), `schemas/types/event-protocol.d.ts`,
  `docs/event-protocol.md` topic table, and `schemas/mcp-tools.json`
- All generated files committed — no runtime build step required

**Server-side publish validation (soft-reject mode by default)**
- `server.ts` publish handler validates `EnvelopeV1` and per-topic data
  schema before fan-out using the Zod schemas
- Soft-reject (default): on failure, emits `system.malformed.received` with
  `{ from, topic, error: ZodIssues }`, then still fans the event out
- Strict mode (`claws.strictEventValidation=true`): hard-rejects with
  `{ ok:false, error:'envelope:invalid'|'payload:invalid', details }`;
  no fan-out occurs
- Migration note: soft-reject is the default in v0.7.0; flips to strict in
  v0.8.0 to give existing callers one release cycle to adopt the envelope

**MCP tool descriptors generated from Zod schemas**
- All 18 MCP tools defined as Zod schemas in `scripts/codegen/gen-mcp-tools.mjs`
- `schemas/mcp-tools.json` committed and consumed by `mcp_server.js` at startup
- `tools/list` response is byte-identical to the previous hand-written array
- `mcp_server.js` startup guard exits clearly if the file is absent

**Claws SDK — zero-dep typed publish helpers**
- `claws-sdk.js` (repo root, copied to `.claws-bin/` by installer): dual CLI
  + module API for workers to publish typed `EnvelopeV1` frames
- CLI verbs: `publish boot|phase|event|heartbeat|complete`
- Module: `ClawsSDK` class with `connect()`, `hello()`, `publishBoot()`,
  `publishPhase()`, `publishEvent()`, `publishHeartbeat()`, `publishComplete()`
- Socket auto-discovery (walks up from `cwd`); reads env `CLAWS_PEER_ID`,
  `CLAWS_PEER_NAME`, `CLAWS_TERMINAL_ID`
- Migration note: SDK is opt-in for Phase β — legacy `claws_publish` with raw
  payloads continues to work in soft-reject mode

**Streaming Worker orchestration pattern**
- Template 8 in `.claude/skills/prompt-templates/SKILL.md`: full streaming
  worker mission boilerplate with checkpoint publish table and orchestrator
  setup guide
- `.claude/skills/claws-orchestration-engine/SKILL.md` Phase 4 OBSERVE
  refactored to event-driven sidecar pattern with heartbeat-based stuck
  detection; legacy `claws_read_log` polling documented as fallback
- New slash command `.claude/commands/claws-streaming-worker.md`

### Tests

192 checks across 18 suites (all green):
- 34 unit checks — `event-schemas.test.js`
- 14 unit checks — `topic-registry.test.js`
- 7 integration checks — `server-validation.test.js`
- 7 static + smoke checks — `mcp-tools-codegen.test.js`
- 7 CLI + integration checks — `sdk-cli.test.js`
- 123 pre-existing checks (suites 1–13) unchanged

---

## [Unreleased] - Phase β: streaming foundation

### Added — β.5 Claws SDK (commit 5/7)

**Zero-dependency worker publish helper:**
- `claws-sdk.js` (repo root): dual CLI + module API for workers to publish
  typed `EnvelopeV1` frames; zero deps (stdlib `net`, `crypto`, `fs` only)
  - CLI: `node .claws-bin/claws-sdk.js publish boot|phase|event|heartbeat|complete [flags]`
  - Module: `const { ClawsSDK } = require('.claws-bin/claws-sdk.js')` —
    `connect()`, `hello()`, `publishBoot()`, `publishPhase()`,
    `publishEvent()`, `publishHeartbeat()`, `publishComplete()`
  - Socket auto-discovery: walks up from `cwd` looking for `.claws/claws.sock`
  - Reads env: `CLAWS_SOCKET`, `CLAWS_PEER_ID` (required for publish),
    `CLAWS_PEER_NAME`, `CLAWS_TERMINAL_ID`
  - `--help` / `--version` (`0.7.0`) / clean error on missing `CLAWS_PEER_ID`
- `scripts/install.sh`: copies `schemas/mcp-tools.json` → `.claws-bin/schemas/`
  (required by `mcp_server.js` at runtime) and `claws-sdk.js` → `.claws-bin/`
- 7 checks in `extension/test/sdk-cli.test.js` (static CLI + module API +
  live server integration via built extension bundle)
- `extension/package.json`: adds `test:sdk` script, 192 checks across 18 suites

---

### Added — β.4 MCP tool descriptor migration (commit 4/7)

**MCP tool descriptors generated from Zod schemas:**
- `scripts/codegen/gen-mcp-tools.mjs`: defines all 18 MCP tools as Zod schemas
  with verbatim descriptions; writes `schemas/mcp-tools.json` at codegen time
- `schemas/mcp-tools.json`: committed generated file — 18 tool descriptors
  consumed by `mcp_server.js` at startup
- `mcp_server.js`: replaced 224-line hand-written `TOOLS` array with
  `require('./schemas/mcp-tools.json')`; adds startup guard that exits with
  a clear message when the file is absent
- 7 checks in `extension/test/mcp-tools-codegen.test.js` (static JSON checks
  + `mcp_server.js` `tools/list` stdio smoke test)
- `extension/package.json`: adds `test:mcp-codegen` script and appends it to
  the `test` chain (185 checks total across 17 suites)

---

### Added — β.1 Schemas + β.1 Server Validation (commits 1–2/7)

**Zod schema definitions as single source of truth for all event types:**
- `extension/src/event-schemas.ts`: `EnvelopeV1`, 5 worker schemas
  (`WorkerBootV1`, `WorkerPhaseV1`, `WorkerEventV1`, `WorkerHeartbeatV1`,
  `WorkerCompleteV1`), 8 cmd schemas, 6 system schemas, enums
  (`PHASES`, `EventKindEnum`, `ClawsRoleEnum`, `ResultEnum`, `SeverityEnum`),
  and `SCHEMA_BY_NAME` lookup map
- `extension/src/topic-utils.ts`: standalone `matchTopic` + `matchSegments`
  extracted from `peer-registry.ts` (§7.7 refactor — clean dep graph)
- `extension/src/topic-registry.ts`: `TOPIC_REGISTRY` (19 entries),
  `schemaForTopic(topic)` lookup
- `extension/src/peer-registry.ts`: now re-exports `matchTopic` from
  `topic-utils.ts`; backward compatible for all existing callers
- 34 unit checks in `test/event-schemas.test.js`
- 14 unit checks in `test/topic-registry.test.js`
- `zod@^3` and `zod-to-json-schema@^3` added as devDependencies

**Codegen pipeline (`npm run schemas`):**
- `scripts/codegen/index.mjs`: bundles `event-schemas.ts` via esbuild → CJS,
  then calls each generator in sequence
- `scripts/codegen/gen-json-schema.mjs`: iterates exported Zod schemas, calls
  `zodToJsonSchema()`, writes 20 files to `schemas/json/`
- `scripts/codegen/gen-types.mjs`: writes `schemas/types/event-protocol.d.ts`
  with hand-templated type aliases for all 19 event schemas
- `scripts/codegen/gen-docs.mjs`: regenerates schema reference table in
  `docs/event-protocol.md` between `<!-- BEGIN/END GENERATED SCHEMAS -->` markers
- `extension/package.json`: adds `"schemas"` script; `build` unchanged
  (codegen is an explicit separate step — run before build for full pipeline)
- `.gitignore`: adds `extension/dist/event-schemas.bundle.cjs` (temp artifact)
- `docs/event-protocol.md`: adds `BEGIN/END GENERATED SCHEMAS` markers with
  initial generated content
- `schemas/` directory committed with all 20 JSON Schema files and `.d.ts`

**Server-side publish validation with soft-reject mode:**
- `server.ts` publish handler now validates envelope (`EnvelopeV1`) and data
  payload (`schemaForTopic`) before fan-out
- Soft-reject mode (default): on failure, emits `system.malformed.received`
  with `{ from, topic, error: ZodIssues }`, then still fans out the event
- Strict mode (`claws.strictEventValidation=true`): hard-rejects with
  `{ ok:false, error:'envelope:invalid'|'payload:invalid', details }`;
  no fan-out occurs
- `server-config.ts`: new `strictEventValidation: boolean` field
  (default `false`); `DEFAULT_STRICT_EVENT_VALIDATION` constant
- `extension.ts`: wires `strictEventValidation` from VS Code settings
- `extension/package.json`: adds `claws.strictEventValidation` VS Code config
- 7 integration checks in `test/server-validation.test.js`

---

## [0.6.5] - 2026-04-28

### Added — Phase α: server-side lifecycle gate

The lifecycle enforcement trust boundary moves from Claude Code hooks (which do
not reliably fire on MCP tool calls) into the socket server itself. Every
transport — MCP, raw Bash socket, and future WebSocket — is gated by the same
server-side check.

**Server-owned lifecycle state (`LifecycleStore`):**
A new `LifecycleStore` class holds lifecycle state in memory (authoritative) and
persists it atomically to `.claws/lifecycle-state.json` via tmp-rename. The
server constructs the store on startup and is the only writer. No client — not
even the model — can write the state file to bypass the gate.

**Server-side gate on `create`:**
The `create` command handler now calls `lifecycleStore.hasPlan()` as its first
action. When no plan exists, `create` is rejected immediately with:
```json
{ "ok": false, "error": "lifecycle:plan-required", "message": "..." }
```
This error is identical regardless of whether the caller is the MCP server, a
raw Bash `node -e` snippet, or a future WebSocket client.

**Four new socket commands:**
- `lifecycle.plan` — log the PLAN phase; idempotent; returns state + `idempotent` flag
- `lifecycle.advance` — advance the state machine one step; enforces legal transitions
- `lifecycle.snapshot` — read-only state query; no side effects
- `lifecycle.reflect` — terminal REFLECT transition with persisted retrospective text

**Four new MCP tools:**
`claws_lifecycle_plan`, `claws_lifecycle_advance`, `claws_lifecycle_snapshot`,
`claws_lifecycle_reflect`. All wrap the new socket commands. The plan tool's
description explains the server gate so the model knows to call it first.

**`/claws-plan` now uses MCP tool, not Write:**
Step 2 of `/claws-plan` previously instructed the model to write
`.claws/lifecycle-state.json` directly. It now invokes
`mcp__claws__claws_lifecycle_plan(plan="...")` — the server writes the file
under its own ownership.

**PostToolUse hook removed:**
`scripts/hooks/post-tool-use-claws.js` is deleted. This hook never reliably
fired on MCP tool calls (issue 06) and phase advancement now happens at the
server dispatch layer. Keeping it was dead code.

**PreToolUse hook simplified:**
`scripts/hooks/pre-tool-use-claws.js` no longer contains lifecycle gate blocks
for `mcp__claws__*` tools. The Bash long-running pattern guard (soft nudge /
CLAWS_STRICT hard-block) is retained — it remains useful for observability.

**Raw-socket bypass instructions removed from claws-do.md:**
All `net.createConnection` / "raw socket via node" fallback instructions are
removed from `.claude/commands/claws-do.md`. If MCP fails to load, the user is
directed to reload VS Code — not to bypass via Bash.

**install.sh migration:**
The hooks-registration step now runs `inject-settings-hooks.js --remove` before
re-registering. This cleanly removes the stale PostToolUse entry from
`~/.claude/settings.json` on re-install without touching non-Claws hooks.

> **Note for users who edited settings.json manually:** if you removed the
> `_source: "claws"` tag from a hook entry, `inject-settings-hooks.js --remove`
> will not find it. Verify your `~/.claude/settings.json` has no PostToolUse
> entry for `post-tool-use-claws.js` after upgrading.

**Post-review fixes (M1+M2+M3 — applied as immediate follow-up):**
Three issues found in the post-merge review have been addressed in this release.
M1: `lifecycle.advance` (and `lifecycle.reflect`) error responses now return the
stable machine-readable code in `error` and the human-readable detail in a
separate `message` field, matching the §2.3 contract already implemented by the
other lifecycle handlers. M2: `lifecycle.advance` returns `idempotent: true` when
the requested phase equals the current phase (no-op transition), as specified in
§2.3. M3: All remaining "or raw socket" bypass phrasing in `claws-do.md` is
removed; the affected prohibition lines are rephrased without the term.

Files changed:
- `extension/src/lifecycle-store.ts` — new `LifecycleStore` class (pure Node.js)
- `extension/src/protocol.ts` — `LifecycleState`, `LifecyclePlanRequest`,
  `LifecycleAdvanceRequest`, `LifecycleSnapshotRequest`, `LifecycleReflectRequest`
  added; all four added to `ClawsRequest` union
- `extension/src/server.ts` — import + field + constructor wiring; gate check in
  `create` handler; four new `lifecycle.*` command handlers
- `mcp_server.js` — four new tool descriptors + four new `handleTool` cases
- `.claude/commands/claws-do.md` — raw-socket bypass instructions removed
- `.claude/commands/claws-plan.md` — step 2 now invokes `claws_lifecycle_plan`;
  lifecycle table updated to remove `(post-tool-use hook auto-advances)` reference
- `scripts/hooks/post-tool-use-claws.js` — **deleted**
- `scripts/hooks/pre-tool-use-claws.js` — lifecycle gate blocks removed; Bash guard kept
- `scripts/inject-settings-hooks.js` — PostToolUse entry removed; 3 hooks remain
- `scripts/install.sh` — hooks registration updated to `--remove` then re-register
- `extension/test/lifecycle-store.test.js` — 25 unit tests (all pass)
- `extension/test/lifecycle-server.test.js` — 8 integration tests (7 original + 1
  new illegal-transition test; idempotent:true assertion added to advance test)

## [0.6.4] - 2026-04-28

### Added — CLAWS_STRICT mode (first Hard enforcement mechanism)

Until v0.6.4 every Claws enforcement layer was advisory: CLAUDE.md blocks,
SessionStart/PreToolUse/Stop hooks all *suggested* the Claws path but the
model could still fall back to plain Bash for long-running orchestration
work. This release ships the first hard block.

When `CLAWS_STRICT=1` is set in the user's environment (or in
`~/.claude/settings.json` `env` block), the PreToolUse hook returns
`permissionDecision: "deny"` for Bash commands that match long-running
patterns (servers, watchers, `nohup`, `nodemon`, `pnpm/bun start|dev|serve|watch`,
etc.). The deny reason is an actionable four-step recipe: `claws_create` →
`claws_send` → `claws_read_log` → `claws_close`. Claude Code blocks the
tool call and the model pivots.

The pattern list is conservative — only commands that are unambiguously
long-running. Ordinary commands like `ls`, `git status`, one-shot builds,
or short tests pass through unchanged. `CLAWS_STRICT` defaults to off; no
behavior change for existing users.

The mechanism uses Claude Code's documented PreToolUse hook protocol
(`hookSpecificOutput.permissionDecision`); no Claude Code change required.

Files changed:
- `scripts/hooks/pre-tool-use-claws.js` — added `STRICT` branch with
  `hookSpecificOutput.permissionDecision: "deny"` + actionable reason.
  Pattern list expanded with `pnpm`, `bun`, `hypercorn`, `nodemon`,
  `nohup`. Word-boundary anchored to reduce false positives.

### Fixed — settings.json schema URL + install.sh housekeeping

- `.claude/settings.json` — `$schema` URL was `json-schema.store.org` (typo);
  corrected to `json.schemastore.org`. Closes the "Found 1 settings issue"
  warning surfaced by `/doctor`.
- `scripts/install.sh` — copies `scripts/stream-events.js` into `.claws-bin/`
  during install so the event-streaming sidecar (referenced in
  `docs/event-protocol.md`) is available out of the box. Documents
  `CLAWS_STRICT` env var in the header. Fixes the install-time MCP
  handshake probe to use newline-delimited JSON (matches the v0.6.1 server
  framing fix; the probe was still using LSP `Content-Length` framing and
  failing silently).

## [0.6.3] - 2026-04-28

### Fixed — claws_send submit reliability for TUI workers

Multi-line text sent via `claws_send` with `newline=true` was not registering as
a discrete Enter keypress in Ink-based TUIs (Claude Code). The trailing CR
arrived in the same write as the bracketed-paste close marker and got bundled
into the TUI's paste-detection burst, leaving the input populated but never
submitted. Empirical workaround: send the CR via raw socket as a separate write.
This release encodes the workaround into the send path itself.

Two-part fix:
- `extension/src/claws-pty.ts:writeInjected` — when bracketed paste is used and
  `withNewline=true`, the trailing `\r` is emitted in a separate `write()` call
  after a 30 ms delay. The pause closes the TUI's paste-detection window before
  the CR arrives, so it registers as Enter.
- `mcp_server.js:claws_send` — auto-sets `paste: true` when text contains `\n`
  or `\r`. The tool description always promised this; the server never
  enforced it.

End-to-end verified: a multi-line `claws_send` with `newline=true` now submits
on the first try in a Claude Code worker terminal — no raw-socket CR fallback
needed.

### Added — npm run deploy:dev for local extension iteration

`extension/scripts/deploy-dev.mjs` (called via `npm run deploy:dev`) copies the
freshly built `dist/extension.js` and `native/` bundle into every installed
extension directory under `~/.vscode/extensions/<publisher>.<name>-*/`. Closes
the silent gap where `npm run build` produced a new bundle that VS Code never
loaded because the editor only reads from its installed-extensions dir.

### Fixed — install.sh now cleans stale install dirs

After a successful `code --install-extension <vsix>`, the installer now removes
older `<publisher>.<name>-X.Y.Z` directories so VS Code's extension picker
isn't confused by lingering versions. Previously, prior installs (e.g. stuck
on a lock when a window was open) could leave multiple version dirs under
`~/.vscode/extensions/` indefinitely.

### Fixed — version manifests now track CHANGELOG

`extension/package.json` was stuck at `0.6.0` and root `package.json` at
`0.5.3` despite CHANGELOG, README, CLAUDE.md, and the `v0.6.1` git tag all
declaring `0.6.1`. Result: every reinstall packaged a VSIX labeled `0.6.0`,
and VS Code's extension UI kept showing `0.6.0` even when the bytes had moved
on. Both manifests now match the CHANGELOG.

## [0.6.2] - 2026-04-28

### Added — Lifecycle gate (PLAN→REFLECT) for orchestration

Multi-terminal orchestration via Claws now follows an enforced 8-phase lifecycle:
PLAN → SPAWN → DEPLOY → OBSERVE → RECOVER → HARVEST → CLEANUP → REFLECT.
A PreToolUse gate blocks `claws_create` (and any `claws_*` tool) until a PLAN
file exists at `.claws/lifecycle-state.json`. The `/claws-plan` slash command
writes this file and unlocks terminal creation.

Why: pre-0.6.2, orchestrators could spawn workers without stating a mission,
which led to runaway terminals, no audit trail, and no shared memory of what
each worker was supposed to do. The gate forces a one-paragraph plan before
any worker is created.

Components:
- `scripts/hooks/lifecycle-state.js` — shared module that read/writes the
  state machine.
- `scripts/hooks/pre-tool-use-claws.js` — gate logic that returns a blocking
  error when no PLAN exists.
- `scripts/hooks/post-tool-use-claws.js` — auto-advances phase after each
  `claws_*` tool call.
- `scripts/hooks/stop-claws.js` — checks lifecycle state on Stop and reminds
  the model to close terminals + write REFLECT before session end.
- `scripts/inject-settings-hooks.js` — registers the new PostToolUse hook
  matcher (`mcp__claws__*`).
- `.claude/commands/claws-plan.md` — new `/claws-plan` slash command.

### Added — Event-streaming sidecar protocol

A convention layer over the existing claws/2 pub-sub for real-time, no-polling
orchestration. Workers emit lifecycle events on well-known topics; orchestrators
subscribe via a long-lived sidecar process that prints each push frame as one
JSON line on stdout — designed to be spawned via `run_in_background` and
consumed by Monitor-style line tailing.

- `docs/event-protocol.md` — event shapes, command channel, state machine.
- `scripts/stream-events.js` — sidecar implementation. Holds one persistent
  socket, registers as a peer, subscribes to a topic pattern, emits JSON-line
  events per push frame.

### Housekeeping

- `scripts/git-hooks/pre-commit` — repo-local hook that enforces CHANGELOG
  updates for code commits. Installed by `scripts/install.sh` into
  `.git/hooks/`.
- `.gitignore` — ignore `.claude/scheduled_tasks.lock` (runtime artifact
  from the scheduling system).

## [0.6.1] - 2026-04-22

### Fixed — MCP server stdio framing (CRITICAL)

The MCP server was implementing **LSP-style `Content-Length` framing** instead of the
**newline-delimited JSON** the MCP spec requires for stdio transport. Result: every
JSON-RPC request from Claude Code (`initialize`, `tools/list`, every tool call) hung
forever — the server was waiting for `Content-Length: NNN\r\n\r\n` headers that never
came. `/mcp` showed "claws — needs auth" / "Failed to reconnect"; `mcp__claws__*` tools
were never actually available in any Claude Code session, regardless of install state.

Fix: `readMessage()` now reads line-by-line; `writeMessage()` appends `\n` instead of a
Content-Length header. Verified end-to-end: `initialize` → response, `tools/list` →
all 14 tools, `claws_ping` callable from a real Claude Code session.

The prior "GAP-2 + GAP-3 — MCP spec compliance" commit (b5c2c7c) only fixed the
`isError` shape and stderr logging — it never tested the JSON-RPC handshake, so the
framing bug shipped in every release through 0.6.0.

Also bumped `serverInfo.version` from `0.6.0` → `0.6.1`.

### Added — Behavioral Injection Enforcement (Lifecycle enforcement overhaul)

Closes the lifecycle enforcement gap identified in `.local/audits/lifecycle-enforcement-gap.md`.
Prior to this release, Claude Code defaulted to Bash in new sessions because the behavioral
injection system was advisory wallpaper — the strong imperative content existed in orphaned
files that nothing auto-loaded.

**Templates (Wave 1)**
- `templates/CLAUDE.project.md` — replaces orphaned `templates/CLAUDE.claws.md`. New template uses
  imperative framing (`MUST`/`ALWAYS`/`NEVER`) and includes the full 7-step worker boot sequence,
  lifecycle phase list, and tool inventory with placeholder substitution.
- `templates/CLAUDE.global.md` — new machine-wide policy template. Injected into `~/.claude/CLAUDE.md`
  so every Claude Code session on the machine sees the lifecycle rules, even in non-Claws projects.
- `.claude/skills/claws-orchestration-engine/SKILL.md` — rewritten with full 8-phase lifecycle
  (PLAN→SPAWN→DEPLOY→OBSERVE→RECOVER→HARVEST→CLEANUP→REFLECT) inlined. Removed false claim
  that lifecycle auto-loads on MCP registration. Deleted dead `lifecycle.yaml`.
- `.claude/commands/claws-boot.md` — new `/claws-boot` slash command codifying the exact 7-step
  worker boot sequence (create → activate → trust → bypass → mission → CR).
- `rules/claws-default-behavior.md` — added ECC-only scope note; canonical rules now live in
  the injected `CLAUDE.md` block.

**Injector scripts (Wave 2)**
- `scripts/inject-claude-md.js` — rewritten to read from `templates/CLAUDE.project.md` instead of
  hardcoded advisory copy. Substitutes 8 placeholders (`{PROJECT_NAME}`, `{SOCKET_PATH}`,
  `{TOOLS_V1_LIST}`, `{TOOLS_V2_LIST}`, `{CMDS_LIST}`, etc.).
- `scripts/inject-global-claude-md.js` — new script. Writes machine-wide Claws policy to
  `~/.claude/CLAUDE.md` using `<!-- CLAWS-GLOBAL:BEGIN v1 -->` sentinel. Idempotent.
- `scripts/inject-settings-hooks.js` — new script. Registers `SessionStart`, `PreToolUse:Bash`,
  and `Stop` hooks in `~/.claude/settings.json` with `_source:"claws"` tag for clean uninstall.
  Supports `--remove` flag to strip all Claws hooks without touching others.
- `.claws-bin/hooks/session-start-claws.js` — fires on every Claude Code session start in a Claws
  project (socket detected). Emits lifecycle rules as a system-reminder.
- `.claws-bin/hooks/pre-tool-use-claws.js` — nudges long-running Bash commands toward `claws_create`.
- `.claws-bin/hooks/stop-claws.js` — reminds model to close terminals before session ends.

**Installer wiring (Wave 3)**
- `scripts/install.sh` — three additive additions (zero line deletions):
  - Vendors `hooks/*.js` into project `.claws-bin/hooks/`
  - Calls `inject-global-claude-md.js` after project CLAUDE.md injection
  - Calls `inject-settings-hooks.js` to register lifecycle hooks on every install
  - Adds `.claws-bin/hooks/` to post-install verification checklist

**Testing**
- `scripts/test-enforcement.sh` — integration test covering the full pipeline:
  inject-claude-md.js (idempotency + imperative content), inject-global-claude-md.js (dry-run),
  inject-settings-hooks.js (dry-run + tag verification), session-start hook (socket detection),
  hook exit codes.

## [0.6.0] - 2026-04-21

### Added — claws/2 Agentic SDLC Protocol (Phase A + B)

**New protocol version `claws/2`** — a backward-compatible extension of `claws/1` that adds a message bus, peer identity, and a task registry so an orchestrator Claude can coordinate a fleet of worker Claudes over the existing Unix socket.

Key additions (all new commands are additive — `claws/1` clients continue to work unchanged):

- **`hello` handshake** — clients register as `orchestrator`, `worker`, or `observer`. Returns a stable `peerId` for the session. Exactly one orchestrator allowed per socket; a second registration returns an error. Workers that disconnect trigger `worker.offline.<peerId>` events.

- **Peer registry** (`peer-registry.ts`) — in-memory map of live peers keyed by peerId. Tracks role, peerName, terminalId, subscriptions, and lastSeen. Cleared on extension reload. `WeakMap<Socket, peerId>` enables O(1) cleanup on disconnect.

- **`subscribe` / `unsubscribe` / `publish`** — named topic pub/sub over the existing socket. Topic patterns support `*` (one segment) and `**` (many segments). Server fans out to matching subscribers. `echo: true` delivers to the sender too.

- **Server-push frames** — new frame format with `push: 'message'` and no `rid` field. Clients distinguish push frames from responses by the absence of `rid`. Implemented via a dedicated `pushFrame()` helper that catches write errors without crashing the server.

- **`broadcast`** — orchestrator-only shorthand that fans out a text message to all workers (or all peers by role). Optional `inject: true` also sends the text into each peer's associated terminal via bracketed paste — the "kill switch" for hung workers.

- **`ping`** — lightweight heartbeat command. Returns `serverTime`. Any command from a peer refreshes its `lastSeen`.

- **Task registry** (`task-registry.ts`) — in-memory task lifecycle with five commands:
  - `task.assign` (orchestrator) — creates a task, delivers via pub/sub and/or terminal inject
  - `task.update` (worker, own tasks only) — reports progress; publishes `task.status`
  - `task.complete` (worker, own tasks only, idempotent) — finalises the task; publishes `task.completed`
  - `task.cancel` (orchestrator) — sets `cancelRequested`; publishes `task.cancel_requested.<assignee>`
  - `task.list` (any role) — filtered snapshot by assignee, status, or updatedAt cursor

- **MCP client tools** (`mcp_server.js`) — six new tools expose claws/2 to Claude Code: `claws_hello`, `claws_subscribe`, `claws_publish`, `claws_broadcast`, `claws_ping`, `claws_peers`.

### Fixed
- **`.mcp.json` now emits absolute paths** — `command`, `args[0]`, `cwd`, and `CLAWS_SOCKET` are pinned to absolute paths at install time. Eliminates silent failures for nvm/volta/asdf users and CWD-sensitive Claude Code launches. The file is machine-specific and gitignored; the embedded README now says so.

### Tests
- 11 suites, 90+ checks. Three new suites added: `claws-v2-hello` (hello handshake + peer registry), `claws-v2-pubsub` (subscribe/unsubscribe/publish/broadcast + wildcard matching), `claws-v2-tasks` (full task lifecycle including push-frame delivery assertions).

## [0.5.11] - 2026-04-19

### Milestone
- **First successful external install verified.** End-to-end install on a fresh machine by a user outside the dev environment completed without issues — extension loaded, socket connected, MCP tools live, shell hooks active.

### Fixed
- **Network pre-check before native build (R3.5).** Before `npm run build` runs `@electron/rebuild`, the installer now probes `https://github.com` with a 5-second timeout (curl, then wget fallback). Air-gapped machines or broken network configurations get an immediate actionable warning — including `CLAWS_ELECTRON_VERSION` and `CLAWS_FORCE_REBUILD_NPTY=0` escape hatches — rather than a silent 3-minute hang waiting for Electron headers that will never arrive.
- **Nushell hook injection added (R5.4).** After the fish hook block, the installer now checks for `~/.config/nushell/env.nu` or `config.nu`. If either exists and doesn't already contain `CLAWS_DIR`, it appends `$env.CLAWS_DIR` and `$env.CLAWS_SOCKET` assignments in native Nushell syntax. Nushell users no longer need to manually export these variables.
- **VSIX install retried with sudo on permission failure (R4.7/B7).** The `--install-extension` loop now attempts a plain install first, then falls back to `sudo` if the first attempt fails (common when the extensions directory is owned by root on shared machines). Both success and failure paths log the outcome.
- **Post-install extensions directory verification (R4.10).** After each editor install attempt, the installer checks `~/$HOME/.<editor>/extensions/neunaha.claws-*` to confirm the VSIX actually landed — rather than trusting the undocumented VS Code exit code alone. The verified/unverified distinction is reported in the install log.
- **Per-editor ABI mismatch warning (R3.7).** After confirming the native `pty.node` build, the installer reads the `electronVersion` field from Cursor, Windsurf, and VS Code Insiders app bundles. If any editor's Electron version differs from the version the binary was built for, a targeted warning is emitted per editor explaining pipe-mode fallback and providing the exact `CLAWS_ELECTRON_VERSION=<version>` rebuild command.
- **Explicit `--arch` passed to `@electron/rebuild` (R3.10).** `bundle-native.mjs` now calls `detectTargetArch()` which honours `CLAWS_ELECTRON_ARCH` env override, then falls back to `process.arch`. On macOS, if Node.js reports `x64` while actually running under Rosetta 2 (detected via `sysctl sysctl.proc_translated`), the user is warned that the binary will be x64 and given the `CLAWS_ELECTRON_ARCH=arm64` override. The detected arch is passed as `--arch` to `@electron/rebuild`.
- **`--useCache` and `--cachePath` added to `@electron/rebuild` (R3.4).** Repeated installs no longer recompile `node-pty` from scratch when the ABI-correct binary is already cached. Cache lives at `<repo>/../.electron-rebuild-cache` and is keyed by Electron version + arch.

## [0.5.10] - 2026-04-19

### Fixed
- **Fish shell hook no longer requires `bass` (R5.3/B3).** Created a standalone `scripts/shell-hook.fish` in pure fish syntax that replicates everything in `shell-hook.sh` — startup banner with socket status and terminal count, plus all four shell functions (`claws-ls`, `claws-new`, `claws-run`, `claws-log`). The `conf.d` loader now sets `CLAWS_DIR`/`CLAWS_SOCKET` and sources `shell-hook.fish` directly. Fish users without `bass` (the majority) previously got only an env var export; now they get the full experience unconditionally.
- **Disk space pre-check added (R8.7).** Installer checks `df -k $HOME` at the start of the dependency preflight and warns if less than 500MB is free, before spending time on a clone + native build that will fail mid-way.
- **Build failure error now targets the root cause (R8.8).** After a failed `npm run build`, the installer scans `$CLAWS_LOG` for keywords (Xcode/CLT, network/ENOTFOUND, python/gyp) and emits a specific fix command for each case instead of a generic "common causes" list.
- **Sensitive env vars purged before `CLAWS_DEBUG` trace (R8.9).** When `CLAWS_DEBUG=1` enables `set -x`, the installer now unsets `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `GITHUB_TOKEN`, `NPM_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and similar vars before enabling the trace, so secrets never appear in debug logs.
- **Zed editor documented as unsupported (R4.12).** If `zed` is found in PATH, the installer now prints an explicit info message explaining that Claws is VS Code/Cursor/Windsurf-only (VSIX format) and Zed is not supported.
- **`CLAWS_SOCKET` relative-path constraint documented inline (R6.4/B9).** Added a JS comment directly inside the `.mcp.json` write block explaining that `.claws/claws.sock` is relative to Claude Code's CWD (workspace root) and how to use an absolute path for non-standard setups.

## [0.5.9] - 2026-04-19

### Fixed
- **git minimum version check (R2.1).** Installer now parses the major version from `git --version` and aborts with a clear upgrade message if it's below 2.x.
- **git clone stderr was silently discarded (R1.4).** `git clone --quiet` and `git fetch --quiet` swallowed all error output. Removed `--quiet`; errors now append to `$CLAWS_LOG` so network failures and auth errors are inspectable.
- **CLAWS_REF pinning mechanism added (R1.5).** `CLAWS_REF="${CLAWS_REF:-main}"` lets users pin to a tag or branch (`CLAWS_REF=v0.5.9 bash install.sh`). All `origin/main` references replaced with `origin/$CLAWS_REF`. Initial clone now tries `--branch $CLAWS_REF` first (works for tags and branches), falls back to default-branch clone.
- **git fsck integrity check after clone and update (R1.6).** After every successful clone or update, `git fsck --no-dangling` runs and warns if integrity fails, catching partial/corrupted clones before the build.
- **Shallow clone for first-time installs (R1.7).** Initial `git clone` now uses `--depth 1`, significantly reducing download size for users who don't need full history.
- **pty.node architecture verification (R3.9).** After the native build, `file "$NATIVE_PTY_BIN"` is checked against `uname -m`. A mismatch (e.g. x86_64 binary on arm64) emits a warning pointing to `$CLAWS_LOG`.
- **Step 4 "Runtime check" was a no-op (B4).** The step previously just printed "No Python required — runtime ready" and did nothing. Replaced with a live `node` reachability check (verifies Node.js is still in PATH mid-install) and a pre-check that `mcp_server.js` exists in the clone before the copy step.
- **`.gitignore` not created for new projects (R6.13).** The `.claws/` gitignore guard previously skipped projects with no `.gitignore`. Now calls `touch` first so the entry is written regardless.
- **inject-claude-md.js error message too generic (B8).** Failure message now references `$CLAWS_LOG` for details instead of just "injector failed".
- **No bash -n smoke test after shell hook injection (R5.8).** After each `inject_hook` call for zsh, bash, and bash_profile, the installer now runs `bash -n` on the modified rc file and warns if a syntax error is detected.
- **Step-8 .mcp.json check was file-exists only (R7.6).** Replaced with a full `JSON.parse` validation — a truncated or corrupted `.mcp.json` now correctly fails the verification step rather than passing silently.
- **Node.js PATH not surfaced in verification (R7.10).** Step 8 now logs the full `process.execPath` of the Node.js binary found in PATH, with a note that GUI-launched VS Code may resolve a different Node.
- **Electron version not visible before build (R2.7/R3.2).** Installer now pre-detects the VS Code/Cursor/Windsurf Electron version from their app bundles (macOS) or binaries (Linux) before `npm run build` starts, surfacing the ABI target in the install log.
- **@electron/rebuild not verified after npm install (R2.8).** Added `require.resolve('@electron/rebuild')` check after `npm install`; warns immediately if the package is missing rather than letting the build fail 2 minutes later with a cryptic error.

## [0.5.8] - 2026-04-19

### Fixed
- **nvm/fnm hints were dead code (B10).** Worker B placed the nvm/fnm detection hints *after* the `case "$PLATFORM"` block whose every arm calls `die()`. Since `die()` exits immediately, the hints could never execute — every user with Node installed via nvm or fnm got a generic "node not found" with no actionable guidance. Moved both hints to before the `case` block so they print before the installer exits.
- **Stale-clone detection was always-false (B11).** Worker C's dynamic-version fix (v0.5.7) read `EXPECTED_MIN_VERSION` from `extension/package.json`, then immediately set `EXT_VERSION="$EXPECTED_MIN_VERSION"` — making both variables identical. The comparison `[ "$EXT_VERSION" != "$EXPECTED_MIN_VERSION" ]` was therefore always false, silently disabling the stale-clone guard entirely. Restored the original two-variable pattern: `EXPECTED_MIN_VERSION` is hardcoded to the release baseline (`"0.5.7"`); `EXT_VERSION` is dynamically read from the clone's `package.json` at runtime. A stale clone now correctly aborts with a recovery command. EXT_VERSION fallback changed from `"0.5.6"` to `"0.0.0"` so a broken read always triggers the check rather than silently passing.

## [0.5.7] - 2026-04-19

### Fixed
- **Fish shell hook broken on first install.** The previous fish config block used `source` (invalid in fish) to load the POSIX shell hook. Replaced with native fish syntax: sets `$CLAWS_DIR` as a global env var and optionally calls `bass` to source the POSIX hook if available. Fish users no longer land in a broken `claws_worker` state on first install.
- **shell-hook.sh existence guard.** Installer now hard-fails if `shell-hook.sh` is absent from `$INSTALL_DIR/scripts/` before attempting injection, surfacing incomplete clones early.
- **No-op source removed from installer end.** The trailing `source "$INSTALL_DIR/scripts/shell-hook.sh"` ran in a subshell and exported nothing to the user's shell. Replaced with an explicit `info` message to open a new terminal.
- **Dead code removed from preflight.** `detect_ext_dir()` function and `EXT_DIR` variable were defined but never referenced; removed entirely.
- **npm minimum version enforced.** Installer now requires npm 7+ and aborts with a clear upgrade command (`npm install -g npm`) if the detected version is older.
- **nvm/fnm hints when node is missing.** If `node` is not found and `~/.nvm` or `~/.fnm` exists, installer surfaces the exact command to activate the version manager before failing.
- **Windows guard added.** Git Bash / MSYS / Cygwin environments now get an immediate `die` with a WSL2 redirect instead of failing mid-install on Unix-specific operations.
- **Architecture logged in preflight.** `uname -m` output (`x86_64` / `arm64`) now appears in the preflight summary — essential context for diagnosing node-pty ABI mismatches.
- **`EXPECTED_MIN_VERSION` is now dynamic.** Previously hardcoded to a static string at script-release time; now read from `extension/package.json` at runtime so version drift between the script and the manifest is impossible.
- **vsce output routed to `$CLAWS_LOG`.** VSIX packaging errors were silently swallowed (`>/dev/null 2>&1`). Now appended to the install log file so failures are inspectable without re-running with verbose flags.
- **Publisher field pre-checked before VSIX packaging.** If `extension/package.json` is missing the `publisher` field, `vsce` fails with an opaque error. Installer now checks the field and warns early.
- **VSIX size sanity check.** A packaged VSIX under 50 KB is almost certainly missing the native binary (`!native/**` absent from `.vscodeignore`). Installer now rejects suspiciously small VSIXes rather than installing a broken extension.
- **`.mcp.json` validated after write.** The node script that writes `.mcp.json` is now followed by a `JSON.parse` check; invalid JSON emits `bad` messages pointing to the log before continuing.
- **`.claws/` added to project `.gitignore` automatically.** If the project `.gitignore` exists but doesn't contain `.claws/`, the installer appends it.
- **`inject-claude-md.js` existence guard.** Before invoking `inject-claude-md.js`, the installer now checks both candidate paths and skips with a `warn` if neither exists, rather than crashing.
- **Shell hook verification before final banner.** Installer now checks `~/.zshrc`, `~/.bashrc`, and `~/.bash_profile` for the hook marker and warns if none is found, prompting the user to source it manually.

## [0.5.6] - 2026-04-18

### Fixed
- **VSIX never installed (regression in v0.5.5).** The v0.5.5 rewrite of the build section forgot to set `BUILD_OK=1` after a successful `npm run build`, so the condition at line 486 (`[ "${BUILD_OK:-0}" = "1" ]`) was always false. Every user was silently getting the symlink fallback — VSIX install was completely bypassed.
- **git pull --ff-only failed silently AND printed a green checkmark anyway.** On a dirty `~/.claws-src/` (local changes, diverged history, offline), `git pull --ff-only` would fail, `warn` would fire, and then `ok "updated"` would print unconditionally on the next line. Replaced with `git fetch origin main && git reset --hard origin/main`. On failure, installer now hard-exits with a concrete recovery command (`rm -rf ~/.claws-src && re-run`).
- **Version stale check warned and continued.** When git fetch/reset updated `~/.claws-src/` to a newer version, the old `EXPECTED_MIN_VERSION` check would detect a mismatch and warn — but then continue with the stale code. Now dies with the recovery command instead of silently shipping v0.4.0 while the banner says v0.5.6.
- **Linux Electron detection completely absent from bundle-native.mjs.** On Linux, `detectElectronVersion()` had no detection logic and fell straight to the hardcoded fallback (`39.8.5`). VS Code on modern Ubuntu typically ships Electron 30–35, so every Linux user got the wrong ABI → pipe-mode. Added detection via VS Code's bundled `electron` binary at known Linux install paths (`/usr/share/code/electron`, `/opt/visual-studio-code/electron`, `/snap/code/current/electron`, etc.).

## [0.5.5] - 2026-04-18

### Fixed
- **Pipe-mode-after-install bug eliminated for good.** Previously, `scripts/install.sh` had two separate node-pty handling paths: `npm run build` (which runs `bundle-native.mjs` → `@electron/rebuild` → copies the ABI-correct binary into `extension/native/node-pty/`) AND a *second, redundant* `@electron/rebuild` run against `node_modules/node-pty/` whose output never made it into the VSIX. If `npm run build` failed silently, the installer fell back to legacy JS, packaged a VSIX without a working `native/node-pty/build/Release/pty.node`, and the extension landed in pipe-mode — exactly what Miles was seeing. The installer now has ONE canonical build path: `npm run build`. If it fails, the installer aborts with a concrete diagnostic (Xcode CLT missing, @electron/rebuild network failure, node-gyp error) instead of shipping a broken VSIX. After the build, it hard-verifies `native/node-pty/build/Release/pty.node` exists and reports which Electron version it was built for; if the binary is missing, install aborts rather than completing "successfully" with a VSIX that can't load node-pty.
- **Pre-flight Xcode Command Line Tools check on macOS.** `@electron/rebuild` needs a C compiler. The installer now checks `xcode-select -p` up front and aborts with the exact recovery command (`xcode-select --install`) before wasting the user's time attempting a build that cannot succeed.
- **`npm run build` output is no longer silent during install.** The previous `--silent` flag hid `@electron/rebuild` progress and compile errors, turning every native build failure into an invisible "falling back to legacy JS" warn. Users now see the bundle-native.mjs output on screen and in `$CLAWS_LOG`, so diagnosing a broken build is a copy-paste away.

### Removed
- Redundant second `@electron/rebuild` run against `node_modules/node-pty/` in `install.sh`. `bundle-native.mjs` is the single source of truth for the ABI-correct binary; the duplicated rebuild only rebuilt a directory the VSIX didn't ship and masked `bundle-native.mjs` failures.

### Migration notes
- Users affected by pipe-mode just need to re-run the curl install once. The v0.5.5 installer will either produce a working VSIX (binary present, Electron version matches) or abort with a concrete next step — no more invisible failures.

## [0.5.4] - 2026-04-18

### Fixed
- **Shell hook injection now self-heals on every install/update.** The old `inject_hook` in `scripts/install.sh` only *added* a `source /path/to/shell-hook.sh` line when no `# CLAWS terminal hook` marker was present; it never removed stale entries. Users who ran the installer under a different `CLAWS_DIR` (e.g. pointing at a project root during testing) ended up with broken `.zshrc` lines like `source:31: no such file or directory: /Users/miles/renew/scripts/shell-hook.sh` that fired on every new shell. The function now strips any existing `# CLAWS terminal hook` marker plus the following line via `sed`, then appends a fresh entry using the current `INSTALL_DIR`. If a stale path was removed, the banner reports `refreshed in .zshrc (removed stale path)` so the fix is visible.
- **Fish shell config is now idempotent too.** `~/.config/fish/conf.d/claws.fish` was only written when absent, leaving stale `INSTALL_DIR` references alive across reinstalls. The installer now overwrites it unconditionally so fish stays in sync with the zsh/bash hooks.

### Migration notes
- Users affected by stale `.zshrc` / `.bashrc` / `.bash_profile` lines just need to re-run the curl install once. The v0.5.4 installer deletes the broken line and installs a fresh one in the same pass — no manual editing of dotfiles required.

## [0.5.3] - 2026-04-18

### Changed
- **Extension install path switched from symlink to `code --install-extension <vsix>`.** When VS Code's CLI is available, the installer now packages the extension as a `.vsix`, runs `code --install-extension --force` for every detected editor (VS Code, Cursor, Insiders, Windsurf), and VS Code itself handles extension registration and shows its standard "Reload to activate?" toast in any running window. Single-click activation vs the old "hope VS Code noticed the symlink" pattern.
- **Install banner reports the install method** explicitly: `(method: vsix)` or `(method: symlink)` so users know which code path landed.

### Added
- `CLAWS_DEV_SYMLINK=1` env var forces symlink install (developer workflow — edit TypeScript → reload → test without re-packaging).
- Detects editor CLIs in both `$PATH` and macOS app bundles (`/Applications/<Editor>.app/Contents/Resources/app/bin/<cli>`) so VSIX install works even when the user never ran "Shell Command: Install 'code' in PATH".
- Symlink install remains as fallback when VSIX packaging fails, when `npx` is unavailable, or when `CLAWS_DEV_SYMLINK=1` is set. Never silent — the banner shows which path was used.

### Fixed
- The previous symlink-only install required users to manually `Developer: Reload Window` and hope VS Code picked up the new symlink. VSIX install via `code --install-extension` means VS Code proactively notices the extension and prompts the user via its own toast.

### Migration notes
- Re-run the curl install once. The new installer will package a VSIX, call `code --install-extension --force`, and VS Code will show a reload toast in any open window (or auto-load on next open). No change needed in how you invoke `/claws-update` or the install curl URL.
- Works now because Phase 2 (v0.4.0) moved `node-pty` from `node_modules/` to `native/node-pty/` — `vsce package` used to strip `node_modules/` and break the runtime load, but `.vscodeignore` allows `!native/**` through so the VSIX now contains the ABI-correct binary.

## [0.5.2] - 2026-04-18

### Fixed
- **Stale-clone bug (critical)** — The installer's `git pull --ff-only --quiet || warn` allowed a failed fetch (dirty tree, diverged history, network hiccup) to fall through to "✓ updated" without actually updating `~/.claws-src/`. Users ended up running the installer against stale source and seeing banners like "Terminal Control Bridge v0.4.0 — installed" even though main was at v0.5.1. Replaced with `git fetch origin main && git reset --hard origin/main`, with an explicit SHA-transition log line (`✓ already at origin/main (abc1234)` or `✓ updated abc1234 → def5678`).
- **Stale-version detection in step 2b** — The installer now compares the extension's actual `package.json` version against an `EXPECTED_MIN_VERSION` pinned at script-release time. If the working tree is older than what this installer expects, the installer prints a loud warning with the recovery command (`rm -rf ~/.claws-src && re-run`).
- **Installer failure modes made explicit** — `git fetch` failing now prints a concrete diagnostic suggesting offline/diverged causes; `git reset --hard` failing prints a clean-slate recovery command and exits rather than continuing with broken state.

### Migration notes
- This is a transparent upgrade — users on v0.5.0 / v0.5.1 just need to re-run the curl install command. The new installer force-resets their `~/.claws-src/` to match origin/main.
- If your `~/.claws-src/` had local edits (unlikely but possible), they'll be lost by the reset. `~/.claws-src/` is not meant to be edited by hand; do development in a separate clone.

## [0.5.1] - 2026-04-18

### Added
- **Extension copy in every project** — `install.sh` now copies the built VS Code extension (`dist/`, `native/`, `package.json`, `README`, `CHANGELOG`) into `<project>/.claws-bin/extension/` on every install and update. Purely for visibility — VS Code still loads the extension from the user-level install at `~/.vscode/extensions/neunaha.claws-<version>`, not from this copy. Size: ~300–400 KB per project. Opt out with `CLAWS_SKIP_EXTENSION_COPY=1`.
- **`.claws-bin/README.md`** — auto-generated in every project. Documents what each file in `.claws-bin/` does, explains why the extension lives at user-scope (VS Code design), provides gitignore guidance, and includes install + update curl URLs for teammates.
- **Verify step** now reports the presence of the project-local extension copy + the `README.md`.

### Changed
- **End-of-install banner rewritten** — the post-install instructions are now a single action: **Reload VS Code**. The Claude Code restart step is no longer called out as a separate required action; new `claude` sessions auto-pick-up `.mcp.json` without manual restart (only users mid-session in a pre-install Claude Code need to restart, which is their natural lifecycle anyway).
- Banner now prints the exact extension symlink path (`~/.vscode/extensions/neunaha.claws-<version>`) AND the project-local visible copy path, so users can see both where VS Code loads from and where the files live in their project.

### Migration notes from v0.5.0
- No code changes required. Next `/claws-update` automatically gets the extension copy and README. Existing project files (`.mcp.json`, `.claude/`, `CLAUDE.md`) are untouched.
- If you want to opt out of the extension copy (disk-sensitive projects, etc.): set `CLAWS_SKIP_EXTENSION_COPY=1` before running install/update. The extension still installs at user-scope.
- The new files are safe to commit (~300 KB total) OR gitignore — see `<project>/.claws-bin/README.md` for guidance.

## [0.5.0] - 2026-04-18

### Architecture
- **Phase 6 hardening sweep** — server, core modules, and extension polish landed in two passes (6A + 6B). Net result: 57 automated checks (up from 22 in v0.4.0), full async deactivate lifecycle, runtime-readable server config, stable UUID-based profile adoption, and a marketplace-ready command surface.
- **`server-config.ts` provider pattern** — the socket server no longer holds hard-coded values for exec-timeout / poll-limit. Extension-level code passes a `ServerConfigProvider` closure that reads live from `vscode.workspace.getConfiguration('claws')` on every request, so `settings.json` edits take effect without a window reload.
- **`IntrospectProvider` pattern** — the new `introspect` protocol command is powered by a provider passed into the server, keeping `server.ts` free of any direct `vscode` import. One snapshot shape is consumed by both the CLI-via-socket path and the in-UI Health Check command.
- **UUID-based profile adoption** — wrapped terminals spawned via the `+` dropdown now embed a crypto-random UUID token in the terminal name (visible as `Claws Wrapped N · abcd1234 [full-uuid]`). Match-on-open is by UUID, not numeric id, eliminating the race where two simultaneous profile provisions could bind to each other's PTY.

### Added
- **`introspect` socket command** — returns `extensionVersion`, `nodeVersion`, `electronAbi`, `platform`, `nodePty: { loaded, loadedFrom, error }`, `servers: [{ workspace, socket }]`, `terminals`, `uptime_ms`. Feeds both the MCP client diagnostics and the in-UI Health Check.
- **`Claws: Uninstall Cleanup` command** — scans open workspace folders, inventories Claws-installed files (`.mcp.json` claws entry, `.claws-bin/`, `.claude/commands/claws-*.md`, skill directories, `.vscode/extensions.json` recommendations, `CLAUDE.md` fenced block), shows a per-folder confirmation, removes only what was actually installed, and writes a summary to the Output channel. Reversible-by-git, destructive-outside-git — modal warning before every removal.
- **Status bar item** — right-aligned, priority 100, shows `$(terminal) Claws (N)` where N is the live terminal count. Tooltip is a rich `MarkdownString` with socket list, node-pty status, and version. Click → Health Check. Color shifts to warning-yellow in pipe-mode, error-red when no server is running. Auto-refreshes every 30s via `unref`'d interval.
- **Command palette `Claws:` grouping** — every contributed command now has an explicit `"category": "Claws"`, so the palette renders them as one cluster.
- **Keybindings** (chord, non-intrusive): `ctrl+alt+c h` / `cmd+alt+c h` → Health Check; `ctrl+alt+c l` / `cmd+alt+c l` → Show Log; `ctrl+alt+c s` / `cmd+alt+c s` → Show Status.
- **`claws.statusBar` command** — manual refresh + re-show hook for the status bar item; useful after a theme swap or a window focus cycle.
- **Version-mismatch detection** — when a client request includes `clientVersion`, the server compares against the running extension version and logs a one-shot warning to the Output channel on drift ≥ 1 minor release. MCP server version is also displayed in the Health Check by reading `<workspace>/.claws-bin/package.json` or parsing a `version: 'x.y.z'` literal from the MCP source.
- **`onCommand:` activationEvents** — `claws.healthCheck`, `claws.showLog`, `claws.status`, `claws.statusBar`, `claws.listTerminals`, `claws.rebuildPty`, `claws.uninstallCleanup` are all registered as activation triggers alongside `onStartupFinished`, so users can invoke diagnostic commands even if the startup activation was skipped.
- **Two new test suites** — `test/profile-provider.test.js` (6 checks: provider registration, UUID match-on-open, concurrent provision safety, socket-visible adoption) and `test/multi-connection.test.js` (8 checks: 3 concurrent connections × 3 interleaved requests, per-connection rid correlation, introspect shape). Run via `npm run test:profile` and `npm run test:multiconn`.
- **Phase 6A checks** (already landed, recapped here for completeness): oversized-line defense + fresh-connection-still-alive probe, capture-store ring-buffer trim + stripAnsi coverage, config hot-reload, pty lifecycle (`mode`, `hasOpened`, `ageMs`, sanitizeEnv), orphan-PTY scan timer in `TerminalManager.dispose()`, and protocol-tag rejection.

### Changed
- **`displayName`** bumped from `"Claws — Terminal Control Bridge"` to `"Claws: Programmable Terminal Bridge"`. Clearer marketplace positioning; leads with the outcome ("programmable") rather than the mechanism ("bridge").
- **`claws.status`** emits a markdown-style status block with section headers (`# Claws Status`, `## Sockets`, `## Runtime`) instead of a single-line dump. Renders well in the Output channel and copies cleanly into bug reports.
- **`claws.listTerminals`** now opens a VS Code QuickPick with each terminal as a selectable item (`id · name · wrapped(pty)/unwrapped · pid`). Selecting an item calls `terminal.show()` on it. Falls through to an info message when no terminals are open.
- **`deactivate()` is now async** — returns `Promise<void>`. Stops every server in the `servers` Map, calls `TerminalManager.dispose()` to clear the orphan-PTY scan timer, disposes every pending profile PTY, disposes the status bar item and its refresh timer, disposes the Output channel, and logs a final state line (`N/M sockets closed`). Wrapped in a `Promise.race` with a 3-second ceiling so a slow dispose can't hang VS Code shutdown.
- **Extension `version`** bumped to `0.5.0`. Root `package.json` (`claws-cli`) and `mcp_server.js` `serverInfo.version` also bumped to `0.5.0` for parity.

### Fixed
- **#6 — createWrapped vs profile-provider name collision.** Name-based match-on-open was brittle when two provisions ran concurrently (both could use "Claws Wrapped 3" before the id increment landed). Now every pending profile carries a UUID token in its name; `onDidOpenTerminal` matches by full-UUID substring. The orphan-timeout path is preserved.
- **#13/#14 — unwired `ServerOptions.getConfig`.** Phase 6A shipped the hook but the extension never passed a value in. v0.5.0 wires it to `cfg('execTimeoutMs', …)` / `cfg('pollLimit', …)`.
- Test mocks updated to cover the new `vscode.window.createStatusBarItem`, `MarkdownString`, `ThemeColor`, and `StatusBarAlignment` surface area. Existing tests continue to pass against both sync and async `deactivate()` call shapes.

### Deprecated
- Nothing newly deprecated in 0.5.0. The 0.4.0-era deprecations (`scripts/terminal-wrapper.sh`, `extension/src/extension.js`) remain — both are scheduled for removal once the Pseudoterminal path has been marketplace-published.

### Migration notes for v0.4 users
- The new `Claws: Uninstall Cleanup` command is OPT-IN — it never runs automatically. It's safe to ignore unless you're actually removing Claws from a project.
- Keybindings are added; if you already have `ctrl+alt+c`-prefixed chords bound to something else, VS Code will surface the conflict in `Keyboard Shortcuts`. Override ours there; the extension will still work without them.
- The status bar item is visible by default. To hide it, right-click the status bar and uncheck "Claws".
- If you were consuming `deactivate()` externally (unit tests, harness scripts), it now returns a Promise. `await ext.deactivate()` is the correct invocation. Calling without `await` still works but the 100ms sleep you may have used to drain teardown is now strictly unnecessary.
- `claws.listTerminals` used to dump to the Output channel; it now opens a QuickPick. If you had a keybinding or macro that expected Output-channel output, use the new `claws.status` which still renders a textual block.

## [0.4.0] - 2026-04-18

### Architecture
- **Extension rewritten in TypeScript** — 8 modular files (`extension.ts`, `server.ts`, `terminal-manager.ts`, `claws-pty.ts`, `capture-store.ts`, `protocol.ts`, `safety.ts`, `ansi-strip.ts`), strict mode, esbuild bundle → `dist/extension.js`.
- **Pseudoterminal replaces `script(1)` wrapping** — wrapped terminals now run under VS Code's native `vscode.Pseudoterminal` with `node-pty` (or `child_process` pipe-mode fallback). Fixes TUI rendering corruption in Claude Code, vim, htop, k9s, and other Ink/ncurses apps.
- **In-memory ring buffer replaces file-tailing** for `readLog` on Pseudoterminal-backed terminals. No more `.claws/terminals/*.log` files for new wrapped terminals; the buffer is configurable via `claws.maxCaptureBytes` (default 1 MB per terminal).

### Added
- **Blocking `claws_worker` lifecycle** — one tool call runs the full worker flow: spawn wrapped terminal → optional Claude Code boot with `boot_marker` detection → send mission → poll capture buffer for `complete_marker` / `error_markers` → harvest last N lines → auto-close → return structured result with `status`, `duration_ms`, `marker_line`, `cleaned_up`, `harvest`. Configurable via `timeout_ms`, `boot_wait_ms`, `poll_interval_ms`, `harvest_lines`, `close_on_complete`. Legacy fire-and-forget behavior via `detach: true`.
- **Project-local install** — `scripts/install.sh` now writes into the current project root as the primary target:
  - `<project>/.mcp.json` — registers Claws MCP server with relative path `./.claws-bin/mcp_server.js`
  - `<project>/.claws-bin/{mcp_server.js,shell-hook.sh}` — self-contained, no dependency on `~/.claws-src`
  - `<project>/.claude/commands/` — all 19 `claws-*` slash commands
  - `<project>/.claude/rules/claws-default-behavior.md`
  - `<project>/.claude/skills/{claws-orchestration-engine,claws-prompt-templates}/`
  - Global `~/.claude/*` install is now opt-in via `CLAWS_GLOBAL_CONFIG=1` and `CLAWS_GLOBAL_MCP=1`.
- **Dynamic CLAUDE.md injection** — fenced with `<!-- CLAWS:BEGIN --> ... <!-- CLAWS:END -->`. Block content is generated at install time (lists actually-installed tools and slash commands). Re-install replaces only the fenced section, preserving every other line of the project's CLAUDE.md.
- **Automatic legacy CLAUDE.md migration** — on upgrade, the installer strips the old `## CLAWS — Terminal Orchestration Active` section (v0.1–v0.3) before inserting the new fenced block. Original project content on either side of the old section is preserved.
- **Extension test suite** — `extension/test/smoke.test.js` (5 checks: bundle load, socket server, protocol, cleanup) and `extension/test/worker.test.js` (6 checks: blocking lifecycle, marker detection, detach mode) — both run via `npm test`.
- **Big end-of-install ASCII banner** with 3-step activation guidance (reload VS Code → restart Claude Code → `/claws-help`) and troubleshooting pointer (`/claws-fix`).

### Changed
- Extension entry point: `main` now points at `./dist/extension.js` (built from TypeScript). Legacy `./src/extension.js` is preserved as a fallback; the installer repoints `main` to it if the TypeScript build fails.
- Install verification expanded from 4 to 10 checks; MCP handshake test uses a portable Node driver (no dependency on GNU `timeout`, works on macOS out of the box).
- `extension/package.json` adds `devDependencies` (`typescript`, `esbuild`, `@types/vscode`, `@types/node`) and `optionalDependencies` (`node-pty`). Pure Node stdlib remains the only runtime requirement.

### Deprecated
- `scripts/terminal-wrapper.sh` — kept for v0.1–v0.3 compatibility but unused by new Pseudoterminal-backed wrapped terminals. Will be removed in v0.5.
- `extension/src/extension.js` (legacy JS) — kept as fallback; will be removed once Pseudoterminal path is marketplace-published.

### Migration notes for v0.3 users running `/claws-update`
- Your project gets a new `.mcp.json`, `.claws-bin/`, and project-local `.claude/` — safe to commit or gitignore per your preference.
- CLAUDE.md's legacy Claws section is automatically stripped and replaced with the new fenced block. Expect to see `CLAUDE.md legacy section migrated; Claws block inserted` during install.
- The old global `~/.claude/settings.json` claws MCP entry remains but becomes inactive when the project-local `.mcp.json` takes precedence. Safe to leave or remove manually.
- `claws_worker` return-text format changed. If you had automation parsing the old output (`worker 'X' spawned with Claude Code...`), it will need updating. The new format leads with `worker 'X' COMPLETED|FAILED|TIMEOUT` followed by structured fields and a `── harvest (last lines) ──` section.

## [0.3.0] - 2026-04-14

### Changed
- MCP server rewritten from Python to Node.js — zero dependencies
- Install no longer requires Python, pip, or brew
- Shell hook commands rewritten from Python to Node.js

### Removed
- Python dependency from install path (Python client remains as optional)

## [0.2.0] - 2026-04-18

### Added
- **MCP Server** — register once, every Claude Code session gets 8 terminal control tools natively
- **Orchestration Engine skill** — 7 patterns (scout, single worker, parallel fleet, AI session driver, pipeline stages, watchdog, orchestrator with delegation)
- **Lifecycle YAML protocol** — 8-phase terminal lifecycle (plan → spawn → deploy → observe → recover → harvest → cleanup → reflect)
- **Prompt engineering guide** — `/claws-help` with 5 levels from beginner to power user
- **Default behavior rule** — Claude prefers visible Claws terminals over silent Bash
- **CLAUDE.md injection** — installer appends Claws orchestration context to project CLAUDE.md
- **Shell hook** — every terminal shows CLAWS banner with bridge status + 4 shell commands (claws-ls, claws-new, claws-run, claws-log)
- **Auto-launch Claude Code** — `claws_worker` auto-starts `claude --dangerously-skip-permissions` in worker terminals
- **Click-to-copy install prompt** on landing page
- **npx claws-cli** — Node.js CLI installer with `claude mcp add` support
- **11 slash commands** — /claws-help, /claws-install, /claws-update, /claws-status, /claws-connect, /claws-create, /claws-send, /claws-exec, /claws-read, /claws-worker, /claws-fleet
- **7 prompt templates** — single worker, analysis, multi-commit, pair programming, parallel fleet, graphify-driven, error recovery
- **6 cinematic capability images** — terminal mgmt, pty capture, exec, safety gate, MCP, cross-device
- **GitHub Pages landing page** — full website with carousels, stats, animations, case studies
- **Cross-platform installer** — bash (macOS/Linux) + PowerShell (Windows), auto-detects VS Code/Cursor/Windsurf
- **Live demo test script** — spawns 3 parallel workers to prove orchestration works

### Fixed
- Linux `script(1)` compatibility — auto-detects BSD vs GNU arg order
- Shell injection in `claws-run` — commands passed via temp file, not interpolated
- `nc -U` dependency removed — all shell commands use Python sockets
- Install step numbering consistent [1/8] through [8/8]
- MCP server tilde path warning in docs
- Installer never exits — `set +e`, all checks are warnings not blockers
- `pip` install uses `python -m pip` with `--break-system-packages` for macOS compatibility

### Changed
- `/claws-update` is now a full rebuild (re-runs entire installer), not just git pull

## [0.1.0] - 2026-04-17

### Added
- Initial release
- Unix socket server with newline-delimited JSON protocol
- Terminal management: list, create, show, send, close
- Wrapped terminals via `script(1)` for full pty capture
- `readLog` command with ANSI stripping
- `exec` command with file-based output capture
- `poll` command for shell-integration event streaming
- Safety gate: foreground process detection + warnings for non-shell TUIs
- Bracketed paste mode for multi-line sends
- "Claws Wrapped Terminal" dropdown profile
- Python client library (`claws-client`)
- Example scripts: basic orchestrator, parallel workers

- docs(architecture) — comprehensive ARCHITECTURE.md as the canonical anchor: charter, 10 architectural principles (event-driven only, atomic writes, hooks safety, no orchestrator-side patches, etc.), full system layer map, protocol specs, lifecycle architecture, 5-layer enforcement chain, test invariants, anti-patterns catalog (10 burned-in lessons), known gaps + roadmap, and an anchoring protocol for future PRs.
- fix(v0.7.10) — worker-fixes-v079.test: sync scanText check to detectCompletion(scanText,opt) (replaces scanText.includes pattern removed when findStandaloneMarker was introduced); restore 17/17 pass.
- fix(v0.7.10) — claws-v2-vehicle-state.test: add workerMode:single+expectedWorkers:1 to lifecycle.plan call and lifecycle.advance to SPAWN before create (canSpawn gate, schema v3 required fields).
- fix(v0.7.10) — lifecycle-store.ts: add M-43 sentinel comment to flushToDisk() (fsyncSync-before-renameSync parity with M-29; fixes lifecycle-store-fsync test).
- feat(v0.7.10) — scripts: install.sh dev-mode symlink branch (eliminates source/.claws-bin drift), F-11 .electron-abi cache, dynamic EXPECTED_MIN_VERSION, .gitignore auto-additions, backup pruning; install.ps1 stub directs Windows to WSL2; update.sh Linux Electron ABI detection + BUG-28 health check; uninstall.sh idempotent 5-step removal.
- feat(v0.7.10) — templates: CLAUDE.global.md + CLAUDE.project.md add capabilities:[push] requirement (BUG-03), worker.<peerId>.heartbeat correction (BUG-06), Sidecar mandatory section, Monitor mandatory section.
- docs(v0.7.10) — commands + skills aligned with non-blocking defaults: claws-army/fleet/wave-lead/worker.md document fire/poll/audit pattern; claws-orchestration-engine SKILL upgraded to 10-phase ring; wave-lead/wave-subworker SKILLs add Monitor arm step 0 + BUG-03/06/10 fixes. New /claws-install command. New claws-prompt-templates SKILL library. New .claude/rules/ dir. README tool count synced 14→38.
- fix(v0.7.10) — test fixture sync: lifecycle-server.test now expects [SESSION-BOOT, PLAN]; reverse-channel.test calls lifecycle.advance to SPAWN; server-validation.test expects payload:invalid; worker-fixes-v079.test regex syncs for detach !== false + findStandaloneMarker. Removes unused Phase import (lifecycle-engine.ts) and dead _requireCapability method (server.ts).
- test(v0.7.10) — non-blocking-defaults (10 checks: detach !== false default, withMaxHold 8s ceiling) and sidecar-enforcement (18 checks: _ensureSidecarOrThrow guards all 4 spawn handlers, singleton dedup, read-only handlers ungated). Both pass.

- **chore(v0.7.10)**: Wave C precursor work landed — pre-tool-use hook fail-closed (BUG-16 argv0 allowlist, BUG-27 mcp_server.js edit gate, BUG-28 spawn-class Monitor arm gate); session-start spawns sidecar + emits "FIRST ACTION arm Monitor" reminder; stop hook kills sidecar + orphan tails + grace file; inject-settings-hooks.js registers four explicit per-tool PreToolUse matchers (claws_create/worker/fleet/dispatch_subworker) as belt-and-suspenders.
- **test(v0.7.10)**: Two new regression suites — non-blocking-defaults (10 checks: detach !== false default, withMaxHold 8s ceiling) and sidecar-enforcement (18 checks: _ensureSidecarOrThrow guards all 4 spawn handlers, singleton dedup, read-only handlers ungated). Both pass.
- **fix(v0.7.10)**: Test fixture sync — lifecycle-server now expects [SESSION-BOOT, PLAN]; reverse-channel calls lifecycle.advance to SPAWN; server-validation expects payload:invalid (not envelope:invalid); worker-fixes-v079 regex updates for detach !== false + findStandaloneMarker. Removes unused Phase import from lifecycle-engine.ts and dead _requireCapability method from server.ts.
- **docs(v0.7.10)**: Slash commands + skills aligned with non-blocking defaults — claws-army/fleet/wave-lead/worker.md document fire/poll/audit pattern; claws-orchestration-engine SKILL upgraded to 10-phase ring with mode-fork spawn table; wave-lead/wave-subworker SKILLs add Monitor arm step 0, BUG-03 capabilities:[\'push\'] workaround, BUG-06 worker.<peerId>.heartbeat fix, BUG-10 drain-and-wait LEAD harvest. New /claws-install command. New claws-prompt-templates SKILL library. README tool count synced 14→38; uninstall section rewritten; Windows section directs to WSL2.
- **feat(v0.7.10)**: Templates updated — CLAUDE.global.md + CLAUDE.project.md add capabilities:[\'push\'] requirement (BUG-03), worker.<peerId>.heartbeat correction (BUG-06), Sidecar mandatory section, Monitor mandatory section with lifecycle-bound description pattern.
- **feat(v0.7.10)**: Scripts — install.sh dev-mode symlink branch (eliminates source↔.claws-bin drift), F-11 .electron-abi cache, dynamic EXPECTED_MIN_VERSION from package.json, .gitignore auto-additions, backup pruning (3 most recent); install.ps1 stub directs Windows to WSL2; update.sh adds Linux Electron ABI detection + BUG-28 health check; uninstall.sh idempotent 5-step removal.
