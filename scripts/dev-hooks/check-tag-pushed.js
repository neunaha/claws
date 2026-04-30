#!/usr/bin/env node
// PostToolUse Bash hook (git push): verify the latest local tag exists on origin.
// Always exits 0 — warnings only. Timeout < 5s. Logs misfires to /tmp/claws-dev-hooks.log.
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');

const LOG = '/tmp/claws-dev-hooks.log';

function log(msg) {
  const ts = new Date().toISOString();
  try { fs.appendFileSync(LOG, `${ts} [check-tag-pushed] ${msg}\n`); } catch (_) {}
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
    return; // no tags yet — skip
  }

  let remoteTags = '';
  try {
    remoteTags = run(`git ls-remote --tags origin refs/tags/${latestTag}`, { cwd, timeout: 4000 });
  } catch (e) {
    log(`ls-remote failed: ${e.message}`);
    return;
  }

  if (!remoteTags.includes(latestTag)) {
    console.warn(
      `\n⚠️  [claws-dev-hook] Local tag ${latestTag} is NOT on origin.\n` +
      `   Run: git push origin ${latestTag}\n` +
      `   Or:  git push --tags\n`
    );
  }
}

try { main(); } catch (e) { log(`uncaught: ${e.message}`); }
process.exit(0);
