'use strict';

const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { findCodeCli } = require('./platform.js');

/**
 * Run preflight checks. Returns an array of failure strings (empty = all good).
 * @param {object} [opts]
 * @param {string|null} [opts.vscodeCli] - Override for VS Code CLI path
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

  // VS Code CLI
  const codeCli = opts.vscodeCli || findCodeCli();
  if (!codeCli) {
    failures.push(
      'VS Code CLI (code) not found — install VS Code and add it to PATH, ' +
      'or set CLAWS_VSCODE_CLI=/path/to/code'
    );
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
