#!/usr/bin/env node
// SessionStart hook: warn if local main/current branch is behind origin.
// Always exits 0 — warnings only. Timeout < 5s. Logs misfires to /tmp/claws-dev-hooks.log.
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOG = '/tmp/claws-dev-hooks.log';

function log(msg) {
  const ts = new Date().toISOString();
  try { fs.appendFileSync(LOG, `${ts} [check-stale-main] ${msg}\n`); } catch (_) {}
}

function run(cmd, opts = {}) {
  return execSync(cmd, { timeout: 4000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

function main() {
  const cwd = process.env.PROJECT_ROOT || process.cwd();

  // Not a git repo — skip silently
  try { run('git rev-parse --git-dir', { cwd }); } catch (_) { return; }

  // Fetch with a tight timeout; if offline, exit silently
  try {
    run('git fetch origin --quiet --no-tags --depth=1', { cwd, timeout: 4000 });
  } catch (e) {
    log(`fetch failed (offline?): ${e.message}`);
    return;
  }

  let behind = 0;
  try {
    const branch = run('git rev-parse --abbrev-ref HEAD', { cwd });
    const upstream = `origin/${branch}`;
    const count = run(`git rev-list --count HEAD..${upstream}`, { cwd });
    behind = parseInt(count, 10) || 0;
  } catch (e) {
    log(`rev-list failed: ${e.message}`);
    return;
  }

  if (behind > 0) {
    console.warn(
      `\n⚠️  [claws-dev-hook] Your branch is ${behind} commit(s) behind origin.\n` +
      `   Run: git pull --ff-only origin\n`
    );
  }
}

try { main(); } catch (e) { log(`uncaught: ${e.message}`); }
process.exit(0);
