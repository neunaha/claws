'use strict';

const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

/**
 * Run preflight checks. Returns { failures, warnings }.
 * failures → hard errors that abort the install.
 * warnings → WARN-not-block advisories printed before continuing.
 *
 * VS Code CLI presence is intentionally NOT checked here — a missing editor CLI
 * is a soft warning emitted by _installExtension itself (phase 7), not a
 * hard failure. install.sh behaves the same way (warn + continue).
 *
 * @param {object} [opts]
 * @returns {{ failures: string[], warnings: string[] }}
 */
function run(opts = {}) {
  const failures = [];
  const warnings = [];

  // ── Hard failures ──────────────────────────────────────────────────────────

  // Node >= 18
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    failures.push(`Node.js ≥ 18 required (found ${process.version})`);
  }

  // git in PATH (any version — version check is a soft warning below)
  const git = spawnSync('git', ['--version'], { encoding: 'utf8', stdio: 'pipe' });
  if (git.status !== 0) {
    failures.push('git not found — install git: https://git-scm.com');
  }

  // HOME writable
  const home = os.homedir();
  try {
    fs.accessSync(home, fs.constants.W_OK);
  } catch {
    failures.push(`Home directory not writable: ${home}`);
  }

  // ── Soft warnings (WARN-not-block) ──────────────────────────────────────

  // git >= 2
  if (git.status === 0) {
    const m = (git.stdout || '').match(/git version (\d+)/);
    if (m && Number(m[1]) < 2) {
      warnings.push(`git ≥ 2 recommended (found ${(git.stdout || '').trim()}) — some git operations may fail`);
    }
  }

  // npm >= 7
  const npm = spawnSync('npm', ['--version'], { encoding: 'utf8', stdio: 'pipe' });
  if (npm.status === 0) {
    const npmMajor = Number((npm.stdout || '').trim().split('.')[0]);
    if (npmMajor < 7) {
      warnings.push(`npm ≥ 7 recommended (found ${(npm.stdout || '').trim()}) — some install steps may fail`);
    }
  } else {
    warnings.push('npm not found in PATH — extension build may fail');
  }

  // C++ toolchain (needed by node-gyp / @electron/rebuild)
  _checkCppToolchain(warnings);

  // python3 (node-gyp fallback); on Windows Python 3 ships as `python`, try that as fallback
  const py = spawnSync('python3', ['--version'], { encoding: 'utf8', stdio: 'pipe' });
  if (py.status !== 0) {
    const pyFallback = spawnSync('python', ['--version'], { encoding: 'utf8', stdio: 'pipe' });
    const pyFallbackOut = (pyFallback.stdout || '') + (pyFallback.stderr || '');
    if (pyFallback.status !== 0 || !pyFallbackOut.includes('Python 3')) {
      warnings.push('python3 not found — node-gyp builds may fail if native modules need recompiling');
    }
  }

  // Disk space >= 512 MB free in HOME
  _checkDiskSpace(home, warnings);

  return { failures, warnings };
}

/**
 * Check for a C++ build toolchain. Emits a warning (not a failure) if missing.
 * darwin: Xcode Command Line Tools (clang)
 * linux:  g++ or make
 * win32:  cl.exe or msbuild.exe (install.ps1 already handles this for Windows)
 * @param {string[]} warnings
 */
function _checkCppToolchain(warnings) {
  const platform = process.platform;

  if (platform === 'win32') {
    const cl       = spawnSync('cl.exe',      [], { encoding: 'utf8', stdio: 'pipe' });
    const msbuild  = spawnSync('msbuild.exe', [], { encoding: 'utf8', stdio: 'pipe' });
    if (cl.status === null && msbuild.status === null) {
      warnings.push(
        'C++ build tools not found (cl.exe / msbuild.exe) — run: winget install Microsoft.VisualStudio.BuildTools'
      );
    }
    return;
  }

  if (platform === 'darwin') {
    const clang = spawnSync('clang', ['--version'], { encoding: 'utf8', stdio: 'pipe' });
    if (clang.status !== 0) {
      warnings.push(
        'Xcode Command Line Tools not found — run: xcode-select --install'
      );
    }
    return;
  }

  // linux
  const gpp  = spawnSync('g++',  ['--version'], { encoding: 'utf8', stdio: 'pipe' });
  const make = spawnSync('make', ['--version'], { encoding: 'utf8', stdio: 'pipe' });
  if (gpp.status !== 0 || make.status !== 0) {
    warnings.push(
      'C++ build tools not found (g++ / make) — run: sudo apt-get install build-essential  (or distro equivalent)'
    );
  }
}

/**
 * Check free disk space in the given directory. Warns if < 512 MB.
 * Uses `df -k` on POSIX; skips silently on win32.
 * @param {string} dir
 * @param {string[]} warnings
 */
function _checkDiskSpace(dir, warnings) {
  if (process.platform === 'win32') return;

  const df = spawnSync('df', ['-k', dir], { encoding: 'utf8', stdio: 'pipe' });
  if (df.status !== 0) return;

  const lines = (df.stdout || '').trim().split('\n');
  if (lines.length < 2) return;

  // df -k output: Filesystem 1K-blocks Used Available Capacity Mounted
  // column index 3 is "Available" in blocks of 1024 bytes.
  const cols = lines[lines.length - 1].trim().split(/\s+/);
  const freeKb = Number(cols[3]);
  if (!isNaN(freeKb) && freeKb < 512 * 1024) {
    warnings.push(
      `Low disk space: ${Math.round(freeKb / 1024)} MB free in ${dir} (512 MB recommended)`
    );
  }
}

module.exports = { run };
