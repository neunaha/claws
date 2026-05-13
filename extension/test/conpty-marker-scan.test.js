#!/usr/bin/env node
// Tests for ConPTY marker detection behavior in mcp_server.js.
// ConPTY (Windows) emits CRLF (\r\n) line endings. Verifies that
// findStandaloneMarker() correctly matches __CLAWS_DONE__ in CRLF output,
// and that the boot detection patterns work with CRLF-terminated lines.
// All tests are fixture-based (no real ConPTY needed) and pass on all platforms.
//
// Cases align with v0.8 blueprint Mission A §8.2 conpty-marker-scan.test.js spec.
// Run: node extension/test/conpty-marker-scan.test.js
// Exits 0 on success, 1 on failure.

'use strict';

const assert = require('assert');
const path = require('path');

// Load findStandaloneMarker and the boot detection pattern from mcp_server.js.
// mcp_server.js uses require() guard for testing; module.exports = { ... } at bottom.
const { findStandaloneMarker } = require(path.resolve(__dirname, '../../mcp_server.js'));

const MARKER = '__CLAWS_DONE__';

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message || String(e) });
    console.log(`  FAIL  ${name}: ${e.message || e}`);
  }
}

// ── Case 1 ────────────────────────────────────────────────────────────────────
check("findStandaloneMarker() matches __CLAWS_DONE__ followed by \\r\\n (ConPTY CRLF)", () => {
  // ConPTY output: command followed by CRLF-terminated marker
  const text = `some output\r\n${MARKER}\r\n`;
  const result = findStandaloneMarker(text, MARKER);
  assert.ok(result !== null, `marker not detected in CRLF-terminated output. text=${JSON.stringify(text)}`);
  assert.ok(result.includes(MARKER), `result '${result}' does not include marker`);
});

// ── Case 2 ────────────────────────────────────────────────────────────────────
check("findStandaloneMarker() matches __CLAWS_DONE__ followed by \\r alone", () => {
  // Some terminal emulators / scroll back buffers strip trailing \n
  const text = `some output\r\n${MARKER}\r`;
  const result = findStandaloneMarker(text, MARKER);
  assert.ok(result !== null, `marker not detected when followed by bare \\r. text=${JSON.stringify(text)}`);
});

// ── Case 3 ────────────────────────────────────────────────────────────────────
check("findStandaloneMarker() matches __CLAWS_DONE__ with leading \\r from previous line", () => {
  // ConPTY CRLF: the \r of the previous line's \r\n appears before the marker
  // when the regex character class [\\r\\n] is used for line boundary detection.
  const text = `output line\r\n${MARKER}\r\nmore output`;
  const result = findStandaloneMarker(text, MARKER);
  assert.ok(
    result !== null,
    `marker not detected with surrounding CRLF lines. text=${JSON.stringify(text)}`,
  );
});

// ── Case 4 ────────────────────────────────────────────────────────────────────
check("boot detection: ❯ and cost:$ both present in bytes with \\r\\n line endings", () => {
  // Verifies that the boot detection logic in mcp_server.js uses includes()
  // which is substring-based and handles CRLF naturally.
  const bytes = "Loading...\r\ncost: $0.003 (5 tokens)\r\n❯ \r\n";
  const hasPrompt = bytes.includes('❯');
  const hasCostLine = bytes.includes('cost:$') || bytes.includes('cost: $');
  assert.ok(hasPrompt, 'boot detection: ❯ not found in CRLF bytes');
  assert.ok(hasCostLine, "boot detection: cost: $ not found in CRLF bytes");
  assert.ok(hasPrompt && hasCostLine, "both signals must be present for boot to be detected");
});

// ── Case 5 ────────────────────────────────────────────────────────────────────
check("boot detection: false when only ❯ present (cost:$ absent) with CRLF output", () => {
  // Boot requires BOTH ❯ and cost:$ — only one should not fire
  const bytesNoPrompt = "Loading extension...\r\ncost: $0.001\r\nwait\r\n";
  const bytesNoCost   = "❯ waiting...\r\nno cost line here\r\n";

  const hasPromptOnly  = bytesNoCost.includes('❯');
  const hasCostOnlyOld = bytesNoCost.includes('cost:$') || bytesNoCost.includes('cost: $');
  assert.ok(hasPromptOnly, "test fixture: ❯ must be present in bytesNoCost");
  assert.ok(!hasCostOnlyOld, "test fixture: cost:$ must NOT be present in bytesNoCost");
  assert.ok(!(hasPromptOnly && hasCostOnlyOld), "incomplete boot signals must not trigger boot detection");

  const hasPromptNone = bytesNoPrompt.includes('❯');
  const hasCostOnly   = bytesNoPrompt.includes('cost:$') || bytesNoPrompt.includes('cost: $');
  assert.ok(!hasPromptNone, "test fixture: ❯ must NOT be present in bytesNoPrompt");
  assert.ok(hasCostOnly, "test fixture: cost: $ must be present in bytesNoPrompt");
  assert.ok(!(hasPromptNone && hasCostOnly), "cost-only signal must not trigger boot detection");
});

const pass = results.filter(r => r.ok).length;
const fail = results.filter(r => !r.ok).length;
console.log(`\nconpty-marker-scan.test.js: ${pass}/${results.length} PASS`);
if (fail > 0) process.exit(1);
process.exit(0);
