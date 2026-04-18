---
A. Concrete bugs/flaws in the code

A1. Protocol bug — id field collides with itself

Look at protocol.md:88, :99, :117:
{ "id": N, "cmd": "send", "id": "5", "text": "..." }
The same JSON object has TWO id keys (request id + terminal id). JSON parsers keep the last one. In extension.js:379 the response uses req.id — which is now the terminal id, not the request id. The reason this hasn't broken anything: mcp_server.js opens a fresh socket per call, so requests never multiplex. Any client that tried to pipeline would see wrong-response routing. Fix: rename request id to rid.

A2. The "safety gate" doesn't exist

README.md:152 and the architecture text in CLAUDE.md claim foreground-process detection that warns before sending into a TUI. Searching extension.js — no such code. Marketing/code mismatch.

A3. claws_send shell-injection RCE in shell-hook.sh

shell-hook.sh:115-128 (claws-run) interpolates $id and $sock directly into a node -e "..." heredoc. Concrete attack:
claws-run "$(printf '\x27); require("child_process").exec("rm -rf ~"); (\x27')" "echo ok"
The ' in the argument closes the JS string and injects arbitrary node code. Same class of bug in claws-ls, claws-new, claws-log. Fix: pass args via env vars, not string interpolation.

A4. claws-* shell functions trust their args

Even without RCE, id="; do_anything" will silently produce wrong JSON.

A5. Bracketed paste claim is also fake

extension.js:235: t.sendText(req.text, true). VS Code's sendText does NOT wrap in bracketed paste. Multi-line prompts fragment line-by-line in many shells. README and tool descriptions both lie about this.

A6. Extension version hardcoded in installer

install.sh:51: EXT_LINK="$EXT_DIR/neunaha.claws-0.1.0" but extension/package.json says "version": "0.1.0" — they happen to match today, but on any version bump they desync. VS Code requires the directory name to match <publisher>.<name>-<version>. Bump version → install creates wrong directory → VS Code refuses to load. Fix: derive from package.json.

A7. MCP path interpolation injection in install.sh

install.sh:135: args: ['$MCP_PATH'] — same single-quote injection class as A3. If $HOME ever contains a ', install corrupts settings.json. Rare but real.

A8. Workspace socket collision

Open the same workspace in two VS Code windows → window 2's fs.unlinkSync(socketPath) (extension.js:358) destroys window 1's socket. Window 1's clients silently fail. No detection, no warning.

A9. extension.js:142-143 — output truncation drops the BEGINNING

if (state.output.length > cap * 2) {
  state.output = state.output.slice(-cap * 2);
}
For a 10-minute build that prints errors in minute 1, the errors are GONE by minute 9. AI sees "build failed" with no clue why.

A10. script(1) on Windows = silent failure

terminal-wrapper.sh is a bash script. install.ps1 doesn't ship a Windows equivalent. On Windows, claws_create wrapped=true opens a regular shell with no logging — same name "Claws Wrapped" but no actual wrapping. claws_read_log returns "not wrapped" with no explanation.

A11. PowerShell shell hook is decoration only

install.ps1:124-136 adds a banner to the user's PowerShell profile but no claws-ls/claws-new/claws-run/claws-log functions. Windows users get the logo and nothing usable.

A12. No retry / no health endpoint

mcp_server.js:80 calls net.createConnection(sockPath) with no retry. If the extension is mid-restart, every tool call fails. There's no ping or health command in the protocol.

A13. claws_worker hardcodes a 5s boot wait

mcp_server.js:328: await sleep(5000). On slow machines Claude isn't ready → mission goes to the shell. On fast machines, 4500ms wasted per spawn. Fix: poll for the Claude TUI prompt in the log (pexpect-style).

A14. pendingWrappedProfiles array never expires

extension.js:437 pushes; cleanup only happens in the onDidOpenTerminal adopt path. Click "Claws Wrapped Terminal" then click away → entry stays forever. Slow leak.

A15. ANSI strip misses OSC sequences

extension.js:33: regex covers CSI but not OSC (ESC ] ... BEL / ESC ] ... ESC \). Hyperlinks, terminal titles, modern shell prompts leave junk in stripped logs.

A16. Activation event runs on every workspace open

package.json:41: onStartupFinished. Even users who never call Claws pay the activation cost on every window. Fix: activate on first command/socket request.

A17. Pty log committed to git

.claws/ lives in workspace. Most users won't think to gitignore it. First commit leaks command history (potentially passwords). Fix: write .claws/.gitignore with * on first activation.

A18. Zero tests

extension/test/ doesn't exist. No CI. v0.4 plan mentions adding tests but Phase 1 prerequisites it on the rewrite.

A19. Installer aggressively removes ALL neunaha.claws-* symlinks

install.sh:95: rm -f "$EXT_DIR"/neunaha.claws-* — removes any version including a manually-installed VSIX. Hostile to power users.

A20. The "Claws Wrapped Terminal" identification is by NAME

extension.js:409: /^Claws Wrapped (\d+)$/.exec(t.name || ''). Fragile — VS Code may auto-rename on collision; user can rename a terminal manually and confuse the matcher.

---
B. What similar OSS projects do better

┌──────────────────────────────┬────────────────────────────────────────────────────────────────────┐
│           Project            │                           What to steal                            │
├──────────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ node-pty (VS Code/Hyper)     │ Replace script(1) — fixes TUI glitching on every platform, plus    │
│                              │ Windows ConPTY support                                             │
├──────────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ VS Code Pseudoterminal API   │ Already in v0.4 plan — extension owns the pty, no wrapper script   │
├──────────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ tmux                         │ Detach/reattach — survive VS Code reload without losing sessions   │
├──────────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ Zellij                       │ WASM plugin model — third-party tools without core changes         │
├──────────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ asciinema                    │ Log format compatibility (.cast) — free in-browser replay          │
├──────────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ expect / pexpect             │ wait_for(pattern, timeout) instead of fixed sleeps — fixes A13 and │
│                              │  worker boot races                                                 │
├──────────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ ttyd / gotty                 │ Token-in-URL auth + TLS for the planned WebSocket transport        │
├──────────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ OpenInterpreter / Aider /    │ Git-aware events ("files changed") surfaced as MCP results         │
│ Cline                        │                                                                    │
├──────────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ MCP servers framework        │ Register prompts + resources, not just tools — pty logs as         │
│                              │ resource URIs                                                      │
├──────────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ VS Code Live Share           │ "Follow another user's cursor" UX → "follow another worker's       │
│                              │ terminal" UX                                                       │
├──────────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ Warp                         │ Per-command "blocks" in the log → easy parse "command N output"    │
├──────────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ systemd / overmind           │ Supervised mode for the watchdog pattern instead of \x03 hack      │
├──────────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ Caddy / fly / Tailscale      │ Single bin, single doctor, single uninstaller, root-cause errors   │
│ installers                   │                                                                    │
├──────────────────────────────┼────────────────────────────────────────────────────────────────────┤
│ MCP Inspector                │ Ship a --debug flag that exposes the protocol on a port for        │
│                              │ inspection                                                         │
└──────────────────────────────┴────────────────────────────────────────────────────────────────────┘

---
C. Memory + Obsidian — my honest take

Don't tie it to Obsidian. Build a "knowledge sink" with a markdown directory. Obsidian users get a vault for free; everyone else gets greppable notes. Both win.

Why the Obsidian-specific framing is wrong

- Locks out Logseq / RemNote / Notion / plain-md users (also: anyone who already tried Obsidian and bounced).
- Conflicts with Claude Code's existing native auto-memory at ~/.claude-campus/projects/.../memory/ — users will ask "where do I look?"
- Scope creep — Claws is "terminal control bridge", not a notes app. Maintaining vault format compat, conflict resolution, and Obsidian plugin breakage = ongoing burden.
- Privacy hazard — terminal output ends in markdown files. Easy to accidentally commit secrets.

What I'd actually build (small, fast, optional)

Two new MCP tools, both opt-in via CLAWS_KNOWLEDGE_DIR:

claws_remember(category, content, tags?)
  → writes to $CLAWS_KNOWLEDGE_DIR/<category>/<timestamp-slug>.md
  → YAML frontmatter (date, terminal_id, tags), markdown body
  → secret-redaction filter (AWS_*, Bearer , password=, ssh-key patterns)

claws_recall(query, since?, limit?)
  → ripgrep over the directory + score results
  → returns top-N snippets with file paths

Plus one ambient behavior, off by default:
- On claws_close of a worker terminal, prompt the orchestrator: "anything worth remembering?" If yes → claws_remember a one-paragraph summary.

Format is plain markdown with YAML frontmatter — works in Obsidian, Logseq, Foam, plain editors. Obsidian users point a vault at the dir. No Obsidian dep, no marketing dependency, fully optional.

Verdict: ship this as v0.5 (after the install/reliability work and after node-pty rewrite). Useful, differentiating, but not core to "terminal control."

---
D. N ways users can break it (52 distinct, grouped)

I went wide on this. Patterns first, then the list.

Pattern 1 — Seams. Most failures happen at boundaries: editor/AI/shell/workspace/network. Anywhere two systems hand off, users mismatch them.

Pattern 2 — Silent fallback. Whenever code "continues with degraded behavior", the user can't tell. Always visible.

Pattern 3 — Unrecoverable async. Long-running commands, parallel workers, mid-restart races have no kill/retry/resume primitives.

Pattern 4 — Implicit state. Workspace path, env vars, which terminal is "current", which Claude is in PATH — all matter, none are surfaced.

The 52 mistakes:

Pre-install (1-6): wrong editor; multiple editors; Codespaces/devcontainer; tampered curl|bash; missing Node.js; parallel installer runs.

Activation (7-10): reload VS Code but skip Claude restart; restart Claude but skip reload; reload into wrong workspace; new terminal without reload.

Workspace (11-16): Claude opened at ~/; two windows same workspace (A8); spaces in path; .claws/ accidentally gitignored; .claws/ accidentally committed (A17); Claude run as sudo.

Wrapped/unwrapped (17-20): plain terminal but AI calls read_log; wrapper script missing; vim/htop in wrapped (script(1) corruption); Claude inside Claws Wrapped → recursion.

Parallel (21-24): all workers named "claws"; never closed; ID collision (A1); double-close.

Long-running (25-28): npm start via exec hangs forever past timeout but server keeps running; infinite loop; output truncation drops beginning (A9); binary output garbles strip.

TUI (29-31): send into running Claude becomes prompt input; raw \r accepts a confirmation dialog; read_log on unwrapped terminal — AI doesn't know to recreate.

Socket/process (32-35): force-quit VS Code leaves stale socket; CLAWS_SOCKET mismatch; multiple claude binaries in PATH; broken extension symlink.

Update (36-39): /claws-update while a worker runs kills it; git pull without re-running install; protocol breakage on version bump (no handshake); installer's settings.json rewrite clobbers unrelated keys.

Auth/security (40-44): world-readable socket; planned WebSocket on coffee-shop wifi; passwords in pty log; tokens in git push errors; AI runs rm -rf on hallucinated permission.

Mental model (45-49): confuses Claws with Claude; types /claws in non-Claude shell; never finds shell-side claws-* commands; assumes bash <(curl) is the product; uses Claude Code outside VS Code.

Cross-machine (50-52): WSL2 namespace split; devcontainer/host symlink mismatch; remote-SSH socket on remote host but Claude on local.

---
E. What to do — prioritized

P0 — small fixes, ship in days (mostly bug fixes from §A)

1. Implement /claws-doctor — done this turn ✓
2. Fix shell-hook RCE (A3, A4) — pass args via env vars
3. Fix protocol id collision (A1) — rename request id to rid, version-handshake before tools
4. Auto-write .claws/.gitignore (A17) — one line on first activation
5. Status bar item — "Claws ✓ socket · 3 terminals · 2 wrapped" — closes pattern "is it working?"
6. Workspace collision detection (A8) — second window refuses to start, clearly errors
7. Read extension version from package.json (A6) — install.sh stops hardcoding
8. Disable wrapped-terminal feature on Windows (A10) + warn — better than silent fail; or block "wrapped" claim until ConPTY ships
9. Either implement safety gate or delete the marketing claim (A2)
10. Either implement bracketed paste or delete the claim (A5)
11. Uninstall script — one command undoes everything
12. Extension test scaffolding — @vscode/test-electron minimal smoke test in CI

P1 — reliability primitives (1-2 weeks)

13. claws_wait_for(id, pattern, timeout) — pexpect-style; replaces fixed sleeps in worker boot
14. claws_kill(id, signal) — SIGINT/SIGTERM, not just dispose
15. Streaming exec — return chunks, not just final
16. Pty-log secret redaction filter
17. Auto-cleanup of leaked worker terminals (per-session ownership)
18. Socket reconnect with backoff in mcp_server.js
19. ping command + protocol version handshake

P2 — v0.4 plan + memory (1-2 months)

20. node-pty + Pseudoterminal rewrite (already planned — fixes A10, A15, the script(1) glitching)
21. State persistence (already planned)
22. Marketplace publish (already planned)
23. Knowledge sink: claws_remember + claws_recall — the answer to your Obsidian question
24. WebSocket transport with token auth + TLS (already planned)
25. asciinema-compatible log format → free replay UX

---
What I want to know before going further

1. Scope today: do you want me to start executing the P0 list now, or pause for discussion? P0 is ~10 small fixes — could land in this session if you greenlight.
2. Memory feature: agree with my "knowledge sink, not Obsidian-specific" framing? If yes, I'd put it in P2 (after install/reliability are solid). If you want it sooner, I can move it up.
3. Security disclosures: A3 is a real RCE in shell functions (low realistic exploit chance, but real). Want me to fix and silently ship as a v0.3.1, or write a security note?
4. Marketing-vs-reality items (A2 safety gate, A5 bracketed paste): delete the claim and ship a roadmap entry, or implement them now?
