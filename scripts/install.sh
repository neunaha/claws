#!/usr/bin/env bash
# Claws — project-local installer
# Usage: cd /path/to/project && bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)
#
# Env overrides:
#   CLAWS_DIR=/path             Where to clone the source (default: ~/.claws-src)
#   CLAWS_EDITOR=cursor|insiders|windsurf|skip  Which editor's extensions dir to use
#   CLAWS_SKIP_MCP=1            Don't write .mcp.json
#   CLAWS_GLOBAL_MCP=1          Also register globally in ~/.claude/settings.json
#   CLAWS_GLOBAL_CONFIG=1       Also write commands/skills/rules into ~/.claude/
#   CLAWS_DEBUG=1               Enable bash -x trace
#   CLAWS_NO_LOG=1              Disable the /tmp/claws-install-*.log file

# ─── Strict-ish mode ────────────────────────────────────────────────────────
# -e: exit on unhandled error
# -o pipefail: catch errors inside pipes
# We do NOT use -u because optional env vars are allowed to be unset.
set -eo pipefail

# If CLAWS_DEBUG=1, trace every line.
if [ "${CLAWS_DEBUG:-0}" = "1" ]; then
  set -x
fi

# ─── Logging ────────────────────────────────────────────────────────────────
CLAWS_LOG="${CLAWS_LOG:-/tmp/claws-install-$(date +%Y%m%d-%H%M%S)-$$.log}"
if [ "${CLAWS_NO_LOG:-0}" != "1" ]; then
  # Tee all stdout and stderr through the log file.
  # Using process substitution so the log captures both the script's own
  # output and anything child processes emit.
  exec > >(tee -a "$CLAWS_LOG") 2> >(tee -a "$CLAWS_LOG" >&2)
  trap 'printf "\n\nInstall log saved to: %s\n" "$CLAWS_LOG" >&2' EXIT
fi

# ─── Colors and progress helpers ────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET='\033[0m'; C_BOLD='\033[1m'
  C_BLUE='\033[0;34m'; C_GREEN='\033[0;32m'; C_YELLOW='\033[0;33m'; C_RED='\033[0;31m'; C_DIM='\033[2m'
else
  C_RESET=''; C_BOLD=''; C_BLUE=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_DIM=''
fi

STEP_NUM=0
STEP_TOTAL=8
step()   { STEP_NUM=$((STEP_NUM+1)); printf "\n${C_BOLD}${C_BLUE}[%d/%d]${C_RESET} %s\n" "$STEP_NUM" "$STEP_TOTAL" "$*"; }
ok()     { printf "  ${C_GREEN}✓${C_RESET} %s\n" "$*"; }
warn()   { printf "  ${C_YELLOW}!${C_RESET} %s\n" "$*"; }
bad()    { printf "  ${C_RED}✗${C_RESET} %s\n" "$*"; }
info()   { printf "  ${C_DIM}%s${C_RESET}\n" "$*"; }
die()    { bad "$*"; exit 1; }

# Treat any unhandled error as fatal with a clear message.
trap 'ec=$?; if [ $ec -ne 0 ]; then printf "\n${C_RED}${C_BOLD}INSTALL FAILED${C_RESET} at line $LINENO (exit $ec). See log: %s\n" "$CLAWS_LOG" >&2; fi' ERR

# ─── Globals ────────────────────────────────────────────────────────────────
REPO="https://github.com/neunaha/claws.git"
INSTALL_DIR="${CLAWS_DIR:-$HOME/.claws-src}"
USER_PWD="$(pwd)"
PLATFORM="$(uname -s)"

# ─── Banner ─────────────────────────────────────────────────────────────────
cat <<BANNER

${C_BOLD}╔═══════════════════════════════════════════╗
║                                           ║
║   CLAWS — Terminal Control Bridge         ║
║   Project-local orchestration setup       ║
║                                           ║
╚═══════════════════════════════════════════╝${C_RESET}

BANNER

# ─── Project safety check ──────────────────────────────────────────────────
is_safe_project_dir() {
  case "$1" in
    "" | "/" | "$HOME" | "/tmp" | "/tmp/" | "/var" | "/var/" \
      | "/opt" | "/opt/" | "/Users" | "/Users/" | "/etc" | "/etc/") return 1 ;;
  esac
  return 0
}

if is_safe_project_dir "$USER_PWD"; then
  PROJECT_ROOT="$USER_PWD"
  PROJECT_INSTALL=1
  echo "  Installing into project: $PROJECT_ROOT"
else
  PROJECT_ROOT=""
  PROJECT_INSTALL=0
  warn "$USER_PWD is not a safe project dir — skipping project-local install."
  info "For a full per-project setup: cd into your project and re-run."
fi
echo ""

# ─── Detect editor extensions dir ──────────────────────────────────────────
detect_ext_dir() {
  local editor="${CLAWS_EDITOR:-auto}"
  case "$editor" in
    cursor)    mkdir -p "$HOME/.cursor/extensions" && echo "$HOME/.cursor/extensions"; return ;;
    insiders)  mkdir -p "$HOME/.vscode-insiders/extensions" && echo "$HOME/.vscode-insiders/extensions"; return ;;
    windsurf)  mkdir -p "$HOME/.windsurf/extensions" && echo "$HOME/.windsurf/extensions"; return ;;
    skip)      echo ""; return ;;
  esac
  # auto-detect — first existing dir wins
  for d in "$HOME/.vscode/extensions" "$HOME/.vscode-insiders/extensions" "$HOME/.cursor/extensions" "$HOME/.windsurf/extensions"; do
    if [ -d "$d" ]; then echo "$d"; return; fi
  done
  # none exist — create VS Code default
  mkdir -p "$HOME/.vscode/extensions"
  echo "$HOME/.vscode/extensions"
}
EXT_DIR="$(detect_ext_dir)"

# ─── Preflight: dependencies ───────────────────────────────────────────────
# Every dependency the installer or the extension's build chain touches is
# checked here with a specific install command for the ones that are missing.
# Fatal checks (die) are things Claws literally cannot work without. Warning
# checks are things that degrade specific features.
echo "Checking dependencies..."

# ── Required: git ──────────────────────────────────────────────────────────
if command -v git &>/dev/null; then
  ok "git ($(git --version | awk '{print $3}'))"
else
  case "$PLATFORM" in
    Darwin) die "git not found — install with: xcode-select --install" ;;
    Linux)  die "git not found — install with: sudo apt install git  (or your distro's package manager)" ;;
    *)      die "git not found — install from https://git-scm.com/" ;;
  esac
fi

# ── Required: Node.js 18+ (for MCP server + extension build) ───────────────
if ! command -v node &>/dev/null; then
  case "$PLATFORM" in
    Darwin) die "node not found — install with: brew install node  (or from https://nodejs.org/)" ;;
    Linux)  die "node not found — install with: sudo apt install nodejs  (or use nvm: https://github.com/nvm-sh/nvm)" ;;
    *)      die "node not found — install from https://nodejs.org/" ;;
  esac
fi
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null || echo "0")
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  die "node $(node --version) is too old — Claws requires Node 18+. Upgrade via nvm or your package manager."
fi
ok "node ($(node --version))"

# ── Required: npm (bundled with node, but verify separately) ───────────────
if ! command -v npm &>/dev/null; then
  die "npm not found — should ship with Node. Reinstall Node or install npm separately."
fi
ok "npm ($(npm --version))"

# ── Optional but strongly recommended: C++ toolchain for native modules ────
# node-pty (optional dep) compiles C++ when no prebuilt binary matches the
# user's Node version. Without it, wrapped terminals fall back to pipe-mode
# which doesn't render TUIs correctly. Warn proactively so the user can fix
# it BEFORE npm install rather than discovering the silent failure later.
TOOLCHAIN_OK=1
case "$PLATFORM" in
  Darwin)
    if xcode-select -p &>/dev/null; then
      ok "Xcode Command Line Tools ($(xcode-select -p))"
    else
      warn "Xcode Command Line Tools not installed"
      info "install with: xcode-select --install"
      info "without this, wrapped terminals will use degraded pipe-mode (TUIs render poorly)"
      TOOLCHAIN_OK=0
    fi
    ;;
  Linux)
    if command -v g++ &>/dev/null && command -v make &>/dev/null; then
      ok "C++ toolchain (g++ $(g++ -dumpversion 2>/dev/null), make $(make --version | head -1 | awk '{print $3}'))"
    else
      warn "C++ toolchain missing — wrapped terminals may fall back to pipe-mode"
      info "install with: sudo apt install build-essential  (Debian/Ubuntu)"
      info "          or: sudo dnf install gcc-c++ make    (Fedora/RHEL)"
      TOOLCHAIN_OK=0
    fi
    ;;
esac

# ── Optional: python3 for node-gyp ─────────────────────────────────────────
# node-gyp spawns python3 to run its gyp files. Missing python3 means
# node-pty source build will fail even if the C++ toolchain is present.
if command -v python3 &>/dev/null; then
  ok "python3 ($(python3 --version 2>&1 | awk '{print $2}'))"
elif command -v python &>/dev/null && python --version 2>&1 | grep -q "Python 3"; then
  ok "python ($(python --version 2>&1 | awk '{print $2}'))"
else
  warn "python3 not found — needed by node-gyp for native module compilation"
  case "$PLATFORM" in
    Darwin) info "install with: brew install python3  (or xcode-select --install provides it)" ;;
    Linux)  info "install with: sudo apt install python3" ;;
  esac
  TOOLCHAIN_OK=0
fi

# ── Optional: bundled VS Code CLI (for VSIX install in step 2c) ────────────
# We don't fail if absent — the installer falls back to a symlink. But log
# what we'd use so /claws-report shows the editor state.
FOUND_EDITOR_CLIS=()
for pair in \
  "code:/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  "code-insiders:/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders" \
  "cursor:/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
  "windsurf:/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf"; do
  label="${pair%%:*}"
  bundled="${pair#*:}"
  if command -v "$label" &>/dev/null; then
    FOUND_EDITOR_CLIS+=("$label (PATH)")
  elif [ -x "$bundled" ]; then
    FOUND_EDITOR_CLIS+=("$label (bundled)")
  fi
done
if [ "${#FOUND_EDITOR_CLIS[@]}" -gt 0 ]; then
  ok "editor CLI(s): ${FOUND_EDITOR_CLIS[*]}"
else
  warn "no editor CLI detected — extension will install via symlink fallback"
  info "to enable VSIX install on macOS: open VS Code and run 'Shell Command: Install code command in PATH'"
fi

info "Platform: $PLATFORM $(uname -r)"
info "Shell: $SHELL ($BASH_VERSION)"
info "Install log: $CLAWS_LOG"
[ "$TOOLCHAIN_OK" = "0" ] && warn "toolchain issues above — install will still run, but node-pty may not compile"
echo ""

# ─── Step 1: Clone or update ───────────────────────────────────────────────
step "Fetching Claws source"
if [ -d "$INSTALL_DIR/.git" ]; then
  info "updating existing clone at $INSTALL_DIR"
  ( cd "$INSTALL_DIR" && git pull --ff-only --quiet origin main ) || warn "git pull failed; using existing tree"
  ok "updated $INSTALL_DIR"
elif [ -d "$INSTALL_DIR" ]; then
  die "$INSTALL_DIR exists but is not a git clone — remove it or set CLAWS_DIR to a different path"
else
  info "cloning $REPO → $INSTALL_DIR"
  git clone --quiet "$REPO" "$INSTALL_DIR"
  ok "cloned to $INSTALL_DIR"
fi

# ─── Step 2: Build + symlink extension ─────────────────────────────────────
step "Installing extension"

# 2a. Build
# Since Claws isn't on the VS Code Marketplace, the install script IS the
# release mechanism. Every run must produce a bundle that reflects whatever
# `extension/src/` is currently on main. Rebuild whenever:
#   - the bundle is missing, OR
#   - any `src/` file is newer than the bundle, OR
#   - the current git HEAD doesn't match the SHA the bundle was built from,
#     OR the user explicitly sets CLAWS_FORCE_BUILD=1.
# Build is ~seconds on a primed node_modules — rebuilding conservatively is
# cheaper than a stale bundle.
BUILD_OK=0
BUNDLE="$INSTALL_DIR/extension/dist/extension.js"
BUILD_SHA_FILE="$INSTALL_DIR/extension/dist/.build-sha"
CURRENT_SHA="$(cd "$INSTALL_DIR" && git rev-parse HEAD 2>/dev/null || echo 'nogit')"
LAST_BUILD_SHA="$(cat "$BUILD_SHA_FILE" 2>/dev/null || echo '')"

needs_build() {
  [ "${CLAWS_FORCE_BUILD:-0}" = "1" ] && return 0
  [ ! -f "$BUNDLE" ] && return 0
  [ "$CURRENT_SHA" != "$LAST_BUILD_SHA" ] && return 0
  # Any TS source newer than the bundle — catches local edits and any file
  # changed by git pull, not just extension.ts.
  if find "$INSTALL_DIR/extension/src" -type f \( -name '*.ts' -o -name '*.js' \) -newer "$BUNDLE" 2>/dev/null | grep -q .; then
    return 0
  fi
  return 1
}

if command -v npm &>/dev/null && [ -f "$INSTALL_DIR/extension/package.json" ]; then
  # ── Bundle build: only when source actually changed ──────────────────────
  # Unchanged bundle + unchanged git HEAD = safe to skip. This is a caching
  # optimization only; it does NOT affect node-pty, which runs unconditionally
  # below so "update is always equivalent to fresh install".
  if needs_build; then
    if [ "$CURRENT_SHA" = "$LAST_BUILD_SHA" ]; then
      info "rebuilding extension bundle (source changed locally)"
    elif [ -z "$LAST_BUILD_SHA" ]; then
      info "building extension bundle (first run)"
    else
      info "rebuilding extension bundle (git HEAD changed: ${LAST_BUILD_SHA:0:7} → ${CURRENT_SHA:0:7})"
    fi
    if ( cd "$INSTALL_DIR/extension" && npm install --no-audit --no-fund --loglevel=error --silent && npm run build --silent ); then
      echo "$CURRENT_SHA" > "$BUILD_SHA_FILE" 2>/dev/null || true
      BUILD_OK=1
      ok "extension built ($(wc -c < "$BUNDLE" | tr -d ' ') bytes, SHA ${CURRENT_SHA:0:7})"
    else
      warn "extension build failed — see $CLAWS_LOG for details. Falling back to legacy JS."
      node --no-deprecation -e "const fs=require('fs'),p='$INSTALL_DIR/extension/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.main='./src/extension.js';fs.writeFileSync(p,JSON.stringify(j,null,2));" 2>/dev/null || true
    fi
  else
    BUILD_OK=1
    ok "extension bundle up to date (SHA ${CURRENT_SHA:0:7}, $(wc -c < "$BUNDLE" | tr -d ' ') bytes)"
    # Even if the bundle is current, make sure npm has actually fetched
    # node-pty (optional dep). A user who cloned before node-pty was added,
    # or whose node_modules got removed, will have no node-pty dir at all.
    if [ ! -d "$INSTALL_DIR/extension/node_modules/node-pty" ]; then
      info "fetching missing deps (node-pty not present)"
      ( cd "$INSTALL_DIR/extension" && npm install --no-audit --no-fund --loglevel=error --silent ) || true
    fi
  fi

  # ── node-pty native binary: ALWAYS verified, rebuilt if ABI-wrong ────────
  # This runs on every install AND every /claws-update, whether the bundle
  # was rebuilt or not. That makes update equivalent to fresh install —
  # no "I updated but the binary stayed wrong" class of bug.
  #
  # node-pty is a native module. Its NODE_MODULE_VERSION must match whatever
  # Node runtime loads it. VS Code's extension host runs Electron-embedded
  # Node, NOT the user's system Node. Building against system Node (what a
  # plain `node-gyp rebuild` does) produces a binary that loads from
  # /usr/local/bin/node but silently fails in the extension host. We use
  # @electron/rebuild to target the exact Electron version detected from the
  # installed VS Code.app — the binary ends up ABI-compatible with the
  # extension host and wrapped terminals get real pty mode.
  NPTY_BIN="$INSTALL_DIR/extension/node_modules/node-pty/build/Release/pty.node"
  ELECTRON_ABI_FILE="$INSTALL_DIR/extension/dist/.electron-abi"
  NPTY_JUST_COMPILED=0
  if [ -d "$INSTALL_DIR/extension/node_modules/node-pty" ]; then
    # Detect VS Code's Electron version from the installed app.
    ELECTRON_VERSION=""
    case "$PLATFORM" in
      Darwin)
        for app in \
          "/Applications/Visual Studio Code.app" \
          "/Applications/Visual Studio Code - Insiders.app" \
          "/Applications/Cursor.app" \
          "/Applications/Windsurf.app"; do
          plist="$app/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist"
          if [ -f "$plist" ]; then
            v=$(plutil -extract CFBundleVersion raw "$plist" 2>/dev/null || true)
            if [ -n "$v" ]; then
              ELECTRON_VERSION="$v"
              info "detected Electron $v from $(basename "$app")"
              break
            fi
          fi
        done
        ;;
    esac
    [ -z "$ELECTRON_VERSION" ] && ELECTRON_VERSION="39.8.5" \
      && info "couldn't detect Electron version — using fallback $ELECTRON_VERSION"

    LAST_ABI=$(cat "$ELECTRON_ABI_FILE" 2>/dev/null || echo "")
    NEEDS_NPTY_BUILD=0
    [ ! -f "$NPTY_BIN" ] && NEEDS_NPTY_BUILD=1
    [ "$LAST_ABI" != "$ELECTRON_VERSION" ] && NEEDS_NPTY_BUILD=1
    [ "${CLAWS_FORCE_REBUILD_NPTY:-0}" = "1" ] && NEEDS_NPTY_BUILD=1

    if [ "$NEEDS_NPTY_BUILD" = "1" ]; then
      if [ "$PLATFORM" = "Darwin" ] && ! xcode-select -p &>/dev/null; then
        warn "Xcode Command Line Tools not installed — can't compile node-pty."
        info "Install CLT with: xcode-select --install   then re-run /claws-update"
      else
        if [ ! -f "$NPTY_BIN" ]; then
          info "building node-pty for Electron $ELECTRON_VERSION (binary missing)"
        else
          info "rebuilding node-pty for Electron $ELECTRON_VERSION (was: ${LAST_ABI:-unknown})"
        fi
        # Remove stale binary + marker so the rebuild is unambiguously fresh.
        rm -f "$NPTY_BIN" "$ELECTRON_ABI_FILE" 2>/dev/null || true
        if ( cd "$INSTALL_DIR/extension" && npx --yes @electron/rebuild --version="$ELECTRON_VERSION" --which=node-pty --force >/dev/null 2>&1 ) && [ -f "$NPTY_BIN" ]; then
          echo "$ELECTRON_VERSION" > "$ELECTRON_ABI_FILE" 2>/dev/null || true
          ok "node-pty built for Electron $ELECTRON_VERSION ($(wc -c < "$NPTY_BIN" | tr -d ' ') bytes)"
          NPTY_JUST_COMPILED=1
        else
          warn "@electron/rebuild failed — wrapped terminals will fall back to pipe-mode."
          info "TUI rendering (claude, vim, htop) will be degraded. See $CLAWS_LOG for build errors."
          info "manual fix: bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/rebuild-node-pty.sh)"
        fi
      fi
    else
      ok "node-pty binary OK for Electron $ELECTRON_VERSION (ABI matches)"
    fi
  else
    # node-pty directory itself is missing even after the install attempt
    # above. Likely means npm install failed or the optional dep was skipped
    # (e.g. --no-optional). Don't block the install; warn and move on.
    warn "node-pty package not installed — wrapped terminals will use pipe-mode"
    info "to install: ( cd $INSTALL_DIR/extension && npm install node-pty )"
  fi
  # Explicit nudge when we just compiled the binary: any VS Code window
  # already open needs to reload to pick up the new pty.node.
  if [ "$NPTY_JUST_COMPILED" = "1" ]; then
    info "reload VS Code to activate: Cmd+Shift+P → Developer: Reload Window"
  fi
else
  warn "npm or extension/package.json missing — using legacy src/extension.js"
  node --no-deprecation -e "const fs=require('fs'),p='$INSTALL_DIR/extension/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.main='./src/extension.js';fs.writeFileSync(p,JSON.stringify(j,null,2));" 2>/dev/null || true
fi

# 2b. Read extension version from manifest so the symlink matches
EXT_VERSION="0.4.0"
if command -v node &>/dev/null && [ -f "$INSTALL_DIR/extension/package.json" ]; then
  EXT_VERSION=$(node -e "try{console.log(require('$INSTALL_DIR/extension/package.json').version||'0.4.0')}catch(e){console.log('0.4.0')}" 2>/dev/null || echo "0.4.0")
fi

# 2c. Install the extension into every detected editor.
#
# This is the hero of the install: without it, nothing else matters. We
# prefer the proper VSIX + `code --install-extension` flow because:
#   - VS Code manages extensions.json itself (reliable activation)
#   - Extension shows up in Extensions panel like any marketplace install
#   - User can disable/uninstall via the UI
#
# If vsce packaging fails OR no editor CLI is found, we fall back to a
# symlink into the first detected extensions dir — always-works fallback.

EXT_LINK=""
INSTALLED_EDITORS=()
VSIX_PATH=""

# Build a VSIX. `vsce package` downloads via npx on first run (~10s once,
# cached after). If it fails we continue to symlink fallback.
if [ "${BUILD_OK:-0}" = "1" ] && command -v npx &>/dev/null; then
  VSIX_PATH="/tmp/claws-$EXT_VERSION.vsix"
  info "packaging VSIX for VS Code install"
  if ( cd "$INSTALL_DIR/extension" \
       && npx --yes @vscode/vsce package --skip-license --no-git-tag-version --no-update-package-json --out "$VSIX_PATH" ) >/dev/null 2>&1; then
    ok "packaged $VSIX_PATH ($(wc -c < "$VSIX_PATH" | tr -d ' ') bytes)"
  else
    warn "vsce package failed — will fall back to symlink install"
    VSIX_PATH=""
  fi
fi

# Find every editor CLI on the system. Accepts:
#   - CLIs in PATH (most Linux installs, macOS when user ran "Shell Command:
#     Install 'code' command in PATH")
#   - macOS app-bundled CLIs at their canonical locations (works even when
#     the user never ran the shell-command installer)
detect_editor_clis() {
  local out=()
  for pair in \
    "code:/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "code-insiders:/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders" \
    "cursor:/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
    "windsurf:/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf"; do
    local label="${pair%%:*}"
    local bundled="${pair#*:}"
    local cli=""
    if command -v "$label" &>/dev/null; then
      cli="$(command -v "$label")"
    elif [ -x "$bundled" ]; then
      cli="$bundled"
    fi
    [ -n "$cli" ] && out+=("$label|$cli")
  done
  # Print one per line so the caller can loop.
  printf '%s\n' "${out[@]}"
}

if [ -n "$VSIX_PATH" ]; then
  while IFS='|' read -r label cli; do
    [ -z "$label" ] && continue
    info "installing into $label via $cli"
    if "$cli" --install-extension "$VSIX_PATH" --force >/dev/null 2>&1; then
      ok "Claws extension installed in $label"
      INSTALLED_EDITORS+=("$label")
    else
      # One known failure: the extension is already loaded in a running
      # window and VS Code refuses reinstall without restart. Still OK —
      # next reload picks up the new bundle.
      warn "$label refused install (likely a running window holds the old version — reload to activate)"
    fi
  done < <(detect_editor_clis)
fi

# Fallback symlink — always attempted, harmless if VSIX install also
# succeeded (VS Code will prefer the official install).
if [ "${#INSTALLED_EDITORS[@]}" -eq 0 ] && [ -n "$EXT_DIR" ]; then
  EXT_LINK="$EXT_DIR/neunaha.claws-$EXT_VERSION"
  info "falling back to symlink: $EXT_LINK"
  rm -f "$EXT_DIR"/neunaha.claws-* 2>/dev/null || sudo rm -f "$EXT_DIR"/neunaha.claws-* 2>/dev/null || true
  if ln -sf "$INSTALL_DIR/extension" "$EXT_LINK" 2>/dev/null \
     || sudo ln -sf "$INSTALL_DIR/extension" "$EXT_LINK" 2>/dev/null; then
    ok "extension symlinked → $EXT_LINK"
    INSTALLED_EDITORS+=("symlink")
  else
    bad "could not install extension — neither VSIX nor symlink worked"
    info "run manually: code --install-extension $VSIX_PATH  (or: ln -s $INSTALL_DIR/extension $EXT_LINK)"
  fi
elif [ -z "$EXT_DIR" ] && [ "${#INSTALLED_EDITORS[@]}" -eq 0 ]; then
  warn "CLAWS_EDITOR=skip and no editor CLI detected — extension not installed"
fi

# ─── Step 3: Script permissions ────────────────────────────────────────────
step "Setting file permissions"
chmod +x "$INSTALL_DIR"/scripts/*.sh 2>/dev/null || true
chmod +x "$INSTALL_DIR/mcp_server.js" 2>/dev/null || true
ok "scripts executable"

# ─── Step 4: Runtime check ─────────────────────────────────────────────────
step "Runtime check"
info "No Python required — Node.js only"
ok "runtime ready"

# ─── Step 5: MCP server (project-local primary, global opt-in) ─────────────
step "Configuring MCP server"

MCP_PATH="$INSTALL_DIR/mcp_server.js"
if [ "${CLAWS_SKIP_MCP:-0}" = "1" ]; then
  warn "CLAWS_SKIP_MCP=1 — skipping MCP registration"
else
  if [ "$PROJECT_INSTALL" = "1" ]; then
    mkdir -p "$PROJECT_ROOT/.claws-bin"
    cp "$INSTALL_DIR/mcp_server.js" "$PROJECT_ROOT/.claws-bin/mcp_server.js"
    chmod +x "$PROJECT_ROOT/.claws-bin/mcp_server.js"
    cp "$INSTALL_DIR/scripts/shell-hook.sh" "$PROJECT_ROOT/.claws-bin/shell-hook.sh"
    ok "vendored $PROJECT_ROOT/.claws-bin/"

    # Write or merge .mcp.json with relative-path registration
    PROJECT_MCP="$PROJECT_ROOT/.mcp.json"
    node --no-deprecation -e "
const fs = require('fs');
const p = process.argv[1];
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
if (!cfg.mcpServers) cfg.mcpServers = {};
cfg.mcpServers.claws = {
  command: 'node',
  args: ['./.claws-bin/mcp_server.js'],
  env: { CLAWS_SOCKET: '.claws/claws.sock' }
};
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
" "$PROJECT_MCP"
    ok "wrote $PROJECT_MCP"

    # Write/merge .vscode/extensions.json so VS Code prompts anyone who opens
    # this project without Claws installed. Pins `neunaha.claws` as a
    # workspace-recommended extension. Doesn't force-install — just shows
    # the standard "this workspace recommends installing these extensions"
    # prompt.
    if [ "${CLAWS_SKIP_VSCODE_RECOMMEND:-0}" != "1" ]; then
      VSCODE_DIR="$PROJECT_ROOT/.vscode"
      VSCODE_EXT_JSON="$VSCODE_DIR/extensions.json"
      mkdir -p "$VSCODE_DIR"
      node --no-deprecation -e "
const fs = require('fs');
const p = process.argv[1];
let cfg = {};
let parseError = false;
try {
  const raw = fs.readFileSync(p, 'utf8');
  // Strip JSONC line + block comments so existing commented files merge
  // cleanly instead of being overwritten.
  const stripped = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  cfg = JSON.parse(stripped);
} catch (e) {
  if (fs.existsSync(p)) parseError = true;
}
if (parseError) {
  console.log('existing extensions.json has non-standard syntax — leaving it untouched');
  process.exit(0);
}
if (!Array.isArray(cfg.recommendations)) cfg.recommendations = [];
if (!cfg.recommendations.includes('neunaha.claws')) {
  cfg.recommendations.push('neunaha.claws');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  console.log('added neunaha.claws to workspace recommendations');
} else {
  console.log('neunaha.claws already in workspace recommendations');
}
" "$VSCODE_EXT_JSON" | sed 's/^/    /' || true
      ok "wrote $VSCODE_EXT_JSON"
    fi
  else
    warn "no safe project dir — skipping project .mcp.json and .vscode/extensions.json"
  fi

  if [ "${CLAWS_GLOBAL_MCP:-0}" = "1" ]; then
    mkdir -p "$HOME/.claude"
    node --no-deprecation -e "
const fs = require('fs');
const p = '$HOME/.claude/settings.json';
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
if (!cfg.mcpServers) cfg.mcpServers = {};
cfg.mcpServers.claws = {
  command: 'node',
  args: ['$MCP_PATH'],
  env: { CLAWS_SOCKET: '.claws/claws.sock' }
};
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
"
    ok "global MCP registered in ~/.claude/settings.json"
  fi
fi

# ─── Step 6: Claude Code capabilities (commands/rules/skills/CLAUDE.md) ────
step "Installing Claude Code capabilities"

install_capabilities_into() {
  local TARGET="$1"
  local LABEL="$2"
  local CMD_DIR="$TARGET/.claude/commands"
  mkdir -p "$CMD_DIR" "$TARGET/.claude/rules" "$TARGET/.claude/skills"

  local cmd_count=0
  if [ -d "$INSTALL_DIR/.claude/commands" ]; then
    for cmd in "$INSTALL_DIR/.claude/commands"/claws*.md; do
      [ -f "$cmd" ] || continue
      cp "$cmd" "$CMD_DIR/" && cmd_count=$((cmd_count+1))
    done
  fi

  # Self-referential /claws-install command (points at GitHub so it works in any project)
  cat > "$CMD_DIR/claws-install.md" <<'CLAWSCMD'
---
name: claws-install
description: Install or update Claws — Terminal Control Bridge for VS Code. Runs the installer inside the current project so this workspace gets the full project-local setup.
---

# /claws-install

Install or update Claws in THIS project from https://github.com/neunaha/claws

Run this from the project root:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)
```

After the script completes:
1. Reload VS Code: Cmd+Shift+P → Developer: Reload Window
2. Restart Claude Code in this project so the project-local `.mcp.json` is picked up.
3. Try `/claws-help` or `/claws-status`.

If MCP tools don't appear after restart, run `/claws-fix` or `/claws-report`.
CLAWSCMD
  cmd_count=$((cmd_count+1))

  [ -f "$INSTALL_DIR/rules/claws-default-behavior.md" ] \
    && cp "$INSTALL_DIR/rules/claws-default-behavior.md" "$TARGET/.claude/rules/" || true

  if [ -d "$INSTALL_DIR/.claude/skills/claws-orchestration-engine" ]; then
    rm -rf "$TARGET/.claude/skills/claws-orchestration-engine" 2>/dev/null || true
    cp -r "$INSTALL_DIR/.claude/skills/claws-orchestration-engine" "$TARGET/.claude/skills/"
  fi
  if [ -d "$INSTALL_DIR/.claude/skills/prompt-templates" ]; then
    rm -rf "$TARGET/.claude/skills/claws-prompt-templates" 2>/dev/null || true
    cp -r "$INSTALL_DIR/.claude/skills/prompt-templates" "$TARGET/.claude/skills/claws-prompt-templates"
  fi

  # CLAUDE.md injection (project scope only — never inside $HOME)
  if [ "$TARGET" != "$HOME" ]; then
    node --no-deprecation "$INSTALL_DIR/scripts/inject-claude-md.js" "$TARGET" 2>&1 | sed 's/^/  /' || warn "CLAUDE.md injector failed"
  fi

  ok "$LABEL: $cmd_count commands, rules, skills"
}

if [ "$PROJECT_INSTALL" = "1" ]; then
  install_capabilities_into "$PROJECT_ROOT" "project"
else
  warn "skipped project-local capabilities (no safe project dir)"
fi

if [ "${CLAWS_GLOBAL_CONFIG:-0}" = "1" ]; then
  install_capabilities_into "$HOME" "global (~/.claude)"
fi

# ─── Step 7: Shell hook ────────────────────────────────────────────────────
step "Injecting shell hook"
HOOK_SOURCE="source \"$INSTALL_DIR/scripts/shell-hook.sh\""
HOOK_MARKER="# CLAWS terminal hook"

inject_hook() {
  local rcfile="$1"
  touch "$rcfile" 2>/dev/null || true
  if grep -q "CLAWS terminal hook" "$rcfile" 2>/dev/null; then
    ok "already in $(basename "$rcfile")"
  else
    printf "\n%s\n%s\n" "$HOOK_MARKER" "$HOOK_SOURCE" >> "$rcfile" && ok "added to $(basename "$rcfile")" || warn "could not write to $rcfile"
  fi
}

inject_hook "$HOME/.zshrc"
inject_hook "$HOME/.bashrc"
[ "$PLATFORM" = "Darwin" ] && inject_hook "$HOME/.bash_profile"

if [ -d "$HOME/.config/fish" ]; then
  FISH_CONF="$HOME/.config/fish/conf.d/claws.fish"
  if [ ! -f "$FISH_CONF" ]; then
    mkdir -p "$HOME/.config/fish/conf.d" 2>/dev/null
    {
      echo "# CLAWS terminal hook"
      echo "if status is-interactive"
      echo "  source $INSTALL_DIR/scripts/shell-hook.sh"
      echo "end"
    } > "$FISH_CONF" && ok "added to fish" || warn "could not write fish config"
  fi
fi

# ─── Step 8: Verify ────────────────────────────────────────────────────────
step "Verifying"

CHECKS_PASS=0
CHECKS_FAIL=0
_ok()   { ok "$*"; CHECKS_PASS=$((CHECKS_PASS+1)); }
_miss() { bad "$*"; CHECKS_FAIL=$((CHECKS_FAIL+1)); }

if [ "${#INSTALLED_EDITORS[@]}" -gt 0 ]; then
  _ok "Extension installed in: ${INSTALLED_EDITORS[*]}"
else
  _miss "Extension not installed in any editor — run /claws-fix"
fi
[ -f "$INSTALL_DIR/extension/dist/extension.js" ] && _ok "Extension bundle built" || warn "Extension bundle missing — fallback to legacy JS active"
[ -f "$MCP_PATH" ] && _ok "MCP server exists at $MCP_PATH" || _miss "$MCP_PATH missing"
command -v node &>/dev/null && _ok "Node.js available ($(node --version))" || _miss "node not found"

if [ "$PROJECT_INSTALL" = "1" ]; then
  [ -f "$PROJECT_ROOT/.mcp.json" ] && _ok "Project .mcp.json" || _miss "project .mcp.json missing"
  [ -f "$PROJECT_ROOT/.claws-bin/mcp_server.js" ] && _ok "Project .claws-bin/mcp_server.js" || _miss "project mcp_server.js copy missing"
  [ -f "$PROJECT_ROOT/.vscode/extensions.json" ] && grep -q "neunaha.claws" "$PROJECT_ROOT/.vscode/extensions.json" 2>/dev/null && _ok "Project .vscode/extensions.json recommends claws" || warn "project .vscode/extensions.json missing claws recommendation"
  [ -d "$PROJECT_ROOT/.claude/commands" ] && _ok "Project .claude/commands" || _miss "project commands missing"
  [ -d "$PROJECT_ROOT/.claude/skills" ] && _ok "Project .claude/skills" || _miss "project skills missing"
  [ -d "$PROJECT_ROOT/.claude/rules" ] && _ok "Project .claude/rules" || _miss "project rules missing"
  [ -f "$PROJECT_ROOT/CLAUDE.md" ] && _ok "Project CLAUDE.md" || warn "project CLAUDE.md not created"
fi

# Test MCP server handshake (portable — no dependency on GNU timeout)
VERIFY_MCP="$MCP_PATH"
[ "$PROJECT_INSTALL" = "1" ] && [ -f "$PROJECT_ROOT/.claws-bin/mcp_server.js" ] && VERIFY_MCP="$PROJECT_ROOT/.claws-bin/mcp_server.js"
if command -v node &>/dev/null && [ -f "$VERIFY_MCP" ]; then
  if MCP_TEST=$(node --no-deprecation -e '
const { spawn } = require("child_process");
const mcp = spawn("node", [process.argv[1]], { stdio: ["pipe", "pipe", "ignore"] });
const req = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
const msg = `Content-Length: ${Buffer.byteLength(req)}\r\n\r\n${req}`;
let buf = "";
const done = (code, out) => { try { mcp.kill(); } catch {} ; process.stdout.write(out); process.exit(code); };
const timer = setTimeout(() => done(1, "TIMEOUT"), 5000);
mcp.stdout.on("data", d => { buf += d.toString("utf8"); if (buf.includes("claws")) { clearTimeout(timer); done(0, buf.slice(0, 200)); } });
mcp.on("error", e => { clearTimeout(timer); done(1, "SPAWN_ERROR: " + e.message); });
mcp.stdin.write(msg);
' "$VERIFY_MCP" 2>&1) && echo "$MCP_TEST" | grep -q "claws"; then
    _ok "MCP server starts and responds (initialize OK)"
  else
    _miss "MCP server failed initialize — run: node $VERIFY_MCP"
    info "$MCP_TEST"
  fi
fi

echo ""
if [ "$CHECKS_FAIL" -eq 0 ]; then
  ok "$CHECKS_PASS checks passed"
else
  warn "$CHECKS_PASS passed, $CHECKS_FAIL issue(s) — see above"
fi

# ─── End-of-install banner ─────────────────────────────────────────────────
cat <<BANNER

   ${C_BOLD}██████╗██╗      █████╗ ██╗    ██╗███████╗
  ██╔════╝██║     ██╔══██╗██║    ██║██╔════╝
  ██║     ██║     ███████║██║ █╗ ██║███████╗
  ██║     ██║     ██╔══██║██║███╗██║╚════██║
  ╚██████╗███████╗██║  ██║╚███╔███╔╝███████║
   ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚══════╝${C_RESET}

  ${C_BOLD}Terminal Control Bridge${C_RESET} v$EXT_VERSION — installed.

BANNER
if [ "$PROJECT_INSTALL" = "1" ]; then
  printf '  Project:     %s\n' "$PROJECT_ROOT"
  printf '  MCP server:  %s\n' "$PROJECT_ROOT/.claws-bin/mcp_server.js"
  printf '  Registered:  %s\n' "$PROJECT_ROOT/.mcp.json"
else
  printf '  Project:     ${C_YELLOW}(none — re-run from your project root)${C_RESET}\n'
  printf '  MCP server:  %s\n' "$MCP_PATH"
fi
if [ "${#INSTALLED_EDITORS[@]}" -gt 0 ]; then
  printf '  Extension:   installed in %s\n' "${INSTALLED_EDITORS[*]}"
else
  printf '  Extension:   ${C_YELLOW}NOT INSTALLED — run /claws-fix${C_RESET}\n'
fi
printf '  Install log: %s\n' "$CLAWS_LOG"
cat <<NEXT

  ${C_BOLD}── Activate Claws ──${C_RESET}
    1. Reload VS Code:      Cmd+Shift+P → "Developer: Reload Window"
    2. Restart Claude Code: exit this session and re-open in THIS project
                            so .mcp.json is picked up
    3. Try:                 /claws-help    or    /claws-status

  ${C_BOLD}── If something is off ──${C_RESET}
    MCP tools not appearing?   /claws-fix
    Want to report an issue?   /claws-report  (bundles logs + diagnostics)
    Update later:              /claws-update

  Docs:    https://github.com/neunaha/claws
  Website: https://neunaha.github.io/claws/

NEXT

# Source shell hook last so its output doesn't push the banner off-screen.
# shellcheck disable=SC1090
source "$INSTALL_DIR/scripts/shell-hook.sh" 2>/dev/null || true
