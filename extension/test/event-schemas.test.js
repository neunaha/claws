#!/usr/bin/env node
// Unit tests for event-schemas.ts — every schema validates good payloads,
// rejects bad ones, and enum coverage is exhaustive.
// Run: node extension/test/event-schemas.test.js
// Exits 0 on success, 1 on failure.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const EXT_ROOT = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-schemas-test-'));
const bundleOut = path.join(tmpDir, 'event-schemas.bundle.cjs');

// Bundle event-schemas.ts with esbuild so zod resolves correctly.
try {
  const esbuildBin = path.join(EXT_ROOT, 'node_modules', '.bin', 'esbuild');
  const src = path.join(EXT_ROOT, 'src', 'event-schemas.ts');
  execSync(
    `"${esbuildBin}" "${src}" --bundle --format=cjs --platform=node --outfile="${bundleOut}"`,
    { stdio: 'pipe' },
  );
} catch (err) {
  console.error('FAIL: esbuild bundle failed:', err.stderr?.toString());
  process.exit(1);
}

const s = require(bundleOut);

// ─── helpers ──────────────────────────────────────────────────────────────────

const assertions = [];
function check(name, fn) {
  try {
    fn();
    assertions.push({ name, ok: true });
  } catch (e) {
    assertions.push({ name, ok: false, err: e.message || String(e) });
  }
}

function ok(schema, val) {
  const r = schema.safeParse(val);
  assert.strictEqual(r.success, true, `Expected success for ${JSON.stringify(val)}, got: ${r.error?.message}`);
}

function fail(schema, val) {
  const r = schema.safeParse(val);
  assert.strictEqual(r.success, false, `Expected failure for ${JSON.stringify(val)}`);
}

// ─── helpers for sample payloads ─────────────────────────────────────────────

const validUuid = '550e8400-e29b-41d4-a716-446655440000';
const validUuid2 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const validTs = '2026-04-28T12:00:00.000Z';

const goodEnvelope = {
  v: 1,
  id: validUuid,
  from_peer: 'p_000001',
  from_name: 'worker-alpha',
  ts_published: validTs,
  schema: 'worker-boot-v1',
  data: { hello: 'world' },
};

// ─── EnvelopeV1 ──────────────────────────────────────────────────────────────

check('EnvelopeV1 — valid minimal envelope parses', () => {
  ok(s.EnvelopeV1, goodEnvelope);
});

check('EnvelopeV1 — valid full envelope parses', () => {
  ok(s.EnvelopeV1, {
    ...goodEnvelope,
    correlation_id: validUuid2,
    parent_id: 'p_000000',
    terminal_id: 'term-1',
    ts_server: validTs,
  });
});

check('EnvelopeV1 — missing id → fails', () => {
  const { id: _id, ...noId } = goodEnvelope;
  fail(s.EnvelopeV1, noId);
});

check('EnvelopeV1 — v=2 (wrong literal) → fails', () => {
  fail(s.EnvelopeV1, { ...goodEnvelope, v: 2 });
});

check('EnvelopeV1 — ts_published not datetime → fails', () => {
  fail(s.EnvelopeV1, { ...goodEnvelope, ts_published: 'not-a-date' });
});

// ─── WorkerBootV1 ────────────────────────────────────────────────────────────

const goodBoot = {
  model: 'claude-sonnet-4-6',
  role: 'worker',
  parent_peer_id: 'p_000000',
  mission_summary: 'Implement phase beta schemas',
  capabilities: ['mcp_claws'],
  cwd: '/home/user/project',
  terminal_id: 'term-1',
};

check('WorkerBootV1 — valid sample parses', () => ok(s.WorkerBootV1, goodBoot));

check('WorkerBootV1 — missing mission_summary → fails', () => {
  const { mission_summary: _m, ...bad } = goodBoot;
  fail(s.WorkerBootV1, bad);
});

check('WorkerBootV1 — role not in enum → fails', () => {
  fail(s.WorkerBootV1, { ...goodBoot, role: 'admin' });
});

check('WorkerBootV1 — capabilities not array → fails', () => {
  fail(s.WorkerBootV1, { ...goodBoot, capabilities: 'mcp_claws' });
});

// ─── WorkerPhaseV1 ───────────────────────────────────────────────────────────

check('WorkerPhaseV1 — valid PLAN→SPAWN transition parses', () => {
  ok(s.WorkerPhaseV1, {
    phase: 'SPAWN',
    prev: 'PLAN',
    transition_reason: 'plan accepted',
    phases_completed: ['PLAN'],
  });
});

check('WorkerPhaseV1 — phase not in enum → fails', () => {
  fail(s.WorkerPhaseV1, {
    phase: 'UNKNOWN',
    prev: null,
    transition_reason: 'x',
    phases_completed: [],
  });
});

check('WorkerPhaseV1 — prev null accepted', () => {
  ok(s.WorkerPhaseV1, {
    phase: 'PLAN',
    prev: null,
    transition_reason: 'initial',
    phases_completed: [],
  });
});

// ─── WorkerEventV1 ───────────────────────────────────────────────────────────

const goodEvent = { kind: 'BLOCKED', severity: 'warn', message: 'waiting for approval' };

check('WorkerEventV1 — kind=BLOCKED parses', () => ok(s.WorkerEventV1, goodEvent));

check('WorkerEventV1 — kind=DECISION parses', () => {
  ok(s.WorkerEventV1, { ...goodEvent, kind: 'DECISION', severity: 'info' });
});

check('WorkerEventV1 — kind=UNKNOWN → fails', () => {
  fail(s.WorkerEventV1, { ...goodEvent, kind: 'UNKNOWN' });
});

check('WorkerEventV1 — severity=fatal accepted', () => {
  ok(s.WorkerEventV1, { ...goodEvent, severity: 'fatal' });
});

check('WorkerEventV1 — severity=critical → fails', () => {
  fail(s.WorkerEventV1, { ...goodEvent, severity: 'critical' });
});

// ─── WorkerHeartbeatV1 ───────────────────────────────────────────────────────

const goodHb = {
  current_phase: 'DEPLOY',
  time_in_phase_ms: 1234,
  tokens_used: 500,
  cost_usd: 0.002,
  last_event_id: null,
  active_sub_workers: [],
};

check('WorkerHeartbeatV1 — valid minimal parses', () => ok(s.WorkerHeartbeatV1, goodHb));

check('WorkerHeartbeatV1 — negative tokens_used → fails', () => {
  fail(s.WorkerHeartbeatV1, { ...goodHb, tokens_used: -1 });
});

check('WorkerHeartbeatV1 — last_event_id null accepted', () => {
  ok(s.WorkerHeartbeatV1, { ...goodHb, last_event_id: null });
});

// ─── WorkerCompleteV1 ────────────────────────────────────────────────────────

const goodComplete = {
  result: 'ok',
  summary: 'all done',
  artifacts: [],
  phases_completed: ['PLAN', 'SPAWN', 'DEPLOY'],
  total_tokens: 1000,
  total_cost_usd: 0.01,
  duration_ms: 60000,
};

check('WorkerCompleteV1 — result=ok parses', () => ok(s.WorkerCompleteV1, goodComplete));

check('WorkerCompleteV1 — result=unknown → fails', () => {
  fail(s.WorkerCompleteV1, { ...goodComplete, result: 'unknown' });
});

check('WorkerCompleteV1 — artifacts array validated', () => {
  ok(s.WorkerCompleteV1, {
    ...goodComplete,
    artifacts: [{ path: '/out/file.txt', type: 'text', size_bytes: 1024 }],
  });
  fail(s.WorkerCompleteV1, { ...goodComplete, artifacts: [{ type: 'text' }] });
});

// ─── CmdApproveV1 ────────────────────────────────────────────────────────────

check('CmdApproveV1 — valid correlation_id parses', () => {
  ok(s.CmdApproveV1, { correlation_id: validUuid });
});

check('CmdApproveV1 — non-uuid correlation_id → fails', () => {
  fail(s.CmdApproveV1, { correlation_id: 'not-a-uuid' });
});

// ─── CmdRejectV1 ─────────────────────────────────────────────────────────────

check('CmdRejectV1 — reason empty string → fails', () => {
  fail(s.CmdRejectV1, { correlation_id: validUuid, reason: '' });
});

// ─── CmdAbortV1 ──────────────────────────────────────────────────────────────

check('CmdAbortV1 — reason required → fails on empty', () => {
  fail(s.CmdAbortV1, {});
  ok(s.CmdAbortV1, { reason: 'mission cancelled by orchestrator' });
});

// ─── CmdSetPhaseV1 ───────────────────────────────────────────────────────────

check('CmdSetPhaseV1 — unknown phase → fails', () => {
  fail(s.CmdSetPhaseV1, { phase: 'DONE', reason: 'override' });
});

// ─── SystemMalformedReceivedV1 ───────────────────────────────────────────────

check('SystemMalformedReceivedV1 — from + topic + error parses', () => {
  ok(s.SystemMalformedReceivedV1, { from: 'p_000001', topic: 'worker.p_000001.boot', error: { msg: 'bad' } });
});

// ─── SystemPeerLeftV1 ────────────────────────────────────────────────────────

check('SystemPeerLeftV1 — reason=crash parses', () => {
  ok(s.SystemPeerLeftV1, { peerId: 'p_000001', role: 'worker', reason: 'crash' });
});

check('SystemPeerLeftV1 — reason=vanished → fails', () => {
  fail(s.SystemPeerLeftV1, { peerId: 'p_000001', role: 'worker', reason: 'vanished' });
});

// ─── SCHEMA_BY_NAME ──────────────────────────────────────────────────────────

check('SCHEMA_BY_NAME — all 37 schema names are present', () => {
  const expected = [
    'worker-boot-v1', 'worker-phase-v1', 'worker-event-v1',
    'worker-heartbeat-v1', 'worker-complete-v1',
    'cmd-approve-v1', 'cmd-reject-v1', 'cmd-abort-v1',
    'cmd-pause-v1', 'cmd-resume-v1', 'cmd-set-phase-v1',
    'cmd-spawn-v1', 'cmd-inject-text-v1',
    'system-peer-joined-v1', 'system-peer-left-v1', 'system-peer-stale-v1',
    'system-gate-fired-v1', 'system-budget-warning-v1', 'system-malformed-received-v1',
    'terminal-closed-v1',
    'vehicle-state-v1',
    'vehicle-content-v1',
    'command-start-v1',
    'command-end-v1',
    'wave-lead-boot-v1', 'wave-lead-complete-v1', 'wave-tester-red-complete-v1',
    'wave-review-finding-v1', 'wave-audit-finding-v1', 'wave-bench-metric-v1', 'wave-doc-complete-v1',
    'wave-harvested-v1',
    'cmd-deliver-v1', 'cmd-ack-v1',
    'pipeline-step-v1',
    'rpc-request-v1', 'rpc-response-v1',
  ];
  for (const name of expected) {
    assert.ok(s.SCHEMA_BY_NAME[name] !== undefined, `Missing schema: ${name}`);
  }
  assert.strictEqual(Object.keys(s.SCHEMA_BY_NAME).length, 37);
});

// ─── PhaseEnum ───────────────────────────────────────────────────────────────

check('PhaseEnum — all 9 phases accepted', () => {
  const phases = ['PLAN', 'SPAWN', 'DEPLOY', 'OBSERVE', 'RECOVER', 'HARVEST', 'CLEANUP', 'REFLECT', 'FAILED'];
  for (const p of phases) {
    ok(s.PhaseEnum, p);
  }
});

check('PhaseEnum — "DONE" rejected', () => {
  fail(s.PhaseEnum, 'DONE');
});

// ─── results ─────────────────────────────────────────────────────────────────

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

for (const a of assertions) {
  console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
}

const failed = assertions.filter((a) => !a.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${assertions.length} event-schemas check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS: ${assertions.length} event-schemas checks`);
process.exit(0);
