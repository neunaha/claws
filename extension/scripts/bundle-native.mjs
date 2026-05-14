#!/usr/bin/env node
// bundle-native.mjs — Post-esbuild step that bundles a runtime-only copy of
// node-pty into <extension>/native/node-pty so the extension is self-contained
// regardless of how it was installed (symlink, VSIX extract, plain clone).
//
// Responsibilities:
//   1. Detect VS Code's Electron version (macOS: read Electron Framework
//      Info.plist CFBundleVersion from VS Code / Insiders / Cursor / Windsurf).
//   2. Try to find a pre-built pty.node in native/node-pty/prebuilt/<platform>-<arch>/;
//      fall back to @electron/rebuild only when the toolchain is available.
//   3. Verify node_modules/node-pty/build/Release/pty.node exists.
//   4. Copy runtime-required pieces into <extension>/native/node-pty/.
//   5. Write native/.metadata.json describing the build.
//
// CLI flags:
//   --skip-rebuild   skip @electron/rebuild (CI / already-correct binaries)
//   --strict         exit non-zero on soft-fail (no prebuilt + no toolchain)
//
// Env vars:
//   CLAWS_FORCE_REBUILD=1   bypass prebuilt and always rebuild from source
//   CLAWS_ELECTRON_VERSION  pin a specific Electron version
//   CLAWS_ELECTRON_ARCH     pin a specific target arch

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync, renameSync, chmodSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = resolve(__dirname, '..');

const args = new Set(process.argv.slice(2));
const SKIP_REBUILD = args.has('--skip-rebuild');
const STRICT_MODE = args.has('--strict');

const FALLBACK_ELECTRON = '39.8.5';
const NODE_PTY_SRC = join(EXT_ROOT, 'node_modules', 'node-pty');
const NATIVE_ROOT = join(EXT_ROOT, 'native');
const NATIVE_DEST = join(NATIVE_ROOT, 'node-pty');
const PREBUILT_ROOT = join(NATIVE_DEST, 'prebuilt');
const MANIFEST_PATH = join(PREBUILT_ROOT, 'manifest.json');
const METADATA_PATH = join(NATIVE_ROOT, '.metadata.json');

function log(msg) {
  process.stdout.write(`[bundle-native] ${msg}\n`);
}

function fail(msg, err) {
  process.stderr.write(`[bundle-native] ERROR: ${msg}\n`);
  if (err) {
    const detail = err && err.stack ? err.stack : String(err);
    process.stderr.write(`[bundle-native] ${detail}\n`);
  }
  process.exit(1);
}

// ─── Step 1: detect Electron version ─────────────────────────────────────────
// Exported for testing (injectable platform/execFn/existsFn/termProgram).
export function detectElectronVersion({
  platform = process.platform,
  execFn = execFileSync,
  existsFn = existsSync,
  termProgram = process.env.TERM_PROGRAM,
  // F4: secondary editor signals for old Cursor builds that still report TERM_PROGRAM=vscode.
  // $CURSOR_TRACE_ID and $CURSOR_CHANNEL are Cursor-specific env vars; if either is set,
  // the shell is almost certainly running inside Cursor regardless of TERM_PROGRAM.
  vscodeInjection = process.env.VSCODE_INJECTION,
  cursorChannel = process.env.CURSOR_CHANNEL,
} = {}) {
  const envOverride = process.env.CLAWS_ELECTRON_VERSION;
  if (envOverride) {
    log(`using CLAWS_ELECTRON_VERSION=${envOverride} (env override)`);
    return { version: envOverride, source: 'env' };
  }

  if (platform === 'darwin') {
    // M-22: prefer the editor that launched this shell session ($TERM_PROGRAM)
    // so the user's daily-driver Electron version wins, not the first-found app.
    const allCandidates = [
      { key: 'vscode',         plist: '/Applications/Visual Studio Code.app/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist' },
      { key: 'vscode-insiders', plist: '/Applications/Visual Studio Code - Insiders.app/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist' },
      { key: 'cursor',         plist: '/Applications/Cursor.app/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist' },
      { key: 'windsurf',       plist: '/Applications/Windsurf.app/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist' },
    ];
    // F4: if CURSOR_CHANNEL/VSCODE_INJECTION signals Cursor, promote 'cursor' even
    // when TERM_PROGRAM still says 'vscode' (old Cursor builds pre-TERM_PROGRAM=cursor).
    let tp = (termProgram || '').toLowerCase();
    if (tp === 'vscode' && (cursorChannel || (vscodeInjection && cursorChannel !== undefined))) {
      // Only override when CURSOR_CHANNEL is explicitly set (Cursor-specific env).
      if (cursorChannel) { tp = 'cursor'; }
    }
    const sorted = [
      ...allCandidates.filter(c => tp && c.key === tp),
      ...allCandidates.filter(c => !(tp && c.key === tp)),
    ];
    for (const { plist } of sorted) {
      if (!existsFn(plist)) continue;
      try {
        const v = execFn('plutil', ['-extract', 'CFBundleVersion', 'raw', plist], {
          encoding: 'utf8',
        }).trim();
        if (v) {
          log(`detected Electron ${v} from ${plist}`);
          return { version: v, source: plist };
        }
      } catch {
        // try next candidate
      }
    }
  }

  if (platform === 'linux') {
    // M-25: VS Code + Cursor + Windsurf Linux install paths.
    const allLinuxCandidates = [
      { key: 'vscode',    ep: '/usr/share/code/electron' },
      { key: 'vscode',    ep: '/usr/lib/code/electron' },
      { key: 'vscode',    ep: '/opt/visual-studio-code/electron' },
      { key: 'vscode',    ep: '/snap/code/current/electron' },
      { key: 'vscode',    ep: '/snap/code/current/usr/share/code/electron' },
      { key: 'cursor',    ep: '/usr/share/cursor/electron' },
      { key: 'cursor',    ep: '/opt/cursor/electron' },
      { key: 'cursor',    ep: '/snap/cursor/current/usr/share/cursor/electron' },
      { key: 'windsurf',  ep: '/usr/share/windsurf/electron' },
      { key: 'windsurf',  ep: '/opt/windsurf/electron' },
    ];
    // M-22/F4: prefer TERM_PROGRAM-matching editor on Linux too; CURSOR_CHANNEL overrides vscode.
    let linuxTp = (termProgram || '').toLowerCase();
    if (linuxTp === 'vscode' && cursorChannel) { linuxTp = 'cursor'; }
    const sorted = [
      ...allLinuxCandidates.filter(c => linuxTp && c.key === linuxTp),
      ...allLinuxCandidates.filter(c => !(linuxTp && c.key === linuxTp)),
    ];
    for (const { ep } of sorted) {
      if (!existsFn(ep)) continue;
      try {
        const v = execFn(ep, ['--version'], { encoding: 'utf8' }).trim().replace(/^v/, '');
        if (v && /^\d+\.\d+\.\d+$/.test(v)) {
          log(`detected Electron ${v} from ${ep}`);
          return { version: v, source: ep };
        }
      } catch {
        // try next candidate
      }
    }
    // Fallback: ask the `electron` CLI if it's on PATH (unlikely but possible)
    try {
      const v = execFn('electron', ['--version'], { encoding: 'utf8' }).trim().replace(/^v/, '');
      if (v && /^\d+\.\d+\.\d+$/.test(v)) {
        log(`detected Electron ${v} from electron CLI`);
        return { version: v, source: 'electron-cli' };
      }
    } catch { /* not available */ }
  }

  if (platform === 'win32') {
    // Read Electron version from VS Code's package.json in the standard install path.
    // VS Code installer puts the app under %LOCALAPPDATA%\Programs\Microsoft VS Code\.
    // Cursor installs under %LOCALAPPDATA%\Programs\cursor\.
    const localAppData = process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local';
    const win32Candidates = [
      { key: 'vscode',  pkg: `${localAppData}\\Programs\\Microsoft VS Code\\resources\\app\\package.json` },
      { key: 'cursor',  pkg: `${localAppData}\\Programs\\cursor\\resources\\app\\package.json` },
      { key: 'vscode',  pkg: `C:\\Program Files\\Microsoft VS Code\\resources\\app\\package.json` },
    ];
    let win32Tp = (termProgram || '').toLowerCase();
    if (win32Tp === 'vscode' && cursorChannel) { win32Tp = 'cursor'; }
    const sorted = [
      ...win32Candidates.filter(c => win32Tp && c.key === win32Tp),
      ...win32Candidates.filter(c => !(win32Tp && c.key === win32Tp)),
    ];
    for (const { pkg } of sorted) {
      if (!existsFn(pkg)) continue;
      try {
        const appPkg = JSON.parse(require('fs').readFileSync(pkg, 'utf8'));
        const v = appPkg.electronVersion || (appPkg.dependencies && appPkg.dependencies.electron);
        if (v && typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v)) {
          const clean = v.replace(/[^0-9.]/g, '').match(/\d+\.\d+\.\d+/)?.[0];
          if (clean) {
            log(`detected Electron ${clean} from ${pkg}`);
            return { version: clean, source: pkg };
          }
        }
      } catch {
        // try next candidate
      }
    }
  }

  // M-23: explicit warning when no editor was found — don't silently fall back.
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') {
    process.stderr.write(
      '[bundle-native] WARNING: could not detect VS Code/Cursor/Windsurf Electron version.\n' +
      '[bundle-native] Set CLAWS_ELECTRON_VERSION=<version> to specify your editor\'s Electron version explicitly.\n',
    );
  }
  log(`no Electron install found; falling back to ${FALLBACK_ELECTRON}`);
  return { version: FALLBACK_ELECTRON, source: 'fallback' };
}

// ─── Detect target architecture ──────────────────────────────────────────────
// Exported for testing (injectable platform/arch/execFn).
export function detectTargetArch({ platform = process.platform, arch = process.arch, execFn = execFileSync } = {}) {
  // Honour explicit override first.
  const envArch = process.env.CLAWS_ELECTRON_ARCH;
  if (envArch) {
    log(`using CLAWS_ELECTRON_ARCH=${envArch} (env override)`);
    return envArch;
  }

  // Rosetta 2 fix (M-05): when Node.js runs under Rosetta (x64 emulation on an
  // arm64 Mac), process.arch reports 'x64'. Building pty.node for x64 produces a
  // binary that native arm64 VS Code/Cursor cannot dlopen — extension falls into
  // pipe-mode silently. Detect via sysctl.proc_translated and return 'arm64' so
  // @electron/rebuild targets the host CPU, not the emulated one.
  if (platform === 'darwin' && arch === 'x64') {
    try {
      const rosetta = execFn('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8' }).trim();
      if (rosetta === '1') {
        log('Rosetta detected — overriding x64 to arm64 for native VS Code/Cursor compatibility');
        log('(Node.js is running under Rosetta 2 on an arm64 Mac — rebuilding for arm64)');
        return 'arm64';
      }
    } catch { /* sysctl not available — not on macOS or too old */ }
  }

  log(`target arch: ${arch}`);
  return arch;
}

// ─── Step 2: @electron/rebuild ───────────────────────────────────────────────
// Exported for testing (injectable spawnFn/failFn).
export function runElectronRebuild(electronVersion, targetArch, { spawnFn = spawnSync, failFn = fail } = {}) {
  log(`running @electron/rebuild --version ${electronVersion} --arch ${targetArch} --only node-pty --force`);
  const IS_WIN = process.platform === 'win32';
  const result = spawnFn(
    'npx',
    [
      '--yes', '@electron/rebuild',
      '--version', electronVersion,
      '--arch', targetArch,
      '--only', 'node-pty',
      '--force',
    ],
    {
      cwd: EXT_ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      timeout: 5 * 60 * 1000, // M-08: 5-minute ceiling — prevents indefinite hang on slow GitHub header fetch
      shell: IS_WIN, // npx.cmd not found without shell on Windows
    },
  );
  if (result.error) failFn(`spawn of @electron/rebuild failed: ${result.error.message}`, result.error);
  // M-07 + M-08: spawnSync sets status=null when the process is killed by a
  // signal. SIGTERM on timeout (M-08) gets a network-hint message; other signals
  // get the re-run hint (M-07).
  if (result.status === null && !result.error) {
    if (result.signal === 'SIGTERM') {
      failFn('@electron/rebuild timed out after 5min — likely a slow Electron headers download. Check network / proxy settings.');
    } else {
      failFn(`@electron/rebuild process killed by signal (${result.signal || 'unknown'}) — re-run /claws-update`);
    }
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    failFn(`@electron/rebuild exited with status ${result.status}`);
  }
  log('@electron/rebuild completed');
}

// ─── Prebuilt helpers ─────────────────────────────────────────────────────────
// Exported for testing.

export function prebuiltPath(platform, arch) {
  return join(PREBUILT_ROOT, `${platform}-${arch}`, 'pty.node');
}

export function verifySha256(file, expected) {
  try {
    const data = readFileSync(file);
    return createHash('sha256').update(data).digest('hex') === expected;
  } catch {
    return false;
  }
}

// Returns true when a Python interpreter is reachable on PATH.
export function hasPython() {
  const IS_WIN = process.platform === 'win32';
  for (const cmd of ['python3', 'python']) {
    try {
      const r = spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: IS_WIN, timeout: 5000 });
      if (r.status === 0) return true;
    } catch { /* not on PATH */ }
  }
  return false;
}

// Returns true when a C++ compiler is reachable (platform-aware).
export function hasCompiler() {
  const plat = process.platform;
  const IS_WIN = plat === 'win32';

  if (plat === 'darwin') {
    return (
      existsSync('/Library/Developer/CommandLineTools/usr/bin/clang') ||
      existsSync('/Applications/Xcode.app/Contents/Developer/usr/bin/clang')
    );
  }

  if (plat === 'linux') {
    for (const cmd of ['cc', 'gcc', 'g++']) {
      try {
        const r = spawnSync('which', [cmd], { stdio: 'ignore', timeout: 3000 });
        if (r.status === 0) return true;
      } catch { /* not on PATH */ }
    }
    return false;
  }

  if (plat === 'win32') {
    // Check well-known MSVC install roots before spawning.
    for (const root of [
      'C:\\Program Files\\Microsoft Visual Studio',
      'C:\\Program Files (x86)\\Microsoft Visual Studio',
    ]) {
      if (existsSync(root)) return true;
    }
    try {
      const r = spawnSync('where', ['cl'], { stdio: 'ignore', shell: IS_WIN, timeout: 5000 });
      if (r.status === 0) return true;
    } catch { /* not found */ }
    return false;
  }

  return false;
}

function readManifest() {
  if (!existsSync(MANIFEST_PATH)) return null;
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function softFailMessage(host) {
  return (
    `[bundle-native] WARNING: no prebuilt pty.node for ${host} and no build toolchain detected.\n` +
    `[bundle-native] The Claws extension will run in pipe-mode (no native PTY capture).\n` +
    `[bundle-native] To fix, choose one of:\n` +
    `[bundle-native]   1. Install Python 3 + a C++ compiler (Xcode CLT on macOS, build-essential on\n` +
    `[bundle-native]      Linux, or VS C++ Build Tools on Windows), then re-run: npm run build\n` +
    `[bundle-native]   2. Set CLAWS_FORCE_REBUILD=1 to force a source rebuild once toolchain is ready.\n` +
    `[bundle-native]   3. Open a GitHub issue requesting a prebuilt for ${host}.\n`
  );
}

// ─── Step 3: verify rebuilt binary ───────────────────────────────────────────
function verifyBinary() {
  const ptyNode = join(NODE_PTY_SRC, 'build', 'Release', 'pty.node');
  if (!existsSync(ptyNode)) {
    fail(
      `expected ${ptyNode} to exist after @electron/rebuild. ` +
      'Check that node_modules/node-pty/ is installed (npm install) and that ' +
      '@electron/rebuild can access it. If the rebuild is failing, re-run with ' +
      '--skip-rebuild after manually building node-pty, or inspect the rebuild ' +
      'output above for the root cause.',
    );
  }
  const st = statSync(ptyNode);
  if (st.size === 0) fail(`${ptyNode} exists but is zero bytes`);
  log(`verified ${relative(EXT_ROOT, ptyNode)} (${st.size} bytes)`);
}

// ─── Step 4: copy runtime-only slice of node-pty ─────────────────────────────
// M-40: atomic copy via staging dir — prevents kill-window leaving an empty
// NATIVE_DEST that silently degrades the extension to pipe-mode on next load.
// Pattern: copy into NATIVE_DEST.claws-new, then rename aside + rename into place.
function setupStagingDir() {
  const staging = NATIVE_DEST + '.claws-new';
  // Clean any stale staging dir from a previous interrupted run.
  if (existsSync(staging)) {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch (err) {
      fail(`failed to remove stale staging dir ${staging}`, err);
    }
  }
  mkdirSync(staging, { recursive: true });
  return staging;
}

function copyFileSafe(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

function copyLibTree(srcLib, destLib, totals) {
  if (!existsSync(srcLib)) return;
  const entries = readdirSync(srcLib, { withFileTypes: true });
  for (const entry of entries) {
    // Exclude TypeScript declaration files and test code from the runtime slice.
    if (entry.name.endsWith('.d.ts')) continue;
    if (entry.name.endsWith('.test.js')) continue;
    if (entry.name.endsWith('.test.js.map')) continue;
    const srcPath = join(srcLib, entry.name);
    const destPath = join(destLib, entry.name);
    if (entry.isDirectory()) {
      copyLibTree(srcPath, destPath, totals);
    } else if (entry.isFile()) {
      copyFileSafe(srcPath, destPath);
      totals.bytes += statSync(destPath).size;
      totals.files += 1;
    }
  }
}

function copyRuntimeSlice() {
  const staging = setupStagingDir();

  const totals = { files: 0, bytes: 0 };

  // 1. package.json (node's resolver needs it)
  if (!existsSync(join(NODE_PTY_SRC, 'package.json'))) {
    fail(`node-pty package.json not found at ${NODE_PTY_SRC}`);
  }
  copyFileSafe(join(NODE_PTY_SRC, 'package.json'), join(staging, 'package.json'));
  totals.files += 1;
  totals.bytes += statSync(join(staging, 'package.json')).size;

  // 2. lib/** (runtime JS, minus tests and *.d.ts)
  copyLibTree(join(NODE_PTY_SRC, 'lib'), join(staging, 'lib'), totals);

  // 3. build/Release/pty.node (native binary) and spawn-helper (Unix only)
  // On win32, ConPTY + Job Objects replace spawn-helper's process-group role;
  // the binary does not exist in Windows node-pty builds so the existsSync guard
  // below naturally skips it. Log explicitly to make the skip observable in CI.
  const ptyNode = join(NODE_PTY_SRC, 'build', 'Release', 'pty.node');
  if (!existsSync(ptyNode)) fail(`pty.node missing at ${ptyNode}`);
  copyFileSafe(ptyNode, join(staging, 'build', 'Release', 'pty.node'));
  totals.files += 1;
  totals.bytes += statSync(join(staging, 'build', 'Release', 'pty.node')).size;

  const spawnHelper = join(NODE_PTY_SRC, 'build', 'Release', 'spawn-helper');
  if (existsSync(spawnHelper)) {
    const dest = join(staging, 'build', 'Release', 'spawn-helper');
    copyFileSafe(spawnHelper, dest);
    try { chmodSync(dest, 0o755); } catch { /* best-effort */ }
    totals.files += 1;
    totals.bytes += statSync(dest).size;
  }

  // 4. Optional LICENSE / README for attribution
  for (const optional of ['LICENSE', 'README.md']) {
    const src = join(NODE_PTY_SRC, optional);
    if (existsSync(src)) {
      copyFileSafe(src, join(staging, optional));
      totals.files += 1;
      totals.bytes += statSync(join(staging, optional)).size;
    }
  }

  // Preserve prebuilt/ — it's version-controlled inside NATIVE_DEST but not in node_modules.
  // The atomic swap below would otherwise wipe committed prebuilt binaries. Copy them into
  // staging so they survive the rename. Use a throwaway totals to keep the summary clean.
  const prebuiltSrc = join(NATIVE_DEST, 'prebuilt');
  if (existsSync(prebuiltSrc)) {
    copyLibTree(prebuiltSrc, join(staging, 'prebuilt'), { files: 0, bytes: 0 });
  }

  // M-40: atomic swap — staging → NATIVE_DEST via rename(2).
  // Kill before this point leaves NATIVE_DEST intact (old version).
  // Kill after renameSync(staging, NATIVE_DEST) leaves NATIVE_DEST correct (new version).
  const oldDest = NATIVE_DEST + '.claws-old';
  if (existsSync(NATIVE_DEST)) {
    renameSync(NATIVE_DEST, oldDest);
  }
  renameSync(staging, NATIVE_DEST);
  if (existsSync(oldDest)) {
    try { rmSync(oldDest, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  return totals;
}

// ─── Step 5: metadata ────────────────────────────────────────────────────────
function writeMetadata(electronVersion, electronSource, nodePtyVersion, totals, targetArch) {
  const metadata = {
    electronVersion,
    electronSource,
    nodePtyVersion,
    platform: process.platform,
    arch: targetArch,
    bundledAt: new Date().toISOString(),
    filesCopied: totals.files,
    bytesCopied: totals.bytes,
    nodeVersion: process.version,
    skippedRebuild: SKIP_REBUILD,
  };
  writeFileSync(METADATA_PATH, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
  log(`wrote ${relative(EXT_ROOT, METADATA_PATH)}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────
function readNodePtyVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(NODE_PTY_SRC, 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch (err) {
    fail(`failed to read node-pty package.json`, err);
    return 'unknown';
  }
}

function main() {
  log(`extension root: ${EXT_ROOT}`);

  if (!existsSync(NODE_PTY_SRC)) {
    fail(
      `node-pty is not installed at ${NODE_PTY_SRC}. ` +
      'Run `npm install` in the extension directory first.',
    );
  }

  const { version: electronVersion, source: electronSource } = detectElectronVersion();
  log(`target Electron: ${electronVersion}`);
  const targetArch = detectTargetArch();
  const host = `${process.platform}-${targetArch}`;
  const FORCE_REBUILD = process.env.CLAWS_FORCE_REBUILD === '1';

  // ── Decision tree (blueprint §Architecture) ──────────────────────────────
  // 1. CLAWS_FORCE_REBUILD=1  → rebuild from source unconditionally
  // 2. prebuilt exists        → verify sha256, stage into node_modules, skip rebuild
  // 3. --skip-rebuild         → trust existing node_modules binary (old CI path)
  // 4. hasPython && hasCompiler → rebuild from source
  // 5. else                   → soft fail (exit 0 unless --strict)

  let binarySource = 'rebuilt-from-source';

  if (FORCE_REBUILD) {
    log(`CLAWS_FORCE_REBUILD=1 — forcing rebuild from source for ${host}`);
    try {
      runElectronRebuild(electronVersion, targetArch);
    } catch (err) {
      fail(`@electron/rebuild invocation threw`, err);
    }
  } else {
    const pb = prebuiltPath(process.platform, targetArch);
    if (existsSync(pb)) {
      log(`prebuilt found for ${host} — skipping @electron/rebuild`);
      const manifest = readManifest();
      const entry = manifest && manifest.binaries && manifest.binaries[host];
      if (entry && entry.sha256) {
        if (!verifySha256(pb, entry.sha256)) {
          fail(
            `prebuilt ${host}/pty.node sha256 mismatch (manifest: ${entry.sha256.slice(0, 16)}…). ` +
            'Re-clone the repo or set CLAWS_FORCE_REBUILD=1 to rebuild from source.',
          );
        }
        log(`sha256 verified for ${host}/pty.node`);
      }
      // Stage prebuilt into node_modules so verifyBinary() + copyRuntimeSlice() work unchanged.
      const destDir = join(NODE_PTY_SRC, 'build', 'Release');
      mkdirSync(destDir, { recursive: true });
      copyFileSync(pb, join(destDir, 'pty.node'));
      log(`staged prebuilt → node_modules/node-pty/build/Release/pty.node`);
      binarySource = 'prebuilt';
    } else if (SKIP_REBUILD) {
      log(`no prebuilt for ${host} — --skip-rebuild set; trusting existing node_modules binary`);
    } else if (hasPython() && hasCompiler()) {
      log(`no prebuilt for ${host} — toolchain detected, rebuilding from source`);
      try {
        runElectronRebuild(electronVersion, targetArch);
      } catch (err) {
        fail(`@electron/rebuild invocation threw`, err);
      }
    } else {
      process.stderr.write(softFailMessage(host));
      if (STRICT_MODE) {
        process.exit(1);
      } else {
        log('continuing without native PTY (pipe-mode). Pass --strict to make this a hard error.');
        process.exit(0);
      }
      return;
    }
  }

  verifyBinary();

  const nodePtyVersion = readNodePtyVersion();
  log(`bundling node-pty@${nodePtyVersion}`);

  let totals;
  try {
    totals = copyRuntimeSlice();
  } catch (err) {
    fail('failed to copy node-pty runtime slice', err);
    return;
  }

  writeMetadata(electronVersion, electronSource, nodePtyVersion, totals, targetArch);

  log('──── bundle summary ────');
  log(`  target        : ${host}`);
  log(`  source        : ${binarySource}`);
  log(`  electron      : ${electronVersion}`);
  log(`  node-pty      : ${nodePtyVersion}`);
  log(`  destination   : ${relative(EXT_ROOT, NATIVE_DEST)}`);
  log(`  files copied  : ${totals.files}`);
  log(`  bytes copied  : ${totals.bytes}`);
  log('[bundle-native] done.');
}

// Only run main when executed directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
