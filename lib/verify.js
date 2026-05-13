'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawnSync } = require('child_process');

const HOME       = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');

/**
 * Post-install verification. Returns array of failure strings (empty = OK).
 * @param {string} projectRoot
 * @returns {string[]}
 */
function verify(projectRoot) {
  const failures = [];

  if (!fs.existsSync(path.join(projectRoot, '.claws-bin', 'mcp_server.js'))) {
    failures.push('.claws-bin/mcp_server.js missing');
  }
  if (!fs.existsSync(path.join(projectRoot, '.mcp.json'))) {
    failures.push('.mcp.json missing');
  }
  if (!fs.existsSync(path.join(CLAUDE_DIR, 'commands', 'claws.md'))) {
    failures.push('claws commands missing from ~/.claude/commands/');
  }
  if (!fs.existsSync(path.join(CLAUDE_DIR, 'skills', 'claws-prompt-templates'))) {
    failures.push('claws skills missing from ~/.claude/skills/');
  }
  if (!fs.existsSync(path.join(CLAUDE_DIR, 'rules', 'claws-default-behavior.md'))) {
    failures.push('claws rule missing from ~/.claude/rules/');
  }

  return failures;
}

/**
 * Print a human-readable status dashboard for the current project.
 * Sets process.exitCode = 1 when any check fails.
 */
function status() {
  const cwd = process.cwd();
  process.stdout.write('\nClaws installation status\n\n');

  const checks = [
    ['Node.js ≥ 18',             _nodeOk()],
    ['git in PATH',              _gitOk()],
    ['.claws-bin/ present',      fs.existsSync(path.join(cwd, '.claws-bin'))],
    ['.mcp.json present',        fs.existsSync(path.join(cwd, '.mcp.json'))],
    ['mcp_server.js in .claws-bin', fs.existsSync(path.join(cwd, '.claws-bin', 'mcp_server.js'))],
    ['commands present',         fs.existsSync(path.join(CLAUDE_DIR, 'commands', 'claws.md'))],
    ['skills present',           fs.existsSync(path.join(CLAUDE_DIR, 'skills', 'claws-prompt-templates'))],
    ['behavior rule present',    fs.existsSync(path.join(CLAUDE_DIR, 'rules', 'claws-default-behavior.md'))],
  ];

  let passing = 0;
  for (const [label, pass] of checks) {
    const icon  = pass ? '✓' : '✗';
    const color = pass ? '\x1b[32m' : '\x1b[31m';
    process.stdout.write(`  ${color}${icon}\x1b[0m ${label}\n`);
    if (pass) passing++;
  }

  process.stdout.write(`\n  ${passing}/${checks.length} checks passing\n\n`);
  if (passing < checks.length) {
    process.stdout.write('  Run: claws-code install\n\n');
    process.exitCode = 1;
  }
}

function _nodeOk() {
  return Number(process.versions.node.split('.')[0]) >= 18;
}

function _gitOk() {
  return spawnSync('git', ['--version'], { stdio: 'pipe' }).status === 0;
}

module.exports = { verify, status };
