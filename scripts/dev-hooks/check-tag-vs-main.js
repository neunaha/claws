#!/usr/bin/env node
// PostToolUse Bash hook (git commit): warn if commits on main are past the last tag.
// Always exits 0 — warnings only. Timeout < 5s. Logs misfires to /tmp/claws-dev-hooks.log.
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');

const LOG = '/tmp/claws-dev-hooks.log';

function log(msg) {
  const ts = new Date().toISOString();
  try { fs.appendFileSync(LOG, `${ts} [check-tag-vs-main] ${msg}\n`); } catch (_) {}
}

function run(cmd, opts = {}) {
  return execSync(cmd, { timeout: 4000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

function main() {
  const cwd = process.env.PROJECT_ROOT || process.cwd();

  // Not a git repo — skip silently
  try { run('git rev-parse --git-dir', { cwd }); } catch (_) { return; }

  let latestTag = '';
  try {
    latestTag = run('git describe --tags --abbrev=0', { cwd });
  } catch (_) {
    return; // no tags yet
  }

  let aheadCount = 0;
  try {
    const count = run(`git rev-list --count ${latestTag}..HEAD`, { cwd });
    aheadCount = parseInt(count, 10) || 0;
  } catch (e) {
    log(`rev-list failed: ${e.message}`);
    return;
  }

  if (aheadCount > 0) {
    // Check if we're on main/master
    let branch = '';
    try { branch = run('git rev-parse --abbrev-ref HEAD', { cwd }); } catch (_) {}
    if (branch === 'main' || branch === 'master') {
      console.warn(
        `\n⚠️  [claws-dev-hook] ${aheadCount} commit(s) on ${branch} past last tag (${latestTag}).\n` +
        `   Remember to tag your release: git tag vX.Y.Z && git push --tags\n`
      );
    }
  }
}

try { main(); } catch (e) { log(`uncaught: ${e.message}`); }
process.exit(0);
