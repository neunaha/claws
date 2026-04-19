# Changelog

All notable changes to Claws will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
