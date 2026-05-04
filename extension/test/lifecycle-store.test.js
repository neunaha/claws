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

// ─── LH-9: TTL fields, markActivity, extendTtl, reconcile, findExpired ───────

const { DEFAULT_IDLE_MS, DEFAULT_MAX_MS } = require(jsOut);

check('LH-9 registerSpawn — seeds idle_ms / max_ms / last_activity_at defaults', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  const w = store.registerSpawn('t1', '00000000-0000-4000-8000-000000000001', 'w1');
  assert.strictEqual(w.idle_ms, DEFAULT_IDLE_MS);
  assert.strictEqual(w.max_ms, DEFAULT_MAX_MS);
  assert.strictEqual(w.last_activity_at, w.spawned_at);
});

check('LH-9 registerSpawn — opts override defaults', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  const w = store.registerSpawn('t1', '00000000-0000-4000-8000-000000000002', 'w1', { idle_ms: 60_000, max_ms: 3_600_000 });
  assert.strictEqual(w.idle_ms, 60_000);
  assert.strictEqual(w.max_ms, 3_600_000);
});

check('LH-9 markActivity — updates last_activity_at in memory', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  const w0 = store.registerSpawn('t1', '00000000-0000-4000-8000-000000000003', 'w1');
  // Force a deterministic future timestamp 10s past spawn so we observe a delta.
  const future = new Date(Date.parse(w0.spawned_at) + 10_000).toISOString();
  const got = store.markActivity('t1', future);
  assert.strictEqual(got, future);
  const after = store.snapshot().spawned_workers[0];
  assert.strictEqual(after.last_activity_at, future);
});

check('LH-9 markActivity — returns null for unknown terminal', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  assert.strictEqual(store.markActivity('does-not-exist'), null);
});

check('LH-9 markActivity — returns null for closed worker (race guard)', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  store.registerSpawn('t1', '00000000-0000-4000-8000-000000000004', 'w1');
  store.markWorkerStatus('t1', 'closed');
  assert.strictEqual(store.markActivity('t1'), null);
});

check('LH-9 extendTtl — pushes last_activity_at forward by addMs', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  store.registerSpawn('t1', '00000000-0000-4000-8000-000000000005', 'w1');
  const before = Date.now();
  const got = store.extendTtl('t1', 5 * 60_000);
  assert(got, 'extendTtl returned null on a live worker');
  const newMs = Date.parse(got);
  const expected = before + 5 * 60_000;
  // Tolerate up to 1s scheduling jitter.
  assert(Math.abs(newMs - expected) < 1000, `extendTtl drifted by ${Math.abs(newMs - expected)}ms`);
});

check('LH-9 extendTtl — returns null for closed worker (lost race)', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  store.registerSpawn('t1', '00000000-0000-4000-8000-000000000006', 'w1');
  store.markWorkerStatus('t1', 'closed');
  assert.strictEqual(store.extendTtl('t1', 60_000), null);
});

check('LH-9 extendTtl — rejects non-positive addMs', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  store.registerSpawn('t1', '00000000-0000-4000-8000-000000000007', 'w1');
  assert.strictEqual(store.extendTtl('t1', 0), null);
  assert.strictEqual(store.extendTtl('t1', -100), null);
  assert.strictEqual(store.extendTtl('t1', NaN), null);
});

check('LH-9 reconcileWithLiveTerminals — closes missing entries', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 3);
  store.registerSpawn('t1', '00000000-0000-4000-8000-000000000008', 'w1');
  store.registerSpawn('t2', '00000000-0000-4000-8000-000000000009', 'w2');
  store.registerSpawn('t3', '00000000-0000-4000-8000-00000000000a', 'w3');
  const reconciled = store.reconcileWithLiveTerminals(new Set(['t2']));
  assert.deepStrictEqual(reconciled.sort(), ['t1', 't3']);
  const snap = store.snapshot();
  assert.strictEqual(snap.spawned_workers.find(w => w.id === 't1').status, 'closed');
  assert.strictEqual(snap.spawned_workers.find(w => w.id === 't2').status, 'spawned');
  assert.strictEqual(snap.spawned_workers.find(w => w.id === 't3').status, 'closed');
  assert.strictEqual(snap.workers.find(w => w.id === 't1').closed, true);
  assert.strictEqual(snap.workers.find(w => w.id === 't2').closed, false);
});

check('LH-9 reconcileWithLiveTerminals — empty live set closes everyone', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 2);
  store.registerSpawn('t1', '00000000-0000-4000-8000-00000000000b', 'w1');
  store.registerSpawn('t2', '00000000-0000-4000-8000-00000000000c', 'w2');
  const reconciled = store.reconcileWithLiveTerminals(new Set());
  assert.deepStrictEqual(reconciled.sort(), ['t1', 't2']);
});

check('LH-9 reconcileWithLiveTerminals — already-closed worker untouched (idempotent)', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  store.registerSpawn('t1', '00000000-0000-4000-8000-00000000000d', 'w1');
  store.markWorkerStatus('t1', 'closed');
  const reconciled = store.reconcileWithLiveTerminals(new Set());
  assert.deepStrictEqual(reconciled, []);
});

check('LH-9 findExpiredWorkers — flags worker past idle window', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  // Use a tiny idle TTL so we can simulate expiry deterministically.
  store.registerSpawn('t1', '00000000-0000-4000-8000-00000000000e', 'w1', { idle_ms: 1000, max_ms: 60_000 });
  const spawnedMs = Date.parse(store.snapshot().spawned_workers[0].spawned_at);
  const expired = store.findExpiredWorkers(spawnedMs + 5000);
  assert.deepStrictEqual(expired, [{ id: 't1', reason: 'idle_timeout' }]);
});

check('LH-9 findExpiredWorkers — ttl_max wins when both expired', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  store.registerSpawn('t1', '00000000-0000-4000-8000-00000000000f', 'w1', { idle_ms: 1000, max_ms: 2000 });
  const spawnedMs = Date.parse(store.snapshot().spawned_workers[0].spawned_at);
  const expired = store.findExpiredWorkers(spawnedMs + 10_000);
  assert.deepStrictEqual(expired, [{ id: 't1', reason: 'ttl_max' }]);
});

check('LH-9 findExpiredWorkers — skips already-closed workers', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  store.registerSpawn('t1', '00000000-0000-4000-8000-000000000010', 'w1', { idle_ms: 1000 });
  store.markWorkerStatus('t1', 'closed');
  const expired = store.findExpiredWorkers(Date.now() + 60_000);
  assert.deepStrictEqual(expired, []);
});

check('LH-9 findExpiredWorkers — recent activity prevents idle timeout', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  store.registerSpawn('t1', '00000000-0000-4000-8000-000000000011', 'w1', { idle_ms: 5_000 });
  const spawnedMs = Date.parse(store.snapshot().spawned_workers[0].spawned_at);
  // Move now to t+10s, but mark activity at t+9s so it's only 1s idle.
  const recent = new Date(spawnedMs + 9000).toISOString();
  store.markActivity('t1', recent);
  const expired = store.findExpiredWorkers(spawnedMs + 10_000);
  assert.deepStrictEqual(expired, []);
});

check('LH-9 registerSpawn — overwrites a stale CLOSED slot (terminal id reuse after reload)', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  // Simulate an entry left behind from a prior session — same terminal id
  // (VS Code reload restarted the counter) but a different correlation id.
  store.registerSpawn('3', '00000000-0000-4000-8000-aaaaaaaaaaa1', 'old');
  store.markWorkerStatus('3', 'closed');
  // Fresh spawn with a NEW correlation id should succeed by overwriting.
  const fresh = store.registerSpawn('3', '00000000-0000-4000-8000-bbbbbbbbbbb2', 'new');
  assert.strictEqual(fresh.correlation_id, '00000000-0000-4000-8000-bbbbbbbbbbb2');
  assert.strictEqual(fresh.name, 'new');
  assert.strictEqual(fresh.status, 'spawned');
  const snap = store.snapshot();
  // Only one record for id '3' — the new one — no duplicates.
  const matches = snap.spawned_workers.filter(w => w.id === '3');
  assert.strictEqual(matches.length, 1);
  assert.strictEqual(matches[0].correlation_id, '00000000-0000-4000-8000-bbbbbbbbbbb2');
  // workers[] mirror also flipped back to closed:false.
  assert.strictEqual(snap.workers.find(w => w.id === '3').closed, false);
});

check('LH-9 registerSpawn — still throws conflict when prior is STILL spawned', () => {
  const store = new LifecycleStore(mkWorkspace());
  store.plan('m', 'single', 1);
  store.registerSpawn('3', '00000000-0000-4000-8000-cccccccccc01', 'old');
  // Worker still active — different corrId is a real conflict.
  assert.throws(
    () => store.registerSpawn('3', '00000000-0000-4000-8000-cccccccccc02', 'new'),
    /lifecycle:correlation-id-conflict/,
  );
});

check('LH-9 reconcile persists to disk (roundtrip)', () => {
  const ws = mkWorkspace();
  const store = new LifecycleStore(ws);
  store.plan('m', 'single', 1);
  store.registerSpawn('t1', '00000000-0000-4000-8000-000000000012', 'w1');
  store.reconcileWithLiveTerminals(new Set());
  const onDisk = JSON.parse(fs.readFileSync(stateFile(ws), 'utf8'));
  assert.strictEqual(onDisk.spawned_workers[0].status, 'closed');
  assert.strictEqual(onDisk.workers[0].closed, true);
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
