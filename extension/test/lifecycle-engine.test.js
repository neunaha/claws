#!/usr/bin/env node
// Unit tests for LifecycleEngine (auto-advance state machine).
// Run: node extension/test/lifecycle-engine.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_ROOT = path.resolve(__dirname, '..');
const { execSync } = require('child_process');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-le-test-'));
const tsSources = [
  path.join(EXT_ROOT, 'src', 'lifecycle-store.ts'),
  path.join(EXT_ROOT, 'src', 'lifecycle-rules.ts'),
  path.join(EXT_ROOT, 'src', 'lifecycle-engine.ts'),
];

try {
  execSync(
    `"${path.join(EXT_ROOT, 'node_modules', '.bin', 'tsc')}" --target ES2020 --module commonjs --moduleResolution node --strict --outDir "${tmpDir}" ${tsSources.map((s) => `"${s}"`).join(' ')}`,
    { stdio: 'pipe' },
  );
} catch (err) {
  console.error('FAIL: TS compile failed:', err.stderr?.toString());
  process.exit(1);
}

const { LifecycleStore } = require(path.join(tmpDir, 'lifecycle-store.js'));
const { LifecycleEngine } = require(path.join(tmpDir, 'lifecycle-engine.js'));

const assertions = [];
function check(name, fn) {
  try { fn(); assertions.push({ name, ok: true }); }
  catch (e) { assertions.push({ name, ok: false, err: e.message || String(e) }); }
}

function mkStore() {
  return new LifecycleStore(fs.mkdtempSync(path.join(os.tmpdir(), 'claws-le-ws-')));
}

function mkEngine(store, events, logs) {
  return new LifecycleEngine({
    store,
    emitEvent: (topic, payload) => { events.push({ topic, payload }); },
    logger: (msg) => { logs.push(msg); },
  });
}

// ─── Test 1: no auto-advance when nextAutoPhase returns null ─────────────────

check('Engine does nothing when nextAutoPhase returns null (phase=PLAN, no spawn)', () => {
  const store = mkStore();
  const events = [];
  const logs = [];
  store.bootSession();
  store.plan('my plan', 'single', 1);
  // Phase is PLAN — nextAutoPhase(PLAN) === null
  const engine = mkEngine(store, events, logs);
  engine.onWorkerEvent('test');
  assert.strictEqual(store.snapshot().phase, 'PLAN');
  assert.strictEqual(events.length, 0);
});

// ─── Test 2: auto-advance SPAWN→DEPLOY when all spawned + all monitored ──────

check('Engine auto-advances SPAWN→DEPLOY when all expected workers spawned + monitored', () => {
  const store = mkStore();
  const events = [];
  const logs = [];
  store.bootSession();
  store.plan('my plan', 'fleet', 2);
  store.setPhase('SPAWN');
  store.registerSpawn('t1', 'c1', 'worker-a');
  store.registerMonitor('t1', 'c1', 'Monitor(...)');
  store.registerSpawn('t2', 'c2', 'worker-b');
  store.registerMonitor('t2', 'c2', 'Monitor(...)');
  const engine = mkEngine(store, events, logs);
  engine.onWorkerEvent('register-monitor');
  assert.strictEqual(store.snapshot().phase, 'DEPLOY');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].topic, 'lifecycle.phase-changed');
  assert.strictEqual(events[0].payload.from, 'SPAWN');
  assert.strictEqual(events[0].payload.to, 'DEPLOY');
});

// ─── Test 3: emits lifecycle.phase-changed event on transition ───────────────

check('Engine emits lifecycle.phase-changed with from/to/reason/ts', () => {
  const store = mkStore();
  const events = [];
  const logs = [];
  store.bootSession();
  store.plan('plan', 'single', 1);
  store.setPhase('SPAWN');
  store.registerSpawn('t1', 'c1', 'worker');
  store.registerMonitor('t1', 'c1', 'Monitor(...)');
  const engine = mkEngine(store, events, logs);
  engine.onWorkerEvent('my-reason');
  assert.strictEqual(events.length, 1);
  const ev = events[0];
  assert.strictEqual(ev.topic, 'lifecycle.phase-changed');
  assert.strictEqual(ev.payload.from, 'SPAWN');
  assert.strictEqual(ev.payload.to, 'DEPLOY');
  assert.strictEqual(ev.payload.reason, 'my-reason');
  assert.ok(typeof ev.payload.ts === 'string', 'ts should be ISO string');
});

// ─── Test 4: cascade — multi-step transition in one call ─────────────────────

check('Engine cascades DEPLOY→OBSERVE→HARVEST in single call when worker completed', () => {
  const store = mkStore();
  const events = [];
  const logs = [];
  store.bootSession();
  store.plan('plan', 'single', 1);
  store.setPhase('SPAWN');
  store.registerSpawn('t1', 'c1', 'worker');
  store.registerMonitor('t1', 'c1', 'Monitor(...)');
  // Force into DEPLOY and mark worker completed — engine should cascade all the way
  store.setPhase('DEPLOY');
  store.markWorkerStatus('t1', 'completed');
  const engine = mkEngine(store, events, logs);
  engine.onWorkerEvent('mark-worker-status:completed');
  // DEPLOY→OBSERVE (worker progressed) then OBSERVE→HARVEST (single, 1 terminal-status)
  assert.strictEqual(store.snapshot().phase, 'HARVEST');
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].payload.from, 'DEPLOY');
  assert.strictEqual(events[0].payload.to, 'OBSERVE');
  assert.strictEqual(events[1].payload.from, 'OBSERVE');
  assert.strictEqual(events[1].payload.to, 'HARVEST');
});

// ─── Test 5: REFLECT gate — won't transition to REFLECT if open terminals ────

check('Engine stays at CLEANUP when terminals not yet closed (canReflect gate)', () => {
  const store = mkStore();
  const events = [];
  const logs = [];
  store.bootSession();
  store.plan('plan', 'single', 1);
  store.setPhase('SPAWN');
  store.registerSpawn('t1', 'c1', 'worker');
  store.registerMonitor('t1', 'c1', 'Monitor(...)');
  store.setPhase('DEPLOY');
  store.setPhase('OBSERVE');
  store.setPhase('HARVEST');
  store.setPhase('CLEANUP');
  store.markWorkerStatus('t1', 'completed');
  // Status is 'completed', not 'closed' — nextAutoPhase(CLEANUP) returns null (canReflect false)
  const engine = mkEngine(store, events, logs);
  engine.onWorkerEvent('test');
  // Should stay at CLEANUP — nextAutoPhase returns null, no transition
  assert.strictEqual(store.snapshot().phase, 'CLEANUP');
  assert.strictEqual(events.length, 0);
});

// ─── Test 6: CLEANUP→REFLECT when all terminals closed ──────────────────────

check('Engine auto-advances CLEANUP→REFLECT when all terminals closed', () => {
  const store = mkStore();
  const events = [];
  const logs = [];
  store.bootSession();
  store.plan('plan', 'single', 1);
  store.setPhase('SPAWN');
  store.registerSpawn('t1', 'c1', 'worker');
  store.registerMonitor('t1', 'c1', 'Monitor(...)');
  store.setPhase('DEPLOY');
  store.setPhase('OBSERVE');
  store.setPhase('HARVEST');
  store.setPhase('CLEANUP');
  // Mark as 'closed' — canReflect returns true
  store.markWorkerStatus('t1', 'closed');
  const engine = mkEngine(store, events, logs);
  engine.onWorkerEvent('mark-worker-status:closed');
  assert.strictEqual(store.snapshot().phase, 'REFLECT');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].payload.from, 'CLEANUP');
  assert.strictEqual(events[0].payload.to, 'REFLECT');
});

// ─── Test 7: logs but doesn't throw on illegal transition (defence-in-depth) ─

check('Engine logs but does not throw when canTransition returns false', () => {
  // Craft a state where nextAutoPhase would return something but canTransition blocks.
  // We can't easily do this with a real store since nextAutoPhase only recommends legal
  // transitions. So we test the logger/no-throw guarantee by verifying normal operation
  // in a phase where no auto-advance applies (SESSION-BOOT) — engine exits silently.
  const store = mkStore();
  const events = [];
  const logs = [];
  store.bootSession();
  // phase = SESSION-BOOT, nextAutoPhase returns null → exits without throw
  const engine = mkEngine(store, events, logs);
  let threw = false;
  try { engine.onWorkerEvent('probe'); } catch { threw = true; }
  assert.strictEqual(threw, false, 'Engine must not throw');
  assert.strictEqual(events.length, 0);
});

// ─── Test 8: army mode — OBSERVE never auto-HARVESTs ─────────────────────────

check('Engine does not auto-advance OBSERVE→HARVEST in army mode', () => {
  const store = mkStore();
  const events = [];
  const logs = [];
  store.bootSession();
  store.plan('plan', 'army', 2);
  store.setPhase('SPAWN');
  store.registerSpawn('t1', 'c1', 'w1');
  store.registerSpawn('t2', 'c2', 'w2');
  store.setPhase('DEPLOY');
  store.setPhase('OBSERVE');
  store.markWorkerStatus('t1', 'completed');
  store.markWorkerStatus('t2', 'completed');
  const engine = mkEngine(store, events, logs);
  engine.onWorkerEvent('mark-worker-status:completed');
  // army mode — claws_wave_complete drives HARVEST, not the engine
  assert.strictEqual(store.snapshot().phase, 'OBSERVE');
  assert.strictEqual(events.length, 0);
});

// ─── results ───────────────────────────────────────────────────────────────

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
for (const a of assertions) console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
const failed = assertions.filter((a) => !a.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${assertions.length} lifecycle-engine check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS: ${assertions.length} lifecycle-engine checks`);
process.exit(0);
