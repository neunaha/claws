'use strict';

const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

/**
 * Run preflight checks. Returns an array of failure strings (empty = all good).
 *
 * VS Code CLI presence is intentionally NOT checked here — a missing editor CLI
 * is a soft warning emitted by _installExtension itself (phase 7), not a
 * hard failure. install.sh behaves the same way (warn + continue).
 *
 * @param {object} [opts]
 * @returns {string[]}
 */
function run(opts = {}) {
  const failures = [];

  // Node >= 18
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    failures.push(`Node.js ≥ 18 required (found ${process.version})`);
  }

  // git in PATH
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

  return failures;
}

module.exports = { run };
