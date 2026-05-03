#!/usr/bin/env node
// Unit tests for LifecycleStore (v0.7.10 schema v3 — 10-phase, D+F arch).
// Run: node extension/test/lifecycle-store.test.js
// Exits 0 on success, 1 on failure.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
  try { fn(); assertions.push({ name, ok: true }); }
  catch (e) { assertions.push({ name, ok: false, err: e.message || String(e) }); }
}

// ─── plan() ────────────────────────────────────────────────────────────────

check('plan — creates state at PLAN phase, schema v3, with mode + expected_workers', () => {
  const store = new LifecycleStore(mkWorkspace());
  const state = store.plan('test mission', 'single', 1);
  assert.strictEqual(state.v, 3);
  assert.strictEqual(state.phase, 'PLAN');
  assert.strictEqual(state.plan, 'test mission');
  assert.strictEqual(state.worker_mode, 'single');
  assert.strictEqual(state.expected_workers, 1);
  assert.strictEqual(state.mission_n, 1);
  assert.deepStrictEqual(state.spawned_workers, []);
  assert.deepStrictEqual(state.monitors, []);
  assert(state.phases_completed.includes('PLAN'));
  assert(state.phases_completed.includes('SESSION-BOOT'), 'auto-boot includes SESSION-BOOT');
  assert(typeof state.session_started_at === 'string');
  assert(typeof state.mission_started_at === 'string');
  assert(store.hasPlan());
});

check('plan — throws on empty text', () => {
  const store = new LifecycleStore(mkWorkspace());
  assert.throws(() => store.plan('', 'single', 1), /lifecycle:plan-empty/);
});

check('plan — throws on whitespace-only text', () => {
  const store = new LifecycleStore(mkWorkspace());
  assert.throws(() => store.plan('   ', 'single', 1), /lifecycle:plan-empty/);
});

check('plan — throws on invalid worker_mode', () => {
  const store = new LifecycleStore(mkWorkspace());
  assert.throws(() => store.plan('m', 'invalid', 1), /lifecycle:invalid-worker-mode/);
});

check('plan — throws on zero expected_workers', () => {
  const store = new LifecycleStore(mkWorkspace());
  assert.throws(() => store.plan('m', 'single', 0), /lifecycle:invalid-expected-workers/);
});

check('plan — throws on non-integer expected_workers', () => {
  const store = new LifecycleStore(mkWorkspace());
  assert.throws(() => store.plan('m', 'single', 1.5), /lifecycle:invalid-expected-workers/);
});

check('plan — idempotent within active mission (same call returns same state)', () => {
  const store = new LifecycleStore(mkWorkspace());
  const s1 = store.plan('first', 'single', 1);
  const s2 = store.plan('second', 'fleet', 3);
  assert.strictEqual(s2.plan, 'first');
  assert.strictEqual(s2.worker_mode, 'single');
  assert.strictEqual(s2.expected_workers, 1);
});

check('plan — re-plan after REFLECT starts mission cycle N+1', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m1', 'single', 1);
  store.setPhase('SPAWN');
  // simulate full cycle to REFLECT
  store.setPhase('DEPLOY');
  store.setPhase('OBSERVE');
  store.setPhase('HARVEST');
  store.setPhase('CLEANUP');
  store.reflect('done');
  // Now re-plan
  const s = store.plan('m2', 'fleet', 3);
  assert.strictEqual(s.phase, 'PLAN');
  assert.strictEqual(s.plan, 'm2');
  assert.strictEqual(s.worker_mode, 'fleet');
  assert.strictEqual(s.expected_workers, 3);
  assert.strictEqual(s.mission_n, 2, 'mission_n incremented');
  assert.deepStrictEqual(s.spawned_workers, [], 'spawned reset for new mission');
  assert.deepStrictEqual(s.monitors, [], 'monitors reset for new mission');
  assert.strictEqual(s.reflect, undefined, 'reflect cleared');
});

// ─── setPhase / advance ────────────────────────────────────────────────────

check('setPhase — PLAN→SPAWN succeeds, phases_completed appended', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  const s = store.setPhase('SPAWN');
  assert.strictEqual(s.phase, 'SPAWN');
  assert(s.phases_completed.includes('SPAWN'));
});

check('setPhase — idempotent: SPAWN→SPAWN returns same state', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  store.setPhase('SPAWN');
  const s1 = store.snapshot();
  const s2 = store.setPhase('SPAWN');
  assert.strictEqual(s1, s2);
});

check('advance — alias for setPhase (backward-compat)', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  const s = store.advance('SPAWN');
  assert.strictEqual(s.phase, 'SPAWN');
});

// ─── registerSpawn ─────────────────────────────────────────────────────────

check('registerSpawn — adds worker with corrId, status=spawned', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  store.setPhase('SPAWN');
  const w = store.registerSpawn('5', 'corr-abc', 'simA');
  assert.strictEqual(w.id, '5');
  assert.strictEqual(w.correlation_id, 'corr-abc');
  assert.strictEqual(w.name, 'simA');
  assert.strictEqual(w.status, 'spawned');
  const s = store.snapshot();
  assert.strictEqual(s.spawned_workers.length, 1);
  assert.deepStrictEqual(s.workers, [{ id: '5', closed: false }]);
});

check('registerSpawn — throws if no correlation_id', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  assert.throws(() => store.registerSpawn('5', '', 'simA'), /correlation-id-required/);
});

check('registerSpawn — idempotent with same id+corrId', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  store.setPhase('SPAWN');
  const w1 = store.registerSpawn('5', 'corr-abc', 'simA');
  const w2 = store.registerSpawn('5', 'corr-abc', 'simA-renamed');
  assert.strictEqual(w1, w2);
  assert.strictEqual(store.snapshot().spawned_workers.length, 1);
});

check('registerSpawn — throws on corrId conflict for same terminal_id', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  store.setPhase('SPAWN');
  store.registerSpawn('5', 'corr-abc', 'simA');
  assert.throws(() => store.registerSpawn('5', 'corr-DIFFERENT', 'simA'), /correlation-id-conflict/);
});

// ─── registerMonitor ───────────────────────────────────────────────────────

check('registerMonitor — adds monitor record', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  store.setPhase('SPAWN');
  store.registerSpawn('5', 'corr-abc', 'simA');
  const m = store.registerMonitor('5', 'corr-abc', 'until grep -q ...; sleep 3');
  assert.strictEqual(m.terminal_id, '5');
  assert.strictEqual(m.correlation_id, 'corr-abc');
  assert(m.command.includes('until grep'));
  assert.strictEqual(store.snapshot().monitors.length, 1);
});

check('registerMonitor — re-register replaces existing record (idempotent on terminal)', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  store.setPhase('SPAWN');
  store.registerSpawn('5', 'corr-abc', 'simA');
  store.registerMonitor('5', 'corr-abc', 'cmd1');
  store.registerMonitor('5', 'corr-abc', 'cmd2');
  const ms = store.snapshot().monitors;
  assert.strictEqual(ms.length, 1);
  assert.strictEqual(ms[0].command, 'cmd2');
});

// ─── markWorkerStatus ──────────────────────────────────────────────────────

check('markWorkerStatus — completed sets status + completed_at', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  store.setPhase('SPAWN');
  store.registerSpawn('5', 'corr-abc', 'simA');
  const u = store.markWorkerStatus('5', 'completed');
  assert.strictEqual(u.status, 'completed');
  assert(typeof u.completed_at === 'string');
});

check('markWorkerStatus — closed flips workers.closed mirror', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  store.setPhase('SPAWN');
  store.registerSpawn('5', 'corr-abc', 'simA');
  store.markWorkerStatus('5', 'closed');
  assert.deepStrictEqual(store.snapshot().workers, [{ id: '5', closed: true }]);
});

check('markWorkerStatus — unknown terminal returns null', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  const r = store.markWorkerStatus('999', 'completed');
  assert.strictEqual(r, null);
});

// ─── reflect ───────────────────────────────────────────────────────────────

check('reflect — sets phase to REFLECT and persists text', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  // setPhase straight to REFLECT — store does no validation; engine validates.
  // (For test isolation, bypass the canonical CLEANUP→REFLECT path.)
  const s = store.reflect('great session');
  assert.strictEqual(s.phase, 'REFLECT');
  assert.strictEqual(s.reflect, 'great session');
  assert(s.phases_completed.includes('REFLECT'));
});

check('reflect — throws on empty text', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  assert.throws(() => store.reflect(''), /lifecycle:reflect-empty/);
});

// ─── snapshot / hasPlan ────────────────────────────────────────────────────

check('snapshot — returns null before any bootSession or plan', () => {
  const store = new LifecycleStore(mkWorkspace());
  assert.strictEqual(store.snapshot(), null);
  assert(!store.hasPlan());
});

check('snapshot — returns state after plan', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  const s = store.snapshot();
  assert(s !== null);
  assert.strictEqual(s.phase, 'PLAN');
});

check('hasPlan — false at SESSION-BOOT', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.bootSession();
  assert(!store.hasPlan());
});

check('hasPlan — true during active mission', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  store.setPhase('SPAWN');
  assert(store.hasPlan());
});

check('hasPlan — false at REFLECT', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  store.reflect('done');
  assert(!store.hasPlan());
});

// ─── persistence (loadFromDisk / flushToDisk) ──────────────────────────────

check('loadFromDisk — valid v3 file is adopted', () => {
  const ws = mkWorkspace();
  writeStateFile(ws, {
    v: 3,
    phase: 'SPAWN',
    phases_completed: ['SESSION-BOOT', 'PLAN', 'SPAWN'],
    plan: 'previous mission',
    worker_mode: 'single',
    expected_workers: 1,
    spawned_workers: [],
    monitors: [],
    workers: [],
    mission_n: 1,
    session_started_at: new Date().toISOString(),
    mission_started_at: new Date().toISOString(),
  });
  const store = new LifecycleStore(ws);
  assert(store.hasPlan());
  assert.strictEqual(store.snapshot().phase, 'SPAWN');
  assert.strictEqual(store.snapshot().worker_mode, 'single');
});

check('loadFromDisk — v1 file is ignored (schema bump, breaking)', () => {
  const ws = mkWorkspace();
  writeStateFile(ws, {
    v: 1, phase: 'PLAN', phases_completed: ['PLAN'],
    plan: 'old', workers: [], started_at: new Date().toISOString(),
  });
  const store = new LifecycleStore(ws);
  assert.strictEqual(store.snapshot(), null, 'v1 file rejected');
});

check('loadFromDisk — v2 file is ignored (intermediate, breaking)', () => {
  const ws = mkWorkspace();
  writeStateFile(ws, { v: 2, phase: 'PLAN', phases_completed: ['PLAN'], plan: 'm', workers: [] });
  const store = new LifecycleStore(ws);
  assert.strictEqual(store.snapshot(), null, 'v2 file rejected');
});

check('loadFromDisk — file with unknown phase ignored', () => {
  const ws = mkWorkspace();
  writeStateFile(ws, {
    v: 3, phase: 'BOGUS', phases_completed: [], plan: 'x',
    worker_mode: 'single', expected_workers: 1, spawned_workers: [], monitors: [], workers: [],
    mission_n: 1, session_started_at: 'x', mission_started_at: 'x',
  });
  const store = new LifecycleStore(ws);
  assert.strictEqual(store.snapshot(), null);
});

check('loadFromDisk — malformed JSON ignored', () => {
  const ws = mkWorkspace();
  const dir = path.join(ws, '.claws');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'lifecycle-state.json'), 'not json}}', 'utf8');
  const store = new LifecycleStore(ws);
  assert.strictEqual(store.snapshot(), null);
});

check('loadFromDisk — missing file ok', () => {
  const store = new LifecycleStore(mkWorkspace());
  assert.strictEqual(store.snapshot(), null);
});

check('flushToDisk — atomic .tmp+rename', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  store.plan('m', 'single', 1);
  const sf = stateFile(ws);
  assert(fs.existsSync(sf));
  assert(!fs.existsSync(sf + '.tmp'));
  const raw = JSON.parse(fs.readFileSync(sf, 'utf8'));
  assert.strictEqual(raw.v, 3);
  assert.strictEqual(raw.worker_mode, 'single');
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
