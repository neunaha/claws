'use strict';
// Fixture-driven unit tests for the forward-compat unwrapMcpResponse normalizer.
//
// BUG6-L1 (v0714): The PostToolUse hook silently exited before spawning monitor-arm-watch.js
// because unwrapMcpResponse returned the bare tool_response array unchanged, and the
// caller's `if (!resp.ok)` guard treated array.ok === undefined as falsy. Root cause
// documented in .local/plans/v0714/investigations/bug6-hook-nested-context.md.
//
// Shape 1 tests use REAL captured Claude Code stdin from /tmp/claws-hook-stdin-*.json
// (W15 forensic trace). All other shapes are synthesized.

const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// ── Mirror of helpers from scripts/hooks/post-tool-use-claws.js ──────────────
// Keep in sync with the source. If unwrapMcpResponse changes, update here.

// Use /tmp directly — os.tmpdir() returns /var/folders/... on macOS which is
// a different path from where the hook writes its files (always /tmp).
const TMP_DIR  = '/tmp';
const DIAG_LOG = path.join(TMP_DIR, 'claws-hook-diag.log');

function writeDiag(event, detail) {
  try {
    const line = `${new Date().toISOString()} hook-diag ${event} ${JSON.stringify(detail)}\n`;
    fs.appendFileSync(path.join(TMP_DIR, 'claws-hook-diag.log'), line);
  } catch {}
}

function unwrapMcpResponse(resp) {
  if (resp == null || typeof resp !== 'object') {
    writeDiag('unwrap-null-or-primitive', { type: typeof resp });
    return null;
  }

  // Shape 3 — plain object already unwrapped
  if (resp.ok !== undefined) return resp;

  // Shape 1 — bare array of content blocks (current Claude Code)
  if (Array.isArray(resp) && resp[0] && typeof resp[0].text === 'string') {
    try { return JSON.parse(resp[0].text); }
    catch (e) { writeDiag('unwrap-bare-array-parse-fail', { error: e.message, preview: resp[0].text.slice(0, 200) }); return null; }
  }

  // Shape 2 — wrapped object with content array (older Claude Code)
  if (Array.isArray(resp.content) && resp.content[0] && typeof resp.content[0].text === 'string') {
    try { return JSON.parse(resp.content[0].text); }
    catch (e) { writeDiag('unwrap-wrapped-parse-fail', { error: e.message, preview: resp.content[0].text.slice(0, 200) }); return null; }
  }

  // Unknown shape — emit diagnostic so future format changes are observable
  writeDiag('unwrap-unknown-shape', { keys: Object.keys(resp), isArray: Array.isArray(resp), preview: JSON.stringify(resp).slice(0, 300) });
  return null;
}

// ── Test harness ──────────────────────────────────────────────────────────────

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

function diagLogContains(substring) {
  try {
    const content = fs.readFileSync(DIAG_LOG, 'utf8');
    return content.includes(substring);
  } catch {
    return false;
  }
}

// ── Fixture loading ───────────────────────────────────────────────────────────

function loadFixtures() {
  const files  = fs.readdirSync(TMP_DIR).filter(f => /^claws-hook-stdin-\d+\.json$/.test(f));
  const valid  = [];
  for (const f of files) {
    try {
      const raw  = fs.readFileSync(path.join(TMP_DIR, f), 'utf8');
      const data = JSON.parse(raw);
      if (!data.tool_response) continue;
      // Only bare-array shaped payloads are useful as real-Claude-Code fixtures
      if (!Array.isArray(data.tool_response)) continue;
      valid.push({ file: f, data });
    } catch { /* skip unparseable */ }
  }
  // Sort by numeric pid descending so most recent are first
  valid.sort((a, b) => {
    const pidA = parseInt(a.file.replace(/\D/g, ''), 10) || 0;
    const pidB = parseInt(b.file.replace(/\D/g, ''), 10) || 0;
    return pidB - pidA;
  });
  return valid;
}

console.log('unwrap-mcp-response.test.js');
console.log('');

// ── Shape 1 — real captured Claude Code stdin (bare array) ───────────────────

const fixtures = loadFixtures();

if (fixtures.length === 0) {
  console.log('  SKIP  Shape 1 (real fixtures) — no /tmp/claws-hook-stdin-*.json files found');
  console.log('         (Run a claws_worker call to generate fixtures, then re-run this test.)');
} else {
  // Use the two most-recently captured fixtures (at least 1)
  const toTest = fixtures.slice(0, Math.min(2, fixtures.length));

  for (const { file, data } of toTest) {
    const toolResponse = data.tool_response;
    // Extract expected values from the inner JSON text for assertion
    let expected;
    try { expected = JSON.parse(toolResponse[0].text); } catch { expected = null; }

    test(`Shape 1 (real fixture ${file}) — bare array unwraps to inner object`, () => {
      const result = unwrapMcpResponse(toolResponse);
      assert.notStrictEqual(result, null, 'should not return null');
      assert.strictEqual(result.ok, true, 'inner object should have ok:true');
      if (expected) {
        assert.strictEqual(String(result.terminal_id), String(expected.terminal_id), 'terminal_id should match');
        assert.strictEqual(result.correlation_id, expected.correlation_id, 'correlation_id should match');
      }
    });
  }

  // Additional: verify the two W15 forensic fixtures specifically if present
  const w15Orch = fixtures.find(f => f.file === 'claws-hook-stdin-80621.json');
  if (w15Orch) {
    test('Shape 1 (W15 orchestrator pid=80621) — terminal_id=31, corrId=0a41a49c', () => {
      const result = unwrapMcpResponse(w15Orch.data.tool_response);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(String(result.terminal_id), '31');
      assert.strictEqual(result.correlation_id, '0a41a49c-6eb9-46f5-aaaf-64a307472b89');
    });
  }

  const w15Nested = fixtures.find(f => f.file === 'claws-hook-stdin-81977.json');
  if (w15Nested) {
    test('Shape 1 (W15 nested-TUI pid=81977) — terminal_id=32, corrId=7fe6d997', () => {
      const result = unwrapMcpResponse(w15Nested.data.tool_response);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(String(result.terminal_id), '32');
      assert.strictEqual(result.correlation_id, '7fe6d997-8461-47c4-ab5d-41da3b761f7a');
    });
  }
}

// ── Shape 2 — wrapped object with content array (older Claude Code) ───────────

test('Shape 2 (wrapped object) — unwraps content array and parses inner JSON', () => {
  const input  = { content: [{ type: 'text', text: '{"ok":true,"terminal_id":"7","correlation_id":"abc-123"}' }] };
  const result = unwrapMcpResponse(input);
  assert.deepEqual(result, { ok: true, terminal_id: '7', correlation_id: 'abc-123' });
});

test('Shape 2 (wrapped object, malformed JSON) — returns null and writes diag', () => {
  const diagBefore = (() => { try { return fs.readFileSync(DIAG_LOG, 'utf8').length; } catch { return 0; } })();
  const input  = { content: [{ type: 'text', text: 'NOT_VALID_JSON' }] };
  const result = unwrapMcpResponse(input);
  assert.strictEqual(result, null);
  // Diag log should have grown
  assert.ok(diagLogContains('unwrap-wrapped-parse-fail'), 'should write unwrap-wrapped-parse-fail diag');
});

// ── Shape 3 — plain object already unwrapped ─────────────────────────────────

test('Shape 3 (plain object) — returns input unchanged (same reference)', () => {
  const input  = { ok: true, terminal_id: '5', correlation_id: 'xyz' };
  const result = unwrapMcpResponse(input);
  assert.strictEqual(result, input, 'should return same object reference');
});

test('Shape 3 (plain object ok:false) — returns it (caller checks ok separately)', () => {
  const input  = { ok: false, error: 'something failed' };
  const result = unwrapMcpResponse(input);
  assert.strictEqual(result, input);
  assert.strictEqual(result.ok, false);
});

// ── Shape 4 — null / undefined / primitives → null ───────────────────────────

test('Shape 4 (null) — returns null and writes diag', () => {
  const result = unwrapMcpResponse(null);
  assert.strictEqual(result, null);
  assert.ok(diagLogContains('unwrap-null-or-primitive'), 'should write null-or-primitive diag');
});

test('Shape 4 (undefined) — returns null', () => {
  const result = unwrapMcpResponse(undefined);
  assert.strictEqual(result, null);
});

test('Shape 4 (string) — returns null', () => {
  const result = unwrapMcpResponse('{"ok":true}');
  assert.strictEqual(result, null);
});

test('Shape 4 (number) — returns null', () => {
  const result = unwrapMcpResponse(42);
  assert.strictEqual(result, null);
});

test('Shape 4 (boolean true) — returns null', () => {
  const result = unwrapMcpResponse(true);
  assert.strictEqual(result, null);
});

// ── Shape 5 — unknown object shapes → null + diag ────────────────────────────

test('Shape 5 (unknown plain object {foo:"bar"}) — returns null and writes unwrap-unknown-shape', () => {
  const diagBefore = (() => { try { return fs.readFileSync(DIAG_LOG, 'utf8').length; } catch { return 0; } })();
  const result = unwrapMcpResponse({ foo: 'bar' });
  assert.strictEqual(result, null);
  assert.ok(diagLogContains('unwrap-unknown-shape'), 'should write unwrap-unknown-shape diag');
});

test('Shape 5 (bare array with non-text blocks [{type:"image"}]) — returns null', () => {
  const result = unwrapMcpResponse([{ type: 'image', source: { url: 'x' } }]);
  assert.strictEqual(result, null);
});

test('Shape 5 (bare array with text but invalid JSON) — returns null and writes bare-array-parse-fail', () => {
  const result = unwrapMcpResponse([{ type: 'text', text: 'not-json-at-all' }]);
  assert.strictEqual(result, null);
  assert.ok(diagLogContains('unwrap-bare-array-parse-fail'), 'should write bare-array-parse-fail diag');
});

test('Shape 5 (empty object {}) — returns null', () => {
  const result = unwrapMcpResponse({});
  assert.strictEqual(result, null);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
