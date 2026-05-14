'use strict';

const fs   = require('fs');
const path = require('path');
const { getDefaultShellRcFile, dryRunLog } = require('./platform.js');

// Canonical marker — matches install.sh's HOOK_MARKER exactly.
const MARKER = '# CLAWS terminal hook';

// Legacy format from old Node installer. Stripped as a one-time migration during inject.
const LEGACY_BEGIN = '# >>> claws-code shell hook >>>';
const LEGACY_END   = '# <<< claws-code shell hook <<<';

/**
 * Inject (or replace) the claws shell hook block in the user's rc file.
 * Idempotent: removes prior block before appending.
 * Format matches install.sh canonical: marker line + source line (no closing marker).
 * @param {string} installDir  - path to the claws repo (contains scripts/shell-hook.sh)
 * @param {boolean} [dryRun]
 */
function injectShellHook(installDir, dryRun = false) {
  if (process.platform === 'win32') {
    process.stdout.write('[install] shell hook no-op on win32\n');
    return;
  }
  const rcFile = getDefaultShellRcFile();
  _injectIntoFile(rcFile, installDir, dryRun);
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

function _injectIntoFile(rcFile, installDir, dryRun) {
  const hookSh = path.join(installDir, 'scripts', 'shell-hook.sh');
  // Canonical format matches install.sh: marker line + source line (no closing marker).
  const block  = `\n${MARKER}\nsource "${hookSh}"\n`;

  if (dryRun) {
    dryRunLog(`inject shell hook into ${rcFile}`);
    return;
  }

  if (!fs.existsSync(rcFile)) {
    fs.mkdirSync(path.dirname(rcFile), { recursive: true });
    fs.writeFileSync(rcFile, '', 'utf8');
  }

  const original = fs.readFileSync(rcFile, 'utf8');
  const cleaned  = _removePriorBlock(original);
  const updated  = cleaned + block;

  const tmp = rcFile + '.claws-tmp.' + process.pid;
  fs.writeFileSync(tmp, updated, 'utf8');
  fs.renameSync(tmp, rcFile);
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

module.exports = { injectShellHook, removeShellHook, _injectIntoFile, _removePriorBlock, _removeLegacyBlock };
