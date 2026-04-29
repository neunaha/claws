#!/usr/bin/env node
// Tests for M-14: exact-command dedup + _source === 'claws' guard.
// Previously command.includes(scriptName) could match non-Claws hooks
// whose command happened to contain our script name as a substring.
// Run: node extension/test/inject-settings-dedup.test.js
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claws-dedup-'));
}
function cleanTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function runInject(home) {
  return spawnSync(process.execPath, [INJECT_SETTINGS, CLAWS_BIN], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, HOME: home },
  });
}

(async () => {

  // 1. Non-Claws hook whose command contains a Claws script name as substring
  //    must NOT be overwritten by inject-settings-hooks.js on rerun
  await check('non-Claws hook containing script substring NOT overwritten on rerun', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');

      // Pre-populate with a non-Claws hook whose command contains "session-start-claws.js"
      const userHook = {
        matcher: '*',
        _source: 'myOtherTool',
        hooks: [{ type: 'command', command: '/foo/bar/my-session-start-claws.js.wrapper' }],
      };
      const initial = {
        hooks: {
          SessionStart: [userHook],
        },
      };
      fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2), 'utf8');

      // First run: inject Claws hooks
      let r = runInject(tmp);
      assert.strictEqual(r.status, 0, `First inject must succeed: ${r.stderr}`);

      const after1 = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      // User's hook must still be present
      const userHookAfter = after1.hooks.SessionStart.find(e => e._source === 'myOtherTool');
      assert.ok(userHookAfter, 'Non-Claws hook must be preserved after first inject');
      assert.strictEqual(
        userHookAfter.hooks[0].command,
        userHook.hooks[0].command,
        'Non-Claws hook command must be unchanged'
      );

      // Second run (idempotent)
      r = runInject(tmp);
      assert.strictEqual(r.status, 0, `Second inject must succeed: ${r.stderr}`);

      const after2 = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const userHookAfter2 = after2.hooks.SessionStart.find(e => e._source === 'myOtherTool');
      assert.ok(userHookAfter2, 'Non-Claws hook must be preserved after second inject (rerun)');
      assert.strictEqual(
        userHookAfter2.hooks[0].command,
        userHook.hooks[0].command,
        'Non-Claws hook command must be unchanged after rerun'
      );
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 2. Claws hook is idempotent: running twice produces only one Claws entry per event
  await check('Claws hook idempotent: two runs → one entry per event', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      fs.writeFileSync(settingsPath, '{}', 'utf8');

      let r = runInject(tmp);
      assert.strictEqual(r.status, 0, `First inject must succeed: ${r.stderr}`);
      r = runInject(tmp);
      assert.strictEqual(r.status, 0, `Second inject must succeed: ${r.stderr}`);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      for (const event of ['SessionStart', 'PreToolUse', 'Stop']) {
        const clawsEntries = (settings.hooks[event] || []).filter(e => e._source === 'claws');
        assert.strictEqual(clawsEntries.length, 1, `${event} must have exactly 1 Claws entry after two runs; got ${clawsEntries.length}`);
      }
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 3. Old-format Claws entry (different command) is upgraded in-place, not duplicated
  await check('stale Claws entry upgraded in-place (no duplicate)', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');

      // Pre-populate with an old-format Claws hook (plain node invocation, old form)
      const oldClawsHook = {
        matcher: '*',
        _source: 'claws',
        hooks: [{ type: 'command', command: `node "/old/path/hooks/session-start-claws.js"` }],
      };
      const initial = { hooks: { SessionStart: [oldClawsHook] } };
      fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2), 'utf8');

      const r = runInject(tmp);
      assert.strictEqual(r.status, 0, `Inject must succeed: ${r.stderr}`);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const clawsEntries = (settings.hooks.SessionStart || []).filter(e => e._source === 'claws');
      assert.strictEqual(clawsEntries.length, 1, `Must have exactly 1 Claws entry after upgrading old-format; got ${clawsEntries.length}`);
      // The entry should now have the new command form
      assert.ok(
        clawsEntries[0].hooks[0].command !== oldClawsHook.hooks[0].command,
        'Old-format command must be replaced with new form'
      );
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 4. Multiple non-Claws hooks in same event are all preserved
  await check('multiple non-Claws hooks in same event all preserved', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');

      const initial = {
        hooks: {
          PreToolUse: [
            { matcher: '*', _source: 'tool-a', hooks: [{ type: 'command', command: '/tool-a/pre-tool-use-claws.js' }] },
            { matcher: '*', _source: 'tool-b', hooks: [{ type: 'command', command: '/tool-b/hook.js' }] },
          ],
        },
      };
      fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2), 'utf8');

      const r = runInject(tmp);
      assert.strictEqual(r.status, 0, `Inject must succeed: ${r.stderr}`);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const toolA = settings.hooks.PreToolUse.find(e => e._source === 'tool-a');
      const toolB = settings.hooks.PreToolUse.find(e => e._source === 'tool-b');
      assert.ok(toolA, 'tool-a hook must be preserved');
      assert.ok(toolB, 'tool-b hook must be preserved');
      assert.strictEqual(toolA.hooks[0].command, '/tool-a/pre-tool-use-claws.js', 'tool-a command must be unchanged');
      assert.strictEqual(toolB.hooks[0].command, '/tool-b/hook.js', 'tool-b command must be unchanged');
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
