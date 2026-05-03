#!/usr/bin/env node
// Backward-compat + new-field tests for WorkerHeartbeatV1 and HeartbeatKindEnum.
// Run: node extension/test/heartbeat-schema-backcompat.test.js
// Exits 0 on success, 1 on failure.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const EXT_ROOT = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-hb-backcompat-'));
const bundleOut = path.join(tmpDir, 'event-schemas.bundle.cjs');

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

let passed = 0;
let failed = 0;

function ok(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${label}: ${e.message}`);
    failed++;
  }
}

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_ISO  = '2026-05-03T12:00:00.000Z';

console.log('WorkerHeartbeatV1 backward-compat tests');

// 1. Old payload (all original fields populated) still validates
ok('old payload with all original fields validates', () => {
  const r = s.WorkerHeartbeatV1.safeParse({
    current_phase:      'PLAN',
    time_in_phase_ms:   1000,
    tokens_used:        500,
    cost_usd:           0.10,
    last_event_id:      VALID_UUID,
    active_sub_workers: [],
  });
  assert.strictEqual(r.success, true, JSON.stringify(r.error?.issues));
});

// 2. Empty payload validates (all fields optional)
ok('empty payload validates (all fields optional)', () => {
  const r = s.WorkerHeartbeatV1.safeParse({});
  assert.strictEqual(r.success, true, JSON.stringify(r.error?.issues));
});

// 3. New payload with kind + summary + captured_at validates
ok('new payload with kind/summary/captured_at validates', () => {
  const r = s.WorkerHeartbeatV1.safeParse({
    kind:        'progress',
    summary:     'reading files',
    captured_at: VALID_ISO,
  });
  assert.strictEqual(r.success, true, JSON.stringify(r.error?.issues));
});

// 4. Mixed old+new fields validate
ok('mixed old+new fields validate', () => {
  const r = s.WorkerHeartbeatV1.safeParse({
    current_phase: 'OBSERVE',
    kind:          'progress',
    summary:       'checking test output',
  });
  assert.strictEqual(r.success, true, JSON.stringify(r.error?.issues));
});

// 5. Each HeartbeatKind value is accepted
const KINDS = ['progress', 'heartbeat', 'approach', 'error', 'mission_complete', 'mission_failed'];
for (const kind of KINDS) {
  ok(`kind='${kind}' accepted`, () => {
    const r = s.WorkerHeartbeatV1.safeParse({ kind });
    assert.strictEqual(r.success, true, JSON.stringify(r.error?.issues));
  });
}

// 6. Invalid kind is rejected
ok('invalid kind rejected', () => {
  const r = s.WorkerHeartbeatV1.safeParse({ kind: 'something_else' });
  assert.strictEqual(r.success, false);
});

// 7. Negative tokens_used rejected
ok('negative tokens_used rejected', () => {
  const r = s.WorkerHeartbeatV1.safeParse({ tokens_used: -1 });
  assert.strictEqual(r.success, false);
});

// 8. Negative tokens_in rejected
ok('negative tokens_in rejected', () => {
  const r = s.WorkerHeartbeatV1.safeParse({ tokens_in: -5 });
  assert.strictEqual(r.success, false);
});

// 9. Bad ISO date rejected for captured_at
ok('bad ISO rejected for captured_at', () => {
  const r = s.WorkerHeartbeatV1.safeParse({ captured_at: 'not-a-date' });
  assert.strictEqual(r.success, false);
});

// 10. approach_detail as array of strings validates
ok('approach_detail array validates', () => {
  const r = s.WorkerHeartbeatV1.safeParse({
    kind:           'approach',
    approach_detail: ['step 1: read files', 'step 2: run tests'],
  });
  assert.strictEqual(r.success, true, JSON.stringify(r.error?.issues));
});

// 11. error_detail string validates with error kind
ok('error_detail with kind=error validates', () => {
  const r = s.WorkerHeartbeatV1.safeParse({
    kind:         'error',
    error_detail: 'npm test exited with code 1',
    summary:      'test suite failed',
  });
  assert.strictEqual(r.success, true, JSON.stringify(r.error?.issues));
});

// 12. HeartbeatKindEnum exported and contains all 6 values
ok('HeartbeatKindEnum exported with all 6 values', () => {
  assert.ok(s.HeartbeatKindEnum, 'HeartbeatKindEnum must be exported');
  const opts = s.HeartbeatKindEnum.options;
  assert.deepStrictEqual(opts, KINDS);
});

// 13. mission_complete kind with full cost/duration fields validates
ok('mission_complete with cost+duration fields validates', () => {
  const r = s.WorkerHeartbeatV1.safeParse({
    kind:              'mission_complete',
    summary:           'all tasks done',
    total_cost_usd:    0.42,
    total_duration_ms: 120000,
    total_tool_calls:  35,
    correlation_id:    VALID_UUID,
  });
  assert.strictEqual(r.success, true, JSON.stringify(r.error?.issues));
});

// 14. null last_event_id still accepted (nullable optional)
ok('null last_event_id accepted', () => {
  const r = s.WorkerHeartbeatV1.safeParse({ last_event_id: null });
  assert.strictEqual(r.success, true, JSON.stringify(r.error?.issues));
});

// 15. Negative total_duration_ms rejected
ok('negative total_duration_ms rejected', () => {
  const r = s.WorkerHeartbeatV1.safeParse({ total_duration_ms: -100 });
  assert.strictEqual(r.success, false);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
