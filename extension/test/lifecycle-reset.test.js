#!/usr/bin/env node
// Regression test: REFLECT → PLAN cycle reset (L2 fix).
// After a session reaches REFLECT, calling plan() should start cycle N+1,
// not return the stale old plan. The gate must re-open for the new cycle.
// Run: node extension/test/lifecycle-reset.test.js
// Exits 0 on success, 1 on failure.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_ROOT = path.resolve(__dirname, '..');
const { execSync } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-lr-test-'));
const tsSource = path.join(EXT_ROOT, 'src', 'lifecycle-store.ts');
const jsOut = path.join(tmpDir, 'lifecycle-store.js');

try {
  execSync(
    `"${path.join(EXT_ROOT, 'node_modules', '.bin', 'tsc')}" --target ES2020 --module commonjs --moduleResolution node --strict --outDir "${tmpDir}" "${tsSource}"`,
    { stdio: 'pipe' },
  );
} catch (err) {
  console.error('FAIL: TypeScript compilation failed:', err.stderr?.toString());
  process.exit(1);
}

const { LifecycleStore } = require(jsOut);

const assertions = [];
function check(name, fn) {
  try {
    fn();
    assertions.push({ name, ok: true });
  } catch (e) {
    assertions.push({ name, ok: false, err: e.message || String(e) });
  }
}

function mkWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claws-lr-ws-'));
}

// ─── full cycle helper ──────────────────────────────────────────────────────

function runFullCycle(store, planText) {
  store.plan(planText, 'single', 1);
  store.advance('SPAWN');
  store.advance('DEPLOY');
  store.advance('OBSERVE');
  store.advance('HARVEST');
  store.advance('CLEANUP');
  store.advance('REFLECT');
}

// ─── tests ──────────────────────────────────────────────────────────────────

// 1 — hasPlan() is false after REFLECT (gate is closed)
check('hasPlan() === false after REFLECT', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  runFullCycle(store, 'first cycle');
  assert.strictEqual(store.hasPlan(), false,
    'hasPlan() must be false in REFLECT so the lifecycle gate is closed');
});

// 2 — plan() after REFLECT resets the cycle (new plan text adopted)
check('plan() after REFLECT starts cycle N+1 with new plan text', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  runFullCycle(store, 'first cycle');
  const s = store.plan('second cycle', 'single', 1);
  assert.strictEqual(s.plan, 'second cycle');
});

// 3 — phases_completed resets to ['PLAN'] for cycle N+1
check('plan() after REFLECT resets phases_completed to [\'PLAN\']', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  runFullCycle(store, 'first cycle');
  const s = store.plan('second cycle', 'single', 1);
  assert.deepStrictEqual(s.phases_completed, ['PLAN']);
});

// 4 — phase resets to PLAN
check('plan() after REFLECT sets phase to PLAN', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  runFullCycle(store, 'first cycle');
  const s = store.plan('second cycle', 'single', 1);
  assert.strictEqual(s.phase, 'PLAN');
});

// 5 — hasPlan() is true again after cycle N+1 plan
check('hasPlan() === true after plan() in cycle N+1', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  runFullCycle(store, 'first cycle');
  store.plan('second cycle', 'single', 1);
  assert.strictEqual(store.hasPlan(), true);
});

// 6 — cycle N+1 can advance normally (gate is open again)
check('cycle N+1 can advance PLAN→SPAWN after reset', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  runFullCycle(store, 'first cycle');
  store.plan('second cycle', 'single', 1);
  const s = store.advance('SPAWN');
  assert.strictEqual(s.phase, 'SPAWN');
});

// 7 — plan() within an active cycle (non-REFLECT) is still idempotent
check('plan() within active cycle (SPAWN) is still idempotent', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  store.plan('first plan');
  store.advance('SPAWN');
  const s = store.plan('new plan attempt');
  assert.strictEqual(s.plan, 'first plan', 'mid-cycle plan() must not overwrite active plan');
  assert.strictEqual(s.phase, 'SPAWN');
});

// 8 — snapshot().reflect is wiped on cycle N+1 reset
check('reflect text does not carry over into cycle N+1', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  runFullCycle(store, 'first cycle');
  store.plan('second cycle', 'single', 1);
  const s = store.snapshot();
  assert.strictEqual(s.reflect, undefined,
    'reflect field must not carry over from previous cycle');
});

// ─── results ────────────────────────────────────────────────────────────────

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

for (const a of assertions) {
  console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
}

const failed = assertions.filter((a) => !a.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${assertions.length} lifecycle-reset check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS: ${assertions.length} lifecycle-reset checks`);
process.exit(0);
