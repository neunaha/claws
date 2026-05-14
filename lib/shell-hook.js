'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { dryRunLog } = require('./platform.js');

// Canonical marker — matches install.sh's HOOK_MARKER exactly.
const MARKER = '# CLAWS terminal hook';

// Legacy format from old Node installer. Stripped as a one-time migration during inject.
const LEGACY_BEGIN = '# >>> claws-code shell hook >>>';
const LEGACY_END   = '# <<< claws-code shell hook <<<';

/**
 * Returns the list of standard shell rc files to inject into.
 * macOS: ~/.zshrc, ~/.bashrc, ~/.bash_profile
 * Linux: ~/.zshrc, ~/.bashrc
 * win32: [] (no-op on Windows)
 * Matches install.sh's multi-file injection (lines 1419–1433).
 * @param {object} [opts]
 * @returns {string[]}
 */
function _getStandardRcFiles(opts = {}) {
  const platform = opts.platform !== undefined ? opts.platform : process.platform;
  const home     = opts.home     !== undefined ? opts.home     : os.homedir();

  if (platform === 'win32') return [];

  const files = [
    path.join(home, '.zshrc'),
    path.join(home, '.bashrc'),
  ];
  if (platform === 'darwin') {
    files.push(path.join(home, '.bash_profile'));
  }
  return files;
}

/**
 * Inject (or replace) the claws shell hook block in all standard rc files.
 * On macOS: ~/.zshrc, ~/.bashrc, ~/.bash_profile.
 * On Linux: ~/.zshrc, ~/.bashrc.
 * Idempotent per file: removes prior block before appending.
 * @param {string} installDir  - path to the claws repo (contains scripts/shell-hook.sh)
 * @param {boolean} [dryRun]
 */
function injectShellHook(installDir, dryRun = false) {
  if (process.platform === 'win32') {
    process.stdout.write('[install] shell hook no-op on win32\n');
    return;
  }
  const rcFiles = _getStandardRcFiles();
  for (const rcFile of rcFiles) {
    _injectIntoFile(rcFile, installDir, dryRun);
  }
}

/**
 * Remove the claws shell hook block from rcFile.
 * Handles both canonical install.sh format and legacy >>>...<<< format.
 * @param {string} rcFile
 * @param {boolean} [dryRun]
 */
function removeShellHook(rcFile, dryRun = false) {
  if (!fs.existsSync(rcFile)) return;

  if (dryRun) {
    dryRunLog(`remove shell hook from ${rcFile}`);
    return;
  }

  const original = fs.readFileSync(rcFile, 'utf8');
  const cleaned  = _removePriorBlock(original);
  if (cleaned === original) return;

  const tmp = rcFile + '.claws-tmp.' + process.pid;
  fs.writeFileSync(tmp, cleaned, 'utf8');
  fs.renameSync(tmp, rcFile);
}

/**
 * Return the shell binary to use for syntax-checking rcFile, or null if
 * no check is applicable. Mirrors install.sh lines 1420-1432 (use zsh for
 * .zshrc to avoid false positives with zsh-only syntax like setopt/autoload).
 * @param {string} rcFile
 * @returns {string|null}
 */
function _getValidatorShell(rcFile) {
  const base = path.basename(rcFile);
  if (base === '.zshrc') return 'zsh';
  if (base === '.bashrc' || base === '.bash_profile') return 'bash';
  return null;
}

function _injectIntoFile(rcFile, installDir, dryRun) {
  const hookSh = path.join(installDir, 'scripts', 'shell-hook.sh');
  // Canonical format matches install.sh: marker line + source line (no closing marker).
  const block  = `\n${MARKER}\nsource "${hookSh}"\n`;

  if (dryRun) {
    dryRunLog(`backup ${rcFile}`);
    dryRunLog(`inject shell hook into ${rcFile}`);
    return;
  }

  if (!fs.existsSync(rcFile)) {
    fs.mkdirSync(path.dirname(rcFile), { recursive: true });
    fs.writeFileSync(rcFile, '', 'utf8');
  }

  // Backup before modification — matches install.sh lines 1360-1369.
  const ts     = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = rcFile + '.claws-bak.' + ts;
  try {
    fs.copyFileSync(rcFile, backup);
  } catch (e) {
    process.stderr.write(`  ! Warning: could not backup ${rcFile}: ${e.message}\n`);
  }

  const original = fs.readFileSync(rcFile, 'utf8');
  const cleaned  = _removePriorBlock(original);
  const updated  = cleaned + block;

  const tmp = rcFile + '.claws-tmp.' + process.pid;
  fs.writeFileSync(tmp, updated, 'utf8');
  fs.renameSync(tmp, rcFile);

  // Syntax validation — matches install.sh lines 1423-1432.
  const shellBin = _getValidatorShell(rcFile);
  if (shellBin) {
    const check = spawnSync(shellBin, ['-n', rcFile], { encoding: 'utf8', stdio: 'pipe' });
    if (check.status !== 0) {
      process.stderr.write(
        `  ! Warning: ${path.basename(rcFile)} failed ${shellBin} -n check — backup at ${backup}\n`
      );
    }
  }
}

/**
 * Remove any prior Claws shell hook block from content.
 * Handles both formats:
 *   - Canonical (install.sh): "# CLAWS terminal hook" marker + following source line
 *   - Legacy (old Node installer): "# >>> claws-code shell hook >>>" ... "# <<< ... <<<"
 * Mirrors the awk cleanup pattern in install.sh's inject_hook():
 *   /# CLAWS terminal hook/ { skip = 1; next }
 *   skip && /source.*shell-hook\.sh/ { skip = 0; next }
 *   skip { skip = 0; print }
 *   { print }
 * @param {string} content
 * @returns {string}
 */
function _removePriorBlock(content) {
  // Step 1: one-time migration — strip legacy >>>...<<< block if present.
  content = _removeLegacyBlock(content);

  // Step 2: strip canonical format — marker line + following source line.
  const lines = content.split('\n');
  const out = [];
  let skip = false;
  for (const line of lines) {
    if (/# CLAWS terminal hook/.test(line)) {
      skip = true;
      continue;
    }
    if (skip && /source.*shell-hook\.sh/.test(line)) {
      skip = false;
      continue;
    }
    if (skip) {
      // Marker found but next line is not a source line — keep it, stop skipping.
      skip = false;
      out.push(line);
      continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n+$/, '');
}

/**
 * Strip the legacy Node-installer >>>...<<< block from content.
 * @param {string} content
 * @returns {string}
 */
function _removeLegacyBlock(content) {
  const beginRe = /^# >>> claws-code shell hook >>>$/m;
  const endRe   = /^# <<< claws-code shell hook <<<$/m;

  const beginIdx = content.search(beginRe);
  if (beginIdx === -1) return content;

  const afterBegin = content.slice(beginIdx);
  const endMatch   = afterBegin.match(endRe);
  if (!endMatch) return content;

  const endIdx = beginIdx + afterBegin.indexOf(endMatch[0]) + endMatch[0].length;
  return content.slice(0, beginIdx).replace(/\n+$/, '') + content.slice(endIdx);
}

module.exports = {
  injectShellHook, removeShellHook,
  _getStandardRcFiles, _getValidatorShell,
  _injectIntoFile, _removePriorBlock, _removeLegacyBlock,
};
