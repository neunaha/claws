#!/usr/bin/env node
// Unit tests for detectCompletion (Task #58) — multi-signal completion detection.
// Run: node extension/test/multisignal-completion.test.js
// Exits 0 on success, 1 on failure.

const assert = require('assert');
const { detectCompletion, findStandaloneMarker } = require('../../mcp_server.js');

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, err: err.message || String(err) });
  }
}

function makeState(overrides) {
  return {
    firstActivityAt: null,
    lastLen: 0,
    lastGrowthAt: Date.now(),
    startedAt: Date.now(),
    ...overrides,
  };
}

const BASE_OPT = {
  complete_marker: 'MISSION_COMPLETE',
  error_markers: ['MISSION_FAILED'],
  idle_timeout_ms: 5000,
  min_runtime_ms: 1000,
};

// ── 1. marker hit ─────────────────────────────────────────────────────────────
check('marker hit returns { status:completed, signal:marker }', () => {
  const text = 'doing work\nMISSION_COMPLETE\ndone';
  const state = makeState({ firstActivityAt: Date.now() - 2000, startedAt: Date.now() - 2000, lastGrowthAt: Date.now() - 500, lastLen: text.length });
  const now = Date.now();
  const result = detectCompletion(text, BASE_OPT, state, '42', now);
  assert.ok(result !== null, 'expected non-null result');
  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(result.signal, 'marker');
  assert.ok(typeof result.line === 'string', 'line should be a string');
});

// ── 2. error hit ──────────────────────────────────────────────────────────────
check('error hit returns { status:failed, signal:error }', () => {
  const text = 'doing work\nMISSION_FAILED\nstopped';
  const state = makeState({ firstActivityAt: Date.now() - 2000, startedAt: Date.now() - 2000, lastGrowthAt: Date.now() - 500, lastLen: text.length });
  const now = Date.now();
  const result = detectCompletion(text, BASE_OPT, state, '42', now);
  assert.ok(result !== null, 'expected non-null result');
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.signal, 'error');
});

// ── 3. pub_complete hit ───────────────────────────────────────────────────────
check('pub_complete hit returns { status:completed, signal:pub_complete }', () => {
  const termId = '77';
  const text = `doing work\n[CLAWS_PUB] topic=worker.${termId}.complete\ndone`;
  const state = makeState({ firstActivityAt: Date.now() - 2000, startedAt: Date.now() - 2000, lastGrowthAt: Date.now() - 500, lastLen: text.length });
  const now = Date.now();
  const result = detectCompletion(text, BASE_OPT, state, termId, now);
  assert.ok(result !== null, 'expected non-null result');
  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(result.signal, 'pub_complete');
});

// ── 4. idle fires when criteria met ──────────────────────────────────────────
check('idle fires when min_runtime elapsed and no growth for idle_timeout_ms', () => {
  const now = Date.now();
  const state = makeState({
    startedAt: now - 10000,       // 10s ago — past min_runtime_ms=1000
    firstActivityAt: now - 8000,  // had activity
    lastGrowthAt: now - 6000,     // last growth 6s ago — past idle_timeout_ms=5000
    lastLen: 100,
  });
  const opt = { ...BASE_OPT, idle_timeout_ms: 5000, min_runtime_ms: 1000 };
  const result = detectCompletion('some text that has not grown', opt, state, '1', now);
  assert.ok(result !== null, 'expected idle to fire');
  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(result.signal, 'idle');
  assert.strictEqual(result.line, null);
});

// ── 5. idle does NOT fire when min_runtime_ms not yet elapsed ─────────────────
check('idle does NOT fire when min_runtime_ms not yet elapsed', () => {
  const now = Date.now();
  const state = makeState({
    startedAt: now - 100,         // only 100ms ago — not past min_runtime_ms=1000
    firstActivityAt: now - 80,
    lastGrowthAt: now - 80,
    lastLen: 50,
  });
  const opt = { ...BASE_OPT, idle_timeout_ms: 50, min_runtime_ms: 1000 };
  const result = detectCompletion('text', opt, state, '1', now);
  assert.strictEqual(result, null, 'expected null — min_runtime not met');
});

// ── 6. idle does NOT fire when text never grew (firstActivityAt null) ──────────
check('idle does NOT fire when firstActivityAt is null', () => {
  const now = Date.now();
  const state = makeState({
    startedAt: now - 10000,
    firstActivityAt: null,        // never grew
    lastGrowthAt: now - 8000,
    lastLen: 0,
  });
  const opt = { ...BASE_OPT, idle_timeout_ms: 100, min_runtime_ms: 100 };
  const result = detectCompletion('', opt, state, '1', now);
  assert.strictEqual(result, null, 'expected null — firstActivityAt is null');
});

// ── 7. marker takes priority over pub_complete ────────────────────────────────
check('marker takes priority over pub_complete', () => {
  const termId = '5';
  const text = `MISSION_COMPLETE\n[CLAWS_PUB] topic=worker.${termId}.complete`;
  const state = makeState({ firstActivityAt: Date.now() - 2000, startedAt: Date.now() - 2000, lastGrowthAt: Date.now() - 500, lastLen: text.length });
  const result = detectCompletion(text, BASE_OPT, state, termId, Date.now());
  assert.ok(result !== null);
  assert.strictEqual(result.signal, 'marker');
});

// ── 8. error takes priority over idle ─────────────────────────────────────────
check('error takes priority over idle', () => {
  const now = Date.now();
  const state = makeState({
    startedAt: now - 10000,
    firstActivityAt: now - 8000,
    lastGrowthAt: now - 6000,
    lastLen: 20,
  });
  const opt = { ...BASE_OPT, idle_timeout_ms: 5000, min_runtime_ms: 1000 };
  const text = 'some output\nMISSION_FAILED\nmore output';
  const result = detectCompletion(text, opt, state, '1', now);
  assert.ok(result !== null);
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.signal, 'error');
});

// ── 9. returns null when nothing matches ──────────────────────────────────────
check('returns null when no signal fires', () => {
  const now = Date.now();
  const state = makeState({
    startedAt: now - 500,
    firstActivityAt: now - 400,
    lastGrowthAt: now - 100,
    lastLen: 10,
  });
  const result = detectCompletion('normal output', BASE_OPT, state, '1', now);
  assert.strictEqual(result, null);
});

// ── Results ───────────────────────────────────────────────────────────────────
let failed = 0;
for (const c of checks) {
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ' — ' + c.err}`);
  if (!c.ok) failed++;
}

if (failed > 0) {
  console.error(`\nFAIL: ${failed}/${checks.length} multisignal-completion check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS: ${checks.length} multisignal-completion checks`);
process.exit(0);
