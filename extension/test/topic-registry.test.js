#!/usr/bin/env node
// Unit tests for topic-registry.ts — matchTopic correctness and schemaForTopic lookups.
// Run: node extension/test/topic-registry.test.js
// Exits 0 on success, 1 on failure.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const EXT_ROOT = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-topicReg-test-'));
const bundleOut = path.join(tmpDir, 'topic-registry.bundle.cjs');

// Bundle topic-registry.ts (and its deps: topic-utils.ts + event-schemas.ts + zod).
try {
  const esbuildBin = path.join(EXT_ROOT, 'node_modules', '.bin', 'esbuild');
  const src = path.join(EXT_ROOT, 'src', 'topic-registry.ts');
  execSync(
    `"${esbuildBin}" "${src}" --bundle --format=cjs --platform=node --outfile="${bundleOut}"`,
    { stdio: 'pipe' },
  );
} catch (err) {
  console.error('FAIL: esbuild bundle failed:', err.stderr?.toString());
  process.exit(1);
}

const reg = require(bundleOut);

// ─── helpers ─────────────────────────────────────────────────────────────────

const assertions = [];
function check(name, fn) {
  try {
    fn();
    assertions.push({ name, ok: true });
  } catch (e) {
    assertions.push({ name, ok: false, err: e.message || String(e) });
  }
}

// ─── schemaForTopic lookups ───────────────────────────────────────────────────

check("schemaForTopic('worker.p7.boot') → WorkerBootV1", () => {
  const sc = reg.schemaForTopic('worker.p7.boot');
  assert.notStrictEqual(sc, null, 'expected a schema');
  // Verify it is the WorkerBootV1 schema by parsing a valid boot payload.
  const r = sc.safeParse({
    model: 'claude-sonnet-4-6',
    role: 'worker',
    parent_peer_id: null,
    mission_summary: 'test',
    capabilities: [],
    cwd: '/tmp',
    terminal_id: 'term-1',
  });
  assert.strictEqual(r.success, true, `WorkerBootV1 parse failed: ${r.error?.message}`);
});

check("schemaForTopic('worker.p7.phase') → WorkerPhaseV1", () => {
  const sc = reg.schemaForTopic('worker.p7.phase');
  assert.notStrictEqual(sc, null);
  const r = sc.safeParse({ phase: 'DEPLOY', prev: 'SPAWN', transition_reason: 'ready', phases_completed: ['PLAN', 'SPAWN'] });
  assert.strictEqual(r.success, true);
});

check("schemaForTopic('worker.p7.heartbeat') → WorkerHeartbeatV1", () => {
  const sc = reg.schemaForTopic('worker.p7.heartbeat');
  assert.notStrictEqual(sc, null);
  const r = sc.safeParse({
    current_phase: 'DEPLOY',
    time_in_phase_ms: 0,
    tokens_used: 0,
    cost_usd: 0,
    last_event_id: null,
    active_sub_workers: [],
  });
  assert.strictEqual(r.success, true);
});

check("schemaForTopic('worker.p7.event') → WorkerEventV1", () => {
  const sc = reg.schemaForTopic('worker.p7.event');
  assert.notStrictEqual(sc, null);
  const r = sc.safeParse({ kind: 'PROGRESS', severity: 'info', message: 'step done' });
  assert.strictEqual(r.success, true);
});

check("schemaForTopic('worker.p7.complete') → WorkerCompleteV1", () => {
  const sc = reg.schemaForTopic('worker.p7.complete');
  assert.notStrictEqual(sc, null);
  const r = sc.safeParse({
    result: 'ok',
    summary: 'done',
    artifacts: [],
    phases_completed: ['PLAN'],
    total_tokens: 0,
    total_cost_usd: 0,
    duration_ms: 0,
  });
  assert.strictEqual(r.success, true);
});

check("schemaForTopic('cmd.p7.approve') → CmdApproveV1", () => {
  const sc = reg.schemaForTopic('cmd.p7.approve');
  assert.notStrictEqual(sc, null);
  const r = sc.safeParse({ correlation_id: '550e8400-e29b-41d4-a716-446655440000' });
  assert.strictEqual(r.success, true);
});

check("schemaForTopic('system.peer.joined') → SystemPeerJoinedV1", () => {
  const sc = reg.schemaForTopic('system.peer.joined');
  assert.notStrictEqual(sc, null);
  const r = sc.safeParse({ peerId: 'p_000001', role: 'worker', peerName: 'w1', ts: '2026-04-28T12:00:00.000Z' });
  assert.strictEqual(r.success, true);
});

check("schemaForTopic('unknown.topic') → null", () => {
  assert.strictEqual(reg.schemaForTopic('unknown.topic'), null);
});

check("schemaForTopic('worker.p7.unknown_suffix') → null", () => {
  assert.strictEqual(reg.schemaForTopic('worker.p7.unknown_suffix'), null);
});

check('TOPIC_REGISTRY has 38 entries', () => {
  assert.strictEqual(reg.TOPIC_REGISTRY.length, 38);
});

// ─── matchTopic correctness ───────────────────────────────────────────────────

check('matchTopic — exact match', () => {
  assert.strictEqual(reg.matchTopic('system.peer.joined', 'system.peer.joined'), true);
});

check('matchTopic — * matches one segment', () => {
  assert.strictEqual(reg.matchTopic('worker.p7.boot', 'worker.*.boot'), true);
  assert.strictEqual(reg.matchTopic('worker.p7.extra.boot', 'worker.*.boot'), false);
});

check('matchTopic — ** matches one or more segments', () => {
  assert.strictEqual(reg.matchTopic('worker.p7.boot', 'worker.**'), true);
  assert.strictEqual(reg.matchTopic('worker.p7.phase.extra', 'worker.**'), true);
  assert.strictEqual(reg.matchTopic('worker', 'worker.**'), false);
});

check('matchTopic — no match returns false', () => {
  assert.strictEqual(reg.matchTopic('cmd.p7.boot', 'worker.*.boot'), false);
});

// ─── results ─────────────────────────────────────────────────────────────────

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

for (const a of assertions) {
  console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
}

const failed = assertions.filter((a) => !a.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${assertions.length} topic-registry check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS: ${assertions.length} topic-registry checks`);
process.exit(0);
