'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, execSync } = require('child_process');

/**
 * Find all installed editor CLIs (VS Code, Code Insiders, Cursor, Windsurf).
 * Returns an array of { label, cliPath } for each editor found on the system.
 * Mirrors install.sh's `for label in code code-insiders cursor windsurf` loop.
 *
 * Search order per editor:
 *   1. CLAWS_VSCODE_CLI env override (code label only)
 *   2. PATH lookup via which/where
 *   3. Platform-specific known bundle/package locations
 *
 * @param {object} [_opts] - Internal overrides for testing only
 * @returns {{ label: string, cliPath: string }[]}
 */
function findAllEditorClis(_opts = {}) {
  const platform = _opts.platform !== undefined ? _opts.platform : process.platform;
  const env      = _opts.env      !== undefined ? _opts.env      : process.env;
  const existsFn = _opts.existsFn !== undefined ? _opts.existsFn : fs.existsSync;
  const spawnFn  = _opts.spawnFn  !== undefined ? _opts.spawnFn  : spawnSync;

  const localApp     = env.LOCALAPPDATA || '';
  const programFiles = env.ProgramFiles  || 'C:\\Program Files';
  const whichCmd     = platform === 'win32' ? 'where' : 'which';

  const EDITORS = [
    {
      label:     'code',
      macBundle: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      linux:     ['/usr/bin/code', '/snap/bin/code'],
      win:       [
        path.join(localApp,     'Programs', 'Microsoft VS Code', 'bin', 'Code.cmd'),
        path.join(programFiles, 'Microsoft VS Code', 'bin', 'Code.cmd'),
      ],
    },
    {
      label:     'code-insiders',
      macBundle: '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders',
      linux:     ['/usr/bin/code-insiders', '/snap/bin/code-insiders'],
      win:       [
        path.join(localApp,     'Programs', 'Microsoft VS Code Insiders', 'bin', 'Code - Insiders.cmd'),
        path.join(programFiles, 'Microsoft VS Code Insiders', 'bin', 'Code - Insiders.cmd'),
      ],
    },
    {
      label:     'cursor',
      macBundle: '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
      linux:     ['/usr/bin/cursor', '/snap/bin/cursor', '/usr/local/bin/cursor'],
      win:       [
        path.join(localApp, 'Programs', 'cursor', 'cursor.cmd'),
        path.join(localApp, 'cursor', 'resources', 'app', 'bin', 'cursor.cmd'),
      ],
    },
    {
      label:     'windsurf',
      macBundle: '/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf',
      linux:     ['/usr/bin/windsurf', '/snap/bin/windsurf', '/usr/local/bin/windsurf'],
      win:       [
        path.join(localApp, 'Programs', 'Windsurf', 'windsurf.cmd'),
      ],
    },
  ];

  const results = [];
  for (const editor of EDITORS) {
    let found = null;

    // 1. CLAWS_VSCODE_CLI env override (code label only — backward compat)
    if (editor.label === 'code') {
      const override = env.CLAWS_VSCODE_CLI;
      if (override && existsFn(override)) found = override;
    }

    // 2. PATH lookup
    if (!found) {
      const r = spawnFn(whichCmd, [editor.label], { encoding: 'utf8', stdio: 'pipe' });
      if (r.status === 0 && r.stdout) {
        const first = r.stdout.trim().split('\n')[0];
        if (first) found = first;
      }
    }

    // 3. Platform-specific known bundle/package locations
    if (!found) {
      const candidates = platform === 'darwin'
        ? (editor.macBundle ? [editor.macBundle] : [])
        : platform === 'win32'
          ? editor.win
          : editor.linux;
      for (const c of candidates) {
        if (existsFn(c)) { found = c; break; }
      }
    }

    if (found) results.push({ label: editor.label, cliPath: found });
  }

  return results;
}

/**
 * Find the VS Code CLI executable path.
 * Kept for backward compatibility — returns the first match from findAllEditorClis().
 *
 * @param {object} [_opts] - Internal overrides for testing only
 * @returns {string|null}
 */
function findCodeCli(_opts = {}) {
  const env      = _opts.env      !== undefined ? _opts.env      : process.env;
  const existsFn = _opts.existsFn !== undefined ? _opts.existsFn : fs.existsSync;

  // Env override takes precedence (retained for backward compat)
  const override = env.CLAWS_VSCODE_CLI;
  if (override && existsFn(override)) return override;

  const found = findAllEditorClis(_opts);
  return found.length > 0 ? found[0].cliPath : null;
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
  findAllEditorClis,
  detectOneDrivePath,
  longPathPreflight,
  defenderExclusionCommand,
  getDefaultShellRcFile,
  dryRunLog,
};
