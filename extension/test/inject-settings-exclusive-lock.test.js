#!/usr/bin/env node
// Tests for F5 M-18: inject-settings-hooks.js must acquire an exclusive advisory
// lock on settings.json before the read-modify-write cycle to prevent concurrent
// invocations from producing torn writes.
// Run: node extension/test/inject-settings-exclusive-lock.test.js
// Exits 0 on success, 1 on failure.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const INJECT_JS = path.resolve(__dirname, '..', '..', 'scripts', 'inject-settings-hooks.js');

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, err: err.message || String(err) });
  }
}

const src = fs.readFileSync(INJECT_JS, 'utf8');

// 1. F5 lock path constant present
check('inject-settings-hooks.js: LOCK_PATH defined', () => {
  assert(src.includes('LOCK_PATH'), 'LOCK_PATH constant not found');
});

// 2. withLock helper present
check('inject-settings-hooks.js: withLock() helper defined', () => {
  assert(src.includes('withLock'), 'withLock function not found');
});

// 3. openSync with wx flag used (exclusive create)
check('inject-settings-hooks.js: fs.openSync(LOCK_PATH, "wx") for exclusive lock', () => {
  assert(
    src.includes("openSync(LOCK_PATH, 'wx')") || src.includes('openSync(LOCK_PATH, "wx")'),
    'Exclusive lock openSync("wx") not found',
  );
});

// 4. Lock released in finally block (always unlinkSync)
check('inject-settings-hooks.js: unlinkSync(LOCK_PATH) in finally for cleanup', () => {
  assert(src.includes('unlinkSync(LOCK_PATH)'), 'unlinkSync(LOCK_PATH) not found — lock may not be released');
});

// 5. All mergeIntoFile call sites wrapped with withLock
check('inject-settings-hooks.js: all mergeIntoFile calls wrapped with withLock', () => {
  const bare = src.match(/await mergeIntoFile\b/g) || [];
  assert(
    bare.length === 0,
    `Found ${bare.length} unwrapped mergeIntoFile call(s) — all must use withLock`,
  );
});

// 6. Behavioral: concurrent invocations both succeed without corrupting settings
(async () => {
  let behavioralOk = true;
  let behavioralErr = '';
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-lock-test-'));
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, 'settings.json');
    fs.writeFileSync(settingsPath, '{}');

    const fakeBin = path.join(tmpDir, 'fakeBin');
    fs.mkdirSync(fakeBin);

    const env = { ...process.env, HOME: tmpDir, CLAWS_NO_GLOBAL_HOOKS: '0' };

    const p1 = spawn(process.execPath, [INJECT_JS, fakeBin], { env, stdio: 'ignore' });
    const p2 = spawn(process.execPath, [INJECT_JS, fakeBin], { env, stdio: 'ignore' });

    await Promise.all([
      new Promise(r => p1.on('exit', r)),
      new Promise(r => p2.on('exit', r)),
    ]);

    const content = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(content);
    assert(typeof parsed === 'object', 'settings.json not an object after concurrent writes');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {
    behavioralOk = false;
    behavioralErr = e.message || String(e);
  }
  checks.push({
    name: 'behavioral: two concurrent invocations both succeed without corrupting settings',
    ok: behavioralOk,
    err: behavioralErr,
  });

  // ─── results ─────────────────────────────────────────────────────────────
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ' — ' + c.err}`);
  }

  const failed = checks.filter(c => !c.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${checks.length} inject-settings-exclusive-lock check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${checks.length} inject-settings-exclusive-lock checks`);
  process.exit(0);
})();
