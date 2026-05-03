#!/usr/bin/env node
// Unit tests for HB-L3 WorkerHeartbeatStateMachine class in mcp_server.js.
// Covers state transitions, edge cases, and time-deterministic behavior via
// observe(text, now=injected).
//
// Run: node extension/test/heartbeat-state-machine.test.js
// Exits 0 on success, 1 on any failure.

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

// ─── Extract L1 parsers + L3 class from mcp_server.js without executing it ───
// We can't require() mcp_server.js directly (it starts an MCP server on load).
// Extract the block from HB-L1 through HB-L3, then sandbox-eval it.
const SERVER_SRC = fs.readFileSync(path.resolve(__dirname, '../../mcp_server.js'), 'utf8');

const BLOCK_START = SERVER_SRC.indexOf('// ─── HB-L1: Heartbeat parser primitives');
const BLOCK_END   = SERVER_SRC.indexOf('\n// ─── Multi-signal completion detector', BLOCK_START);
assert.ok(BLOCK_START !== -1, 'HB-L1 block not found in mcp_server.js');
assert.ok(BLOCK_END   !== -1, 'HB-L3 block end-marker not found in mcp_server.js');

const combinedBlock = SERVER_SRC.slice(BLOCK_START, BLOCK_END);
assert.ok(combinedBlock.includes('WorkerHeartbeatStateMachine'), 'WorkerHeartbeatStateMachine not found in extracted block');

const moduleSource = `'use strict';\n${combinedBlock}\nmodule.exports = { WorkerHeartbeatStateMachine };`;

const mod = { exports: {} };
const script = new vm.Script(moduleSource, { filename: 'heartbeat-state-machine-extracted.js' });
script.runInNewContext({ module: mod, require, console });
const { WorkerHeartbeatStateMachine } = mod.exports;

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

// ─── Test 1: Constructor initializes correctly ───────────────────────────────

check('constructor: sets state=BOOTING, scanOffset=0, toolCount=0', () => {
  const m = new WorkerHeartbeatStateMachine({ terminalId: 1, correlationId: 'test-corr' });
  assert.strictEqual(m.state, 'BOOTING');
  assert.strictEqual(m.scanOffset, 0);
  assert.strictEqual(m.toolCount, 0);
  assert.strictEqual(m.lastSpinnerAt, null);
  assert.strictEqual(m.lastToolAt, null);
  assert.strictEqual(m.lastNewBytesAt, null);
  assert.strictEqual(m.firstActivityAt, null);
  assert.strictEqual(m.postWorkEnteredAt, null);
  assert.strictEqual(m.cumulative.tokens_in, 0);
  assert.strictEqual(m.cumulative.tokens_out, 0);
  assert.strictEqual(m.todoItems, null);
  assert.strictEqual(m.lastErrors.length, 0);
  assert.strictEqual(m.transitions.length, 0);
  assert.strictEqual(m.terminalId, 1);
  assert.strictEqual(m.correlationId, 'test-corr');
});

// ─── Test 2: observe() with empty/null text ───────────────────────────────────

check('observe: empty string returns [] and state unchanged', () => {
  const m = new WorkerHeartbeatStateMachine({ terminalId: 2, correlationId: 'x' });
  const t1 = m.observe('', 0);
  assert.ok(Array.isArray(t1) && t1.length === 0, 'expected empty transitions array');
  assert.strictEqual(m.state, 'BOOTING');
  assert.strictEqual(m.scanOffset, 0);
});

check('observe: null returns [] safely', () => {
  const m = new WorkerHeartbeatStateMachine({ terminalId: 2, correlationId: 'x' });
  const t = m.observe(null, 0);
  assert.ok(Array.isArray(t) && t.length === 0, 'expected empty transitions array');
  assert.strictEqual(m.state, 'BOOTING');
});

// ─── Test 3: BOOTING → READY ──────────────────────────────────────────────────

check('observe: BOOTING→READY on bypass permissions + prompt idle', () => {
  const m = new WorkerHeartbeatStateMachine({ terminalId: 3, correlationId: 'x' });
  const text = 'Trust this folder?\nYou can bypass permissions on this session.\n❯';
  const transitions = m.observe(text, 100);
  assert.strictEqual(transitions.length, 1);
  assert.strictEqual(transitions[0].from, 'BOOTING');
  assert.strictEqual(transitions[0].to, 'READY');
  assert.strictEqual(transitions[0].reason, 'bypass-permissions-detected');
  assert.strictEqual(transitions[0].at, 100);
  assert.strictEqual(m.state, 'READY');
  assert.strictEqual(m.scanOffset, text.length);
});

check('observe: BOOTING stays BOOTING when no bypass permissions', () => {
  const m = new WorkerHeartbeatStateMachine({ terminalId: 3, correlationId: 'x' });
  const t = m.observe('Claude Code initializing...\n❯', 0);
  assert.ok(Array.isArray(t) && t.length === 0, 'expected no transitions');
  assert.strictEqual(m.state, 'BOOTING');
});

check('observe: BOOTING→READY fires on bypass permissions without prompt idle', () => {
  const m = new WorkerHeartbeatStateMachine({ terminalId: 3, correlationId: 'x' });
  // bypass permissions text present but last line is NOT ❯ — should still transition
  const t = m.observe('bypass permissions on this session.\nLoading tools...', 0);
  assert.strictEqual(t.length, 1, 'expected BOOTING→READY transition');
  assert.strictEqual(t[0].from, 'BOOTING');
  assert.strictEqual(t[0].to, 'READY');
  assert.strictEqual(m.state, 'READY');
});

// ─── Test 4: READY → WORKING ─────────────────────────────────────────────────

check('observe: READY→WORKING on first tool call, toolCount=1', () => {
  const m = new WorkerHeartbeatStateMachine({ terminalId: 4, correlationId: 'x' });
  const readyText = 'bypass permissions on\n❯';
  m.observe(readyText, 0);   // → BOOTING→READY
  assert.strictEqual(m.state, 'READY');

  const workText = readyText + '\n⏺ Bash(npm test)\n';
  const transitions = m.observe(workText, 10);
  assert.strictEqual(transitions.length, 1);
  assert.strictEqual(transitions[0].from, 'READY');
  assert.strictEqual(transitions[0].to, 'WORKING');
  assert.strictEqual(m.state, 'WORKING');
  assert.strictEqual(m.toolCount, 1);
  assert.strictEqual(m.lastToolAt, 10);
  assert.strictEqual(m.firstActivityAt, 10);
});

// ─── Test 4b: cascade fix — boot+tool in same tick, next tick (no new tools) still transitions ───

check('observe: READY→WORKING fires on next tick via cumulative toolCount (cascade fix)', () => {
  const sm = new WorkerHeartbeatStateMachine({ terminalId: 99, correlationId: 'test-cascade' });

  // Tick 1: boot text + first tool indicator both present in same observe() call
  const tick1Text = 'Welcome to Claude\n⏵⏵ bypass permissions on\n⏺ Bash(git status)\n';
  sm.observe(tick1Text, 1000);
  // BOOTING→READY fires (else-if means READY→WORKING was gated this tick)
  assert.strictEqual(sm.state, 'READY', 'expected READY after boot text + tool in same tick');
  assert.strictEqual(sm.toolCount, 1, 'tool was counted even though READY→WORKING was skipped');

  // Tick 2: only sleep output — no new tool indicators (tools.length===0 this tick)
  const tick2Text = tick1Text + 'sleep started\n';
  sm.observe(tick2Text, 31000);
  // With the cascade fix (this.toolCount > 0), READY→WORKING fires here
  assert.strictEqual(sm.state, 'WORKING', 'expected WORKING: cumulative toolCount>0 catches the skipped transition');
});

// ─── Test 5: spinner active keeps state WORKING ───────────────────────────────

check('observe: spinner active → stays WORKING, updates lastSpinnerAt', () => {
  const m = new WorkerHeartbeatStateMachine({ terminalId: 5, correlationId: 'x' });
  const readyText = 'bypass permissions on\n❯';
  m.observe(readyText, 0);
  const toolText = readyText + '\n⏺ Bash(npm test)\n';
  m.observe(toolText, 100);  // → READY→WORKING, lastNewBytesAt=100
  assert.strictEqual(m.state, 'WORKING');

  // Spinner active: no transition, but lastSpinnerAt updated
  const spinnerText = toolText + '✻ Cooked for 3s';
  const transitions = m.observe(spinnerText, 200);
  assert.ok(Array.isArray(transitions) && transitions.length === 0, 'expected no transitions');
  assert.strictEqual(m.state, 'WORKING');
  assert.strictEqual(m.lastSpinnerAt, 200);
  // lastNewBytesAt updated since text grew
  assert.strictEqual(m.lastNewBytesAt, 200);
});

// ─── Test 6: WORKING → POST_WORK after 5s idle ───────────────────────────────

check('observe: WORKING→POST_WORK when spinner stopped + prompt idle + bytes idle 5s', () => {
  const m = new WorkerHeartbeatStateMachine({ terminalId: 6, correlationId: 'x' });
  const readyText = 'bypass permissions on\n❯';
  m.observe(readyText, 0);

  // Enter WORKING with tool call, lastNewBytesAt=100
  const workText = readyText + '\n⏺ Read(docs.md)\n❯';
  m.observe(workText, 100);
  assert.strictEqual(m.state, 'WORKING');
  assert.strictEqual(m.lastNewBytesAt, 100);

  // 5100ms later: same text (no new bytes), no spinner, prompt idle
  const transitions = m.observe(workText, 5201);
  // lastSpinnerAt=null → spinnerStopped=true
  // 5201 - 100 = 5101 > 5000 → bytesIdle=true
  // parsePromptIdle(workText) → last non-empty line is '❯' → true
  assert.strictEqual(transitions.length, 1);
  assert.strictEqual(transitions[0].from, 'WORKING');
  assert.strictEqual(transitions[0].to, 'POST_WORK');
  assert.strictEqual(m.state, 'POST_WORK');
  assert.strictEqual(m.postWorkEnteredAt, 5201);
});

check('observe: WORKING stays WORKING when bytes not yet idle (< 5s)', () => {
  const m = new WorkerHeartbeatStateMachine({ terminalId: 6, correlationId: 'x' });
  m.observe('bypass permissions on\n❯', 0);
  const workText = 'bypass permissions on\n❯\n⏺ Bash(ls)\n❯';
  m.observe(workText, 100);   // READY→WORKING, lastNewBytesAt=100
  // Only 2s elapsed since lastNewBytesAt — bytesIdle=false
  const t = m.observe(workText, 2100);
  assert.ok(Array.isArray(t) && t.length === 0, 'expected no transitions');
  assert.strictEqual(m.state, 'WORKING');
});

// ─── Test 7: POST_WORK → WORKING on Claude resumption ────────────────────────

check('observe: POST_WORK→WORKING when new tool call (resets postWorkEnteredAt)', () => {
  const m = new WorkerHeartbeatStateMachine({ terminalId: 7, correlationId: 'x' });
  const base = 'bypass permissions on\n❯';
  m.observe(base, 0);

  const workText = base + '\n⏺ Read(test.md)\n❯';
  m.observe(workText, 100);   // READY→WORKING
  m.observe(workText, 5201);  // WORKING→POST_WORK
  assert.strictEqual(m.state, 'POST_WORK');
  assert.strictEqual(m.postWorkEnteredAt, 5201);
  assert.strictEqual(m.toolCount, 1);

  // Claude resumes with a new tool call
  const resumedText = workText + '\n⏺ Edit(file.ts)\n';
  const transitions = m.observe(resumedText, 5300);
  assert.strictEqual(transitions.length, 1);
  assert.strictEqual(transitions[0].from, 'POST_WORK');
  assert.strictEqual(transitions[0].to, 'WORKING');
  assert.strictEqual(transitions[0].reason, 'tool-call-resumed');
  assert.strictEqual(m.state, 'WORKING');
  assert.strictEqual(m.postWorkEnteredAt, null);  // timer reset
  assert.strictEqual(m.toolCount, 2);             // incremented
});

// ─── Test 8: POST_WORK → COMPLETE after 20s sustained ────────────────────────

check('observe: POST_WORK→COMPLETE after 20s sustained + toolCount≥1', () => {
  const m = new WorkerHeartbeatStateMachine({ terminalId: 8, correlationId: 'x' });
  const base = 'bypass permissions on\n❯';
  m.observe(base, 0);

  const workText = base + '\n⏺ Bash(echo done)\n❯';
  m.observe(workText, 100);   // READY→WORKING
  m.observe(workText, 5201);  // WORKING→POST_WORK, postWorkEnteredAt=5201
  assert.strictEqual(m.state, 'POST_WORK');
  assert.strictEqual(m.toolCount, 1);

  // 20001ms later: sustained POST_WORK, toolCount=1 ≥ 1
  const transitions = m.observe(workText, 25202);  // 25202 - 5201 = 20001 >= 20000
  assert.strictEqual(transitions.length, 1);
  assert.strictEqual(transitions[0].from, 'POST_WORK');
  assert.strictEqual(transitions[0].to, 'COMPLETE');
  assert.strictEqual(transitions[0].reason, 'post-work-sustained-20s');
  assert.strictEqual(m.state, 'COMPLETE');
});

// ─── Test 9: POST_WORK does NOT fire COMPLETE when toolCount=0 ───────────────

check('observe: POST_WORK sustained ≥20s but toolCount=0 → does NOT complete', () => {
  const m = new WorkerHeartbeatStateMachine({ terminalId: 9, correlationId: 'x' });
  const promptText = '❯';
  // Directly put machine in POST_WORK without going through WORKING
  // (edge case: toolCount stays 0 — prevents false-fire gate)
  m.state = 'POST_WORK';
  m.postWorkEnteredAt = 0;
  m.scanOffset = promptText.length; // pretend we've already scanned this text

  // 25s elapsed since postWorkEnteredAt=0, but toolCount=0 → gate prevents COMPLETE
  const transitions = m.observe(promptText, 25000);
  const complete = transitions.filter(t => t.to === 'COMPLETE');
  assert.strictEqual(complete.length, 0, 'should not fire COMPLETE when toolCount=0');
  assert.strictEqual(m.state, 'POST_WORK');
});

// ─── Test 10: Chunked text accumulation ──────────────────────────────────────

check('observe: chunked text evolves state correctly across multiple calls', () => {
  const m = new WorkerHeartbeatStateMachine({ terminalId: 10, correlationId: 'x' });

  // Chunk 1: bypass text alone → BOOTING→READY (no prompt-idle required)
  m.observe('bypass permissions on', 0);
  assert.strictEqual(m.state, 'READY', 'bypass text: READY immediately');

  // Chunk 2: prompt appears — already READY, no new transition
  m.observe('bypass permissions on\n❯', 100);
  assert.strictEqual(m.state, 'READY', 'already READY, stays READY');

  // Chunk 3: tool call appears → READY→WORKING
  m.observe('bypass permissions on\n❯\n⏺ Write(out.txt)\n', 200);
  assert.strictEqual(m.state, 'WORKING', 'tool call: WORKING');
  assert.strictEqual(m.toolCount, 1);

  // Chunk 4: second tool
  m.observe('bypass permissions on\n❯\n⏺ Write(out.txt)\n⏺ Bash(git add .)\n', 300);
  assert.strictEqual(m.state, 'WORKING', 'second tool: still WORKING');
  assert.strictEqual(m.toolCount, 2);
});

// ─── Test 11: snapshot() returns expected fields ──────────────────────────────

check('snapshot: returns all expected fields with correct types', () => {
  const m = new WorkerHeartbeatStateMachine({ terminalId: 11, correlationId: 'snap-test' });
  const snap = m.snapshot();
  assert.strictEqual(snap.state, 'BOOTING');
  assert.strictEqual(snap.toolCount, 0);
  assert.strictEqual(snap.lastSpinnerAt, null);
  assert.strictEqual(snap.lastToolAt, null);
  assert.strictEqual(snap.lastNewBytesAt, null);
  assert.strictEqual(snap.firstActivityAt, null);
  assert.strictEqual(snap.postWorkEnteredAt, null);
  assert.ok(typeof snap.durationMs === 'number' && snap.durationMs >= 0, 'durationMs is non-negative number');
  assert.strictEqual(snap.cumulative.tokens_in, 0);
  assert.strictEqual(snap.cumulative.tokens_out, 0);
  assert.strictEqual(snap.todoItems, null);
  assert.strictEqual(snap.errorsCount, 0);
  // snapshot cumulative is a copy, not the live reference
  snap.cumulative.tokens_in = 9999;
  assert.strictEqual(m.cumulative.tokens_in, 0, 'snapshot cumulative is a copy');
});

// ─── Test 12: cumulative tokens/cost from footer ──────────────────────────────

check('observe: updates cumulative tokens from cost footer', () => {
  const m = new WorkerHeartbeatStateMachine({ terminalId: 12, correlationId: 'x' });
  const text = 'worker output\n[████░░░░░░] 40%  in:3.5k  out:12.8k  cost:$1.23\n❯';
  m.observe(text, 100);
  assert.strictEqual(m.cumulative.tokens_in, 3500);
  assert.strictEqual(m.cumulative.tokens_out, 12800);

  // Second update with higher values
  const text2 = text + '\nmore output\n[████████░░] 80%  in:6.0k  out:24.0k  cost:$2.46\n❯';
  m.observe(text2, 200);
  assert.strictEqual(m.cumulative.tokens_in, 6000);
  assert.strictEqual(m.cumulative.tokens_out, 24000);
});

// ─── Test 13: TodoWrite items captured ───────────────────────────────────────

check('observe: captures TodoWrite items into todoItems', () => {
  const m = new WorkerHeartbeatStateMachine({ terminalId: 13, correlationId: 'x' });
  m.observe('bypass permissions on\n❯', 0);  // READY

  const todoText = 'bypass permissions on\n❯\n⏺ TodoWrite()\n☐ Run tests\n☐ Commit changes\n';
  m.observe(todoText, 100);
  assert.ok(Array.isArray(m.todoItems), 'todoItems should be array');
  assert.strictEqual(m.todoItems.length, 2);
  assert.strictEqual(m.todoItems[0], 'Run tests');
  assert.strictEqual(m.todoItems[1], 'Commit changes');
  // snapshot also reflects todoItems
  const snapTodo = m.snapshot().todoItems;
  assert.ok(Array.isArray(snapTodo) && snapTodo.length === 2, 'snapshot todoItems length');
  assert.strictEqual(snapTodo[0], 'Run tests');
  assert.strictEqual(snapTodo[1], 'Commit changes');
});

// ─── Test 14: error accumulation ─────────────────────────────────────────────

check('observe: accumulates errors across multiple observe() calls', () => {
  const m = new WorkerHeartbeatStateMachine({ terminalId: 14, correlationId: 'x' });
  m.observe('bypass permissions on\n❯', 0);  // READY

  // First call: READY→WORKING + first error
  const t1 = 'bypass permissions on\n❯\n⏺ Bash(ls /nope)\n⎿ Error: ENOENT: no such file\n';
  m.observe(t1, 100);
  assert.strictEqual(m.lastErrors.length, 1);
  assert.strictEqual(m.lastErrors[0].kind, 'error');
  assert.ok(m.lastErrors[0].detail.includes('ENOENT'));

  // Second call: non-zero exit error
  const t2 = t1 + '⎿ Command failed with exit code 1\n';
  m.observe(t2, 200);
  assert.strictEqual(m.lastErrors.length, 2);
  assert.strictEqual(m.lastErrors[1].kind, 'exit_nonzero');
  assert.ok(m.lastErrors[1].detail.includes('1'));
  // snapshot errorsCount reflects accumulation
  assert.strictEqual(m.snapshot().errorsCount, 2);
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
