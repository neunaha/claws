'use strict';

const fs   = require('fs');
const path = require('path');
const { getDefaultShellRcFile, dryRunLog } = require('./platform.js');

const BLOCK_BEGIN = '# >>> claws-code shell hook >>>';
const BLOCK_END   = '# <<< claws-code shell hook <<<';

/**
 * Inject (or replace) the claws shell hook block in the user's rc file.
 * Idempotent: removes prior block before appending.
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
  const block  = `\n${BLOCK_BEGIN}\n[ -f "${hookSh}" ] && source "${hookSh}"\n${BLOCK_END}\n`;

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

function _removePriorBlock(content) {
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

module.exports = { injectShellHook, removeShellHook, _injectIntoFile, _removePriorBlock };
