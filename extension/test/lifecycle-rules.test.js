#!/usr/bin/env node
// Unit tests for lifecycle-rules.ts (pure validators).
// Run: node extension/test/lifecycle-rules.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_ROOT = path.resolve(__dirname, '..');
const { execSync } = require('child_process');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-lr-test-'));
const tsSources = [
  path.join(EXT_ROOT, 'src', 'lifecycle-store.ts'),
  path.join(EXT_ROOT, 'src', 'lifecycle-rules.ts'),
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

const rules = require(path.join(tmpDir, 'lifecycle-rules.js'));
const { LifecycleStore } = require(path.join(tmpDir, 'lifecycle-store.js'));

const assertions = [];
function check(name, fn) {
  try { fn(); assertions.push({ name, ok: true }); }
  catch (e) { assertions.push({ name, ok: false, err: e.message || String(e) }); }
}

function mkStore() {
  return new LifecycleStore(fs.mkdtempSync(path.join(os.tmpdir(), 'claws-lr-ws-')));
}

// ─── canTransition ─────────────────────────────────────────────────────────

check('canTransition — SESSION-BOOT→PLAN allowed', () => {
  assert.strictEqual(rules.canTransition('SESSION-BOOT', 'PLAN'), true);
});

check('canTransition — PLAN→SPAWN allowed', () => {
  assert.strictEqual(rules.canTransition('PLAN', 'SPAWN'), true);
});

check('canTransition — SPAWN→DEPLOY allowed', () => {
  assert.strictEqual(rules.canTransition('SPAWN', 'DEPLOY'), true);
});

check('canTransition — REFLECT→PLAN allowed (next mission cycle)', () => {
  assert.strictEqual(rules.canTransition('REFLECT', 'PLAN'), true);
});

check('canTransition — REFLECT→SESSION-END allowed', () => {
  assert.strictEqual(rules.canTransition('REFLECT', 'SESSION-END'), true);
});

check('canTransition — SESSION-END is terminal', () => {
  assert.strictEqual(rules.canTransition('SESSION-END', 'PLAN'), false);
  assert.strictEqual(rules.canTransition('SESSION-END', 'SPAWN'), false);
});

check('canTransition — PLAN→REFLECT NOT allowed (must go through SPAWN/DEPLOY/...)', () => {
  assert.strictEqual(rules.canTransition('PLAN', 'REFLECT'), false);
});

check('canTransition — same-phase always allowed (idempotent)', () => {
  assert.strictEqual(rules.canTransition('SPAWN', 'SPAWN'), true);
});

check('canTransition — FAILED→CLEANUP allowed (recovery path)', () => {
  assert.strictEqual(rules.canTransition('FAILED', 'CLEANUP'), true);
});

// ─── canSpawn ──────────────────────────────────────────────────────────────

check('canSpawn — null state rejected', () => {
  const r = rules.canSpawn(null);
  assert.strictEqual(r.ok, false);
  assert(r.reason.includes('no lifecycle'));
});

check('canSpawn — phase=PLAN rejected (must be SPAWN)', () => {
  const s = mkStore();
  s.plan('m', 'single', 1);
  const r = rules.canSpawn(s.snapshot());
  assert.strictEqual(r.ok, false);
  assert(r.reason.includes('SPAWN'));
});

check('canSpawn — phase=SPAWN with capacity allowed', () => {
  const s = mkStore();
  s.plan('m', 'fleet', 3);
  s.setPhase('SPAWN');
  const r = rules.canSpawn(s.snapshot());
  assert.strictEqual(r.ok, true);
});

check('canSpawn — capacity exhausted rejected', () => {
  const s = mkStore();
  s.plan('m', 'single', 1);
  s.setPhase('SPAWN');
  s.registerSpawn('1', 'c1', 'w');
  const r = rules.canSpawn(s.snapshot());
  assert.strictEqual(r.ok, false);
  assert(r.reason.includes('expected_workers'));
});

// ─── canCleanup ────────────────────────────────────────────────────────────

check('canCleanup — incomplete worker blocks', () => {
  const s = mkStore();
  s.plan('m', 'single', 1);
  s.setPhase('SPAWN');
  s.registerSpawn('1', 'c1', 'w');
  // Status still 'spawned' — not terminal
  const r = rules.canCleanup(s.snapshot());
  assert.strictEqual(r.ok, false);
  assert(r.reason.includes('not at terminal status'));
});

check('canCleanup — all completed allows', () => {
  const s = mkStore();
  s.plan('m', 'single', 1);
  s.setPhase('SPAWN');
  s.registerSpawn('1', 'c1', 'w');
  s.markWorkerStatus('1', 'completed');
  assert.strictEqual(rules.canCleanup(s.snapshot()).ok, true);
});

check('canCleanup — failed status counts as terminal', () => {
  const s = mkStore();
  s.plan('m', 'single', 1);
  s.setPhase('SPAWN');
  s.registerSpawn('1', 'c1', 'w');
  s.markWorkerStatus('1', 'failed');
  assert.strictEqual(rules.canCleanup(s.snapshot()).ok, true);
});

// ─── canReflect ────────────────────────────────────────────────────────────

check('canReflect — open terminal blocks', () => {
  const s = mkStore();
  s.plan('m', 'single', 1);
  s.setPhase('SPAWN');
  s.registerSpawn('1', 'c1', 'w');
  s.markWorkerStatus('1', 'completed');
  // status=completed but not 'closed'
  const r = rules.canReflect(s.snapshot());
  assert.strictEqual(r.ok, false);
});

check('canReflect — all closed allows', () => {
  const s = mkStore();
  s.plan('m', 'single', 1);
  s.setPhase('SPAWN');
  s.registerSpawn('1', 'c1', 'w');
  s.markWorkerStatus('1', 'closed');
  assert.strictEqual(rules.canReflect(s.snapshot()).ok, true);
});

// ─── allWorkersHaveMonitors ────────────────────────────────────────────────

check('allWorkersHaveMonitors — true when every worker has a monitor', () => {
  const s = mkStore();
  s.plan('m', 'fleet', 2);
  s.setPhase('SPAWN');
  s.registerSpawn('1', 'c1', 'a'); s.registerMonitor('1', 'c1', 'cmd');
  s.registerSpawn('2', 'c2', 'b'); s.registerMonitor('2', 'c2', 'cmd');
  assert.strictEqual(rules.allWorkersHaveMonitors(s.snapshot()), true);
});

check('allWorkersHaveMonitors — false when one worker missing monitor', () => {
  const s = mkStore();
  s.plan('m', 'fleet', 2);
  s.setPhase('SPAWN');
  s.registerSpawn('1', 'c1', 'a'); s.registerMonitor('1', 'c1', 'cmd');
  s.registerSpawn('2', 'c2', 'b'); // no monitor
  assert.strictEqual(rules.allWorkersHaveMonitors(s.snapshot()), false);
  assert.deepStrictEqual(rules.workersWithoutMonitors(s.snapshot()), ['2']);
});

// ─── nextAutoPhase ─────────────────────────────────────────────────────────

check('nextAutoPhase — SPAWN→DEPLOY when all spawned + all monitored', () => {
  const s = mkStore();
  s.plan('m', 'fleet', 2);
  s.setPhase('SPAWN');
  s.registerSpawn('1', 'c1', 'a'); s.registerMonitor('1', 'c1', 'cmd');
  s.registerSpawn('2', 'c2', 'b'); s.registerMonitor('2', 'c2', 'cmd');
  assert.strictEqual(rules.nextAutoPhase(s.snapshot()), 'DEPLOY');
});

check('nextAutoPhase — SPAWN no advance if monitor missing', () => {
  const s = mkStore();
  s.plan('m', 'fleet', 2);
  s.setPhase('SPAWN');
  s.registerSpawn('1', 'c1', 'a'); s.registerMonitor('1', 'c1', 'cmd');
  s.registerSpawn('2', 'c2', 'b'); // no monitor
  assert.strictEqual(rules.nextAutoPhase(s.snapshot()), null);
});

check('nextAutoPhase — DEPLOY→OBSERVE when any worker progressed', () => {
  const s = mkStore();
  s.plan('m', 'single', 1);
  s.setPhase('SPAWN');
  s.registerSpawn('1', 'c1', 'a'); s.registerMonitor('1', 'c1', 'cmd');
  s.setPhase('DEPLOY');
  s.markWorkerStatus('1', 'completed');
  assert.strictEqual(rules.nextAutoPhase(s.snapshot()), 'OBSERVE');
});

check('nextAutoPhase — single mode OBSERVE→HARVEST after 1 terminal', () => {
  const s = mkStore();
  s.plan('m', 'single', 1);
  s.setPhase('SPAWN');
  s.registerSpawn('1', 'c1', 'a');
  s.setPhase('DEPLOY');
  s.setPhase('OBSERVE');
  s.markWorkerStatus('1', 'completed');
  assert.strictEqual(rules.nextAutoPhase(s.snapshot()), 'HARVEST');
});

check('nextAutoPhase — fleet mode OBSERVE→HARVEST only after all terminal', () => {
  const s = mkStore();
  s.plan('m', 'fleet', 2);
  s.setPhase('SPAWN');
  s.registerSpawn('1', 'c1', 'a');
  s.registerSpawn('2', 'c2', 'b');
  s.setPhase('DEPLOY');
  s.setPhase('OBSERVE');
  s.markWorkerStatus('1', 'completed');
  // Only 1/2 done — no auto-advance yet
  assert.strictEqual(rules.nextAutoPhase(s.snapshot()), null);
  s.markWorkerStatus('2', 'completed');
  assert.strictEqual(rules.nextAutoPhase(s.snapshot()), 'HARVEST');
});

check('nextAutoPhase — army mode OBSERVE never auto-HARVEST (claws_wave_complete drives)', () => {
  const s = mkStore();
  s.plan('m', 'army', 1);
  s.setPhase('SPAWN');
  s.registerSpawn('1', 'c1', 'a');
  s.setPhase('DEPLOY');
  s.setPhase('OBSERVE');
  s.markWorkerStatus('1', 'completed');
  assert.strictEqual(rules.nextAutoPhase(s.snapshot()), null);
});

// ─── results ───────────────────────────────────────────────────────────────

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
for (const a of assertions) console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
const failed = assertions.filter((a) => !a.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${assertions.length} lifecycle-rules check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS: ${assertions.length} lifecycle-rules checks`);
process.exit(0);
