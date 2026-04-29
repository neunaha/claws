# Changelog

All notable changes to Claws will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.4-bulletproof-L2] - 2026-04-29 — Layer 2: install.sh data-loss + atomicity fixes (M-01, M-02, M-09, M-17, M-27–M-30)

### Fixed

- **M-01** `scripts/install.sh inject_hook`: removed generic `/source .../shell-hook\.sh/` awk regex that stripped non-Claws tool hooks (oh-my-zsh, asdf, custom dotfiles). awk now strips ONLY lines inside a `# CLAWS terminal hook` marked block. Added timestamped dotfile backup (`$rcfile.claws-bak.<ISO-ts>`) before any modification.
- **M-02** `scripts/install.sh` `.mcp.json` merge: replaced `try{}catch{}` reset-to-`{}` pattern with `mergeIntoFile()` from `scripts/_helpers/json-safe.mjs`. On parse failure: backup created, original untouched, install.sh exits non-zero with actionable message. Never silently wipes other MCP servers.
- **M-09** `scripts/install.sh` `.claws-bin/hooks/` copy: replaced `rm -rf + cp` with atomic rename pattern via `copyDirAtomic()` from `scripts/_helpers/atomic-file.mjs`. Kill-window now leaves either full old hooks or full new hooks — never an empty dir.
- **M-17** `scripts/install.sh inject_hook`: fixed awk empty-file edge case. When `.zshrc` contains ONLY the Claws block, awk output is empty; the old `[ -s "$tmp" ]` guard prevented promotion, leaving original intact and causing duplicate blocks on next install. Now always promotes awk output when awk succeeds.
- **M-27** `scripts/inject-claude-md.js`: replaced `fs.writeFileSync` with atomic write pattern (tmp + rename) — prevents partial project `CLAUDE.md` on kill mid-write.
- **M-28** `scripts/inject-global-claude-md.js`: same atomic write for `~/.claude/CLAUDE.md` — machine-wide config corruption on power-cut prevented.
- **M-29** `scripts/hooks/lifecycle-state.js writeState()`: replaced `fs.writeFileSync` with atomic tmp+rename pattern — mirrors `extension/src/lifecycle-store.ts` which was already atomic. Prevents partial lifecycle-state.json on hook kill.
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
