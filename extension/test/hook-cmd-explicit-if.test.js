#!/usr/bin/env node
// Tests for M-12: hookCmd() uses explicit if-then-fi instead of && exec || pattern.
// The if-then-else form ensures the else branch is reachable even when exec fails
// for unusual reasons (node binary gone, ENOEXEC).
// Run: node extension/test/hook-cmd-explicit-if.test.js
// Exits 0 on success, 1 on failure. No VS Code dependency.

'use strict';
const assert  = require('assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const { spawnSync } = require('child_process');

const INJECT_SETTINGS = path.resolve(__dirname, '../../scripts/inject-settings-hooks.js');
const CLAWS_BIN       = path.resolve(__dirname, '../../scripts');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claws-hook-if-'));
}
function cleanTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

(async () => {

  // 1. hookCmd produces explicit if-then-fi form
  await check('hookCmd produces explicit if [ -f "$0" ]; then ... else ... fi form', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      fs.writeFileSync(settingsPath, '{}', 'utf8');

      const r = spawnSync(process.execPath, [INJECT_SETTINGS, CLAWS_BIN], {
        encoding: 'utf8', timeout: 10000,
        env: { ...process.env, HOME: tmp },
      });
      assert.strictEqual(r.status, 0, `inject must succeed: ${r.stderr}`);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const cmd = settings.hooks.SessionStart[0].hooks[0].command;

      // Must use if-then-fi, not the && exec || pattern
      assert.ok(cmd.includes('if [ -f "$0" ]'), `Command must use if [ -f "$0" ]; got: ${cmd}`);
      assert.ok(cmd.includes('then exec node "$0"'), `Command must have "then exec node"; got: ${cmd}`);
      assert.ok(cmd.includes('else '), `Command must have explicit "else" branch; got: ${cmd}`);
      assert.ok(cmd.includes('fi\''), `Command must end with "fi'"; got: ${cmd}`);

      // Must NOT use the old && exec || pattern (without if-then-fi)
      assert.ok(
        !cmd.match(/'\s*\[\s*-f\s+"?\$0"?\s*\]\s*&&\s*exec/),
        `Command must NOT use "[ -f ] && exec" pattern; got: ${cmd}`
      );
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 2. The wrapper correctly executes the script when it exists
  await check('if-then-fi wrapper executes existing script and exits 0', () => {
    const tmp = makeTmpDir();
    try {
      const hooksDir = path.join(tmp, 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      const scriptPath = path.join(hooksDir, 'test.js');
      fs.writeFileSync(scriptPath, "'use strict'; process.exit(0);\n");

      const cmd = (
        `sh -c 'if [ -f "$0" ]; then exec node "$0"; ` +
        `else printf "[claws-hook-misfire] %s missing path: %s\\n" ` +
        `"$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$0" >> /tmp/claws-hook-misfire.log; ` +
        `exit 0; fi' ${JSON.stringify(scriptPath)}`
      );

      const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', timeout: 5000 });
      assert.strictEqual(r.status, 0, `Wrapper must exit 0 when script exists; stderr: ${r.stderr}`);
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 3. The else branch fires and exits 0 when script is missing
  await check('if-then-fi else branch exits 0 when script is missing', () => {
    const nonExistentPath = '/tmp/claws-test-nonexistent-hook-script-XXXXXXX.js';
    const cmd = (
      `sh -c 'if [ -f "$0" ]; then exec node "$0"; ` +
      `else printf "[claws-hook-misfire] %s missing path: %s\\n" ` +
      `"$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$0" >> /tmp/claws-hook-misfire.log; ` +
      `exit 0; fi' ${JSON.stringify(nonExistentPath)}`
    );

    const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', timeout: 5000 });
    assert.strictEqual(r.status, 0, `Else branch must exit 0; got status ${r.status}`);
  });

  // 4. All three hooks use the if-then-fi form
  await check('all three registered hooks use if-then-fi form', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      fs.writeFileSync(settingsPath, '{}', 'utf8');

      const r = spawnSync(process.execPath, [INJECT_SETTINGS, CLAWS_BIN], {
        encoding: 'utf8', timeout: 10000,
        env: { ...process.env, HOME: tmp },
      });
      assert.strictEqual(r.status, 0, `inject must succeed: ${r.stderr}`);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const events = ['SessionStart', 'PreToolUse', 'Stop'];
      for (const event of events) {
        const cmd = settings.hooks[event][0].hooks[0].command;
        assert.ok(
          cmd.includes('if [ -f "$0" ]') && cmd.includes('fi\''),
          `${event} hook must use if-then-fi; got: ${cmd}`
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
