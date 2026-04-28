#!/usr/bin/env node
// Unit tests for LifecycleStore — pure Node.js, no VS Code dependency.
// Run: node extension/test/lifecycle-store.test.js
// Exits 0 on success, 1 on failure.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// LifecycleStore is a TypeScript module compiled into dist/extension.js.
// We import it from the compiled bundle via a small shim that extracts the
// exported class. Since esbuild bundles everything together, we instead
// load the source directly via ts-node or require the dist.
//
// Because we have zero extra deps, we compile and load lifecycle-store.ts
// via the TypeScript compiler output (dist). However, lifecycle-store is
// not exported from the extension bundle entry point. We therefore compile
// it standalone with tsc to a temp .js file.

const EXT_ROOT = path.resolve(__dirname, '..');

// Compile lifecycle-store.ts to a temp file and require it.
const { execSync } = require('child_process');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-ls-test-'));
const tsSource = path.join(EXT_ROOT, 'src', 'lifecycle-store.ts');
const jsOut = path.join(tmpDir, 'lifecycle-store.js');

try {
  execSync(
    `"${path.join(EXT_ROOT, 'node_modules', '.bin', 'tsc')}" --target ES2020 --module commonjs --moduleResolution node --strict --outDir "${tmpDir}" "${tsSource}"`,
    { stdio: 'pipe' },
  );
} catch (err) {
  console.error('FAIL: TypeScript compilation of lifecycle-store.ts failed:', err.stderr?.toString());
  process.exit(1);
}

const { LifecycleStore } = require(jsOut);

// ─── helpers ───────────────────────────────────────────────────────────────

function mkWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claws-ls-ws-'));
}

function stateFile(ws) {
  return path.join(ws, '.claws', 'lifecycle-state.json');
}

function writeStateFile(ws, obj) {
  const dir = path.join(ws, '.claws');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile(ws), JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

const assertions = [];
function check(name, fn) {
  try {
    fn();
    assertions.push({ name, ok: true });
  } catch (e) {
    assertions.push({ name, ok: false, err: e.message || String(e) });
  }
}

// ─── tests ─────────────────────────────────────────────────────────────────

// 1
check('plan — creates state at PLAN phase with non-empty plan text', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  const state = store.plan('test mission');
  assert.strictEqual(state.phase, 'PLAN');
  assert.strictEqual(state.plan, 'test mission');
  assert.deepStrictEqual(state.phases_completed, ['PLAN']);
  assert.strictEqual(state.v, 1);
  assert(typeof state.started_at === 'string');
  assert(store.hasPlan());
});

// 2
check('plan — throws lifecycle:plan-empty on empty string', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  assert.throws(() => store.plan(''), /lifecycle:plan-empty/);
});

// 3
check('plan — throws lifecycle:plan-empty on whitespace-only string', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  assert.throws(() => store.plan('   '), /lifecycle:plan-empty/);
});

// 4
check('plan — idempotent: second call returns existing state unchanged', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  const s1 = store.plan('first plan');
  const s2 = store.plan('second plan');
  assert.strictEqual(s2.plan, 'first plan');
  assert.strictEqual(s1, s2);
});

// 5
check('plan — idempotent: call after advance to SPAWN returns state, no reset', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  store.plan('original plan');
  store.advance('SPAWN');
  const s = store.plan('new plan');
  assert.strictEqual(s.phase, 'SPAWN');
  assert.strictEqual(s.plan, 'original plan');
});

// 6
check('advance — PLAN→SPAWN succeeds', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  store.plan('mission');
  const s = store.advance('SPAWN');
  assert.strictEqual(s.phase, 'SPAWN');
  assert(s.phases_completed.includes('SPAWN'));
});

// 7
check('advance — SPAWN→DEPLOY succeeds', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  store.plan('mission');
  store.advance('SPAWN');
  const s = store.advance('DEPLOY');
  assert.strictEqual(s.phase, 'DEPLOY');
});

// 8
check('advance — PLAN→REFLECT throws lifecycle:invalid-transition', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  store.plan('mission');
  assert.throws(() => store.advance('REFLECT'), /lifecycle:invalid-transition/);
});

// 9
check('advance — SPAWN→PLAN throws lifecycle:invalid-transition (no reverse)', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  store.plan('mission');
  store.advance('SPAWN');
  assert.throws(() => store.advance('PLAN'), /lifecycle:invalid-transition/);
});

// 10
check('advance — throws lifecycle:plan-required when no plan exists', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  assert.throws(() => store.advance('SPAWN'), /lifecycle:plan-required/);
});

// 11
check('advance — idempotent: SPAWN→SPAWN returns ok, state unchanged', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  store.plan('mission');
  store.advance('SPAWN');
  const s1 = store.snapshot();
  const s2 = store.advance('SPAWN');
  assert.strictEqual(s1, s2);
  assert.strictEqual(s2.phase, 'SPAWN');
});

// 12
check('advance — REFLECT is terminal: REFLECT→SPAWN throws', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  store.plan('mission');
  store.advance('SPAWN');
  store.advance('DEPLOY');
  store.advance('OBSERVE');
  store.advance('HARVEST');
  store.advance('CLEANUP');
  store.advance('REFLECT');
  assert.throws(() => store.advance('SPAWN'), /lifecycle:invalid-transition/);
});

// 13
check('advance — FAILED is terminal: FAILED→SPAWN throws', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  store.plan('mission');
  store.advance('SPAWN');
  store.advance('FAILED');
  assert.throws(() => store.advance('SPAWN'), /lifecycle:invalid-transition/);
});

// 14
check('reflect — transitions CLEANUP→REFLECT and persists text', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  store.plan('mission');
  store.advance('SPAWN');
  store.advance('DEPLOY');
  store.advance('OBSERVE');
  store.advance('HARVEST');
  store.advance('CLEANUP');
  const s = store.reflect('great session, learned a lot');
  assert.strictEqual(s.phase, 'REFLECT');
  assert.strictEqual(s.reflect, 'great session, learned a lot');
});

// 15
check('reflect — throws lifecycle:reflect-empty on empty string', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  store.plan('mission');
  store.advance('SPAWN');
  store.advance('DEPLOY');
  store.advance('OBSERVE');
  store.advance('HARVEST');
  store.advance('CLEANUP');
  assert.throws(() => store.reflect(''), /lifecycle:reflect-empty/);
});

// 16
check('reflect — throws lifecycle:invalid-transition when called from SPAWN', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  store.plan('mission');
  store.advance('SPAWN');
  assert.throws(() => store.reflect('should fail'), /lifecycle:invalid-transition/);
});

// 17
check('snapshot — returns null before any plan', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  assert.strictEqual(store.snapshot(), null);
  assert(!store.hasPlan());
});

// 18
check('snapshot — returns current state after plan', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  store.plan('my mission');
  const s = store.snapshot();
  assert(s !== null);
  assert.strictEqual(s.phase, 'PLAN');
  assert.strictEqual(s.plan, 'my mission');
});

// 19
check('loadFromDisk — valid existing file is adopted on construction', () => {
  const ws = mkWorkspace();
  writeStateFile(ws, {
    v: 1,
    phase: 'SPAWN',
    phases_completed: ['PLAN', 'SPAWN'],
    plan: 'previous mission',
    workers: [],
    started_at: new Date().toISOString(),
  });
  const store = new LifecycleStore(ws);
  assert(store.hasPlan());
  assert.strictEqual(store.snapshot().phase, 'SPAWN');
  assert.strictEqual(store.snapshot().plan, 'previous mission');
});

// 20
check('loadFromDisk — file with unknown phase is ignored (state starts null)', () => {
  const ws = mkWorkspace();
  writeStateFile(ws, {
    v: 1,
    phase: 'PLAN-REQUIRED',
    phases_completed: [],
    plan: 'something',
    workers: [],
    started_at: new Date().toISOString(),
  });
  const store = new LifecycleStore(ws);
  assert(!store.hasPlan());
  assert.strictEqual(store.snapshot(), null);
});

// 21
check('loadFromDisk — file with empty plan is ignored (state starts null)', () => {
  const ws = mkWorkspace();
  writeStateFile(ws, {
    v: 1,
    phase: 'PLAN',
    phases_completed: ['PLAN'],
    plan: '',
    workers: [],
    started_at: new Date().toISOString(),
  });
  const store = new LifecycleStore(ws);
  assert(!store.hasPlan());
});

// 22
check('loadFromDisk — malformed JSON is silently ignored (state starts null)', () => {
  const ws = mkWorkspace();
  const dir = path.join(ws, '.claws');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'lifecycle-state.json'), '{ not valid json }}', 'utf8');
  const store = new LifecycleStore(ws);
  assert(!store.hasPlan());
});

// 23
check('loadFromDisk — missing file is ok (state starts null)', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  assert(!store.hasPlan());
});

// 24
check('flushToDisk — state file is written after plan()', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  store.plan('test flush');
  const sf = stateFile(ws);
  assert(fs.existsSync(sf), 'state file should exist after plan()');
  const raw = JSON.parse(fs.readFileSync(sf, 'utf8'));
  assert.strictEqual(raw.phase, 'PLAN');
  assert.strictEqual(raw.plan, 'test flush');
});

// 25
check('flushToDisk — atomic write: uses .tmp rename pattern (no partial reads)', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  store.plan('atomic test');
  const sf = stateFile(ws);
  const tmpFile = sf + '.tmp';
  // After plan(), the .tmp file should NOT exist (was renamed to final)
  assert(!fs.existsSync(tmpFile), '.tmp file should be gone after atomic rename');
  // The final file should exist
  assert(fs.existsSync(sf), 'final state file should exist');
});

// ─── results ───────────────────────────────────────────────────────────────

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

for (const a of assertions) {
  console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
}

const failed = assertions.filter((a) => !a.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${assertions.length} lifecycle-store check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS: ${assertions.length} lifecycle-store checks`);
process.exit(0);
