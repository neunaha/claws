#!/usr/bin/env node
// Unit tests for detectCompletion (Task #58 — idle-timeout removed).
// Event-driven signals only: marker > error > pub_complete.
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

const BASE_OPT = {
  complete_marker: 'MISSION_COMPLETE',
  error_markers: ['MISSION_FAILED'],
};

// ── 1. marker hit ─────────────────────────────────────────────────────────────
check('marker hit returns { status:completed, signal:marker }', () => {
  const text = 'doing work\nMISSION_COMPLETE\ndone';
  const result = detectCompletion(text, BASE_OPT, '42');
  assert.ok(result !== null, 'expected non-null result');
  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(result.signal, 'marker');
  assert.ok(typeof result.line === 'string', 'line should be a string');
});

// ── 2. error hit ──────────────────────────────────────────────────────────────
check('error hit returns { status:failed, signal:error }', () => {
  const text = 'doing work\nMISSION_FAILED\nstopped';
  const result = detectCompletion(text, BASE_OPT, '42');
  assert.ok(result !== null, 'expected non-null result');
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.signal, 'error');
});

// ── 3. pub_complete hit ───────────────────────────────────────────────────────
check('pub_complete hit returns { status:completed, signal:pub_complete }', () => {
  const termId = '77';
  const text = `doing work\n[CLAWS_PUB] topic=worker.${termId}.complete\ndone`;
  const result = detectCompletion(text, BASE_OPT, termId);
  assert.ok(result !== null, 'expected non-null result');
  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(result.signal, 'pub_complete');
});

// ── 4. marker takes priority over pub_complete ────────────────────────────────
check('marker takes priority over pub_complete', () => {
  const termId = '5';
  const text = `MISSION_COMPLETE\n[CLAWS_PUB] topic=worker.${termId}.complete`;
  const result = detectCompletion(text, BASE_OPT, termId);
  assert.ok(result !== null);
  assert.strictEqual(result.signal, 'marker');
});

// ── 5. error takes priority over pub_complete ─────────────────────────────────
check('error takes priority over pub_complete', () => {
  const termId = '5';
  const text = `MISSION_FAILED\n[CLAWS_PUB] topic=worker.${termId}.complete`;
  const result = detectCompletion(text, BASE_OPT, termId);
  assert.ok(result !== null);
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.signal, 'error');
});

// ── 6. returns null when nothing matches ──────────────────────────────────────
check('returns null when no signal fires', () => {
  const text = 'just normal output, no markers';
  const result = detectCompletion(text, BASE_OPT, '1');
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
