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
#   CLAWS_STRICT=1              Hard-block long-running Bash via PreToolUse hook (v0.6.4+)
#   CLAWS_NO_GLOBAL_HOOKS=1     Skip ~/.claude/settings.json hook registration (test/CI safe)

# ─── Strict-ish mode ────────────────────────────────────────────────────────
# -e: exit on unhandled error
# -o pipefail: catch errors inside pipes
# We do NOT use -u because optional env vars are allowed to be unset.
set -eo pipefail

# If CLAWS_DEBUG=1, trace every line.
# Unset any env vars that may contain secrets before enabling xtrace
# so they don't appear in the trace log.
if [ "${CLAWS_DEBUG:-0}" = "1" ]; then
  { unset AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_ACCESS_KEY_ID \
         GITHUB_TOKEN NPM_TOKEN ANTHROPIC_API_KEY OPENAI_API_KEY \
         CLAWS_TOKEN HOMEBREW_GITHUB_API_TOKEN; } 2>/dev/null || true
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
STEP_TOTAL=9
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
CLAWS_REF="${CLAWS_REF:-main}"
USER_PWD="$(pwd)"
PLATFORM="$(uname -s)"
case "$PLATFORM" in
  MINGW*|MSYS*|CYGWIN*)
    die "Windows (Git Bash/MSYS/Cygwin) not supported — use WSL2: https://aka.ms/wslinstall" ;;
esac

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

# ─── Preflight: dependencies ───────────────────────────────────────────────
# Every dependency the installer or the extension's build chain touches is
# checked here with a specific install command for the ones that are missing.
# Fatal checks (die) are things Claws literally cannot work without. Warning
# checks are things that degrade specific features.
echo "Checking dependencies..."
# Disk space: clone + npm install + native build + VSIX needs ~500MB
_avail_kb=$(df -k "$HOME" 2>/dev/null | awk 'NR==2{print $4}' || echo "")
if [ -n "$_avail_kb" ] && [ "$_avail_kb" -lt 512000 ] 2>/dev/null; then
  warn "Low disk space: $(( _avail_kb / 1024 ))MB free in \$HOME — Claws needs ~500MB for clone, build, and VSIX packaging"
fi
unset _avail_kb

# ── Required: git ──────────────────────────────────────────────────────────
if command -v git &>/dev/null; then
  GIT_VERSION_STR="$(git --version | awk '{print $3}')"
  GIT_MAJOR="$(echo "$GIT_VERSION_STR" | cut -d. -f1)"
  if [ "${GIT_MAJOR:-0}" -lt 2 ] 2>/dev/null; then
    die "git $GIT_VERSION_STR too old — Claws requires git 2+. Upgrade via your package manager."
  fi
  ok "git ($GIT_VERSION_STR)"
else
  case "$PLATFORM" in
    Darwin) die "git not found — install with: xcode-select --install" ;;
    Linux)  die "git not found — install with: sudo apt install git  (or your distro's package manager)" ;;
    *)      die "git not found — install from https://git-scm.com/" ;;
  esac
fi

# ── Required: Node.js 18+ (for MCP server + extension build) ───────────────
if ! command -v node &>/dev/null; then
  [ -d "$HOME/.nvm" ] && info "nvm detected — run: nvm use --lts  then re-run this installer."
  [ -d "$HOME/.fnm" ] && info "fnm detected — run: fnm use --lts  then re-run this installer."
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
NPM_MAJOR=$(npm --version 2>/dev/null | cut -d. -f1 || echo "0")
if [ "$NPM_MAJOR" -lt 7 ] 2>/dev/null; then
  die "npm $(npm --version) too old — requires npm 7+. Upgrade: npm install -g npm"
fi

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
ARCH="$(uname -m)"
info "Architecture: $ARCH"
info "Shell: $SHELL ($BASH_VERSION)"
info "Install log: $CLAWS_LOG"
[ "$TOOLCHAIN_OK" = "0" ] && warn "toolchain issues above — install will still run, but node-pty may not compile"
echo ""

# ─── Step 1: Clone or update ───────────────────────────────────────────────
step "Fetching Claws source"
if [ -d "$INSTALL_DIR/.git" ]; then
  info "updating existing clone at $INSTALL_DIR (ref: $CLAWS_REF)"
  PREV_SHA="$(cd "$INSTALL_DIR" && git rev-parse HEAD 2>/dev/null || echo 'unknown')"
  if ( cd "$INSTALL_DIR" && git fetch origin "$CLAWS_REF" 2>>"$CLAWS_LOG" \
       && git reset --hard --quiet "origin/$CLAWS_REF" ); then
    NEW_SHA="$(cd "$INSTALL_DIR" && git rev-parse HEAD 2>/dev/null || echo 'unknown')"
    if [ "$PREV_SHA" = "$NEW_SHA" ]; then
      ok "already at origin/$CLAWS_REF (${NEW_SHA:0:7})"
    else
      ok "updated ${PREV_SHA:0:7} → ${NEW_SHA:0:7}"
    fi
    # GAP-3 (v0.7.7.1): if update.sh's --ff-only pull diverged and set GIT_PULL_OK=0,
    # but our force-reset above succeeded, the source is now fresh — flip the flag back
    # so CLAUDE.md re-injection (gated on GIT_PULL_OK) runs. Without this, users with a
    # modified ~/.claws-src clone get fresh source but stale CLAUDE.md tool lists.
    if [ "${GIT_PULL_OK:-1}" = "0" ]; then
      info "force-reset succeeded after ff-only divergence — re-enabling CLAUDE.md injection"
      GIT_PULL_OK=1
      export GIT_PULL_OK
    fi
    git -C "$INSTALL_DIR" fsck --no-dangling 2>/dev/null || warn "clone integrity check failed — consider: rm -rf $INSTALL_DIR && re-run installer"
  else
    bad "failed to update $INSTALL_DIR (network error or corrupted clone)."
    bad "Fix: rm -rf $INSTALL_DIR && re-run this installer."
    exit 1
  fi
elif [ -d "$INSTALL_DIR" ]; then
  die "$INSTALL_DIR exists but is not a git clone — remove it or set CLAWS_DIR to a different path"
else
  info "cloning $REPO → $INSTALL_DIR (ref: $CLAWS_REF, shallow)"
  git clone --depth 1 --branch "$CLAWS_REF" "$REPO" "$INSTALL_DIR" 2>>"$CLAWS_LOG" \
    || git clone --depth 1 "$REPO" "$INSTALL_DIR" 2>>"$CLAWS_LOG"
  ok "cloned to $INSTALL_DIR (${CLAWS_REF})"
  git -C "$INSTALL_DIR" fsck --no-dangling 2>/dev/null || warn "clone integrity check failed — consider: rm -rf $INSTALL_DIR && re-run installer"
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
  # ── Canonical build path ─────────────────────────────────────────────────
  # `npm run build` = esbuild (TS → dist/extension.js) + bundle-native.mjs
  # (detects the user's VS Code Electron version, runs @electron/rebuild
  # against node_modules/node-pty, and copies the ABI-correct binary into
  # extension/native/node-pty/). That native/ directory is what the VSIX
  # ships (via .vscodeignore's `!native/**`) and what claws-pty.ts loads
  # at runtime. ONE build step owns both outputs — there is no second
  # rebuild, and there is no fallback to a stale binary.
  #
  # If @electron/rebuild fails (missing Xcode CLT, node-gyp/Python issue,
  # network failure while fetching Electron headers), the build fails
  # loud and the installer aborts. A silently-broken binary would ship a
  # VSIX that lands but can't load node-pty — the exact pipe-mode bug
  # we're trying to kill.
  NATIVE_PTY_BIN="$INSTALL_DIR/extension/native/node-pty/build/Release/pty.node"

  # Pre-flight: on macOS, @electron/rebuild needs Xcode Command Line Tools
  # to compile node-pty. Check up front so the error is obvious, not
  # buried 200 lines into npm output.
  if [ "$PLATFORM" = "Darwin" ] && ! xcode-select -p &>/dev/null; then
    bad "Xcode Command Line Tools required to build node-pty."
    bad "Fix: run 'xcode-select --install', wait for it to finish, then re-run this installer."
    exit 1
  fi

  # Pre-detect Electron version from installed editors before building.
  # bundle-native.mjs detects this too, but surfacing it here lets users
  # see the ABI target before a potentially long compile.
  _ELECTRON_PRE=""
  case "$PLATFORM" in
    Darwin)
      for _plist in \
        "/Applications/Visual Studio Code.app/Contents/Resources/app/package.json" \
        "/Applications/Cursor.app/Contents/Resources/app/package.json" \
        "/Applications/Windsurf.app/Contents/Resources/app/package.json"; do
        if [ -f "$_plist" ]; then
          _v=$(node -e "try{console.log(require('$_plist').electronVersion||'')}catch{}" 2>/dev/null || true)
          if [ -n "$_v" ]; then
            _label=$(basename "$(dirname "$(dirname "$(dirname "$_plist")")")" | sed 's/\.app//')
            info "Detected Electron $_v from $_label"
            _ELECTRON_PRE="$_v"
            break
          fi
        fi
      done
      ;;
    Linux)
      for _ep in /usr/share/code/electron /snap/code/current/usr/share/code/electron /opt/visual-studio-code/electron; do
        if [ -x "$_ep" ]; then
          _v=$("$_ep" --version 2>/dev/null | sed 's/^v//' || true)
          if [ -n "$_v" ]; then
            info "Detected Electron $_v from $_ep"
            _ELECTRON_PRE="$_v"
            break
          fi
        fi
      done
      ;;
  esac
  [ -z "$_ELECTRON_PRE" ] && info "Electron version not pre-detected — bundle-native.mjs will detect at build time"

  needs_rebuild_native=0
  [ ! -f "$NATIVE_PTY_BIN" ] && needs_rebuild_native=1
  [ "${CLAWS_FORCE_REBUILD_NPTY:-0}" = "1" ] && needs_rebuild_native=1
  if needs_build; then needs_rebuild_native=1; fi

  # Electron-ABI drift detection (v0.7.3). If the user updated VS Code/Cursor/
  # Windsurf to a newer Electron version since the last build, the bundled
  # pty.node is now ABI-mismatched and the extension will silently fall into
  # pipe-mode. Read native/.metadata.json's electronVersion (written by
  # bundle-native.mjs at build time) and compare with the currently-installed
  # editor's Electron version. If they differ, force a rebuild.
  if [ -f "$NATIVE_PTY_BIN" ] && [ -f "$INSTALL_DIR/extension/native/.metadata.json" ] && [ "$needs_rebuild_native" = "0" ]; then
    _claws_last_elec=$(node -e "try{console.log(require('$INSTALL_DIR/extension/native/.metadata.json').electronVersion||'')}catch(e){}" 2>/dev/null || echo "")
    _claws_curr_elec=""
    if [ "$PLATFORM" = "Darwin" ]; then
      # M-22: build candidate list with TERM_PROGRAM-matching editor first so the
      # user's daily-driver wins the ABI check instead of the hardcoded VS Code path.
      _tp="${TERM_PROGRAM:-}"
      # F2: use bash array — avoids eval footgun while keeping TERM_PROGRAM ordering.
      case "$_tp" in
        cursor)   _claws_darwin_apps=('/Applications/Cursor.app' '/Applications/Visual Studio Code.app' '/Applications/Visual Studio Code - Insiders.app' '/Applications/Windsurf.app') ;;
        windsurf) _claws_darwin_apps=('/Applications/Windsurf.app' '/Applications/Visual Studio Code.app' '/Applications/Visual Studio Code - Insiders.app' '/Applications/Cursor.app') ;;
        *)        _claws_darwin_apps=('/Applications/Visual Studio Code.app' '/Applications/Visual Studio Code - Insiders.app' '/Applications/Cursor.app' '/Applications/Windsurf.app') ;;
      esac
      for _claws_app in "${_claws_darwin_apps[@]}"; do
        _claws_plist="$_claws_app/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist"
        if [ -f "$_claws_plist" ]; then
          _claws_curr_elec=$(plutil -extract CFBundleVersion raw "$_claws_plist" 2>/dev/null || true)
          [ -n "$_claws_curr_elec" ] && break
        fi
      done
      unset _tp _claws_darwin_apps
    elif [ "$PLATFORM" = "Linux" ]; then
      # M-22: prefer TERM_PROGRAM editor on Linux too.
      # M-25: add Cursor + Windsurf Linux paths.
      _tp="${TERM_PROGRAM:-}"
      case "$_tp" in
        cursor)
          _claws_linux_eps="/usr/share/cursor/electron /opt/cursor/electron /snap/cursor/current/usr/share/cursor/electron /usr/share/code/electron /usr/lib/code/electron /opt/visual-studio-code/electron /snap/code/current/usr/share/code/electron /usr/share/windsurf/electron /opt/windsurf/electron"
          ;;
        windsurf)
          _claws_linux_eps="/usr/share/windsurf/electron /opt/windsurf/electron /usr/share/code/electron /usr/lib/code/electron /opt/visual-studio-code/electron /snap/code/current/usr/share/code/electron /usr/share/cursor/electron /opt/cursor/electron"
          ;;
        *)
          _claws_linux_eps="/usr/share/code/electron /usr/lib/code/electron /opt/visual-studio-code/electron /snap/code/current/usr/share/code/electron /usr/share/cursor/electron /opt/cursor/electron /snap/cursor/current/usr/share/cursor/electron /usr/share/windsurf/electron /opt/windsurf/electron"
          ;;
      esac
      for _claws_ep in $_claws_linux_eps; do
        if [ -x "$_claws_ep" ]; then
          _claws_curr_elec=$("$_claws_ep" --version 2>/dev/null | sed 's/^v//' | head -1)
          [ -n "$_claws_curr_elec" ] && break
        fi
      done
      unset _tp _claws_linux_eps
    fi
    # M-23: warn when detection returns empty — don't silently skip drift check.
    if [ -z "$_claws_curr_elec" ] && [ -n "$_claws_last_elec" ]; then
      warn "Could not detect the current VS Code/Cursor/Windsurf Electron version."
      warn "Set CLAWS_ELECTRON_VERSION=<version> to specify it explicitly."
      warn "(run: plutil -extract CFBundleVersion raw '/Applications/Cursor.app/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist')"
    fi
    if [ -n "$_claws_curr_elec" ] && [ -n "$_claws_last_elec" ] && [ "$_claws_curr_elec" != "$_claws_last_elec" ]; then
      info "Electron version changed since last build ($_claws_last_elec → $_claws_curr_elec) — forcing pty.node rebuild"
      info "without this rebuild, the extension would silently fall into pipe-mode"
      needs_rebuild_native=1
    fi
    unset _claws_last_elec _claws_curr_elec _claws_app _claws_plist _claws_ep
  fi

  if [ "$needs_rebuild_native" = "1" ]; then
    if [ ! -f "$NATIVE_PTY_BIN" ]; then
      info "building extension + native node-pty (binary missing)"
    elif [ "$CURRENT_SHA" != "$LAST_BUILD_SHA" ] && [ -n "$LAST_BUILD_SHA" ]; then
      info "rebuilding extension (git HEAD ${LAST_BUILD_SHA:0:7} → ${CURRENT_SHA:0:7})"
    else
      info "building extension bundle + rebuilding node-pty for current Electron"
    fi

    # Network pre-check: @electron/rebuild fetches Electron headers from GitHub.
    # Fail fast on air-gapped machines before a 3-minute build that will hang.
    info "checking network connectivity for Electron headers fetch..."
    if curl --silent --head --max-time 5 "https://github.com" >/dev/null 2>&1 \
       || wget --spider --quiet --timeout=5 "https://github.com" >/dev/null 2>&1; then
      info "network reachable — Electron headers fetch should succeed"
    else
      warn "network unreachable (GitHub) — @electron/rebuild may fail fetching Electron headers"
      warn "If you are on an air-gapped machine, set CLAWS_ELECTRON_VERSION=<version> and ensure"
      warn "headers are available at a local mirror, or use CLAWS_FORCE_REBUILD_NPTY=0 to skip."
    fi

    # Run with visible output — the user needs to see @electron/rebuild
    # progress and any compile errors. --silent here hides the exact
    # diagnostic that tells them what to fix.
    if ( cd "$INSTALL_DIR/extension" \
         && npm install --no-audit --no-fund --loglevel=error \
         && { node -e "require.resolve('@electron/rebuild')" >/dev/null 2>&1 \
              || warn "@electron/rebuild not found after npm install — pty.node build will likely fail"; true; } \
         && npm run build ); then
      echo "$CURRENT_SHA" > "$BUILD_SHA_FILE" 2>/dev/null || true
      BUILD_OK=1
    else
      bad "extension build failed — see $CLAWS_LOG for the full compile log."
      # Scan the log to give a targeted hint
      if grep -qi "xcode\|xcrun\|CLT\|command line tools" "$CLAWS_LOG" 2>/dev/null; then
        bad "Likely cause: Xcode Command Line Tools missing or incomplete — run: xcode-select --install"
      elif grep -qi "electron.*header\|ENOTFOUND\|ETIMEDOUT\|network\|fetch" "$CLAWS_LOG" 2>/dev/null; then
        bad "Likely cause: network error fetching Electron headers — check internet connectivity and proxy settings"
      elif grep -qi "python\|gyp" "$CLAWS_LOG" 2>/dev/null; then
        bad "Likely cause: Python 3 or node-gyp issue — run: brew install python3  OR  sudo apt install python3"
      else
        bad "Common causes: Xcode CLT missing, Python 3 missing, or network error during @electron/rebuild's Electron headers fetch"
      fi
      bad "After fixing, re-run: bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)"
      exit 1
    fi
  else
    BUILD_OK=1
    ok "extension bundle up to date (SHA ${CURRENT_SHA:0:7}, $(wc -c < "$BUNDLE" | tr -d ' ') bytes)"
  fi

  # Hard verification — the VSIX in step 2c packages from extension/, and
  # without this binary present, wrapped terminals fall back to pipe-mode.
  # Refusing to continue is the correct behavior; a silent pipe-mode
  # install is worse than an explicit failure the user can fix.
  if [ ! -f "$NATIVE_PTY_BIN" ]; then
    bad "native/node-pty/build/Release/pty.node missing after build."
    bad "This means @electron/rebuild failed silently or bundle-native.mjs didn't copy the output."
    bad "Diagnostic: ( cd $INSTALL_DIR/extension && npm run bundle-native )"
    bad "See $CLAWS_LOG for the bundle-native output."
    exit 1
  fi
  NATIVE_PTY_SIZE=$(wc -c < "$NATIVE_PTY_BIN" | tr -d ' ')
  NATIVE_PTY_ELECTRON=$(node -e "try{console.log(require('$INSTALL_DIR/extension/native/.metadata.json').electronVersion||'?')}catch(e){console.log('?')}" 2>/dev/null || echo '?')
  ok "native node-pty ready (${NATIVE_PTY_SIZE} bytes, Electron $NATIVE_PTY_ELECTRON) — VSIX will ship this binary"
  if command -v file &>/dev/null; then
    # M-34: when bash runs under Rosetta 2 (x64 shell on Apple Silicon), uname -m returns
    # x86_64 but bundle-native.mjs (M-05) builds for arm64. Detect Rosetta via sysctl so
    # the expected arch is arm64, not x86_64 — prevents a spurious arch mismatch warning.
    # Linux x86_64 false-positive: `uname -m` returns `x86_64` (underscore),
    # but `file(1)` describes ELF binaries as `x86-64` (hyphen). Match both
    # spellings so legitimate x86_64 bundles don't trigger the warning.
    # Audit 1 finding H-1.
    _claws_expected_arch="$(uname -m)"
    if [ "$_claws_expected_arch" = "x86_64" ] && [ "$(uname -s)" = "Darwin" ]; then
      _claws_rosetta=$(sysctl -n sysctl.proc_translated 2>/dev/null || echo "0")
      [ "$_claws_rosetta" = "1" ] && _claws_expected_arch="arm64"
    fi
    _claws_arch_alt="$(echo "$_claws_expected_arch" | sed 's/_/-/g')"
    file "$NATIVE_PTY_BIN" 2>/dev/null | grep -qiE "$_claws_expected_arch|$_claws_arch_alt" \
      || warn "pty.node architecture may not match current machine ($(uname -m) → expected $_claws_expected_arch) — check bundle-native.mjs output in $CLAWS_LOG"
    unset _claws_arch_alt _claws_rosetta _claws_expected_arch
  fi

  # R3.7: Check if other installed editors use a different Electron version.
  # The VSIX ships ONE binary built for one Electron ABI. If Cursor/Windsurf
  # ship a different Electron than VS Code, the binary may load in pipe-mode
  # for those editors. Warn so the user knows and can rebuild with CLAWS_ELECTRON_VERSION.
  if [ -n "$NATIVE_PTY_ELECTRON" ] && [ "$NATIVE_PTY_ELECTRON" != "?" ]; then
    _check_editor_electron() {
      local app_label="$1"
      local pkg_json="$2"
      if [ -f "$pkg_json" ]; then
        local editor_ver
        editor_ver=$(node -e "try{console.log(require('$pkg_json').electronVersion||'')}catch{}" 2>/dev/null || true)
        if [ -n "$editor_ver" ] && [ "$editor_ver" != "$NATIVE_PTY_ELECTRON" ]; then
          warn "$app_label uses Electron $editor_ver but pty.node was built for Electron $NATIVE_PTY_ELECTRON"
          warn "  node-pty will load in pipe-mode in $app_label — rebuild with: CLAWS_ELECTRON_VERSION=$editor_ver bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)"
        fi
      fi
    }
    case "$PLATFORM" in
      Darwin)
        _check_editor_electron "Cursor"   "/Applications/Cursor.app/Contents/Resources/app/package.json"
        _check_editor_electron "Windsurf" "/Applications/Windsurf.app/Contents/Resources/app/package.json"
        _check_editor_electron "VS Code Insiders" "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/package.json"
        ;;
    esac
    unset -f _check_editor_electron
  fi
else
  bad "npm or extension/package.json missing — cannot build extension."
  bad "Install Node.js 18+ and re-run: bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)"
  exit 1
fi

# 2b. Read extension version from manifest so the symlink matches.
# EXPECTED_MIN_VERSION is hardcoded at script-release time. EXT_VERSION is
# read from the clone at runtime. If the clone is behind EXPECTED_MIN_VERSION,
# the working tree is stale and the installer aborts — that was the v0.5.1 bug
# where users saw "v0.4.0 — installed" because their ~/.claws-src/ was stale.
EXPECTED_MIN_VERSION="0.7.7"
EXT_VERSION=$(node -e "try{console.log(require('$INSTALL_DIR/extension/package.json').version)}catch(e){console.log('0.0.0')}" 2>/dev/null || echo "0.0.0")

# Flag stale clones loudly so users don't silently run on an old version.
if [ "$EXT_VERSION" != "$EXPECTED_MIN_VERSION" ]; then
  if ! node -e "
    const [a,b]=[process.argv[1],process.argv[2]].map(s=>s.split('.').map(Number));
    for (let i=0;i<3;i++){ if((a[i]||0)<(b[i]||0)) process.exit(1); if((a[i]||0)>(b[i]||0)) process.exit(0); }
    process.exit(0);
  " "$EXT_VERSION" "$EXPECTED_MIN_VERSION" 2>/dev/null; then
    bad "extension version $EXT_VERSION < expected $EXPECTED_MIN_VERSION — clone is stale."
    bad "Fix: rm -rf $INSTALL_DIR && re-run this installer."
    exit 1
  fi
fi

# 2c. Install the extension into every detected editor.
#
# Strategy (v0.5.3+):
#   1. VSIX install via `code --install-extension` — the proper way.
#      VS Code registers the extension in its extensions.json, extracts
#      to the extensions dir, and (if a window is open) shows a
#      "Reload to activate?" toast automatically. For a closed VS Code,
#      next window-open loads it with zero clicks.
#   2. Symlink fallback — used when vsce packaging or the editor CLI
#      isn't available (network error, no `code` binary). Also what
#      CLAWS_DEV_SYMLINK=1 forces.
#
# Why VSIX works now when it didn't before: Phase 2 moved node-pty out
# of node_modules/ into native/node-pty/. .vscodeignore excludes
# node_modules/** but un-ignores !native/**, so the packaged VSIX
# contains the ABI-correct binary at the exact path the runtime loader
# expects (<ext>/native/node-pty/).

INSTALLED_EDITORS=()
VSIX_INSTALL_METHOD=""  # "vsix" or "symlink" — reported in the banner

# Zed uses a proprietary extension format (.zedbundle) — not VSIX-compatible.
# Claws extension is VS Code-only. If Zed is detected, inform the user.
if command -v zed &>/dev/null; then
  info "Zed editor detected — Claws extension is VS Code/Cursor/Windsurf-only (VSIX format). Zed is not supported."
fi

# Editor CLI discovery. Checks $PATH first, then macOS app bundle paths.
_find_editor_cli() {
  local label="$1"
  # In $PATH?
  if command -v "$label" &>/dev/null; then
    command -v "$label"
    return 0
  fi
  # Bundled in an app (macOS). Windows/Linux paths fall through.
  case "$PLATFORM" in
    Darwin)
      case "$label" in
        code)          [ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ] && echo "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" && return 0 ;;
        code-insiders) [ -x "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders" ] && echo "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders" && return 0 ;;
        cursor)        [ -x "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" ] && echo "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" && return 0 ;;
        windsurf)      [ -x "/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf" ] && echo "/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf" && return 0 ;;
      esac
      ;;
  esac
  return 1
}

# Fallback: symlink the source clone into the editor's extensions dir.
_link_extension_into() {
  local label="$1"
  local ext_dir="$2"
  [ ! -d "$ext_dir" ] && return 1
  local link="$ext_dir/neunaha.claws-$EXT_VERSION"
  rm -rf "$ext_dir"/neunaha.claws-* 2>/dev/null \
    || sudo rm -rf "$ext_dir"/neunaha.claws-* 2>/dev/null \
    || true
  if ln -sf "$INSTALL_DIR/extension" "$link" 2>/dev/null \
     || sudo ln -sf "$INSTALL_DIR/extension" "$link" 2>/dev/null; then
    ok "linked Claws into $label ($link)"
    INSTALLED_EDITORS+=("$label")
    return 0
  fi
  bad "could not link Claws into $label"
  return 1
}

# VSIX install path: package once, install into every editor CLI we find.
_install_via_vsix() {
  local VSIX_PATH="/tmp/claws-$EXT_VERSION.vsix"
  info "packaging VSIX for VS Code install"

  # Sanity-check publisher field — vsce fails silently if it's missing.
  local pub
  pub=$(node -e "try{console.log(require('$INSTALL_DIR/extension/package.json').publisher||'')}catch(e){console.log('')}" 2>/dev/null || echo "")
  if [ -z "$pub" ]; then
    warn "extension/package.json missing 'publisher' field — vsce will fail"
    return 1
  fi

  # Package. vsce reads package.json + .vscodeignore to produce the VSIX.
  if ! ( cd "$INSTALL_DIR/extension" \
       && rm -f "$VSIX_PATH" 2>/dev/null \
       && npx --yes @vscode/vsce package --skip-license --no-git-tag-version --no-update-package-json --out "$VSIX_PATH" ) >>"$CLAWS_LOG" 2>&1; then
    warn "vsce package failed — see $CLAWS_LOG for details"
    info "diagnostic: cd $INSTALL_DIR/extension && npx @vscode/vsce package --out $VSIX_PATH"
    return 1
  fi

  if [ ! -f "$VSIX_PATH" ]; then
    warn "vsce reported success but VSIX missing — falling back to symlink"
    return 1
  fi

  local vsix_size; vsix_size=$(wc -c < "$VSIX_PATH" | tr -d ' ')
  if [ "$vsix_size" -lt 50000 ] 2>/dev/null; then
    warn "VSIX suspiciously small (${vsix_size} bytes < 50KB) — native binary may be missing from package"
    warn "Check .vscodeignore includes !native/** and re-run installer"
    return 1
  fi
  ok "packaged $VSIX_PATH ($(numfmt --to=iec-i --suffix=B "$vsix_size" 2>/dev/null || echo "${vsix_size} bytes"))"

  # Install into every detected editor CLI.
  local any_installed=0
  for label in code code-insiders cursor windsurf; do
    local cli
    cli="$(_find_editor_cli "$label")" || continue
    info "installing into $label via $cli"

    # Try normal install, then sudo on permission failure (R4.7/B7).
    local install_ok=0
    if "$cli" --install-extension "$VSIX_PATH" --force >/dev/null 2>&1; then
      install_ok=1
    elif sudo "$cli" --install-extension "$VSIX_PATH" --force >/dev/null 2>&1; then
      info "  installed via sudo (extensions dir required elevated permissions)"
      install_ok=1
    fi

    if [ "$install_ok" = "1" ]; then
      # R4.10: Verify the extension actually landed in the extensions directory
      # rather than trusting the exit code alone (VS Code exit codes are undocumented).
      local ext_dir="$HOME/.vscode/extensions"
      case "$label" in
        code-insiders) ext_dir="$HOME/.vscode-insiders/extensions" ;;
        cursor)        ext_dir="$HOME/.cursor/extensions" ;;
        windsurf)      ext_dir="$HOME/.windsurf/extensions" ;;
      esac
      if ls "$ext_dir"/neunaha.claws-* 2>/dev/null | grep -q .; then
        ok "Claws extension installed in $label (verified in $ext_dir)"
        # Clean stale older-version directories. VS Code itself usually does
        # this on VSIX install, but if a prior install hit a lock or used a
        # different CLI, old <publisher>.<name>-X.Y.Z dirs can linger and
        # confuse VS Code's extension picker. Keep only the just-installed
        # version (matches EXT_VERSION).
        # M-06: gate cleanup on kept_dir existing first. VS Code extracts VSIX
        # asynchronously — if kept_dir hasn't appeared yet, the safety guard
        # ([ "$stale" = "$kept_dir" ]) never matches and the loop would delete
        # every installed version. Skip and warn instead of destroying all installs.
        local kept_dir="$ext_dir/neunaha.claws-$EXT_VERSION"
        # FINDING-B-4: VS Code extracts VSIX asynchronously — poll up to 1s
        # (5×200ms) for kept_dir to appear before deciding it's absent.
        for _poll in 1 2 3 4 5; do
          [ -d "$kept_dir" ] && break
          sleep 0.2
        done
        unset _poll
        if [ -d "$kept_dir" ]; then
          for stale in "$ext_dir"/neunaha.claws-*; do
            [ -d "$stale" ] || continue
            [ "$stale" = "$kept_dir" ] && continue
            if rm -rf "$stale" 2>/dev/null || sudo rm -rf "$stale" 2>/dev/null; then
              info "  removed stale install $(basename "$stale")"
            fi
          done
        else
          warn "  kept_dir not yet present ($kept_dir) — skipping stale cleanup to avoid removing all versions"
          warn "  (VS Code may still be extracting the VSIX — stale dirs will be cleaned on next install)"
        fi
      else
        ok "Claws extension installed in $label (via VSIX — extensions dir not found for verification)"
      fi
      INSTALLED_EDITORS+=("$label")
      any_installed=1
    else
      # Non-zero exit and sudo also failed — likely a running window holds an
      # exclusive lock on the .node binary. The VSIX is staged in /tmp; VS Code
      # will pick it up on next Reload Window.
      warn "$label --install-extension refused (likely a running window holds the current version)"
      info "  this is fine — the new VSIX is staged; Reload Window activates it"
      # R4.10: Still verify — the extensions dir may already have the new version
      local ext_dir2="$HOME/.vscode/extensions"
      case "$label" in
        code-insiders) ext_dir2="$HOME/.vscode-insiders/extensions" ;;
        cursor)        ext_dir2="$HOME/.cursor/extensions" ;;
        windsurf)      ext_dir2="$HOME/.windsurf/extensions" ;;
      esac
      if ls "$ext_dir2"/neunaha.claws-* 2>/dev/null | grep -q .; then
        INSTALLED_EDITORS+=("$label (pending reload)")
        any_installed=1
      else
        warn "$label extensions dir has no neunaha.claws-* entry — install may have failed"
      fi
    fi
  done

  [ "$any_installed" = "1" ] && return 0
  return 1
}

# Choose install path.
if [ "${CLAWS_DEV_SYMLINK:-0}" = "1" ]; then
  info "CLAWS_DEV_SYMLINK=1 — using symlink install (live-edit dev workflow)"
  VSIX_INSTALL_METHOD="symlink"
elif [ "${BUILD_OK:-0}" = "1" ] && command -v npx &>/dev/null; then
  if _install_via_vsix; then
    VSIX_INSTALL_METHOD="vsix"
  else
    warn "VSIX install failed — falling back to symlink"
    VSIX_INSTALL_METHOD="symlink"
  fi
else
  info "no npx or build failed — using symlink install"
  VSIX_INSTALL_METHOD="symlink"
fi

# Symlink fallback — only runs if VSIX path didn't cover us.
if [ "$VSIX_INSTALL_METHOD" = "symlink" ] || [ "${#INSTALLED_EDITORS[@]}" -eq 0 ]; then
  for pair in \
    "vscode:$HOME/.vscode/extensions" \
    "vscode-insiders:$HOME/.vscode-insiders/extensions" \
    "cursor:$HOME/.cursor/extensions" \
    "windsurf:$HOME/.windsurf/extensions"; do
    label="${pair%%:*}"
    dir="${pair#*:}"
    [ -d "$dir" ] && _link_extension_into "$label" "$dir" || true
  done

  # If no editor dir existed at all, create the default one and link there.
  if [ "${#INSTALLED_EDITORS[@]}" -eq 0 ] && [ "$CLAWS_EDITOR" != "skip" ]; then
    mkdir -p "$HOME/.vscode/extensions" 2>/dev/null
    _link_extension_into "vscode (new)" "$HOME/.vscode/extensions" || true
  fi
fi

if [ "${#INSTALLED_EDITORS[@]}" -eq 0 ]; then
  warn "extension not installed in any editor — check CLAWS_EDITOR env var"
fi

# ─── Step 3: Script permissions ────────────────────────────────────────────
step "Setting file permissions"
chmod +x "$INSTALL_DIR"/scripts/*.sh 2>/dev/null || true
chmod +x "$INSTALL_DIR/mcp_server.js" 2>/dev/null || true
ok "scripts executable"

# ─── Step 4: Runtime check ─────────────────────────────────────────────────
step "Runtime check"
# Verify Node.js is still reachable (a PATH change mid-install would break MCP)
if command -v node &>/dev/null; then
  ok "Node.js reachable at $(node -e 'process.stdout.write(process.execPath)' 2>/dev/null) ($(node --version))"
else
  bad "node not reachable in current PATH — MCP server and extension build will fail"
  die "Install Node.js 18+ and re-run: bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)"
fi
# Verify mcp_server.js is present in the clone before we try to copy it in step 5
if [ ! -f "$INSTALL_DIR/mcp_server.js" ]; then
  bad "$INSTALL_DIR/mcp_server.js missing — clone may be incomplete"
  die "Fix: rm -rf $INSTALL_DIR && re-run this installer"
fi
ok "runtime ready"

# ─── Step 5: MCP server (project-local primary, global opt-in) ─────────────
step "Configuring MCP server"

MCP_PATH="$INSTALL_DIR/mcp_server.js"
if [ "${CLAWS_SKIP_MCP:-0}" = "1" ]; then
  warn "CLAWS_SKIP_MCP=1 — skipping MCP registration"
else
  if [ "$PROJECT_INSTALL" = "1" ]; then
    # FINDING-B-2: guard against dangling / loop / unexpected symlinks at .claws-bin
    # before mkdir -p, which would silently create files at the symlink target.
    if [ -L "$PROJECT_ROOT/.claws-bin" ]; then
      [ -e "$PROJECT_ROOT/.claws-bin" ] \
        && warn ".claws-bin is a symlink → $(readlink "$PROJECT_ROOT/.claws-bin") — removing and replacing with directory" \
        || warn ".claws-bin is a dangling symlink — removing"
      rm -f "$PROJECT_ROOT/.claws-bin"
    fi
    mkdir -p "$PROJECT_ROOT/.claws-bin"
    cp "$INSTALL_DIR/mcp_server.js" "$PROJECT_ROOT/.claws-bin/mcp_server.js"
    chmod +x "$PROJECT_ROOT/.claws-bin/mcp_server.js"
    # Copy generated schema artifacts: mcp-tools.json (consumed by mcp_server.js
    # at startup) + json/ (20 per-topic JSON Schemas) + types/ (TS .d.ts).
    # External schema consumers (worker SDKs, validators, IDE hints) need the
    # json/ and types/ files even though mcp_server.js itself only needs
    # mcp-tools.json.
    if [ -d "$INSTALL_DIR/schemas" ]; then
      mkdir -p "$PROJECT_ROOT/.claws-bin/schemas/json" "$PROJECT_ROOT/.claws-bin/schemas/types"
      cp "$INSTALL_DIR/schemas/mcp-tools.json" "$PROJECT_ROOT/.claws-bin/schemas/" 2>/dev/null || true
      # P3-1: deploy client-types.d.ts for typed SDK consumers
      cp "$INSTALL_DIR/schemas/client-types.d.ts" "$PROJECT_ROOT/.claws-bin/schemas/" 2>/dev/null || true
      cp "$INSTALL_DIR"/schemas/json/*.json "$PROJECT_ROOT/.claws-bin/schemas/json/" 2>/dev/null || true
      cp "$INSTALL_DIR"/schemas/types/*.d.ts "$PROJECT_ROOT/.claws-bin/schemas/types/" 2>/dev/null || true
    fi
    # Copy Claws SDK (v0.7.0+) for typed publish helpers in worker scripts
    if [ -f "$INSTALL_DIR/claws-sdk.js" ]; then
      cp "$INSTALL_DIR/claws-sdk.js" "$PROJECT_ROOT/.claws-bin/claws-sdk.js"
      chmod +x "$PROJECT_ROOT/.claws-bin/claws-sdk.js" 2>/dev/null || true
    else
      warn "claws-sdk.js not found in $INSTALL_DIR — SDK helpers unavailable (P3-3)"
    fi
    cp "$INSTALL_DIR/scripts/shell-hook.sh" "$PROJECT_ROOT/.claws-bin/shell-hook.sh"
    # Copy event-streaming sidecar (v0.6.2+) so Bash run_in_background + Monitor can stream pub/sub frames
    if [ -f "$INSTALL_DIR/scripts/stream-events.js" ]; then
      cp "$INSTALL_DIR/scripts/stream-events.js" "$PROJECT_ROOT/.claws-bin/stream-events.js"
      chmod +x "$PROJECT_ROOT/.claws-bin/stream-events.js" 2>/dev/null || true
    fi
    # Copy lifecycle hook scripts for inject-settings-hooks.js to reference.
    # Source-of-truth is $INSTALL_DIR/scripts/hooks/ (committed to git).
    # Previously this read from $INSTALL_DIR/.claws-bin/hooks/, which is
    # gitignored and therefore missing on every fresh clone — silent skip.
    #
    # Wipe-then-copy: removed-in-newer-release files (e.g. post-tool-use-claws.js
    # deprecated in v0.6.5) used to survive in users' .claws-bin/hooks/ and the
    # Claude Code hook runner would still try to invoke them. Audit 4 finding I.
    #
    # We also ship a package.json shim with {"type":"commonjs"} alongside the
    # hooks. Without it, projects whose root package.json declares
    # "type":"module" (modern Node/TS projects) load the hook scripts as ESM,
    # and the CommonJS require() call at the top of each hook crashes.
    # Reported by user (Miles) on v0.7.0.
    if [ -d "$INSTALL_DIR/scripts/hooks" ]; then
      # M-09: atomic rename pattern — copy to tmp dir first, then swap into place.
      # Prevents kill-window leaving an empty hooks dir that breaks every Bash hook.
      # F1: set +e around heredoc so $? is readable (under set -eo pipefail the script
      # would abort at the heredoc before reaching any if [ $? ] check).
      set +e
      node --no-deprecation --input-type=module <<HOOKSATOMICEOF
import { copyDirAtomic } from '${INSTALL_DIR}/scripts/_helpers/atomic-file.mjs';
try {
  await copyDirAtomic('${INSTALL_DIR}/scripts/hooks', '${PROJECT_ROOT}/.claws-bin/hooks');
} catch (e) {
  process.stderr.write('[M-09] atomic hooks copy failed: ' + e.message + '\\n');
  process.exit(1);
}
HOOKSATOMICEOF
      _hooks_exit=$?
      set -e
      if [ "$_hooks_exit" -ne 0 ]; then
        warn "hooks dir copy failed — .claws-bin/hooks may be incomplete"
      fi
      # package.json shim: write if not present after copy (older hooks dirs omit it).
      if [ ! -f "$PROJECT_ROOT/.claws-bin/hooks/package.json" ]; then
        printf '{"type":"commonjs","private":true}\n' > "$PROJECT_ROOT/.claws-bin/hooks/package.json"
      fi
    fi
    ok "vendored $PROJECT_ROOT/.claws-bin/"

    # ── Copy the built VS Code extension into the project for visibility ────
    # VS Code still loads the extension from the user-level install
    # (~/.vscode/extensions/neunaha.claws-<version>). This project-local
    # copy is purely for visibility + portability — teammates who clone the
    # project can SEE what's installed, and users running `ls .claws-bin/`
    # can confirm Claws is present.
    #
    # Opt out with CLAWS_SKIP_EXTENSION_COPY=1.
    if [ "${CLAWS_SKIP_EXTENSION_COPY:-0}" != "1" ]; then
      PROJECT_EXT_DIR="$PROJECT_ROOT/.claws-bin/extension"
      rm -rf "$PROJECT_EXT_DIR" 2>/dev/null || true
      mkdir -p "$PROJECT_EXT_DIR"

      # Copy the runtime-required pieces only — skip src/, test/, scripts/,
      # tsconfig, esbuild, node_modules (we have native/ as the bundle).
      for entry in dist native package.json package-lock.json README.md CHANGELOG.md icon.png .vscodeignore; do
        if [ -e "$INSTALL_DIR/extension/$entry" ]; then
          cp -R "$INSTALL_DIR/extension/$entry" "$PROJECT_EXT_DIR/" 2>/dev/null || true
        fi
      done

      EXT_COPY_BYTES=$(du -sk "$PROJECT_EXT_DIR" 2>/dev/null | awk '{print $1*1024}')
      ok "copied extension → $PROJECT_EXT_DIR ($(numfmt --to=iec-i --suffix=B "$EXT_COPY_BYTES" 2>/dev/null || echo "${EXT_COPY_BYTES} bytes"))"
    fi

    # ── Write a visible README.md in .claws-bin/ so teammates see what's there ──
    cat > "$PROJECT_ROOT/.claws-bin/README.md" <<CLAWSBIN
# .claws-bin/

Project-local Claws runtime and artifacts. Auto-generated by the Claws
installer — don't edit by hand; it's refreshed on every \`/claws-update\`.

## Contents

| File / dir | Role |
|---|---|
| \`mcp_server.js\` | Node MCP server. Spawned by Claude Code when it reads \`../.mcp.json\`. Bridges MCP protocol ⇄ Claws socket. |
| \`shell-hook.sh\` | Shell initialization hook — copied from \`scripts/shell-hook.sh\` for reference. Actual hook lives in your \`~/.zshrc\`/\`~/.bashrc\` (appended by the installer). |
| \`extension/\` | Full built copy of the VS Code extension (dist + native node-pty binary + manifest). **For visibility only** — VS Code itself loads the extension from the user-level install at \`~/.vscode/extensions/neunaha.claws-<version>\`, not from here. |
| \`README.md\` | This file. |

## How the extension actually loads

The VS Code extension is installed at **user scope**, not per-project —
that's how every VS Code extension works (Python, ESLint, Prettier, etc.).
The symlinked location is:

\`\`\`
~/.vscode/extensions/neunaha.claws-<version>  →  ~/.claws-src/extension
\`\`\`

The \`extension/\` directory inside \`.claws-bin/\` is a **reference copy** that
lets teammates see "Claws is installed" in the project. It's also useful if
you want to version-pin the extension files alongside your project's git
history.

## Recommended .gitignore

The \`extension/\` copy is ~300–400 KB. Common choices:

- **Commit it** if you want teammates who clone the repo to see the exact
  Claws version that's active, without running the installer.
- **Ignore it** (\`.claws-bin/extension/\`) if you treat it as an install
  artifact that regenerates on demand.

\`.mcp.json\` is machine-specific (contains absolute paths) and is gitignored.
Do not commit it. Re-run the installer to regenerate it if node or the
project moves.

## Installing Claws from this project

If a teammate clones this project without Claws installed, they just run:

\`\`\`bash
bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)
\`\`\`

That installs the extension at user scope, registers the MCP server, and
refreshes these project-local files.

## Updating

\`\`\`bash
bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/update.sh)
\`\`\`

Or from inside a Claude Code session: \`/claws-update\`.

---

Claws docs: https://github.com/neunaha/claws
CLAWSBIN
    ok "wrote $PROJECT_ROOT/.claws-bin/README.md"

    # Write or merge .mcp.json with absolute args path so Claude Code can start
    # the server regardless of its cwd. __dirname walk-up in mcp_server.js
    # handles socket discovery once the server is running — no CLAWS_SOCKET needed.
    #
    # M-02: use json-safe.mjs mergeIntoFile — JSONC-tolerant, never resets cfg to {}
    # on parse error (which would silently wipe the user's other MCP servers).
    # F5: PROJECT_MCP and PROJECT_ROOT passed as env vars (not string-literal-embedded in JS)
    #     to avoid JS SyntaxError when paths contain single-quotes or backslashes.
    PROJECT_MCP="$PROJECT_ROOT/.mcp.json"
    # F1: set +e around heredoc so _mcp_exit is readable before set -e is restored.
    set +e
    PROJECT_MCP="$PROJECT_MCP" PROJECT_ROOT="$PROJECT_ROOT" INSTALL_DIR="$INSTALL_DIR" \
    node --no-deprecation --input-type=module <<MCPMERGEEOF
const { mergeIntoFile } = await import(process.env.INSTALL_DIR + '/scripts/_helpers/json-safe.mjs');
const mcpPath = process.env.PROJECT_MCP;
const projectRoot = process.env.PROJECT_ROOT;
const result = await mergeIntoFile(mcpPath, cfg => {
  if (!cfg.mcpServers) cfg.mcpServers = {};
  cfg.mcpServers.claws = { command: 'node', args: [projectRoot + '/.claws-bin/mcp_server.js'] };
});
if (!result.ok) {
  const e = result.error;
  process.stderr.write('[M-02] .mcp.json merge failed: ' + e.message + '\\n');
  if (e.backupSavedAt) {
    process.stderr.write('[M-02] Malformed original backed up to: ' + e.backupSavedAt + '\\n');
    process.stderr.write('[M-02] Fix the JSON then re-run /claws-update\\n');
  }
  process.exit(1);
}
MCPMERGEEOF
    _mcp_exit=$?
    set -e
    if [ "$_mcp_exit" -ne 0 ]; then
      die ".mcp.json merge failed — original preserved. Fix $PROJECT_MCP then re-run /claws-update"
    fi
    ok "wrote $PROJECT_MCP"
    if ! node -e "JSON.parse(require('fs').readFileSync('$PROJECT_ROOT/.mcp.json','utf8'))" 2>/dev/null; then
      bad ".mcp.json written to $PROJECT_ROOT but is not valid JSON — MCP server will fail to load"
      bad "Check $CLAWS_LOG for jq/cat errors above"
    fi
    touch "$PROJECT_ROOT/.gitignore" 2>/dev/null || true
    if ! grep -q "^\.claws/" "$PROJECT_ROOT/.gitignore" 2>/dev/null; then
      echo ".claws/" >> "$PROJECT_ROOT/.gitignore"
      ok "added .claws/ to $PROJECT_ROOT/.gitignore"
    fi

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
const mcpServerPath = process.argv[1];
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
if (!cfg.mcpServers) cfg.mcpServers = {};
cfg.mcpServers.claws = { command: 'node', args: [mcpServerPath] };
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
" "$INSTALL_DIR/mcp_server.js"
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

  # P3-2: glob all claws-* and dev-protocol-* skills so new skills are picked up
  # without editing this script. prompt-templates is renamed to claws-prompt-templates.
  for _skill_src in "$INSTALL_DIR/.claude/skills"/claws-* "$INSTALL_DIR/.claude/skills"/dev-protocol-*; do
    [ -d "$_skill_src" ] || continue
    _skill_name="$(basename "$_skill_src")"
    rm -rf "$TARGET/.claude/skills/$_skill_name" 2>/dev/null || true
    cp -r "$_skill_src" "$TARGET/.claude/skills/$_skill_name"
  done
  if [ -d "$INSTALL_DIR/.claude/skills/prompt-templates" ]; then
    rm -rf "$TARGET/.claude/skills/claws-prompt-templates" 2>/dev/null || true
    cp -r "$INSTALL_DIR/.claude/skills/prompt-templates" "$TARGET/.claude/skills/claws-prompt-templates"
  fi
  unset _skill_src _skill_name

  # CLAUDE.md injection (project scope only — never inside $HOME)
  # M-21: GIT_PULL_OK=0 means git pull failed in update.sh — skip re-injection to
  # avoid overwriting the user's CLAUDE.md tool set with stale source.
  if [ "$TARGET" != "$HOME" ]; then
    if [ "${GIT_PULL_OK:-1}" = "0" ]; then
      note "CLAUDE.md injection skipped — git pull failed, stale source (M-21)"
    elif [ ! -f "$INSTALL_DIR/scripts/inject-claude-md.js" ] && [ ! -f "$INSTALL_DIR/.claws-bin/inject-claude-md.js" ]; then
      warn "inject-claude-md.js not found — CLAUDE.md injection skipped. Clone may be incomplete."
    else
      node --no-deprecation "$INSTALL_DIR/scripts/inject-claude-md.js" "$TARGET" 2>&1 | sed 's/^/  /' || warn "CLAUDE.md injector failed — see $CLAWS_LOG for details"
    fi
    # Global ~/.claude/CLAUDE.md injection (machine-wide Claws policy)
    # F2/M-21: same GIT_PULL_OK gate as project CLAUDE.md — avoids rewriting
    # the machine-wide policy from stale source when git pull failed.
    if [ "${GIT_PULL_OK:-1}" = "0" ]; then
      note "global CLAUDE.md injection skipped — git pull failed, stale source (F2/M-21)"
    elif [ -f "$INSTALL_DIR/scripts/inject-global-claude-md.js" ]; then
      node --no-deprecation "$INSTALL_DIR/scripts/inject-global-claude-md.js" 2>&1 | sed 's/^/  /' || warn "global CLAUDE.md injector failed"
    fi
    # Hook registration in ~/.claude/settings.json (SessionStart / PreToolUse / Stop).
    # Bin path passed to the injector is $INSTALL_DIR/scripts — hooks register pointing
    # to the source clone's committed scripts/hooks/ directory (NOT gitignored, kept
    # current by git pull). Using the shared INSTALL_DIR path is correct because
    # ~/.claude/settings.json is a per-user global file, not per-project.
    # NOT $INSTALL_DIR/.claws-bin — that directory IS gitignored and missing on fresh clones.
    # CLAWS_NO_GLOBAL_HOOKS=1 skips this step entirely — useful for testing
    # an isolated install without touching the user's global Claude Code config.
    if [ -f "$INSTALL_DIR/scripts/inject-settings-hooks.js" ]; then
      if [ "${CLAWS_NO_GLOBAL_HOOKS:-0}" != "1" ]; then
        echo "Updating Claws hooks..."
        # M-18: use --update (atomic remove+add in one read-modify-write) instead of
        # two-pass --remove + add, which has a kill-window with zero Claws hooks.
        node --no-deprecation "$INSTALL_DIR/scripts/inject-settings-hooks.js" "$INSTALL_DIR/scripts" --update 2>&1 | sed 's/^/  /' || warn "settings hooks update failed"
      else
        echo "  CLAWS_NO_GLOBAL_HOOKS=1 — skipping ~/.claude/settings.json registration"
      fi
    fi
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

# ─── Step 6b: Dev-discipline hooks ──────────────────────────────────────────
# Copies scripts/dev-hooks/*.js into <project>/.claws-bin/dev-hooks/ and
# registers them in <project>/.claude/settings.json via inject-dev-hooks.js.
# Idempotent: safe to re-run on every update.
if [ "$PROJECT_INSTALL" = "1" ] && [ -d "$INSTALL_DIR/scripts/dev-hooks" ]; then
  step "Installing dev-discipline hooks"
  DEV_HOOKS_DST="$PROJECT_ROOT/.claws-bin/dev-hooks"
  mkdir -p "$DEV_HOOKS_DST"
  _dh_count=0
  for _dh in "$INSTALL_DIR/scripts/dev-hooks"/*.js; do
    [ -f "$_dh" ] || continue
    cp "$_dh" "$DEV_HOOKS_DST/" && _dh_count=$((_dh_count+1))
  done
  ok "copied $_dh_count dev-hook scripts → $DEV_HOOKS_DST"

  if [ -f "$INSTALL_DIR/scripts/inject-dev-hooks.js" ]; then
    node --no-deprecation "$INSTALL_DIR/scripts/inject-dev-hooks.js" "$PROJECT_ROOT" 2>&1 | sed 's/^/  /' \
      || warn "inject-dev-hooks.js failed — dev hooks not registered"
  else
    warn "inject-dev-hooks.js not found — dev hooks not registered"
  fi
  unset _dh _dh_count
fi

# ─── Step 7: Shell hook ────────────────────────────────────────────────────
step "Injecting shell hook"
HOOK_SOURCE="source \"$INSTALL_DIR/scripts/shell-hook.sh\""
HOOK_MARKER="# CLAWS terminal hook"

inject_hook() {
  local rcfile="$1"
  touch "$rcfile" 2>/dev/null || true

  # Detect prior state BEFORE rewriting so we can report accurately.
  local had_stale=0
  local had_marker=0
  if grep -q "CLAWS terminal hook" "$rcfile" 2>/dev/null; then
    had_marker=1
    if ! grep -Fq "$HOOK_SOURCE" "$rcfile" 2>/dev/null; then
      had_stale=1
    fi
  fi
  # Detect orphaned source lines (marker missing, source survived from a
  # prior install whose sed delete failed on BSD sed). Audit 4 finding G.
  if grep -Eq '^[[:space:]]*source[[:space:]].*/shell-hook\.sh' "$rcfile" 2>/dev/null \
     && ! grep -Fq "$HOOK_SOURCE" "$rcfile" 2>/dev/null; then
    had_stale=1
  fi

  # M-01: create a timestamped backup of the dotfile BEFORE any modification.
  # Allows the user to restore if something goes wrong. Only created when the
  # file already has content — no backup for a freshly touch'd empty file.
  local tmp="$rcfile.claws-tmp.$$"
  if [ -s "$rcfile" ]; then
    local _bak_ts
    _bak_ts=$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || date +%Y%m%dT%H%M%SZ)
    cp "$rcfile" "${rcfile}.claws-bak.${_bak_ts}" 2>/dev/null || true
  fi

  # Portable cleanup via awk (works on BSD awk and GNU awk identically).
  # Replaces the GNU-only `sed '/pat/,+1d'` form, which silently failed on
  # macOS ≤ Monterey and left orphaned `source ".../shell-hook.sh"` lines.
  #
  # M-01: strips ONLY lines inside a Claws-marked block:
  #   1. Strip every `# CLAWS terminal hook` marker line.
  #   2. Strip the immediately following line IF it is the Claws source line.
  # The previous generic `/source .../shell-hook\.sh/` regex is removed because
  # it matched non-Claws tools (oh-my-zsh, asdf, custom dotfiles) causing data loss.
  #
  # F4: orphaned-marker edge case — if a user manually deleted the source line but
  # left the marker, the old `skip { skip=0; next }` would silently strip whatever
  # user content happened to follow the marker. Fix: only skip the following line if
  # it matches the Claws source pattern; otherwise keep it (skip=0; print).
  #
  # M-17: always promote awk output when awk succeeds, even if output is empty.
  # When the file contains ONLY the Claws block, awk produces no output (empty tmp).
  # The old `[ -s "$tmp" -o ! -s "$rcfile" ]` guard prevented promotion in that case
  # (rcfile had content → `! -s` false; tmp empty → `-s` false → guard fails), so the
  # original was left intact and a new block was appended on the next install, creating
  # duplicate hooks. Fix: mv unconditionally when awk exits 0.
  if awk '
    /# CLAWS terminal hook/ { skip = 1; next }
    skip && /source.*shell-hook\.sh/ { skip = 0; next }
    skip { skip = 0; print }
    { print }
  ' "$rcfile" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$rcfile" 2>/dev/null || rm -f "$tmp"
  else
    rm -f "$tmp" 2>/dev/null || true
  fi

  if printf "\n%s\n%s\n" "$HOOK_MARKER" "$HOOK_SOURCE" >> "$rcfile" 2>/dev/null; then
    if [ "$had_stale" = "1" ]; then
      ok "refreshed in $(basename "$rcfile") (removed stale path)"
    elif [ "$had_marker" = "1" ]; then
      ok "refreshed in $(basename "$rcfile")"
    else
      ok "added to $(basename "$rcfile")"
    fi
  else
    warn "could not write to $rcfile"
  fi
}

[ -f "$INSTALL_DIR/scripts/shell-hook.sh" ] \
  || die "shell-hook.sh missing from $INSTALL_DIR/scripts/ — clone may be incomplete."
inject_hook "$HOME/.zshrc"
# Use `zsh -n` for .zshrc (zsh-only syntax like `setopt`/`autoload -Uz` parses
# fine in zsh but `bash -n` reports false-positive errors). Fall back to `bash -n`
# only if zsh is not installed. Audit 1 finding H-2.
if command -v zsh &>/dev/null; then
  zsh -n "$HOME/.zshrc" 2>/dev/null || warn "~/.zshrc has a syntax error after hook injection — check manually"
else
  bash -n "$HOME/.zshrc" 2>/dev/null || warn "~/.zshrc has a syntax error after hook injection — check manually"
fi
inject_hook "$HOME/.bashrc"
bash -n "$HOME/.bashrc" 2>/dev/null || warn "~/.bashrc has a syntax error after hook injection — check manually"
if [ "$PLATFORM" = "Darwin" ]; then
  inject_hook "$HOME/.bash_profile"
  bash -n "$HOME/.bash_profile" 2>/dev/null || warn "~/.bash_profile has a syntax error after hook injection — check manually"
fi

if [ -d "$HOME/.config/fish" ]; then
  FISH_CONF="$HOME/.config/fish/conf.d/claws.fish"
  mkdir -p "$HOME/.config/fish/conf.d" 2>/dev/null
  # Write a minimal conf.d loader that sets CLAWS_DIR and sources the
  # standalone shell-hook.fish (no bass dependency required).
  {
    echo "# CLAWS terminal hook (auto-generated — do not edit)"
    echo "set -gx CLAWS_DIR '$INSTALL_DIR'"
    echo "set -gx CLAWS_SOCKET '.claws/claws.sock'"
    echo "if test -f '$INSTALL_DIR/scripts/shell-hook.fish'"
    echo "    source '$INSTALL_DIR/scripts/shell-hook.fish'"
    echo "end"
  } > "$FISH_CONF" && ok "wrote fish conf (native fish, no bass required)" || warn "could not write fish config"
fi

# ── Nushell hook ─────────────────────────────────────────────────────────────
# Nushell sources env.nu on startup. We append a CLAWS_DIR assignment if absent.
_NU_ENV="$HOME/.config/nushell/env.nu"
_NU_CONFIG="$HOME/.config/nushell/config.nu"
if [ -f "$_NU_ENV" ] || [ -f "$_NU_CONFIG" ]; then
  _NU_TARGET="${_NU_ENV:-$_NU_CONFIG}"
  if ! grep -q "CLAWS_DIR" "$_NU_TARGET" 2>/dev/null; then
    {
      printf '\n# CLAWS terminal hook\n'
      printf '$env.CLAWS_DIR = "%s"\n' "$INSTALL_DIR"
      printf '$env.CLAWS_SOCKET = ".claws/claws.sock"\n'
    } >> "$_NU_TARGET" && ok "wrote nushell env ($( basename "$_NU_TARGET" ))" \
      || warn "could not write nushell config"
  else
    ok "nushell env already has CLAWS_DIR — skipped"
  fi
fi
unset _NU_ENV _NU_CONFIG _NU_TARGET

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
if command -v node &>/dev/null; then
  _ok "Node.js available ($(node --version)) — $(node -e 'process.stdout.write(process.execPath)' 2>/dev/null)"
  info "Note: GUI-launched VS Code may resolve a different Node.js PATH than this shell"
else
  _miss "node not found"
fi

if [ "$PROJECT_INSTALL" = "1" ]; then
  if [ -f "$PROJECT_ROOT/.mcp.json" ] && node -e "JSON.parse(require('fs').readFileSync('$PROJECT_ROOT/.mcp.json','utf8'))" 2>/dev/null; then
    _ok "Project .mcp.json (present and valid JSON)"
  elif [ -f "$PROJECT_ROOT/.mcp.json" ]; then
    _miss "Project .mcp.json exists but is invalid JSON — MCP server will fail to load"
  else
    _miss "project .mcp.json missing"
  fi
  [ -f "$PROJECT_ROOT/.claws-bin/mcp_server.js" ] && _ok "Project .claws-bin/mcp_server.js" || _miss "project mcp_server.js copy missing"
  if [ "${CLAWS_SKIP_EXTENSION_COPY:-0}" != "1" ]; then
    [ -f "$PROJECT_ROOT/.claws-bin/extension/dist/extension.js" ] \
      && _ok "Project .claws-bin/extension/ (visible copy)" \
      || warn "project .claws-bin/extension/ not copied"
  fi
  [ -f "$PROJECT_ROOT/.claws-bin/README.md" ] && _ok "Project .claws-bin/README.md" || warn "project .claws-bin/README.md missing"
  [ -d "$PROJECT_ROOT/.claws-bin/hooks" ] && _ok "Project .claws-bin/hooks/ (lifecycle hooks)" || _miss "project .claws-bin/hooks/ missing"
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
const msg = req + "\n";
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

# Verify shell hook is active in user's rc files
_hook_verified=0
for _rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
  if [ -f "$_rc" ] && grep -q "CLAWS terminal hook" "$_rc" 2>/dev/null; then
    _hook_verified=1
    break
  fi
done
if [ "$_hook_verified" = "0" ]; then
  warn "Shell hook not detected in any rc file — run: source $INSTALL_DIR/scripts/shell-hook.sh"
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
  printf '               (method: %s)\n' "$VSIX_INSTALL_METHOD"
  printf '               (loaded from %s)\n' "$HOME/.vscode/extensions/neunaha.claws-$EXT_VERSION"
  if [ "$PROJECT_INSTALL" = "1" ] && [ "${CLAWS_SKIP_EXTENSION_COPY:-0}" != "1" ]; then
    printf '               (visible copy in %s/.claws-bin/extension/)\n' "$PROJECT_ROOT"
  fi
else
  printf '  Extension:   ${C_YELLOW}NOT INSTALLED — run /claws-fix${C_RESET}\n'
fi
printf '  Install log: %s\n' "$CLAWS_LOG"
cat <<NEXT

  ${C_BOLD}── One step left to activate ──${C_RESET}
    ${C_BOLD}Reload VS Code:${C_RESET}   Cmd+Shift+P → "Developer: Reload Window"

  That's it. The extension activates on reload; the MCP tools come online
  the next time you start a Claude Code session in this project (new
  sessions auto-pick-up .mcp.json — no manual restart required if Claude
  Code isn't already running here).

  ${C_BOLD}── If something is off ──${C_RESET}
    MCP tools not appearing?   /claws-fix
    Want to report an issue?   /claws-report
    Update later:              /claws-update

  ${C_DIM}Optional: export CLAWS_STRICT=1 to hard-block long-running Bash via PreToolUse hook${C_RESET}

  Docs:    https://github.com/neunaha/claws
  Website: https://neunaha.github.io/claws/

NEXT

# Source shell hook last so its output doesn't push the banner off-screen.
# shellcheck disable=SC1090
info "Open a new terminal to activate the shell hook."
