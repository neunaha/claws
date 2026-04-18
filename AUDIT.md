# Claws v0.3.0 Comprehensive Audit

Audited: 2026-04-14
Scope: Every file on the install path, user journey trace, broken links, missing files.

---

## PART 1 — DEPENDENCY AUDIT (Python/pip/brew on Install Path)

The v0.3.0 goal: zero Python on the mandatory install path.

| File | Verdict | Notes |
|---|---|---|
| `scripts/install.sh` | **CLEAN** | No python/pip. One `brew install node` reference on line 78, but it is a *help text suggestion* for users who lack Node.js — not an install-path dependency. Acceptable. |
| `scripts/install.ps1` | **CLEAN** | Pure PowerShell + git + node. No python/pip/brew anywhere. |
| `scripts/shell-hook.sh` | **CLEAN** | All socket communication uses inline `node -e`. Zero python. |
| `scripts/test-install.sh` | **CLEAN** | All test logic is inline `node -e`. Zero python. |
| `scripts/terminal-wrapper.sh` | **CLEAN** | Pure bash + `script(1)`. No python/node/brew. |
| `cli.js` | **CLEAN** | Pure Node.js, zero python references. |
| `mcp_server.js` | **CLEAN** | Pure Node.js, zero python references. |
| `extension/src/extension.js` | **CLEAN** | Pure VS Code API + Node.js stdlib. |
| `extension/package.json` | **CLEAN** | No python/pip/brew. |
| `rules/claws-default-behavior.md` | **CLEAN** | No python references. |
| `templates/CLAUDE.claws.md` | **CLEAN** | No python references. |
| `.claude/commands/claws.md` | **CLEAN** | Uses bash only. |
| `.claude/commands/claws-do.md` | **CLEAN** | No code blocks — pure Claude instructions. |
| `.claude/commands/claws-go.md` | **CLEAN** | No code blocks — uses MCP tool names. |
| `.claude/commands/claws-help.md` | **CLEAN** | Text guide only. |
| `.claude/commands/claws-setup.md` | **CLEAN** | Calls install.sh via bash. |
| `.claude/commands/claws-update.md` | **CLEAN** | Calls install.sh via bash. Note: line 38 mentions "macOS pip errors resolved" in a sample changelog summary — cosmetic only, not functional. |
| `.claude/commands/claws-watch.md` | **CLEAN** | Uses MCP tool names only. |
| `.claude/commands/claws-learn.md` | **CLEAN** | Text guide only. |
| `.claude/commands/claws-cleanup.md` | **CLEAN** | Uses MCP tool names only. |
| `.claude/commands/claws-fleet.md` | **CLEAN** | No python in the command logic itself. |
| `.claude/commands/claws-status.md` | **DIRTY** | Lines 18-29: `python3 -c` block using `socket.AF_UNIX` to list terminals. This is ON the install path (copied to `~/.claude/commands/` by install.sh step 6). Should be rewritten to use `node -e` or the `claws_list` MCP tool call. |
| `.claude/commands/claws-connect.md` | **DIRTY** | Lines 19-34: `python3 -c` block using `socket.AF_UNIX` to verify connection. Should use `node -e` or bash `nc -U`. |
| `.claude/commands/claws-create.md` | **DIRTY** | Lines 15-30: `python3 -c` block to create terminal via socket. Should use `claws_create` MCP tool call or `node -e`. |
| `.claude/commands/claws-send.md` | **DIRTY** | Lines 13-21: `python3 -c` block to send text. Should use `claws_send` MCP tool. |
| `.claude/commands/claws-read.md` | **DIRTY** | Lines 13-29: `python3 -c` block to read log. Should use `claws_read_log` MCP tool. |
| `.claude/commands/claws-exec.md` | **DIRTY** | Lines 15-51: `python3 -c` block for file-based exec. Should use `claws_exec` MCP tool. |
| `.claude/commands/claws-worker.md` | **DIRTY** | Lines 13-22 and 28-35: Two `python3 -c` blocks for create and send. Should use `claws_worker` MCP tool. |

### Summary

**7 slash command files are DIRTY** — they contain `python3 -c` socket code that runs on the install path.

These 7 files (`claws-status`, `claws-connect`, `claws-create`, `claws-send`, `claws-read`, `claws-exec`, `claws-worker`) are copied to `~/.claude/commands/` by install.sh line 227-231. When a user types these slash commands, Claude will attempt to run `python3` and fail on machines without Python.

**Critical fix needed**: Each of these 7 commands should either:
1. Use the MCP tool calls directly (e.g., instruct Claude to call `claws_list` instead of running `python3 -c`)
2. Replace `python3 -c` blocks with `node -e` equivalents
Option 1 is strongly preferred — the MCP tools exist precisely to avoid raw socket code.

**Also notable**: `mcp_server.py` (the old Python MCP server) still exists at the repo root. It should be removed or moved to an `archive/` directory to avoid confusion.

---

## PART 2 — SYNTAX VERIFICATION

| Check | Result |
|---|---|
| `node --check mcp_server.js` | PASS (exit 0) |
| `node --check cli.js` | PASS (exit 0) |
| `node --check extension/src/extension.js` | PASS (exit 0) |
| `bash -n scripts/install.sh` | PASS (exit 0) |
| `bash -n scripts/shell-hook.sh` | PASS (exit 0) |
| `bash -n scripts/test-install.sh` | PASS (exit 0) |
| `bash -n scripts/terminal-wrapper.sh` | PASS (exit 0) |

All 7 checks pass. No syntax errors anywhere.

---

## PART 3 — USER JOURNEY TRACE

### Step 1: New user opens Claude Code and says "install claws from https://github.com/neunaha/claws — run the install script and set up everything"

Claude Code reads the user's request, recognizes it as an install instruction, and runs:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)
```

**What `scripts/install.sh` does (8 steps)**:

**[1/8] Clone** — `git clone https://github.com/neunaha/claws.git ~/.claws-src` (or `git pull` if it already exists). Files land at `~/.claws-src/`.

**[2/8] Extension symlink** — Detects which editor is installed (VS Code > Insiders > Cursor > Windsurf). Creates a symlink: `~/.vscode/extensions/neunaha.claws-0.1.0 -> ~/.claws-src/extension`. Falls back to sudo if permission denied.

**[3/8] Permissions** — `chmod +x` on `scripts/terminal-wrapper.sh`, `scripts/install.sh`, `scripts/test-install.sh`, `mcp_server.js`.

**[4/8] Runtime check** — Prints "No Python required — Claws uses Node.js only".

**[5/8] MCP server registration** — Uses `node -e` to inject into `~/.claude/settings.json`:
```json
{
  "mcpServers": {
    "claws": {
      "command": "node",
      "args": ["~/.claws-src/mcp_server.js"],
      "env": { "CLAWS_SOCKET": ".claws/claws.sock" }
    }
  }
}
```
Creates the file if it doesn't exist, merges if it does.

**[6/8] Context injection** — Multiple substeps:
- Copies `rules/claws-default-behavior.md` to `~/.claude/rules/`
- Appends `templates/CLAUDE.claws.md` to the current project's `CLAUDE.md` (creates it if missing, replaces if already injected)
- Copies `claws-orchestration-engine` skill to `~/.claude/skills/`
- Copies `prompt-templates` skill to `~/.claude/skills/claws-prompt-templates`
- Copies 9 slash commands to `~/.claude/commands/`: `claws-status`, `claws-connect`, `claws-create`, `claws-send`, `claws-exec`, `claws-read`, `claws-worker`, `claws-fleet`, `claws-update`
- Creates the `claws-install` slash command inline

**NOTE**: Only 9 of the 17 command files in `.claude/commands/` are installed. The following 8 are NOT copied: `claws.md`, `claws-do.md`, `claws-go.md`, `claws-help.md`, `claws-learn.md`, `claws-watch.md`, `claws-cleanup.md`, `claws-setup.md`. This is a bug — the user will not have `/claws`, `/claws-do`, `/claws-go`, `/claws-help`, `/claws-learn`, `/claws-watch`, `/claws-cleanup`, or `/claws-setup` available after install.

**[7/8] Shell hook injection** — Appends `source "$HOME/.claws-src/scripts/shell-hook.sh"` to `~/.zshrc` and/or `~/.bashrc`.

**[8/8] Verify** — Checks: extension symlink exists, wrapper is executable, MCP server file exists, Node.js is available. Prints pass count.

**Post-verify**: Immediately sources the shell hook in the current terminal, displaying the Claws banner.

**Files written to the user's machine**:
- `~/.claws-src/` — full repo clone
- `~/.vscode/extensions/neunaha.claws-0.1.0` — symlink
- `~/.claude/settings.json` — MCP server entry added
- `~/.claude/rules/claws-default-behavior.md` — behavior override
- `~/.claude/skills/claws-orchestration-engine/SKILL.md` + `lifecycle.yaml`
- `~/.claude/skills/claws-prompt-templates/SKILL.md`
- `~/.claude/commands/claws-{status,connect,create,send,exec,read,worker,fleet,update,install}.md`
- Current project's `CLAUDE.md` — Claws section appended
- `~/.zshrc` and/or `~/.bashrc` — shell hook line appended

### Step 2: User reloads VS Code (Cmd+Shift+P > Developer: Reload Window)

1. VS Code scans `~/.vscode/extensions/` and finds the `neunaha.claws-0.1.0` symlink pointing to `~/.claws-src/extension/`.
2. Reads `extension/package.json`: `activationEvents: ["onStartupFinished"]` — the extension activates after VS Code fully loads.
3. VS Code calls `extension/src/extension.js` `activate()`:
   - Creates the "Claws" output channel
   - Attaches shell integration listeners (`onDidStartTerminalShellExecution`, `onDidEndTerminalShellExecution`)
   - Starts a Unix socket server at `{workspace}/.claws/claws.sock` (creates the `.claws/` directory)
   - Registers the "Claws Wrapped Terminal" profile provider (appears in the terminal dropdown)
   - Registers two commands: `claws.status` and `claws.listTerminals`
   - Assigns IDs to any already-open terminals
4. Socket file is created with `chmod 600` at `{workspace}/.claws/claws.sock`.

**What the user sees**: No visible UI change. The extension activates silently. To verify, they can open the Output panel (Cmd+Shift+U) and select "Claws" — they should see `[claws] activating` and `[claws] listening on /path/.claws/claws.sock`.

### Step 3: User opens a new terminal

1. The shell starts and sources `~/.zshrc` (or `~/.bashrc`).
2. The sourced `shell-hook.sh` runs:
   - Checks `[[ $- == *i* ]]` — only runs in interactive shells
   - Checks `CLAWS_BANNER_SHOWN` — only shows banner once per shell session
   - Probes the socket (`.claws/claws.sock`) to check if the bridge is live
   - If the socket exists: runs `node -e` to send a `list` command and count terminals
   - Prints the CLAWS banner with:
     - Bridge status: `connected` (green) or `socket not found` (yellow)
     - Terminal count
     - Wrapped status of this terminal: `unwrapped` (this is a regular terminal, not wrapped)
   - Registers 4 shell functions: `claws-ls`, `claws-new`, `claws-run`, `claws-log`

**What the user sees**: The Claws banner appears at the top of the terminal with connection status. If VS Code was reloaded (Step 2), the banner shows `connected` with the terminal count.

### Step 4: User types /claws in Claude Code

1. Claude Code sees `/claws` and looks for `~/.claude/commands/claws.md`.
2. **PROBLEM**: `claws.md` is NOT installed by `install.sh` (it only copies commands listed on line 227: `claws-status claws-connect claws-create claws-send claws-exec claws-read claws-worker claws-fleet claws-update`). The `/claws` command is missing.
3. **If it were installed**: Claude would check for the socket, run `claws_list` MCP tool, and show a status dashboard or guide the user to install.
4. **What actually happens**: Claude Code will not recognize `/claws` as a registered slash command. It may try to interpret it as a natural language request, or show "unknown command."

### Step 5: User types /claws-do run my tests

1. Claude Code looks for `~/.claude/commands/claws-do.md`.
2. **PROBLEM**: `claws-do.md` is NOT installed by `install.sh` either.
3. **If it were installed**: Claude would read the instructions, decide this is a "single command" pattern, create a wrapped terminal via `claws_create` MCP tool, send `npm test` (or the appropriate test command) via `claws_send`, monitor via `claws_read_log`, report results, and close the terminal.
4. **What actually happens**: Not recognized as a slash command. However, because the behavior rule (`claws-default-behavior.md`) IS installed, Claude will likely understand the intent and use the MCP tools correctly anyway — but the slash command itself fails.

**Full MCP tool call chain if it did work**:
1. `claws_create` (name: "worker-tests", wrapped: true) → creates visible terminal, returns ID + logPath
2. Wait 1.5s for shell init
3. `claws_send` (id: returned-id, text: "npm test") → sends command to terminal
4. `claws_read_log` (id: returned-id, lines: 50) → reads test output
5. `claws_close` (id: returned-id) → closes the terminal
6. Reports results to user

### Step 6: User types /claws-go fix the bug in auth.ts

1. Claude Code looks for `~/.claude/commands/claws-go.md`.
2. **PROBLEM**: `claws-go.md` is NOT installed.
3. **If it were installed**: Full trace:
   - `claws_worker` MCP tool called with name="fix-auth", mission="fix the bug in auth.ts. print MISSION_COMPLETE when done. go.", launch_claude=true
   - MCP server (`mcp_server.js`) handles `claws_worker`:
     1. Calls `clawsRpc` to extension → `create` terminal (name="fix-auth", wrapped=true, show=true)
     2. Extension creates a visible terminal using `terminal-wrapper.sh` as the shell, with `CLAWS_TERM_LOG` set
     3. Sleeps 1.5s for shell init
     4. Sends `claude --dangerously-skip-permissions` via `clawsRpc` → `send`
     5. Sleeps 5s for Claude to boot
     6. Sends the mission prompt
     7. Sleeps 300ms
     8. Sends `\r` (raw CR) to submit the prompt in Claude's TUI
     9. Returns terminal ID, log path, and monitoring instructions
   - User sees a second Claude Code instance in their terminal panel, working on the bug fix
   - Orchestrator monitors via `claws_read_log` until `MISSION_COMPLETE` appears

### Step 7: User types /claws-update after a week

1. Claude Code finds `~/.claude/commands/claws-update.md` (this IS installed).
2. Claude runs:
   ```bash
   cd ~/.claws-src && git pull origin main && bash scripts/install.sh
   ```
3. `git pull` fetches the latest changes from GitHub.
4. `install.sh` re-runs all 8 steps — this is idempotent:
   - Step 1: `git pull` (already pulled, no-op)
   - Step 2: Re-creates the extension symlink (removes old, creates new)
   - Step 3: Re-applies permissions
   - Step 4: Runtime check
   - Step 5: MCP server — checks if already registered (skips if yes)
   - Step 6: Re-copies rules, skills, commands (overwrites with latest versions)
   - Step 7: Shell hook — checks if already injected (skips if yes)
   - Step 8: Verify
5. Claude reads `~/.claws-src/CHANGELOG.md` and summarizes what's new.
6. Tells user to reload VS Code.

---

## PART 4 — BROKEN LINK / REFERENCE CHECK

### README.md

| Link | Target | Status |
|---|---|---|
| `docs/protocol.md` | `docs/protocol.md` | EXISTS |
| `docs/features.md` (via "Complete Feature Reference") | `docs/features.md` | EXISTS |
| `/.claude/skills/prompt-templates/SKILL.md` (via "Prompt Templates") | `.claude/skills/prompt-templates/SKILL.md` | EXISTS |
| `docs/guide.md#installing-the-python-client` (via "Python client library") | `docs/guide.md` | EXISTS, anchor valid (line 65) |
| `LICENSE` | `LICENSE` | EXISTS |
| GitHub raw image: `extension/icon.png` | `extension/icon.png` | EXISTS |
| GitHub raw image: `docs/images/architecture.png` | `docs/images/architecture.png` | EXISTS |
| GitHub raw image: `docs/images/wrapped-terminal.png` | `docs/images/wrapped-terminal.png` | EXISTS |
| GitHub raw image: `docs/images/cross-device.png` | `docs/images/cross-device.png` | EXISTS |

**Broken links in README.md**: The "Prompt Templates" link uses `/.claude/skills/prompt-templates/SKILL.md` (starts with `/`). This is a root-relative link that works on GitHub (points to the repo root) but is unusual formatting. It will work on GitHub.com but NOT if someone browses the README locally. Minor issue.

**Stale roadmap**: The README says `v0.2 — TypeScript rewrite, VS Code Marketplace publish, status bar, tests` and `v0.3 — WebSocket transport`. But the project is already AT v0.3.0 per CHANGELOG.md, and none of those v0.2 items shipped (still raw JS, no marketplace, no status bar, no tests). The roadmap is outdated.

### extension/README.md

Identical to README.md — same links, same status. All pass. Same roadmap issue.

### docs/index.html

All GitHub raw image URLs reference images in `docs/images/`:

| Image URL (suffix) | File Exists |
|---|---|
| `docs/images/hero-cinematic.png` | YES |
| `docs/images/architecture.png` | YES |
| `docs/images/wrapped-terminal.png` | YES |
| `docs/images/ai-orchestration.png` | YES |
| `docs/images/protocol-flow.png` | YES |
| `docs/images/safety-gate.png` | YES |
| `docs/images/cross-device.png` | YES |
| `docs/images/cap-terminal-mgmt.png` | YES |
| `docs/images/cap-pty-capture.png` | YES |
| `docs/images/cap-exec.png` | YES |
| `docs/images/cap-safety.png` | YES |
| `docs/images/cap-mcp.png` | YES |
| `docs/images/cap-crossdevice.png` | YES |
| `docs/images/social-preview.png` | YES (og:image) |
| `extension/icon.png` | YES |

All image links in index.html are valid. No broken references.

All external links (GitHub repo, CONTRIBUTING.md, SECURITY.md, guide.md, features.md, protocol.md, prompt-templates SKILL.md) point to files that exist.

### docs/guide.md

No broken internal references. All file references exist. The guide mentions `pip install -e clients/python` — this is in a section titled "Installing the Python Client" and is clearly marked as optional. Not a broken link.

### CLAUDE.md

| Reference | Status | Issue |
|---|---|---|
| `@docs/protocol.md` | EXISTS | OK |
| `extension/src/` described as "TypeScript source" | EXISTS but is JavaScript | **STALE** — CLAUDE.md says "TypeScript source" but the file is `extension.js`, not TypeScript |
| `extension/test/` described as "Extension tests" | EXISTS but EMPTY | **STALE** — directory exists but contains zero files |
| `clients/python/` | EXISTS | OK (optional) |
| `clients/node/` described as "npm install @claws/client" | EXISTS but only contains an empty `src/` dir | **STALE** — no actual Node client exists yet |

### .claude/commands/*.md

All 17 command files exist and are syntactically valid Markdown with correct YAML frontmatter.

No broken internal references within the command files.

---

## PART 5 — MISSING FILES CHECK

### Images

| Directory | Expected | Found | Status |
|---|---|---|---|
| `docs/images/` | 14 images | 14 images | ALL PRESENT |
| `extension/docs/images/` | 14 images | 14 images | ALL PRESENT |

Full image list (both directories identical):
ai-orchestration.png, architecture.png, cap-crossdevice.png, cap-exec.png, cap-mcp.png, cap-pty-capture.png, cap-safety.png, cap-terminal-mgmt.png, cross-device.png, hero-cinematic.png, protocol-flow.png, safety-gate.png, social-preview.png, wrapped-terminal.png

### Core Files

| File | Status |
|---|---|
| `mcp_server.js` | PRESENT |
| `mcp_server.py` (legacy) | STILL PRESENT — should be removed or archived |
| `cli.js` | PRESENT |
| `extension/src/extension.js` | PRESENT |
| `extension/package.json` | PRESENT |
| `extension/icon.png` | PRESENT |
| `rules/claws-default-behavior.md` | PRESENT |
| `templates/CLAUDE.claws.md` | PRESENT |

### Slash Commands in .claude/commands/

| File | Status | Installed by install.sh |
|---|---|---|
| `claws.md` | PRESENT | **NO** — not copied to user's machine |
| `claws-cleanup.md` | PRESENT | **NO** |
| `claws-connect.md` | PRESENT | YES |
| `claws-create.md` | PRESENT | YES |
| `claws-do.md` | PRESENT | **NO** |
| `claws-exec.md` | PRESENT | YES |
| `claws-fleet.md` | PRESENT | YES |
| `claws-go.md` | PRESENT | **NO** |
| `claws-help.md` | PRESENT | **NO** |
| `claws-learn.md` | PRESENT | **NO** |
| `claws-read.md` | PRESENT | YES |
| `claws-send.md` | PRESENT | YES |
| `claws-setup.md` | PRESENT | **NO** |
| `claws-status.md` | PRESENT | YES |
| `claws-update.md` | PRESENT | YES |
| `claws-watch.md` | PRESENT | **NO** |
| `claws-worker.md` | PRESENT | YES |

**8 commands exist in the repo but are NOT installed.** The install.sh only copies: `claws-status claws-connect claws-create claws-send claws-exec claws-read claws-worker claws-fleet claws-update`.

Missing from install: `claws`, `claws-do`, `claws-go`, `claws-help`, `claws-learn`, `claws-watch`, `claws-cleanup`, `claws-setup`.

### Skills

| Skill | Status |
|---|---|
| `.claude/skills/claws-orchestration-engine/SKILL.md` | PRESENT |
| `.claude/skills/claws-orchestration-engine/lifecycle.yaml` | PRESENT |
| `.claude/skills/prompt-templates/SKILL.md` | PRESENT |

Both skills present and complete.

---

## CRITICAL ISSUES (would break a real user's experience)

### CRITICAL-1: 7 slash commands use `python3` on install path
**Files**: `claws-status.md`, `claws-connect.md`, `claws-create.md`, `claws-send.md`, `claws-read.md`, `claws-exec.md`, `claws-worker.md`
**Impact**: When user types these slash commands, Claude attempts to run `python3 -c` socket code. On machines without Python (the stated v0.3.0 goal), these commands fail entirely.
**Fix**: Rewrite these commands to instruct Claude to use the MCP tools (`claws_list`, `claws_create`, `claws_send`, etc.) instead of `python3` socket code. The MCP tools are already registered and work without Python.

### CRITICAL-2: 8 slash commands not installed
**Files**: `claws.md`, `claws-do.md`, `claws-go.md`, `claws-help.md`, `claws-learn.md`, `claws-watch.md`, `claws-cleanup.md`, `claws-setup.md`
**Impact**: `/claws`, `/claws-do`, `/claws-go`, `/claws-help` are the primary user-facing commands (the ones the install banner, README, CLAUDE.claws.md template, and help guide all tell users to type). They silently don't exist after install.
**Fix**: Add these 8 commands to the install.sh `for cmd in ...` loop on line 227.

### CRITICAL-3: Legacy `mcp_server.py` still in repo root
**Impact**: Confusing. A user browsing the repo sees both `mcp_server.js` and `mcp_server.py`. The install script references `.js` but the `.py` file suggests Python is still needed.
**Fix**: Delete `mcp_server.py` or move to `archive/`.

## HIGH ISSUES (confusing but not breaking)

### HIGH-1: CLAUDE.md says "TypeScript source" but extension is JavaScript
**File**: `CLAUDE.md` line 73-74
**Impact**: Contributors will expect TypeScript when they open `extension/src/` and find JavaScript.
**Fix**: Change "TypeScript source" to "JavaScript source" in the project structure section.

### HIGH-2: `extension/test/` exists but is empty
**File**: `CLAUDE.md` references "Extension tests" directory
**Impact**: Contributors expect tests but find nothing.
**Fix**: Either add tests or remove the empty directory and the reference.

### HIGH-3: `clients/node/` exists but is empty (only an empty `src/` subdir)
**File**: `CLAUDE.md` says `clients/node/ # npm install @claws/client`
**Impact**: Contributors or users expect a Node client library that doesn't exist.
**Fix**: Either remove the empty directory or add a README explaining it's planned.

### HIGH-4: Roadmap in README.md is stale
**File**: `README.md` and `extension/README.md` lines 183-186
**Impact**: Says v0.2 = TypeScript rewrite (not done), v0.3 = WebSocket (not done). But CHANGELOG says v0.3.0 is the current version.
**Fix**: Update roadmap to reflect actual current state and future plans.

### HIGH-5: MCP server version string is stale
**File**: `mcp_server.js` line 376
**Impact**: The MCP server reports `version: '0.2.0'` but the project is at v0.3.0.
**Fix**: Update to `'0.3.0'`.

### HIGH-6: `docs/guide.md` examples all use Python client
**Impact**: The 830-line guide uses `from claws import ClawsClient` throughout. While it notes the Python client is optional, a new user following the guide will need Python. The guide should include Node.js / MCP tool equivalents, or at least a prominent note at the top that all examples can be done with MCP tools instead.

---

## SUMMARY

| Category | Count |
|---|---|
| Critical issues | 3 |
| High issues | 6 |
| Files with Python on install path | 7 slash commands |
| Slash commands not installed | 8 commands |
| Syntax errors | 0 |
| Missing images | 0 |
| Broken links | 0 |
| Missing core files | 0 |

**Bottom line**: The core infrastructure (extension, MCP server, install script, shell hook) is cleanly rewritten to Node.js. But the slash commands — the user-facing layer — are half-stale. 7 still use `python3` for socket communication, and 8 (including the primary `/claws` and `/claws-do` commands) aren't even installed. A new user will have the MCP tools working perfectly but the slash command experience will be broken.
