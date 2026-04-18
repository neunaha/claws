# Zero-prerequisite install — design

How to make `bash <(curl ...install.sh)` work on a brand-new machine with nothing installed (no Node, no VS Code, no Claude Code), while *never* overwriting an existing Claude Code install.

---

## Why

Today's `install.sh` assumes the world. Reality:

| Prereq | Current behavior | What actually happens on a fresh machine |
|---|---|---|
| `bash` / `curl` | Required | OK (always present on macOS/Linux) |
| `git` | Warns then continues | Clone step blows up |
| `node` ≥ 18 | Warns then continues | MCP server **silently broken** |
| **VS Code** | Just creates `~/.vscode/extensions/` | Extension never loads — **silent failure** |
| **Claude Code CLI** | Not checked at all | MCP tools never load — **silent failure** |

Worst failure mode: the installer prints all green checks on a brand-new Mac with nothing on it, and **none of Claws works**. That's false confidence. Audit finding **A20**.

The user explicitly asked: zero-prereq install must work, but **detect Claude Code first and skip if present** — never overwrite an existing install (that would lose login/API keys/version pinning).

---

## What zero-prereq actually requires

Order matters: package manager → git/node → editor → Claude Code → Claws. Each step must be idempotent (skip if already present).

### macOS

| Piece | Detect with | If missing |
|---|---|---|
| Homebrew | `command -v brew` | `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"` (needs sudo, ~5 min) |
| git | `command -v git` | `brew install git` (or use Xcode CLT) |
| node ≥ 18 | `command -v node && node -v` | `brew install node` |
| VS Code | `command -v code` OR `[ -d /Applications/Visual\ Studio\ Code.app ]` | `brew install --cask visual-studio-code` (~150 MB) |
| Claude Code | **`command -v claude`** ← mandatory gate | Per Anthropic's published install method (verify canonical command before shipping) |
| Claws | (existing install.sh) | (existing install.sh) |

### Linux

Distro detection via `/etc/os-release` `ID=` field:

| Distro | Install command for prereqs | VS Code |
|---|---|---|
| Debian / Ubuntu | `sudo apt-get install -y git nodejs` | Microsoft's apt repo (gpg key + sources.list, then `apt install code`) |
| Fedora / RHEL | `sudo dnf install -y git nodejs` | Microsoft's repo, then `dnf install code` |
| Arch | `sudo pacman -S git nodejs` | AUR (`visual-studio-code-bin`) — **no AUR helper guaranteed**; bail with instructions |
| Alpine | `sudo apk add git nodejs` | No official VS Code; bail |

All variants need sudo for system packages. Detect lack of sudo and explain.

### Windows

PowerShell only. `winget` is preinstalled on Win10 1809+/Win11.

```powershell
winget install --silent Git.Git
winget install --silent OpenJS.NodeJS.LTS
winget install --silent Microsoft.VisualStudioCode
# Claude Code: per Anthropic's canonical method
```

Some installs need an elevated shell — detect and prompt user to re-launch as admin if not.

Fallback to scoop/choco only if winget unavailable (rare).

---

## The Claude-detection gate (the user's specific ask)

```bash
# Detection — runs BEFORE any install action
CLAUDE_PRESENT=0
CLAUDE_REASON=""

if command -v claude >/dev/null 2>&1; then
  CLAUDE_VERSION="$(claude --version 2>/dev/null | head -n1)"
  if [ -n "$CLAUDE_VERSION" ]; then
    echo "  ✓ Claude Code already installed: $CLAUDE_VERSION — skipping"
    CLAUDE_PRESENT=1
  else
    echo "  ! Claude Code binary found but --version failed — broken install?"
    CLAUDE_REASON="broken"
  fi
elif [ -d "$HOME/.claude" ]; then
  echo "  ! ~/.claude exists but 'claude' is not on PATH — PATH issue, not missing"
  CLAUDE_REASON="path"
else
  echo "  ! Claude Code not found"
  CLAUDE_REASON="missing"
fi

# Later: only install if confirmed missing AND user said yes
if [ "$CLAUDE_PRESENT" = "0" ] && [ "$CLAUDE_REASON" = "missing" ] && [ "$INSTALL_CLAUDE" = "yes" ]; then
  install_claude_code
fi
```

Two extra checks beyond `command -v` matter:
1. **`~/.claude/` exists** but `claude` not in PATH → Claude was installed but PATH is broken. Tell the user to fix PATH, not reinstall.
2. **`claude --version` exits non-zero** → broken install. Offer to repair, not reinstall.

This avoids the worst failure: stomping a working Claude install with a different version + losing the user's API key/login.

---

## Risks of building a full bootstrap

1. **Homebrew install on locked-down/MDM-managed Macs** — fragile, may need direct .pkg downloads as fallback.
2. **Sudo in `bash <(curl...)`** — no TTY by default; sudo prompts hang silently. Need either `sudo -v` upfront or a "download then run" instruction.
3. **Linux distro matrix** — Ubuntu LTS variants × Debian × Fedora × Arch × WSL × Alpine × NixOS is a long tail. AUR alone is a rabbit hole.
4. **Windows** — winget version skew, antivirus flagging, admin elevation flow.
5. **Failure recovery** — if VS Code installs but Claude Code fails, you're 70% through with no clear "resume" path. Need explicit checkpointing.
6. **Bandwidth** — 500 MB–1 GB for fresh install; dial-up users hit a wall mid-install.
7. **Out-of-scope drift** — Claws becomes "the thing that installs your dev environment" instead of a terminal bridge. Maintenance burden grows.

---

## Recommendation: ship Tier A, defer Tier B

| Path | Effort | Maintenance | UX for fresh user |
|---|---|---|---|
| Today (warn + continue) | 0 | 0 | Silent failure (terrible) |
| **Tier A** — detect + halt + copy-paste guide | ~1 day | low | "Run these commands, then re-run me." Clear, honest, works. |
| **Tier B-macOS** — Tier A + auto-install on macOS via brew | ~2-3 days | medium | "Run me — I'll handle macOS. For Linux/Win, copy-paste guide." |
| **Full multi-platform bootstrap** | ~1-2 weeks | high | True one-command install — but you own the support burden. |

**Pick: Tier A first, ship this week.** Tier B-macOS as a v0.4 polish. Don't promise full multi-platform bootstrap until v1.0.

Reasoning:
- Tier A is honest. Users see exactly what's needed. No hidden side effects.
- Tier A reuses each prereq's canonical installer (battle-tested, maintained by their teams).
- Tier A has no "it broke halfway, what now?" failure mode.
- Tier B-macOS gives the magical-feeling demo-day UX for the most-likely user (you on macOS).
- Full bootstrap creates ongoing per-distro support work that's outside Claws's actual mission.

---

## Tier A — concrete design

### `scripts/preflight.sh`

A new script that runs BEFORE `install.sh`'s real work. Detects every prereq and either passes through or halts with an actionable message.

```
─── Preflight ───
  ✓ macOS 14.5 detected
  ✓ git 2.43
  ✓ node v20.11.0
  ! VS Code not found
  ! Claude Code not found

You're missing 2 prerequisites. Install them, then re-run me:

  # 1. VS Code
  brew install --cask visual-studio-code

  # 2. Claude Code  (DO NOT RE-RUN if it's already installed)
  <official Anthropic install command>

After both are installed:
  bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)
```

### Wiring

`install.sh` calls `preflight.sh` first. If exit code != 0, install.sh exits without doing anything.

`preflight.sh` exit codes:
- `0` — all green, proceed
- `1` — missing prereqs, instructions printed, do not proceed
- `2` — environment unsupported (BSD other than macOS, exotic distro), instructions to file an issue

### Detection list (per platform)

| Check | Detection | macOS missing | Debian/Ubuntu missing | Fedora missing | Windows missing |
|---|---|---|---|---|---|
| git | `command -v git` | `brew install git` | `sudo apt install -y git` | `sudo dnf install -y git` | `winget install Git.Git` |
| node ≥ 18 | `command -v node && [ "$(node -v \| cut -d. -f1 \| tr -d v)" -ge 18 ]` | `brew install node` | NodeSource setup script + `apt install -y nodejs` | NodeSource + `dnf install -y nodejs` | `winget install OpenJS.NodeJS.LTS` |
| editor | one of: `code` / `cursor` / `windsurf` / `code-insiders` | `brew install --cask visual-studio-code` | apt repo + `apt install code` | dnf repo + `dnf install code` | `winget install Microsoft.VisualStudioCode` |
| **claude** | `command -v claude` (skip if present) | per Anthropic's official method | per Anthropic's official method | per Anthropic's official method | per Anthropic's official method |

### What `install.sh` already does well, keep doing

- Auto-detect editor extension dir.
- Idempotent re-runs (already mostly idempotent after this session's fixes).
- The new `/claws-doctor` for post-install verification.

### What changes

- Halt-on-missing replaces warn-and-continue (audit A20).
- Verification verdict shows X/Y not bare X (already done this session).
- Final box mentions all 3 activation steps (already done this session).

---

## Tier B-macOS — concrete design (deferred)

When the user passes `--auto`, the installer will:

1. Run preflight to detect missing pieces.
2. Print the install plan with sizes:
   ```
   This will install:
     • Homebrew              (sudo, ~200 MB)
     • Node.js v20            (~30 MB)
     • Visual Studio Code     (~150 MB)
     • Claude Code            (~50 MB)
   Total: ~430 MB. Sudo password will be required.

   Continue? [y/N]
   ```
3. `sudo -v` upfront to cache credentials (avoids hung TTY-less sudo prompts).
4. Run each install in dependency order.
5. After each install, re-detect to confirm it landed.
6. If any step fails, print the failed step + a recovery command + exit. Do not silently continue.
7. After all prereqs are present, chain into the existing `install.sh` flow.

Tier B is opt-in (`--auto`). Default behavior remains Tier A (halt + guide).

---

## Open questions

1. **Canonical Claude Code install command.** Need the exact official method. Don't want to hallucinate. Probably one of:
   - `curl -fsSL https://claude.ai/install.sh | bash` (Anthropic's standalone installer)
   - `npm install -g @anthropic-ai/claude-code`
   - Something else
   The bootstrap must use the canonical method or it'll create version drift.

2. **Claude detection scope.** Just `command -v claude` + `claude --version`? Or also check `~/.claude/` exists (logged-in vs not)? Recommend the version above (3-state: present/broken/missing).

3. **Linux Arch / Alpine / NixOS** — bail with friendly instructions, or omit entirely from the docs? Recommend bail with instructions; document supported distros explicitly (Ubuntu LTS, Debian stable, Fedora current).

4. **Windows scope.** Tier A only (detect + copy-paste install commands)? Or wait for full bootstrap? Recommend Tier A only — winget commands are easy to copy-paste, low value to automate.

5. **Bootstrap goes in this PR or as a follow-up?** Recommend follow-up — the install gap fixes are already a coherent shippable unit; bootstrap is a different surface and warrants its own review.

---

## What I would ship as a Tier A PR

1. `scripts/preflight.sh` — platform detection, prereq check, halt-with-instructions on missing.
2. `scripts/install.sh` — calls preflight first; exits cleanly if preflight fails.
3. `README.md` — new section "If you have nothing installed" pointing at preflight.
4. `CHANGELOG.md` — entry.

Roughly 200 lines of script + 30 lines of README + a CHANGELOG entry. Doable in a single session with verification.

Tier B-macOS is a separate PR after Tier A lands.
