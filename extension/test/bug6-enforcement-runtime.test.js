'use strict';
// Unit tests for Bug 6 Layer 1 runtime fix — unwrapMcpResponse helper.
//
// BUG6-RUNTIME-1 (v0714 sim pass 2): Claude Code passes MCP tool responses as
// { content: [{ type: 'text', text: '<JSON>' }] }. The hook checked resp.ok
// directly on the wrapper — undefined → early exit before spawning monitor-arm-watch.js.
// The fix adds unwrapMcpResponse() which parses the text content before any checks.
//
// These tests cover the 4 input shapes the helper must handle.

const assert = require('node:assert/strict');

// Mirror of the helper in scripts/hooks/post-tool-use-claws.js.
// If that function changes, update here to keep them in sync.
function unwrapMcpResponse(resp) {
  if (!resp || typeof resp !== 'object') return resp;
  if (resp.ok !== undefined) return resp;
  if (Array.isArray(resp.content) && resp.content[0] && typeof resp.content[0].text === 'string') {
    try { return JSON.parse(resp.content[0].text); } catch { return resp; }
  }
  return resp;
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
    failed++;
  }
}

console.log('bug6-enforcement-runtime.test.js');

// Shape 1: MCP-wrapped response — must parse inner JSON
test('unwraps MCP content wrapper and parses inner JSON', () => {
  const input = { content: [{ type: 'text', text: '{"ok":true,"terminal_id":"5"}' }] };
  const result = unwrapMcpResponse(input);
  assert.deepEqual(result, { ok: true, terminal_id: '5' });
});

// Shape 2: already plain — must return unchanged (no double-parse)
test('returns plain response unchanged', () => {
  const input = { ok: true, terminal_id: '5' };
  const result = unwrapMcpResponse(input);
  assert.deepEqual(result, { ok: true, terminal_id: '5' });
  assert.strictEqual(result, input, 'should return same object reference');
});

// Shape 3: malformed JSON in text — must return original wrapper without throwing
test('returns original when content text is not valid JSON', () => {
  const input = { content: [{ type: 'text', text: 'not json' }] };
  const result = unwrapMcpResponse(input);
  assert.strictEqual(result, input, 'should return original wrapper on parse failure');
});

// Shape 4: null input — must return null without throwing
test('returns null for null input', () => {
  const result = unwrapMcpResponse(null);
  assert.strictEqual(result, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
