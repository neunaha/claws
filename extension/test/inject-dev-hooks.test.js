#!/usr/bin/env node
// TDD RED: tests for scripts/inject-dev-hooks.js.
// Verifies that inject-dev-hooks.js:
//   - registers exactly 5 hooks tagged _source:"claws-dev-hooks" in the standard
//     event-keyed Claude Code hooks format (settings.hooks.<Event>[])
//   - is idempotent (running twice produces no duplicates)
//   - safe-merges (preserves existing user hooks)
// Run: node --test extension/test/inject-dev-hooks.test.js
// Exits 0 on all pass, 1 on any failure.

'use strict';
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');
const { spawnSync } = require('node:child_process');

const INJECT_DEV_HOOKS = path.resolve(__dirname, '../../scripts/inject-dev-hooks.js');
const SOURCE_TAG = 'claws-dev-hooks';

// Expected hooks: [event, scriptName] — inject-dev-hooks.js must register all 5
const EXPECTED_HOOKS = [
  { event: 'SessionStart', name: 'check-stale-main' },
  { event: 'PostToolUse',  name: 'check-tag-pushed' },
  { event: 'PostToolUse',  name: 'check-tag-vs-main' },
  { event: 'Stop',         name: 'check-open-claws-terminals' },
  { event: 'SessionStart', name: 'check-extension-dirs' },
];

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claws-dev-hooks-'));
}
function cleanTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// inject-dev-hooks.js takes projectRoot as process.argv[2]
function runInjectDevHooks(projectRoot, extraArgs = []) {
  return spawnSync(process.execPath, [INJECT_DEV_HOOKS, projectRoot, ...extraArgs], {
    encoding: 'utf8',
    timeout: 12000,
    env: { ...process.env },
  });
}

// settings.json lives at projectRoot/.claude/settings.json
function settingsPath(projectRoot) {
  return path.join(projectRoot, '.claude', 'settings.json');
}

function readSettings(projectRoot) {
  return JSON.parse(fs.readFileSync(settingsPath(projectRoot), 'utf8'));
}

function writeSettings(projectRoot, obj) {
  fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
  fs.writeFileSync(settingsPath(projectRoot), JSON.stringify(obj, null, 2), 'utf8');
}

// Count all hooks with _source === SOURCE_TAG across all events.
// Expects standard Claude Code format: settings.hooks.<Event> = [...]
function countDevHooks(settings) {
  let total = 0;
  const hooks = settings.hooks || {};
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      if (e._source === SOURCE_TAG) total++;
    }
  }
  return total;
}

// ── test 1: registers exactly 5 hooks with _source:"claws-dev-hooks" ───────
test('registers exactly 5 hooks with _source:"claws-dev-hooks"', () => {
  const tmp = makeTmpDir();
  try {
    writeSettings(tmp, {});

    const r = runInjectDevHooks(tmp);
    assert.equal(r.status, 0, `inject-dev-hooks must exit 0; stderr: ${r.stderr}`);

    const settings = readSettings(tmp);
    // Must use event-keyed format: settings.hooks.SessionStart = [...], not flat array
    assert.equal(typeof settings.hooks, 'object',
      'settings.hooks must be an object (event-keyed), not an array');
    assert.ok(!Array.isArray(settings.hooks),
      'settings.hooks must be an object (not flat array) — use { SessionStart: [], PostToolUse: [], Stop: [] }');
    const count = countDevHooks(settings);
    assert.equal(count, 5, `Expected 5 claws-dev-hooks entries; got ${count}`);
  } finally {
    cleanTmpDir(tmp);
  }
});

// ── test 2: all 5 expected hook names are present in correct events ─────────
test('all 5 named dev hooks are registered under correct events', () => {
  const tmp = makeTmpDir();
  try {
    writeSettings(tmp, {});

    const r = runInjectDevHooks(tmp);
    assert.equal(r.status, 0, `inject-dev-hooks must exit 0; stderr: ${r.stderr}`);

    const settings = readSettings(tmp);
    assert.ok(!Array.isArray(settings.hooks),
      'settings.hooks must be event-keyed object');

    for (const { event, name } of EXPECTED_HOOKS) {
      const eventEntries = (settings.hooks?.[event] || [])
        .filter(e => e._source === SOURCE_TAG);
      const found = eventEntries.some(e =>
        e.hooks && e.hooks.some(h => h.command && h.command.includes(name))
      );
      assert.ok(found,
        `Hook "${name}" must be present in ${event}; entries: ${JSON.stringify(eventEntries)}`);
    }

    // SessionStart: 2 claws-dev-hooks entries (check-stale-main + check-extension-dirs)
    const ssEntries = (settings.hooks?.SessionStart || []).filter(e => e._source === SOURCE_TAG);
    assert.equal(ssEntries.length, 2,
      `SessionStart must have 2 claws-dev-hooks entries; got ${ssEntries.length}`);

    // PostToolUse: 2 claws-dev-hooks entries (check-tag-pushed + check-tag-vs-main)
    const ptuEntries = (settings.hooks?.PostToolUse || []).filter(e => e._source === SOURCE_TAG);
    assert.equal(ptuEntries.length, 2,
      `PostToolUse must have 2 claws-dev-hooks entries; got ${ptuEntries.length}`);

    // Stop: 1 claws-dev-hooks entry (check-open-claws-terminals)
    const stopEntries = (settings.hooks?.Stop || []).filter(e => e._source === SOURCE_TAG);
    assert.equal(stopEntries.length, 1,
      `Stop must have 1 claws-dev-hooks entry; got ${stopEntries.length}`);
  } finally {
    cleanTmpDir(tmp);
  }
});

// ── test 3: PostToolUse hooks have Bash matcher ──────────────────────────────
test('PostToolUse dev hooks have Bash matcher', () => {
  const tmp = makeTmpDir();
  try {
    writeSettings(tmp, {});

    const r = runInjectDevHooks(tmp);
    assert.equal(r.status, 0, `inject-dev-hooks must exit 0; stderr: ${r.stderr}`);

    const settings = readSettings(tmp);
    assert.ok(!Array.isArray(settings.hooks), 'settings.hooks must be event-keyed');

    const ptuEntries = (settings.hooks?.PostToolUse || []).filter(e => e._source === SOURCE_TAG);
    assert.ok(ptuEntries.length > 0, 'Must have at least one PostToolUse claws-dev-hooks entry');
    for (const e of ptuEntries) {
      // matcher must be "Bash" string (not an object like { tool: 'Bash', pattern: '...' })
      assert.ok(
        e.matcher === 'Bash' || e.matcher === '*',
        `PostToolUse dev hook must have "Bash" or "*" matcher; got: ${JSON.stringify(e.matcher)}`
      );
    }
  } finally {
    cleanTmpDir(tmp);
  }
});

// ── test 4: idempotent — running twice produces no duplicates ───────────────
test('idempotent: running twice does not duplicate dev hooks', () => {
  const tmp = makeTmpDir();
  try {
    writeSettings(tmp, {});

    let r = runInjectDevHooks(tmp);
    assert.equal(r.status, 0, `First run must exit 0; stderr: ${r.stderr}`);

    r = runInjectDevHooks(tmp);
    assert.equal(r.status, 0, `Second run must exit 0; stderr: ${r.stderr}`);

    const settings = readSettings(tmp);
    assert.ok(!Array.isArray(settings.hooks), 'settings.hooks must be event-keyed');
    const count = countDevHooks(settings);
    assert.equal(count, 5,
      `After two runs, must still have exactly 5 claws-dev-hooks entries; got ${count}`);
  } finally {
    cleanTmpDir(tmp);
  }
});

// ── test 5: idempotent — running three times stays at 5 ─────────────────────
test('idempotent: three runs still produces exactly 5 hooks', () => {
  const tmp = makeTmpDir();
  try {
    writeSettings(tmp, {});

    for (let i = 0; i < 3; i++) {
      const r = runInjectDevHooks(tmp);
      assert.equal(r.status, 0, `Run ${i + 1} must exit 0; stderr: ${r.stderr}`);
    }

    const settings = readSettings(tmp);
    assert.ok(!Array.isArray(settings.hooks), 'settings.hooks must be event-keyed');
    const count = countDevHooks(settings);
    assert.equal(count, 5,
      `After three runs must have exactly 5 claws-dev-hooks entries; got ${count}`);
  } finally {
    cleanTmpDir(tmp);
  }
});

// ── test 6: safe-merge — existing user hooks are preserved ──────────────────
test('safe-merge: existing user hooks in settings.json are preserved', () => {
  const tmp = makeTmpDir();
  try {
    const userHook = {
      matcher: '*',
      _source: 'my-other-tool',
      hooks: [{ type: 'command', command: '/usr/local/bin/my-session-hook.sh' }],
    };
    writeSettings(tmp, {
      hooks: {
        SessionStart: [userHook],
      },
      someOtherConfig: { key: 'value' },
    });

    const r = runInjectDevHooks(tmp);
    assert.equal(r.status, 0, `inject-dev-hooks must exit 0; stderr: ${r.stderr}`);

    const settings = readSettings(tmp);
    assert.ok(!Array.isArray(settings.hooks), 'settings.hooks must be event-keyed');

    // User's hook must still be present
    const preserved = (settings.hooks?.SessionStart || []).find(e => e._source === 'my-other-tool');
    assert.ok(preserved, 'User hook (_source:"my-other-tool") must be preserved');
    assert.equal(preserved.hooks[0].command, userHook.hooks[0].command,
      'User hook command must be unchanged');

    // Unrelated config must be preserved
    assert.deepEqual(settings.someOtherConfig, { key: 'value' },
      'Unrelated config must be preserved');
  } finally {
    cleanTmpDir(tmp);
  }
});

// ── test 7: safe-merge — multiple user hooks across events are all preserved ─
test('safe-merge: multiple user hooks across events all preserved', () => {
  const tmp = makeTmpDir();
  try {
    writeSettings(tmp, {
      hooks: {
        SessionStart: [
          { matcher: '*', _source: 'tool-a', hooks: [{ type: 'command', command: '/tool-a/session.sh' }] },
        ],
        PostToolUse: [
          { matcher: 'Bash', _source: 'tool-b', hooks: [{ type: 'command', command: '/tool-b/post.sh' }] },
        ],
        Stop: [
          { matcher: '*', _source: 'tool-c', hooks: [{ type: 'command', command: '/tool-c/stop.sh' }] },
        ],
      },
    });

    const r = runInjectDevHooks(tmp);
    assert.equal(r.status, 0, `inject-dev-hooks must exit 0; stderr: ${r.stderr}`);

    const settings = readSettings(tmp);
    assert.ok(!Array.isArray(settings.hooks), 'settings.hooks must be event-keyed');

    const toolA = (settings.hooks?.SessionStart || []).find(e => e._source === 'tool-a');
    assert.ok(toolA, 'tool-a hook must be preserved in SessionStart');
    assert.equal(toolA.hooks[0].command, '/tool-a/session.sh');

    const toolB = (settings.hooks?.PostToolUse || []).find(e => e._source === 'tool-b');
    assert.ok(toolB, 'tool-b hook must be preserved in PostToolUse');
    assert.equal(toolB.hooks[0].command, '/tool-b/post.sh');

    const toolC = (settings.hooks?.Stop || []).find(e => e._source === 'tool-c');
    assert.ok(toolC, 'tool-c hook must be preserved in Stop');
    assert.equal(toolC.hooks[0].command, '/tool-c/stop.sh');

    // Dev hooks must also be present (all 5)
    assert.equal(countDevHooks(settings), 5,
      'All 5 dev hooks must be present alongside user hooks');
  } finally {
    cleanTmpDir(tmp);
  }
});

// ── test 8: JSONC settings.json not wiped (FINDING-B-3) ─────────────────────
test('FINDING-B-3: JSONC settings.json with comments is preserved — not wiped on inject', () => {
  const tmp = makeTmpDir();
  try {
    const dir = path.join(tmp, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    const settingsFile = path.join(dir, 'settings.json');
    // JSONC with a comment — JSON.parse throws on this, old code silently returned {} and wiped the file
    const jsoncContent = [
      '{',
      '  // This is a JSONC comment',
      '  "model": "claude-opus-4-7",',
      '  "someExistingConfig": true',
      '}',
    ].join('\n');
    fs.writeFileSync(settingsFile, jsoncContent, 'utf8');

    const r = runInjectDevHooks(tmp);
    assert.equal(r.status, 0, `inject-dev-hooks must exit 0 on JSONC; stderr: ${r.stderr}`);

    // File must still be parseable JSON after injection
    let result;
    try {
      result = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    } catch (e) {
      assert.fail(`Settings file is no longer valid JSON after inject: ${e.message}`);
    }
    // Pre-existing JSONC config must be preserved (not wiped to {})
    assert.equal(result.model, 'claude-opus-4-7',
      '"model" key must survive JSONC inject — file must not be wiped');
    assert.equal(result.someExistingConfig, true,
      '"someExistingConfig" must survive JSONC inject');
    // Dev hooks must also be present
    assert.ok(typeof result.hooks === 'object' && !Array.isArray(result.hooks),
      'hooks must be added alongside preserved JSONC content');
    assert.equal(countDevHooks(result), 5, 'All 5 dev hooks must be registered');
  } finally {
    cleanTmpDir(tmp);
  }
});

// ── test 9: safe-merge + idempotency: user hooks preserved after two runs ────
test('safe-merge + idempotency: user hooks preserved after two runs', () => {
  const tmp = makeTmpDir();
  try {
    writeSettings(tmp, {
      hooks: {
        SessionStart: [
          { matcher: '*', _source: 'user-tool', hooks: [{ type: 'command', command: '/user/hook.sh' }] },
        ],
      },
    });

    runInjectDevHooks(tmp);
    const r = runInjectDevHooks(tmp);
    assert.equal(r.status, 0, `Second run must exit 0; stderr: ${r.stderr}`);

    const settings = readSettings(tmp);
    assert.ok(!Array.isArray(settings.hooks), 'settings.hooks must be event-keyed');

    const userHook = (settings.hooks?.SessionStart || []).find(e => e._source === 'user-tool');
    assert.ok(userHook, 'User hook must be preserved after two runs');
    assert.equal(userHook.hooks[0].command, '/user/hook.sh',
      'User hook command unchanged after two runs');
    assert.equal(countDevHooks(settings), 5, 'Still exactly 5 dev hooks after two runs');
  } finally {
    cleanTmpDir(tmp);
  }
});
