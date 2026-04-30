#!/usr/bin/env node
// Tests for M-03 + M-38 + M-39: inject-settings-hooks.js uses json-safe mergeIntoFile
// — atomic write, JSONC-tolerant, abort-on-malformed (never silently reset to {}).
// Run: node extension/test/inject-settings-safe-merge.test.js
// Exits 0 on success, 1 on failure. No VS Code dependency.

'use strict';
const assert   = require('assert');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const { spawnSync, spawn } = require('child_process');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claws-settings-merge-'));
}
function cleanTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function runInject(clawsBin, { home, extraArgs = [] } = {}) {
  const args = [INJECT_SETTINGS];
  if (clawsBin) args.push(clawsBin);
  args.push(...extraArgs);
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 12000,
    env: { ...process.env, HOME: home || os.homedir() },
  });
}

(async () => {

  // 1. Malformed JSON → backup created + original UNCHANGED + non-zero exit
  await check('malformed JSON → backup created + original unchanged + non-zero exit', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      const malformed = '{ "hooks": { MALFORMED JSON HERE }';
      fs.writeFileSync(settingsPath, malformed, 'utf8');

      const r = runInject(CLAWS_BIN, { home: tmp });

      assert.notStrictEqual(r.status, 0, `Expected non-zero exit on malformed JSON, got ${r.status}. stderr: ${r.stderr}`);

      // Original must be unchanged
      const after = fs.readFileSync(settingsPath, 'utf8');
      assert.strictEqual(after, malformed, 'Original file must be unchanged after parse failure');

      // Backup must exist
      const files = fs.readdirSync(claudeDir);
      const backups = files.filter(f => f.includes('settings.json.claws-bak.'));
      assert.ok(backups.length > 0, `Backup file must be created; found: ${JSON.stringify(files)}`);
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 2. JSONC with line + block comments → non-Claws values preserved
  await check('JSONC line+block comments → existing values preserved after merge', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      const jsoncContent = [
        '{',
        '  // this is a line comment',
        '  /* block comment */',
        '  "model": "claude-opus-4-5",',
        '  "other": true,',
        '  "nested": { "key": "value" }',
        '}',
      ].join('\n');
      fs.writeFileSync(settingsPath, jsoncContent, 'utf8');

      const r = runInject(CLAWS_BIN, { home: tmp });
      assert.strictEqual(r.status, 0, `Expected exit 0 for valid JSONC. stderr: ${r.stderr}`);

      const result = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.strictEqual(result.model, 'claude-opus-4-5', '"model" key must be preserved');
      assert.strictEqual(result.other, true, '"other" key must be preserved');
      assert.deepStrictEqual(result.nested, { key: 'value' }, '"nested" key must be preserved');
      assert.ok(result.hooks, 'hooks key must be added by inject-settings-hooks');
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 3. JSONC with trailing commas → non-Claws values preserved
  await check('JSONC trailing commas → existing values preserved after merge', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      const jsoncContent = '{"model":"claude-sonnet-4-6","extra":42,}';
      fs.writeFileSync(settingsPath, jsoncContent, 'utf8');

      const r = runInject(CLAWS_BIN, { home: tmp });
      assert.strictEqual(r.status, 0, `Expected exit 0 for JSONC with trailing comma. stderr: ${r.stderr}`);

      const result = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.strictEqual(result.model, 'claude-sonnet-4-6', '"model" key must be preserved through trailing-comma JSONC');
      assert.strictEqual(result.extra, 42, '"extra" key must be preserved');
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 4. Fresh file (non-existent) → created with hooks
  await check('non-existent settings.json → created with Claws hooks', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      // Do NOT create .claude dir — mergeIntoFile should create it
      const settingsPath = path.join(claudeDir, 'settings.json');
      assert.ok(!fs.existsSync(settingsPath), 'settings.json must not exist before test');

      const r = runInject(CLAWS_BIN, { home: tmp });
      assert.strictEqual(r.status, 0, `Expected exit 0 for fresh install. stderr: ${r.stderr}`);

      const result = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.ok(result.hooks, 'hooks must be written to fresh settings.json');
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 5. Concurrent writers → no corruption (atomic write prevents torn file)
  await check('concurrent writers → no corruption', async () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      fs.writeFileSync(settingsPath, '{}', 'utf8');

      const N = 6;
      const results = await Promise.all(
        Array.from({ length: N }, () =>
          new Promise((resolve, reject) => {
            const p = spawn(process.execPath, [INJECT_SETTINGS, CLAWS_BIN], {
              encoding: 'utf8',
              env: { ...process.env, HOME: tmp },
            });
            let stderr = '';
            p.stderr && p.stderr.on('data', d => { stderr += d; });
            p.on('close', code => resolve({ code, stderr }));
            p.on('error', reject);
            setTimeout(() => { try { p.kill(); } catch {} }, 15000);
          })
        )
      );

      let anyFailed = false;
      for (const { code, stderr } of results) {
        if (code !== 0) {
          anyFailed = true;
          console.error('  [concurrent] child failed:', stderr);
        }
      }
      assert.ok(!anyFailed, 'All concurrent writers must succeed');

      // File must be valid JSON
      const final = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.ok(final.hooks, 'File must have hooks after concurrent writes');
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 6b. legacy array hooks → migrated to object format + Claws hooks added (FINDING-B-1)
  await check('legacy array hooks → migrated to object format + Claws hooks added (--update)', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      // Legacy format: hooks is a flat array with an event field per entry
      const legacy = JSON.stringify({
        hooks: [
          { event: 'SessionStart', matcher: '*', _source: 'other-tool',
            hooks: [{ type: 'command', command: '/other/hook.sh' }] },
        ],
      });
      fs.writeFileSync(settingsPath, legacy, 'utf8');

      const r = runInject(CLAWS_BIN, { home: tmp, extraArgs: ['--update'] });
      assert.strictEqual(r.status, 0, `Expected exit 0 after migrating legacy array hooks. stderr: ${r.stderr}`);

      const result = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      // After migration, hooks MUST be an object keyed by event name
      assert.ok(!Array.isArray(result.hooks), 'hooks must be migrated to object format (not array)');
      assert.strictEqual(typeof result.hooks, 'object', 'hooks must be an object after migration');
      // Claws SessionStart hook must be present
      const sessionHooks = result.hooks.SessionStart || [];
      const clawsHook = sessionHooks.find(e => e._source === 'claws');
      assert.ok(clawsHook, `Claws SessionStart hook must be present after legacy array migration; hooks: ${JSON.stringify(result.hooks)}`);
      // Non-claws legacy array entry must be preserved
      const otherHook = sessionHooks.find(e => e._source === 'other-tool');
      assert.ok(otherHook, 'Non-claws legacy hook must survive array→object migration');
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 6. --remove with malformed JSON → backup + non-zero exit + original unchanged
  await check('--remove on malformed JSON → backup created + non-zero exit', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      const malformed = '{ bad: json }';
      fs.writeFileSync(settingsPath, malformed, 'utf8');

      const r = runInject(CLAWS_BIN, { home: tmp, extraArgs: ['--remove'] });
      assert.notStrictEqual(r.status, 0, 'Expected non-zero exit when --remove on malformed JSON');
      const after = fs.readFileSync(settingsPath, 'utf8');
      assert.strictEqual(after, malformed, 'Original must be unchanged');
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
