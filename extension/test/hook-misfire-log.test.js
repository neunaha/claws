#!/usr/bin/env node
// Tests for M-04: hook misfire logging to /tmp/claws-hook-misfire.log.
// When the hook script path is missing, the sh -c wrapper logs a forensic
// entry and exits 0 (preserving the "never surface hook error" contract).
// Run: node extension/test/hook-misfire-log.test.js
// Exits 0 on success, 1 on failure. No VS Code dependency.

'use strict';
const assert  = require('assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const { spawnSync } = require('child_process');

const INJECT_SETTINGS = path.resolve(__dirname, '../../scripts/inject-settings-hooks.js');

const MISFIRE_LOG = '/tmp/claws-hook-misfire.log';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claws-misfire-'));
}
function cleanTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

(async () => {

  // 1. hookCmd() wrapper exits 0 when script path is missing (contract preserved)
  await check('missing hook path: wrapper exits 0 (silent contract preserved)', () => {
    const tmp = makeTmpDir();
    try {
      // Register hooks pointing to a non-existent CLAWS_BIN
      const fakeBin = path.join(tmp, 'fake-bin');
      fs.mkdirSync(fakeBin, { recursive: true });
      // Create hooks/ dir but DO NOT create any .js files — simulate missing scripts
      fs.mkdirSync(path.join(fakeBin, 'hooks'), { recursive: true });

      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      fs.writeFileSync(settingsPath, '{}', 'utf8');

      // Inject hooks with non-existent script paths
      const injectResult = spawnSync(process.execPath, [INJECT_SETTINGS, fakeBin], {
        encoding: 'utf8', timeout: 10000,
        env: { ...process.env, HOME: tmp },
      });
      assert.strictEqual(injectResult.status, 0, `inject should succeed: ${injectResult.stderr}`);

      // Extract the registered command for session-start hook
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const sessionStartHooks = settings.hooks && settings.hooks.SessionStart;
      assert.ok(sessionStartHooks && sessionStartHooks.length > 0, 'SessionStart hooks must be registered');
      const cmd = sessionStartHooks[0].hooks[0].command;
      assert.ok(cmd, 'hook command must be present');

      // The registered command should contain the misfire log pattern
      assert.ok(
        cmd.includes('claws-hook-misfire.log'),
        `hookCmd must reference misfire log; got: ${cmd}`
      );

      // Execute the wrapper script directly in sh — the path doesn't exist, so it should
      // log to misfire log and exit 0
      const misfireLogBefore = fs.existsSync(MISFIRE_LOG)
        ? fs.readFileSync(MISFIRE_LOG, 'utf8')
        : '';

      const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', timeout: 5000 });
      assert.strictEqual(r.status, 0, `Wrapper must exit 0 on missing path; got ${r.status}, stderr: ${r.stderr}`);

      // Misfire log should be appended with timestamp + path
      const misfireLogAfter = fs.existsSync(MISFIRE_LOG)
        ? fs.readFileSync(MISFIRE_LOG, 'utf8')
        : '';
      const newContent = misfireLogAfter.slice(misfireLogBefore.length);
      assert.ok(newContent.includes('[claws-hook-misfire]'), `Misfire log must contain marker; new content: ${JSON.stringify(newContent)}`);
      assert.ok(newContent.includes('missing path:'), `Misfire log must contain "missing path:"; got: ${JSON.stringify(newContent)}`);
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 2. hookCmd() wrapper exits 0 when script EXISTS (normal path)
  await check('existing hook path: wrapper executes node and exits 0', () => {
    const tmp = makeTmpDir();
    try {
      const fakeBin = path.join(tmp, 'fake-bin');
      const hooksDir = path.join(fakeBin, 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });

      // Create a real script that exits 0
      const scriptPath = path.join(hooksDir, 'test-hook.js');
      fs.writeFileSync(scriptPath, "'use strict'; process.exit(0);\n", 'utf8');

      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      fs.writeFileSync(settingsPath, '{}', 'utf8');

      // Build the wrapper command directly (mirrors hookCmd logic)
      const cmd = (
        `sh -c '[ -f "$0" ] && exec node "$0" || ` +
        `(printf "[claws-hook-misfire] %s missing path: %s\\n" ` +
        `"$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$0" >> /tmp/claws-hook-misfire.log; exit 0)' ` +
        `${JSON.stringify(scriptPath)}`
      );

      const misfireLogBefore = fs.existsSync(MISFIRE_LOG)
        ? fs.readFileSync(MISFIRE_LOG, 'utf8')
        : '';

      const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', timeout: 5000 });
      assert.strictEqual(r.status, 0, `Wrapper must exit 0 when script exists; stderr: ${r.stderr}`);

      // No new misfire entry when script exists
      const misfireLogAfter = fs.existsSync(MISFIRE_LOG)
        ? fs.readFileSync(MISFIRE_LOG, 'utf8')
        : '';
      const newContent = misfireLogAfter.slice(misfireLogBefore.length);
      assert.ok(!newContent.includes('[claws-hook-misfire]'), `No misfire entry when script exists; got: ${JSON.stringify(newContent)}`);
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 3. hookCmd output contains printf + misfire log path
  await check('hookCmd output contains misfire-log printf command', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      fs.writeFileSync(settingsPath, '{}', 'utf8');

      const clawsBin = path.resolve(__dirname, '../../scripts');
      const r = spawnSync(process.execPath, [INJECT_SETTINGS, clawsBin], {
        encoding: 'utf8', timeout: 10000,
        env: { ...process.env, HOME: tmp },
      });
      assert.strictEqual(r.status, 0, `inject must succeed: ${r.stderr}`);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const cmd = settings.hooks.SessionStart[0].hooks[0].command;

      assert.ok(cmd.includes('printf'), 'hookCmd must use printf for misfire logging');
      assert.ok(cmd.includes('claws-hook-misfire.log'), 'hookCmd must reference claws-hook-misfire.log');
      assert.ok(cmd.includes('claws-hook-misfire]'), 'hookCmd must include [claws-hook-misfire] marker');
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
