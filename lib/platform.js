'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, execSync } = require('child_process');

/**
 * Find the VS Code CLI executable path.
 *
 * Search order:
 *   1. CLAWS_VSCODE_CLI env override
 *   2. Platform-specific known locations (win32/darwin/linux)
 *   3. PATH lookup via which/where
 *
 * @param {object} [_opts] - Internal overrides for testing only
 * @returns {string|null}
 */
function findCodeCli(_opts = {}) {
  const platform = _opts.platform !== undefined ? _opts.platform : process.platform;
  const env      = _opts.env      !== undefined ? _opts.env      : process.env;
  const existsFn = _opts.existsFn !== undefined ? _opts.existsFn : fs.existsSync;
  const spawnFn  = _opts.spawnFn  !== undefined ? _opts.spawnFn  : spawnSync;

  // 1. Env override
  const override = env.CLAWS_VSCODE_CLI;
  if (override && existsFn(override)) return override;

  // 2. Platform-specific known locations
  if (platform === 'win32') {
    const localApp     = env.LOCALAPPDATA || '';
    const programFiles = env.ProgramFiles  || 'C:\\Program Files';
    const candidates = [
      path.join(localApp,     'Programs', 'Microsoft VS Code', 'bin', 'Code.cmd'),
      path.join(programFiles, 'Microsoft VS Code', 'bin', 'Code.cmd'),
    ];
    for (const c of candidates) {
      if (existsFn(c)) return c;
    }
  } else if (platform === 'darwin') {
    const mac = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
    if (existsFn(mac)) return mac;
  } else {
    for (const c of ['/usr/bin/code', '/snap/bin/code']) {
      if (existsFn(c)) return c;
    }
  }

  // 3. PATH lookup
  const whichCmd = platform === 'win32' ? 'where' : 'which';
  const result = spawnFn(whichCmd, ['code'], { encoding: 'utf8', stdio: 'pipe' });
  if (result.status === 0 && result.stdout) {
    const first = result.stdout.trim().split('\n')[0];
    if (first) return first;
  }

  return null;
}

/**
 * Returns true if homeDir contains "OneDrive".
 * @param {string} homeDir
 * @returns {boolean}
 */
function detectOneDrivePath(homeDir) {
  return homeDir.includes('OneDrive');
}

/**
 * Returns a warning string when homeDir is suspiciously long (>100 chars) or
 * OneDrive-rooted; returns null otherwise.
 * @param {string} homeDir
 * @returns {string|null}
 */
function longPathPreflight(homeDir) {
  if (homeDir.length > 100) {
    return `Warning: home directory path is very long (${homeDir.length} chars). Node on Windows may hit the 260-character path limit.`;
  }
  if (detectOneDrivePath(homeDir)) {
    return `Warning: home directory appears to be OneDrive-synced (${homeDir}). Use fs.realpathSync() on all install paths to resolve symlinks.`;
  }
  return null;
}

/**
 * Returns a PowerShell one-liner to add a Windows Defender exclusion for
 * installPath; returns null on non-Windows.
 * @param {string} installPath
 * @param {object} [_opts] - Internal overrides for testing only
 * @returns {string|null}
 */
function defenderExclusionCommand(installPath, _opts = {}) {
  const platform = _opts.platform !== undefined ? _opts.platform : process.platform;
  if (platform !== 'win32') return null;
  return `Add-MpPreference -ExclusionPath "${installPath}"`;
}

/**
 * Returns the default shell rc-file path for the current user.
 *
 * Platform mapping:
 *   zsh  → ~/.zshrc
 *   bash → ~/.bashrc
 *   fish → ~/.config/fish/config.fish
 *   win32 PowerShell → $PROFILE (resolved via powershell -c $PROFILE)
 *
 * @param {object} [_opts] - Internal overrides for testing only
 * @returns {string}
 */
function getDefaultShellRcFile(_opts = {}) {
  const platform = _opts.platform !== undefined ? _opts.platform : process.platform;
  const env      = _opts.env      !== undefined ? _opts.env      : process.env;
  const home     = _opts.home     !== undefined ? _opts.home     : os.homedir();
  const execFn   = _opts.execFn   !== undefined ? _opts.execFn   : execSync;

  if (platform === 'win32') {
    try {
      const profile = execFn('powershell -c $PROFILE', { encoding: 'utf8' }).trim();
      if (profile) return profile;
    } catch (_) {
      // powershell not available — use canonical default
    }
    return path.join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
  }

  const shell = env.SHELL || '';
  if (shell.includes('zsh'))  return path.join(home, '.zshrc');
  if (shell.includes('fish')) return path.join(home, '.config', 'fish', 'config.fish');
  if (shell.includes('bash')) return path.join(home, '.bashrc');

  // No $SHELL set — fall back by platform
  if (platform === 'darwin') return path.join(home, '.zshrc');
  return path.join(home, '.bashrc');
}

/**
 * Dry-run logger — writes a [dry-run] prefixed line to stdout.
 * Used throughout the installer when --dry-run is active.
 * @param {string} msg
 */
function dryRunLog(msg) {
  process.stdout.write(`[dry-run] ${msg}\n`);
}

module.exports = {
  findCodeCli,
  detectOneDrivePath,
  longPathPreflight,
  defenderExclusionCommand,
  getDefaultShellRcFile,
  dryRunLog,
};
