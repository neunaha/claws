# Claws — Terminal Behavior Override

> Auto-installed by Claws. This rule OVERRIDES default terminal behavior.

## MANDATORY: when the user invokes any /claws command, you MUST use Claws terminals

When the user types `/claws-do`, `/claws-go`, or any `/claws-*` command, you are REQUIRED to create visible terminals via the Claws socket. Do NOT fall back to the Bash tool. Do NOT say "this isn't a Claws task." EVERYTHING asked through a /claws command IS a Claws task.

**If MCP tools (claws_list, claws_create, etc.) are available**: use them directly.

**If MCP tools are NOT loaded** (new session, MCP not registered): use raw socket calls via `node -e` with `require('net').createConnection('.claws/claws.sock')`. The socket commands are documented in every /claws-* slash command file.

**If the socket doesn't exist**: tell the user to reload VS Code (Cmd+Shift+P → Developer: Reload Window).

## For all other work (no /claws prefix), use this behavior:

**DO**: run visible work in Claws terminals — builds, tests, deploys, servers, AI workers, refactoring, audits. The user watches it happen live in their VS Code terminal panel.

**DO**: use `claws_worker` when the user asks to "fix", "refactor", "audit", or any complex task. This spawns a Claude Code session with full permissions that the user can watch.

**DO**: spawn parallel terminals for independent tasks. "lint + test + build" = 3 terminals, all running simultaneously.

**DO**: always create wrapped terminals (`wrapped=true`). Always close them when done.

**USE BASH DIRECTLY FOR**: quick lookups — `ls`, `cat`, `git status`, `grep`, file reads. No terminal needed.

## Pattern matching — what the user says → what you do

"run tests" / "run the build" / "lint the code"
→ `claws_create` wrapped → `claws_send` the command → `claws_read_log` → report → `claws_close`

"run lint, test, and build" / "do these in parallel"
→ 3x `claws_create` → send all 3 commands → monitor all 3 → close all → aggregate report

"fix the bug" / "refactor this" / "audit the code" / "write tests for X"
→ `claws_worker` with the mission → monitor via `claws_read_log` → report → close

"start the server" / "watch for crashes"
→ `claws_create` wrapped → send start command → monitor → restart if crash detected

"spawn a worker" / "launch claude in a terminal"
→ `claws_worker` — auto-launches Claude Code with `--dangerously-skip-permissions`

"what's running" / "show me the terminals"
→ `claws_list` → format as dashboard

"clean up" / "close the workers"
→ `claws_list` → close all worker terminals → confirm

## Terminal naming

Always descriptive: `worker-tests`, `worker-lint`, `build-server`, `ai-refactor`, `deploy-staging`.
Never generic: `terminal`, `shell`, `worker-1`.

## Cleanup is non-negotiable

Every `claws_create` must have a matching `claws_close`. At the end of any orchestration, run `claws_list` and close anything you own that's still open. Stale terminals are a bug.

## Never headless

When spawning Claude Code in a worker terminal:
- ALWAYS: `claude --dangerously-skip-permissions` (interactive, visible TUI)
- NEVER: `claude -p "..."` (headless, invisible)

The user must see every AI worker in their terminal panel.
