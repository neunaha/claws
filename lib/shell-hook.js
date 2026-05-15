'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { dryRunLog, getDefaultShellRcFile } = require('./platform.js');

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
 * Also handles fish (conf.d/claws.fish) and nushell (env.nu) when present.
 * Idempotent per file.
 * @param {string} installDir  - path to the claws repo (contains scripts/shell-hook.sh)
 * @param {boolean} [dryRun]
 */
function injectShellHook(installDir, dryRun = false) {
  if (process.platform === 'win32') {
    _injectPowershellHook(installDir, dryRun);
    return;
  }
  const rcFiles = _getStandardRcFiles();
  for (const rcFile of rcFiles) {
    _injectIntoFile(rcFile, installDir, dryRun);
  }
  _injectFishHook(installDir, dryRun);
  _injectNushellHook(installDir, dryRun);
}

/**
 * Write (or overwrite) ~/.config/fish/conf.d/claws.fish when the fish
 * config directory exists. Fish sources conf.d/ automatically on startup.
 * Matches install.sh lines 1435-1448.
 * @param {string} installDir
 * @param {boolean} [dryRun]
 */
function _injectFishHook(installDir, dryRun) {
  const home = os.homedir();
  if (!fs.existsSync(path.join(home, '.config', 'fish'))) return;

  const confD    = path.join(home, '.config', 'fish', 'conf.d');
  const fishFile = path.join(confD, 'claws.fish');
  const hookFish = path.join(installDir, 'scripts', 'shell-hook.fish');

  const content = [
    '# CLAWS terminal hook (auto-generated — do not edit)',
    `set -gx CLAWS_DIR '${installDir}'`,
    `set -gx CLAWS_SOCKET '.claws/claws.sock'`,
    `if test -f '${hookFish}'`,
    `    source '${hookFish}'`,
    'end',
    '',
  ].join('\n');

  if (dryRun) {
    dryRunLog(`write fish hook to ${fishFile}`);
    return;
  }

  fs.mkdirSync(confD, { recursive: true });
  const tmp = fishFile + '.claws-tmp.' + process.pid;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, fishFile);
  process.stdout.write(`  \x1b[32m✓\x1b[0m fish hook written to ${fishFile}\n`);
}

/**
 * Append the CLAWS_DIR assignment to nushell env.nu (or config.nu) when
 * either file exists. Idempotent: skips if CLAWS_DIR already present.
 * Matches install.sh lines 1450-1466.
 * @param {string} installDir
 * @param {boolean} [dryRun]
 */
function _injectNushellHook(installDir, dryRun) {
  const home     = os.homedir();
  const nuEnv    = path.join(home, '.config', 'nushell', 'env.nu');
  const nuConfig = path.join(home, '.config', 'nushell', 'config.nu');

  let target = null;
  if (fs.existsSync(nuEnv)) target = nuEnv;
  else if (fs.existsSync(nuConfig)) target = nuConfig;
  if (!target) return;

  if (dryRun) {
    dryRunLog(`append CLAWS_DIR to nushell ${path.basename(target)}`);
    return;
  }

  const existing = fs.readFileSync(target, 'utf8');
  if (existing.includes('CLAWS_DIR')) {
    process.stdout.write(`  \x1b[2m${path.basename(target)} already has CLAWS_DIR — skipped\x1b[0m\n`);
    return;
  }

  const append = `\n${MARKER}\n$env.CLAWS_DIR = "${installDir}"\n$env.CLAWS_SOCKET = ".claws/claws.sock"\n`;
  fs.appendFileSync(target, append, 'utf8');
  process.stdout.write(`  \x1b[32m✓\x1b[0m nushell env written to ${target}\n`);
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
 * Inject the Claws shell hook into the PowerShell profile on win32.
 * Copies shell-hook.ps1 to a stable location ($HOME/.claude/claws/) so that
 * $PROFILE never references the install-time temp dir (which is deleted post-install).
 * Uses the same `# CLAWS terminal hook` marker as the bash installer.
 * @param {string} installDir  - path to the claws repo (contains scripts/shell-hook.ps1)
 * @param {boolean} [dryRun]
 * @param {object}  [opts]     - internal overrides for testing
 * @param {string}  [opts.home]   - override os.homedir()
 * @param {Function}[opts.execFn] - override execSync for powershell profile lookup
 */
function _injectPowershellHook(installDir, dryRun, opts = {}) {
  const home        = opts.home   !== undefined ? opts.home   : os.homedir();
  const profilePath = getDefaultShellRcFile({ platform: 'win32', home, execFn: opts.execFn });
  const hookPs1     = path.join(installDir, 'scripts', 'shell-hook.ps1');

  // Stable location: $HOME/.claude/claws/shell-hook.ps1 — one level above the lifecycle
  // hooks dir (~/.claude/claws/hooks/). $PROFILE sources this stable copy so it survives
  // the install temp-dir deletion (root cause of W7-4B).
  const stableDir     = path.join(home, '.claude', 'claws');
  const stableHookPs1 = path.join(stableDir, 'shell-hook.ps1');

  // PowerShell dot-source syntax: . "absolute\path\to\shell-hook.ps1"
  const block = `\n${MARKER}\n. "${stableHookPs1}"\n`;

  if (dryRun) {
    dryRunLog(`copy shell-hook.ps1 to ${stableHookPs1}`);
    dryRunLog(`inject PS shell hook into ${profilePath}`);
    return;
  }

  // Copy hook to stable dir before writing $PROFILE entry.
  fs.mkdirSync(stableDir, { recursive: true });
  if (fs.existsSync(hookPs1)) {
    fs.copyFileSync(hookPs1, stableHookPs1);
    process.stdout.write(`  \x1b[32m✓\x1b[0m shell-hook.ps1 copied to ${stableHookPs1}\n`);
  }

  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  if (!fs.existsSync(profilePath)) {
    fs.writeFileSync(profilePath, '', 'utf8');
  }

  // Backup before modification — mirrors _injectIntoFile's backup pattern.
  const ts     = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = profilePath + '.claws-bak.' + ts;
  try {
    fs.copyFileSync(profilePath, backup);
  } catch (e) {
    process.stderr.write(`  ! Warning: could not backup ${profilePath}: ${e.message}\n`);
  }

  const original = fs.readFileSync(profilePath, 'utf8');
  const cleaned  = _removePriorBlock(original);
  const updated  = cleaned + block;

  const tmp = profilePath + '.claws-tmp.' + process.pid;
  fs.writeFileSync(tmp, updated, 'utf8');
  fs.renameSync(tmp, profilePath);
  process.stdout.write(`  \x1b[32m✓\x1b[0m PS profile updated: ${profilePath}\n`);
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
    if (skip && /shell-hook\.(sh|ps1)/.test(line)) {
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
  _injectFishHook, _injectNushellHook, _injectPowershellHook,
  _injectIntoFile, _removePriorBlock, _removeLegacyBlock,
};
