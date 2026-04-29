#!/usr/bin/env node
// Tests for M-15: canonical-path fast path (direct node invocation).
// When CLAWS_BIN/hooks/ directory exists (canonical install), hooks are
// registered as `node "<path>"` directly instead of via sh -c wrapper.
// When CLAWS_BIN has no hooks/ dir (non-canonical), uses wrapped form.
// Run: node extension/test/hookCmd-canonical-fast-path.test.js
// Exits 0 on success, 1 on failure. No VS Code dependency.

'use strict';
const assert  = require('assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const { spawnSync } = require('child_process');

const INJECT_SETTINGS = path.resolve(__dirname, '../../scripts/inject-settings-hooks.js');
const CANONICAL_BIN   = path.resolve(__dirname, '../../scripts');

const assertions = [];
async function check(name, fn) {
  try {
    await fn();
    assertions.push({ name, ok: true });
  } catch (e) {
    assertions.push({ name, ok: false, err: e.message || String(e) });
  }
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claws-canonical-'));
}
function cleanTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function runInjectWith(clawsBin, home) {
  return spawnSync(process.execPath, [INJECT_SETTINGS, clawsBin], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, HOME: home },
  });
}

(async () => {

  // 1. Canonical path (scripts/hooks/ exists) → direct `node "<path>"` invocation
  await check('canonical CLAWS_BIN (hooks/ dir exists) → plain node invocation', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      fs.writeFileSync(settingsPath, '{}', 'utf8');

      // CANONICAL_BIN = scripts/, which has hooks/ subdir
      const r = runInjectWith(CANONICAL_BIN, tmp);
      assert.strictEqual(r.status, 0, `Inject must succeed: ${r.stderr}`);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      for (const event of ['SessionStart', 'PreToolUse', 'Stop']) {
        const cmd = settings.hooks[event][0].hooks[0].command;
        // Canonical: must be `node "<path>"` — no sh -c wrapper
        assert.ok(
          cmd.startsWith('node ') && !cmd.startsWith('sh '),
          `${event}: canonical path must use direct node invocation; got: ${cmd}`
        );
        assert.ok(
          !cmd.includes('sh -c'),
          `${event}: canonical path must NOT use sh -c wrapper; got: ${cmd}`
        );
      }
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 2. Non-canonical path (no hooks/ dir) → wrapped form with misfire logging
  await check('non-canonical CLAWS_BIN (no hooks/ dir) → sh -c wrapped form', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      fs.writeFileSync(settingsPath, '{}', 'utf8');

      // Use tmp dir itself as CLAWS_BIN — it has no hooks/ subdir
      const fakeBin = path.join(tmp, 'custom-claws');
      fs.mkdirSync(fakeBin, { recursive: true });
      // Intentionally DO NOT create hooks/ subdir → non-canonical

      const r = runInjectWith(fakeBin, tmp);
      assert.strictEqual(r.status, 0, `Inject must succeed even with non-canonical path: ${r.stderr}`);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      for (const event of ['SessionStart', 'PreToolUse', 'Stop']) {
        const cmd = settings.hooks[event][0].hooks[0].command;
        // Non-canonical: must use sh -c wrapper with misfire logging
        assert.ok(
          cmd.startsWith('sh -c '),
          `${event}: non-canonical path must use sh -c wrapper; got: ${cmd}`
        );
        assert.ok(
          cmd.includes('if [ -f "$0" ]'),
          `${event}: wrapped form must use if-then-fi; got: ${cmd}`
        );
        assert.ok(
          cmd.includes('claws-hook-misfire.log'),
          `${event}: wrapped form must reference misfire log; got: ${cmd}`
        );
      }
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 3. Canonical: direct node invocation actually runs the hook correctly
  await check('canonical direct node invocation executes hook correctly (exit 0)', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      fs.writeFileSync(settingsPath, '{}', 'utf8');

      const r = runInjectWith(CANONICAL_BIN, tmp);
      assert.strictEqual(r.status, 0, `Inject must succeed: ${r.stderr}`);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const sessionStartCmd = settings.hooks.SessionStart[0].hooks[0].command;

      // The registered command should be `node "/path/to/session-start-claws.js"`
      // Running it with empty stdin should exit 0
      const runResult = spawnSync('sh', ['-c', `${sessionStartCmd} </dev/null`], {
        encoding: 'utf8', timeout: 6000,
      });
      assert.strictEqual(runResult.status, 0, `Direct node invocation must exit 0; stderr: ${runResult.stderr}`);
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 4. F1: partial canonical (hooks/ dir present, but specific scripts missing) → wrapped form
  //    Regression for isCanonicalInstall() dir-only check: an empty hooks/ dir must NOT
  //    produce bare `node` invocations — the missing script would exit non-zero
  //    (MODULE_NOT_FOUND), breaking the SAFETY CONTRACT.
  await check('partial canonical (hooks/ dir present, scripts missing) → sh -c wrapped form', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      fs.writeFileSync(settingsPath, '{}', 'utf8');

      // Create hooks/ dir but leave it EMPTY — no script files
      const fakeBin = path.join(tmp, 'partial-canonical');
      fs.mkdirSync(path.join(fakeBin, 'hooks'), { recursive: true });

      const r = runInjectWith(fakeBin, tmp);
      assert.strictEqual(r.status, 0, `Inject must succeed: ${r.stderr}`);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      for (const event of ['SessionStart', 'PreToolUse', 'Stop']) {
        const cmd = settings.hooks[event][0].hooks[0].command;
        assert.ok(
          cmd.startsWith('sh -c '),
          `${event}: partial canonical (empty hooks/) must fall back to sh -c wrapper; got: ${cmd}`
        );
        assert.ok(
          cmd.includes('if [ -f "$0" ]'),
          `${event}: wrapped form must use if-then-fi guard; got: ${cmd}`
        );
        assert.ok(
          cmd.includes('claws-hook-misfire.log'),
          `${event}: wrapped form must reference misfire log; got: ${cmd}`
        );
      }
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // Report
  const pass = assertions.filter(a => a.ok).length;
  const fail = assertions.filter(a => !a.ok).length;
  for (const a of assertions) {
    console.log(`${a.ok ? 'PASS' : 'FAIL'} — ${a.name}${a.ok ? '' : '\n     ' + a.err}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
