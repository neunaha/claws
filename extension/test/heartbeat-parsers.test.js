#!/usr/bin/env node
// Unit tests for HB-L1 heartbeat parser primitives in mcp_server.js.
// Pure function coverage: empty/malformed/realistic inputs for all 6 parsers.
//
// Run: node extension/test/heartbeat-parsers.test.js
// Exits 0 on success, 1 on any failure.

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

// ─── Extract the 6 parser functions from mcp_server.js without executing it ───
// We can't require() mcp_server.js directly (it starts an MCP server on load).
// Instead we pull the source, wrap the helpers in a sandbox module, and eval.
const SERVER_SRC = fs.readFileSync(path.resolve(__dirname, '../../mcp_server.js'), 'utf8');

// Extract only the HB-L1 block: from the section header to the next ─── header.
const HB_START = SERVER_SRC.indexOf('// ─── HB-L1: Heartbeat parser primitives');
const HB_END   = SERVER_SRC.indexOf('\n// ─── Multi-signal completion detector', HB_START);
assert.ok(HB_START !== -1, 'HB-L1 block not found in mcp_server.js');
assert.ok(HB_END   !== -1, 'HB-L1 block end-marker not found in mcp_server.js');

const parserBlock = SERVER_SRC.slice(HB_START, HB_END);

// Wrap in a module that exports the 6 functions
const moduleSource = `
'use strict';
${parserBlock}
module.exports = {
  parseToolIndicators,
  parseCostFooter,
  parseSpinnerActivity,
  parsePromptIdle,
  parseTodoWrite,
  parseErrorIndicators,
};
`;

const mod = { exports: {} };
const script = new vm.Script(moduleSource, { filename: 'heartbeat-parsers-extracted.js' });
script.runInNewContext({ module: mod, require, console });
const {
  parseToolIndicators,
  parseCostFooter,
  parseSpinnerActivity,
  parsePromptIdle,
  parseTodoWrite,
  parseErrorIndicators,
} = mod.exports;

// ─── Test harness ─────────────────────────────────────────────────────────────

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, err: err.message || String(err) });
  }
}

// ─── parseToolIndicators ──────────────────────────────────────────────────────

check('parseToolIndicators: empty string returns []', () => {
  const r = parseToolIndicators('', 0);
  assert.ok(Array.isArray(r) && r.length === 0, 'expected empty array');
});

check('parseToolIndicators: null/undefined returns []', () => {
  const r1 = parseToolIndicators(null, 0);
  const r2 = parseToolIndicators(undefined, 0);
  assert.ok(Array.isArray(r1) && r1.length === 0, 'null: expected empty array');
  assert.ok(Array.isArray(r2) && r2.length === 0, 'undefined: expected empty array');
});

check('parseToolIndicators: detects ⏺ Read(path)', () => {
  const text = '⏺ Read(/Users/foo/src/main.ts)';
  const results = parseToolIndicators(text, 0);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].tool, 'Read');
  assert.strictEqual(results[0].target, '/Users/foo/src/main.ts');
  assert.ok(results[0].summary.includes('reading'));
  assert.ok(results[0].summary.includes('main.ts'));
  assert.strictEqual(results[0].atOffset, 0);
});

check('parseToolIndicators: detects ⏺ Edit(path)', () => {
  const text = '⏺ Edit(extension/src/server.ts)';
  const results = parseToolIndicators(text, 0);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].tool, 'Edit');
  assert.ok(results[0].summary.includes('editing'));
  assert.ok(results[0].summary.includes('server.ts'));
});

check('parseToolIndicators: detects ⏺ Bash with truncation', () => {
  const cmd = 'npm test -- --reporter=spec --timeout=30000 --grep "worker lifecycle"';
  const text = `⏺ Bash(${cmd})`;
  const results = parseToolIndicators(text, 0);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].tool, 'Bash');
  assert.ok(results[0].summary.startsWith('running: '));
});

check('parseToolIndicators: detects multiple tools in sequence', () => {
  const text = [
    '⏺ Read(docs/protocol.md)',
    'some output here',
    '⏺ Edit(mcp_server.js)',
    '⏺ Write(extension/src/server.ts)',
  ].join('\n');
  const results = parseToolIndicators(text, 0);
  assert.strictEqual(results.length, 3);
  assert.strictEqual(results[0].tool, 'Read');
  assert.strictEqual(results[1].tool, 'Edit');
  assert.strictEqual(results[2].tool, 'Write');
});

check('parseToolIndicators: sinceOffset excludes earlier content', () => {
  const text = '⏺ Read(old.ts)\nPREFIX END\n⏺ Grep(pattern)';
  const offset = text.indexOf('PREFIX END') + 'PREFIX END\n'.length;
  const results = parseToolIndicators(text, offset);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].tool, 'Grep');
});

check('parseToolIndicators: TodoWrite returns planning summary', () => {
  const text = '⏺ TodoWrite()';
  const results = parseToolIndicators(text, 0);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].tool, 'TodoWrite');
  assert.ok(results[0].summary.includes('planning'));
});

check('parseToolIndicators: WebSearch returns searching web summary', () => {
  const text = '⏺ WebSearch(claude code heartbeat)';
  const results = parseToolIndicators(text, 0);
  assert.strictEqual(results.length, 1);
  assert.ok(results[0].summary.includes('searching web'));
});

// ─── parseCostFooter ──────────────────────────────────────────────────────────

check('parseCostFooter: null returns null', () => {
  assert.strictEqual(parseCostFooter(null), null);
  assert.strictEqual(parseCostFooter(''), null);
});

check('parseCostFooter: no footer returns null', () => {
  assert.strictEqual(parseCostFooter('just some text without footer'), null);
});

check('parseCostFooter: parses k-suffix tokens', () => {
  const text = '[█████░░░░░] 51%  in:2.6k  out:26.3k  cost:$2.45';
  const result = parseCostFooter(text);
  assert.ok(result !== null);
  assert.strictEqual(result.percent, 51);
  assert.strictEqual(result.tokens_in, 2600);
  assert.strictEqual(result.tokens_out, 26300);
  assert.strictEqual(result.cost_usd, 2.45);
});

check('parseCostFooter: parses plain numbers (no k suffix)', () => {
  const text = '[██░░░░░░░░] 20%  in:500  out:1200  cost:$0.05';
  const result = parseCostFooter(text);
  assert.ok(result !== null);
  assert.strictEqual(result.tokens_in, 500);
  assert.strictEqual(result.tokens_out, 1200);
  assert.strictEqual(result.cost_usd, 0.05);
});

check('parseCostFooter: returns LAST occurrence (most up-to-date)', () => {
  const text = [
    '[█░░░░░░░░░] 10%  in:0.5k  out:1.0k  cost:$0.10',
    'some output',
    '[████░░░░░░] 40%  in:1.5k  out:8.0k  cost:$0.88',
  ].join('\n');
  const result = parseCostFooter(text);
  assert.ok(result !== null);
  assert.strictEqual(result.percent, 40);
  assert.strictEqual(result.cost_usd, 0.88);
});

// ─── parseSpinnerActivity ─────────────────────────────────────────────────────

check('parseSpinnerActivity: empty returns {lastSpinnerAt: null, isActive: false}', () => {
  const r = parseSpinnerActivity('', 0);
  assert.strictEqual(r.lastSpinnerAt, null);
  assert.strictEqual(r.isActive, false);
});

check('parseSpinnerActivity: null/undefined is safe', () => {
  const r = parseSpinnerActivity(null, 0);
  assert.strictEqual(r.lastSpinnerAt, null);
  assert.strictEqual(r.isActive, false);
});

check('parseSpinnerActivity: detects ✻ spinner', () => {
  const text = '✻ Cooked for 13s';
  const r = parseSpinnerActivity(text, 0);
  assert.ok(r.lastSpinnerAt !== null);
});

check('parseSpinnerActivity: detects ✶ spinner', () => {
  const text = '✶ Working for 5s';
  const r = parseSpinnerActivity(text, 0);
  assert.ok(r.lastSpinnerAt !== null);
});

check('parseSpinnerActivity: no spinner text returns inactive', () => {
  const text = 'Just regular output with no spinner indicators here';
  const r = parseSpinnerActivity(text, 0);
  assert.strictEqual(r.lastSpinnerAt, null);
  assert.strictEqual(r.isActive, false);
});

check('parseSpinnerActivity: spinner at end of text is active', () => {
  const text = 'start output\n' + '✻ Thinking for 8s';
  const r = parseSpinnerActivity(text, 0);
  assert.ok(r.lastSpinnerAt !== null);
  assert.strictEqual(r.isActive, true);
});

// ─── parsePromptIdle ─────────────────────────────────────────────────────────

check('parsePromptIdle: empty returns false', () => {
  assert.strictEqual(parsePromptIdle(''), false);
  assert.strictEqual(parsePromptIdle(null), false);
});

check('parsePromptIdle: returns true when ❯ is last visible line', () => {
  const text = 'Some worker output\n❯';
  assert.strictEqual(parsePromptIdle(text), true);
});

check('parsePromptIdle: returns true with trailing whitespace after ❯', () => {
  const text = 'Some output\n❯   \n';
  assert.strictEqual(parsePromptIdle(text), true);
});

check('parsePromptIdle: returns false when more content follows ❯', () => {
  const text = '❯ \nmore output after prompt';
  assert.strictEqual(parsePromptIdle(text), false);
});

check('parsePromptIdle: returns false when ❯ is in the middle', () => {
  const text = 'line one\n❯ \nline three still writing';
  assert.strictEqual(parsePromptIdle(text), false);
});

// ─── parseTodoWrite ───────────────────────────────────────────────────────────

check('parseTodoWrite: empty returns null', () => {
  assert.strictEqual(parseTodoWrite('', 0), null);
  assert.strictEqual(parseTodoWrite(null, 0), null);
});

check('parseTodoWrite: no TodoWrite indicator returns null', () => {
  assert.strictEqual(parseTodoWrite('just some text', 0), null);
});

check('parseTodoWrite: extracts ☐ list items', () => {
  const text = [
    '⏺ TodoWrite()',
    '☐ Run tests',
    '☐ Fix lint errors',
    '☐ Commit changes',
  ].join('\n');
  const result = parseTodoWrite(text, 0);
  assert.ok(result !== null);
  assert.strictEqual(result.todoItems.length, 3);
  assert.strictEqual(result.todoItems[0], 'Run tests');
  assert.strictEqual(result.todoItems[1], 'Fix lint errors');
  assert.strictEqual(result.todoItems[2], 'Commit changes');
});

check('parseTodoWrite: extracts - bullet items', () => {
  const text = [
    '⏺ TodoWrite()',
    '- Step 1: analyze',
    '- Step 2: implement',
  ].join('\n');
  const result = parseTodoWrite(text, 0);
  assert.ok(result !== null);
  assert.strictEqual(result.todoItems.length, 2);
  assert.ok(result.todoItems[0].includes('analyze'));
});

check('parseTodoWrite: stops at next ⏺ indicator', () => {
  const text = [
    '⏺ TodoWrite()',
    '☐ Task A',
    '⏺ Read(file.ts)',
    '☐ should not be included',
  ].join('\n');
  const result = parseTodoWrite(text, 0);
  assert.ok(result !== null);
  assert.strictEqual(result.todoItems.length, 1);
  assert.strictEqual(result.todoItems[0], 'Task A');
});

check('parseTodoWrite: respects sinceOffset', () => {
  const prefix = 'earlier content without todo\n';
  const text = prefix + '⏺ TodoWrite()\n☐ New task';
  const result = parseTodoWrite(text, prefix.length);
  assert.ok(result !== null);
  assert.strictEqual(result.todoItems.length, 1);
  assert.strictEqual(result.atOffset, prefix.length);
});

// ─── parseErrorIndicators ────────────────────────────────────────────────────

check('parseErrorIndicators: empty returns []', () => {
  const r1 = parseErrorIndicators('', 0);
  const r2 = parseErrorIndicators(null, 0);
  assert.ok(Array.isArray(r1) && r1.length === 0, 'empty string: expected empty array');
  assert.ok(Array.isArray(r2) && r2.length === 0, 'null: expected empty array');
});

check('parseErrorIndicators: detects ⎿ Error: pattern', () => {
  const text = '⎿ Error: ENOENT: no such file or directory, open \'/tmp/test.txt\'';
  const results = parseErrorIndicators(text, 0);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].kind, 'error');
  assert.ok(results[0].detail.includes('ENOENT'));
  assert.strictEqual(results[0].atOffset, 0);
});

check('parseErrorIndicators: detects ⎿ exit code N (non-zero)', () => {
  const text = '⎿ Command failed with exit code 1';
  const results = parseErrorIndicators(text, 0);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].kind, 'exit_nonzero');
  assert.ok(results[0].detail.includes('1'));
});

check('parseErrorIndicators: does NOT fire on exit code 0', () => {
  const text = '⎿ Command completed with exit code 0';
  const results = parseErrorIndicators(text, 0);
  assert.strictEqual(results.length, 0);
});

check('parseErrorIndicators: does NOT fire on generic Error: in prose (conservative)', () => {
  // Without the ⎿ prefix, a bare "Error:" mention should NOT fire
  const text = 'The Error: message was logged to the console';
  const results = parseErrorIndicators(text, 0);
  assert.strictEqual(results.length, 0, 'Should not fire on prose "Error:" without ⎿ prefix');
});

check('parseErrorIndicators: multiple errors returned in order', () => {
  const text = [
    '⎿ Error: first error happened',
    'some output',
    '⎿ Error: second error occurred',
  ].join('\n');
  const results = parseErrorIndicators(text, 0);
  assert.strictEqual(results.length, 2);
  assert.ok(results[0].atOffset < results[1].atOffset);
  assert.ok(results[0].detail.includes('first'));
  assert.ok(results[1].detail.includes('second'));
});

check('parseErrorIndicators: respects sinceOffset', () => {
  const prefix = '⎿ Error: old error before offset\n';
  const text = prefix + '⎿ Error: new error after offset';
  const results = parseErrorIndicators(text, prefix.length);
  assert.strictEqual(results.length, 1);
  assert.ok(results[0].detail.includes('new error'));
});

// ─── Report ───────────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
for (const c of checks) {
  if (c.ok) {
    console.log(`  PASS  ${c.name}`);
    pass++;
  } else {
    console.log(`  FAIL  ${c.name}: ${c.err}`);
    fail++;
  }
}
console.log(`\n${pass + fail} checks: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
