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

  needs_rebuild_native=0
  [ ! -f "$NATIVE_PTY_BIN" ] && needs_rebuild_native=1
  [ "${CLAWS_FORCE_REBUILD_NPTY:-0}" = "1" ] && needs_rebuild_native=1
  if needs_build; then needs_rebuild_native=1; fi

  if [ "$needs_rebuild_native" = "1" ]; then
    if [ ! -f "$NATIVE_PTY_BIN" ]; then
      info "building extension + native node-pty (binary missing)"
    elif [ "$CURRENT_SHA" != "$LAST_BUILD_SHA" ] && [ -n "$LAST_BUILD_SHA" ]; then
      info "rebuilding extension (git HEAD ${LAST_BUILD_SHA:0:7} → ${CURRENT_SHA:0:7})"
    else
      info "building extension bundle + rebuilding node-pty for current Electron"
    fi

    # Run with visible output — the user needs to see @electron/rebuild
    # progress and any compile errors. --silent here hides the exact
    # diagnostic that tells them what to fix.
    if ( cd "$INSTALL_DIR/extension" \
         && npm install --no-audit --no-fund --loglevel=error \
         && npm run build ); then
      echo "$CURRENT_SHA" > "$BUILD_SHA_FILE" 2>/dev/null || true
      BUILD_OK=1
    else
      bad "extension build failed — see $CLAWS_LOG for the full compile log."
      bad "Common causes: Xcode CLT not fully installed, Python 3 missing, offline during @electron/rebuild's Electron headers fetch."
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
EXPECTED_MIN_VERSION="0.5.7"
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
    if "$cli" --install-extension "$VSIX_PATH" --force >/dev/null 2>&1; then
      ok "Claws extension installed in $label (via VSIX)"
      INSTALLED_EDITORS+=("$label")
      any_installed=1
    else
      # Known failure: extension already loaded, VS Code refuses reinstall
      # without a restart. That's still fine — VS Code's extensions dir
      # was updated, the toast fires on next action, and the extension
      # activates on next window.
      warn "$label --install-extension refused (likely a running window holds the current version)"
      info "  this is fine — the new VSIX is staged; Reload Window activates it"
      INSTALLED_EDITORS+=("$label (pending reload)")
      any_installed=1
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

Either way, \`.mcp.json\`, \`.claude/\`, and this directory's other files are
safe to commit — they're stable across installs and help teammates get the
same Claws behavior.

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
    if ! node -e "JSON.parse(require('fs').readFileSync('$PROJECT_ROOT/.mcp.json','utf8'))" 2>/dev/null; then
      bad ".mcp.json written to $PROJECT_ROOT but is not valid JSON — MCP server will fail to load"
      bad "Check $CLAWS_LOG for jq/cat errors above"
    fi
    if [ -f "$PROJECT_ROOT/.gitignore" ] && ! grep -q "^\.claws/" "$PROJECT_ROOT/.gitignore" 2>/dev/null; then
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
    if [ ! -f "$INSTALL_DIR/scripts/inject-claude-md.js" ] && [ ! -f "$INSTALL_DIR/.claws-bin/inject-claude-md.js" ]; then
      warn "inject-claude-md.js not found — CLAUDE.md injection skipped. Clone may be incomplete."
    else
      node --no-deprecation "$INSTALL_DIR/scripts/inject-claude-md.js" "$TARGET" 2>&1 | sed 's/^/  /' || warn "CLAUDE.md injector failed"
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

# ─── Step 7: Shell hook ────────────────────────────────────────────────────
step "Injecting shell hook"
HOOK_SOURCE="source \"$INSTALL_DIR/scripts/shell-hook.sh\""
HOOK_MARKER="# CLAWS terminal hook"

inject_hook() {
  local rcfile="$1"
  touch "$rcfile" 2>/dev/null || true
  local had_stale=0
  if grep -q "CLAWS terminal hook" "$rcfile" 2>/dev/null; then
    if ! grep -Fq "$HOOK_SOURCE" "$rcfile" 2>/dev/null; then
      had_stale=1
    fi
    sed -i.claws-bak '/# CLAWS terminal hook/,+1d' "$rcfile" 2>/dev/null && rm -f "$rcfile.claws-bak" 2>/dev/null
  fi
  if printf "\n%s\n%s\n" "$HOOK_MARKER" "$HOOK_SOURCE" >> "$rcfile" 2>/dev/null; then
    if [ "$had_stale" = "1" ]; then
      ok "refreshed in $(basename "$rcfile") (removed stale path)"
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
inject_hook "$HOME/.bashrc"
[ "$PLATFORM" = "Darwin" ] && inject_hook "$HOME/.bash_profile"

if [ -d "$HOME/.config/fish" ]; then
  FISH_CONF="$HOME/.config/fish/conf.d/claws.fish"
  mkdir -p "$HOME/.config/fish/conf.d" 2>/dev/null
  {
    echo "# CLAWS terminal hook (auto-generated)"
    echo "if status is-interactive"
    echo "    set -gx CLAWS_DIR '$INSTALL_DIR'"
    echo "    if command -v bass >/dev/null 2>&1"
    echo "        bass source '$INSTALL_DIR/scripts/shell-hook.sh' 2>/dev/null"
    echo "    end"
    echo "end"
  } > "$FISH_CONF" && ok "wrote fish conf (native syntax)" || warn "could not write fish config"
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
  if [ "${CLAWS_SKIP_EXTENSION_COPY:-0}" != "1" ]; then
    [ -f "$PROJECT_ROOT/.claws-bin/extension/dist/extension.js" ] \
      && _ok "Project .claws-bin/extension/ (visible copy)" \
      || warn "project .claws-bin/extension/ not copied"
  fi
  [ -f "$PROJECT_ROOT/.claws-bin/README.md" ] && _ok "Project .claws-bin/README.md" || warn "project .claws-bin/README.md missing"
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

  Docs:    https://github.com/neunaha/claws
  Website: https://neunaha.github.io/claws/

NEXT

# Source shell hook last so its output doesn't push the banner off-screen.
# shellcheck disable=SC1090
info "Open a new terminal to activate the shell hook."
