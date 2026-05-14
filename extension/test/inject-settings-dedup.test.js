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

  // 2. Claws hook is idempotent: running twice produces the expected number of
  //    Claws entries per event (no duplicates, no missing).
  //    Counts reflect the current hook layout (v0.7.13+):
  //      SessionStart: 1  (* matcher — session-start-claws.js)
  //      PreToolUse:   6  (* for general guard + Bash for --no-verify block +
  //                        4 explicit MCP spawn-class matchers re-added in W7h-30C)
  //      PostToolUse:  4  (4 per-tool matchers — Wave C monitor gate)
  //      Stop:         1  (* matcher — stop-claws.js)
  await check('Claws hook idempotent: two runs → correct entry count per event', () => {
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
      const expectedCounts = {
        SessionStart: 1,
        PreToolUse:   6, // '*' + 'Bash' (no-verify block) + 4 MCP spawn-class (W7h-30C)
        PostToolUse:  4, // claws_create/worker/fleet/dispatch_subworker (Wave C monitor gate)
        Stop:         1,
      };
      for (const [event, expected] of Object.entries(expectedCounts)) {
        const clawsEntries = (settings.hooks[event] || []).filter(e => e._source === 'claws');
        assert.strictEqual(clawsEntries.length, expected, `${event} must have exactly ${expected} Claws entries after two runs; got ${clawsEntries.length}`);
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

  // ── W7-2b: orphan hook cleanup tests ────────────────────────────────────────

  // 5. Orphan entry (no _source, command contains Claws hook script filename) is removed
  await check('W7-2b: orphan entry without _source + Claws hook filename is removed', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');

      // Simulate a pre-fix install entry: no _source, old temp path
      const orphanEntry = {
        matcher: '*',
        hooks: [{ type: 'command', command: 'node "/some/old/path/session-start-claws.js"' }],
      };
      // Also include a legitimate non-Claws hook that must be preserved
      const thirdPartyHook = {
        matcher: '*',
        _source: 'my-other-tool',
        hooks: [{ type: 'command', command: '/usr/local/bin/my-hook.sh' }],
      };
      const initial = { hooks: { SessionStart: [orphanEntry, thirdPartyHook] } };
      fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2), 'utf8');

      const r = runInject(tmp);
      assert.strictEqual(r.status, 0, `Inject must succeed: ${r.stderr}`);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const sessionHooks = settings.hooks.SessionStart || [];

      // Orphan must be gone
      const orphanStillPresent = sessionHooks.some(e =>
        !e._source && e.hooks && e.hooks[0] && e.hooks[0].command.includes('session-start-claws.js') &&
        e.hooks[0].command.includes('/some/old/path/')
      );
      assert.ok(!orphanStillPresent, 'Orphan entry (no _source, old path) must be removed');

      // Third-party hook must survive
      const thirdPartyStillPresent = sessionHooks.some(e => e._source === 'my-other-tool');
      assert.ok(thirdPartyStillPresent, 'Third-party hook must be preserved');

      // The new flagged Claws entry must be present
      const newClawsEntry = sessionHooks.find(e => e._source === 'claws');
      assert.ok(newClawsEntry, 'New _source:claws entry must be added');
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 6. Windows temp-dir orphan (command contains 'claws-install-') is removed
  await check('W7-2b: Windows temp-dir orphan (claws-install- path) is removed', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');

      const windowsOrphan = {
        matcher: '*',
        hooks: [{
          type: 'command',
          command: 'node "C:\\\\Users\\\\claws\\\\AppData\\\\Local\\\\Temp\\\\claws-install-dad9c4c0\\\\extract\\\\claws-0.8-alpha\\\\scripts\\\\hooks\\\\session-start-claws.js"',
        }],
      };
      const initial = { hooks: { SessionStart: [windowsOrphan] } };
      fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2), 'utf8');

      const r = runInject(tmp);
      assert.strictEqual(r.status, 0, `Inject must succeed: ${r.stderr}`);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const sessionHooks = settings.hooks.SessionStart || [];

      const orphanStillPresent = sessionHooks.some(e =>
        e.hooks && e.hooks[0] && e.hooks[0].command.includes('claws-install-')
      );
      assert.ok(!orphanStillPresent, 'Windows temp-dir orphan (claws-install-) must be removed');

      // The new flagged Claws entry must be present
      const newClawsEntry = sessionHooks.find(e => e._source === 'claws');
      assert.ok(newClawsEntry, 'New _source:claws entry must be added after orphan removal');
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 7. Settings with NO orphan entries → no-op (non-Claws hooks untouched)
  await check('W7-2b: no orphans → unrelated non-Claws hook untouched (idempotent)', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');

      // A hook that does NOT match any Claws pattern
      const unrelatedHook = {
        matcher: '*',
        _source: 'my-formatter',
        hooks: [{ type: 'command', command: '/usr/local/bin/prettier --write' }],
      };
      const initial = { hooks: { PostToolUse: [unrelatedHook] } };
      fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2), 'utf8');

      let r = runInject(tmp);
      assert.strictEqual(r.status, 0, `First inject must succeed: ${r.stderr}`);
      r = runInject(tmp);
      assert.strictEqual(r.status, 0, `Second inject must succeed: ${r.stderr}`);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const postHooks = settings.hooks.PostToolUse || [];
      const formatterHook = postHooks.find(e => e._source === 'my-formatter');
      assert.ok(formatterHook, 'Unrelated non-Claws hook must survive two inject runs');
      assert.strictEqual(
        formatterHook.hooks[0].command,
        unrelatedHook.hooks[0].command,
        'Unrelated hook command must be unchanged'
      );
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 8. Multiple orphan types in same settings file: all removed, _source:claws entry added
  await check('W7-2b: mixed pre-fix + new-fix + 3rd-party → only new-flagged + 3rd-party remain', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');

      const orphanFilename = {
        matcher: '*',
        hooks: [{ type: 'command', command: 'node "/old/path/hooks/stop-claws.js"' }],
      };
      const orphanTempDir = {
        matcher: '*',
        hooks: [{
          type: 'command',
          command: 'node "C:\\\\Temp\\\\claws-install-abc123\\\\scripts\\\\hooks\\\\stop-claws.js"',
        }],
      };
      const thirdParty = {
        matcher: '*',
        _source: 'lint-runner',
        hooks: [{ type: 'command', command: '/opt/tools/lint.sh' }],
      };
      const initial = { hooks: { Stop: [orphanFilename, orphanTempDir, thirdParty] } };
      fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2), 'utf8');

      const r = runInject(tmp);
      assert.strictEqual(r.status, 0, `Inject must succeed: ${r.stderr}`);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const stopHooks = settings.hooks.Stop || [];

      // Both orphans must be gone
      const anyOrphan = stopHooks.some(e => !e._source);
      assert.ok(!anyOrphan, 'All entries without _source must be removed');

      // Third-party hook preserved
      const lintRunner = stopHooks.find(e => e._source === 'lint-runner');
      assert.ok(lintRunner, 'Third-party lint-runner hook must be preserved');

      // Exactly one Claws-flagged Stop entry
      const clawsEntries = stopHooks.filter(e => e._source === 'claws');
      assert.strictEqual(clawsEntries.length, 1, `Must have exactly 1 Claws Stop entry; got ${clawsEntries.length}`);
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
