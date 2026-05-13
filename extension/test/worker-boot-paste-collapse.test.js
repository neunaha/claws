#!/usr/bin/env node
// REGRESSION GUARD: worker boot paste-collapse submit verification
//
// Bug history: a latent bug in v0.7.11+ caused workers with missions large
// enough to trigger Claude TUI paste-collapse (~30-50 lines) to hang in the
// input box when MCP servers were slow to load (auth modal interfering with
// implicit \r submit). The byte-count verification check
// (`bytes.length > payload.length + 200`) NEVER passed for collapsed pastes
// because the placeholder is ~50 bytes vs. payload of thousands.
//
// Fix in commit 9fd97ac: replaced byte-count with signal-based verification
// (placeholder DISAPPEARED OR Claude rendered output) plus retry loop
// (5 CR nudges over 15s deadline).
//
// THIS TEST GUARANTEES THE FIX CANNOT BE ACCIDENTALLY REVERTED. If anyone
// changes mcp_server.js boot paths back to the broken pattern, this test
// fails loudly. Worker boot reliability is the user's #1 stability concern;
// regressing it is forbidden.
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const MCP = fs.readFileSync(path.resolve(__dirname, '../../mcp_server.js'), 'utf8');

// ─── 1. Both dispatch paths must have the recovery comment ────────────────
//
// 'PASTE-COLLAPSE RECOVERY' is the marker comment for the runBlockingWorker
// recovery loop. The fast-path uses 'robust against paste-collapse' as its
// equivalent marker. Both should be present.
assert.ok(/PASTE-COLLAPSE RECOVERY/i.test(MCP),
  'mcp_server.js: runBlockingWorker MUST contain PASTE-COLLAPSE RECOVERY block');
assert.ok(/robust against paste-collapse/i.test(MCP),
  'mcp_server.js: fast-path MUST contain "robust against paste-collapse" comment');

// ─── 2. Signal-based verification (not byte-count only) ───────────────────
//
// The fix introduced two new signal predicates. Both must be present in source.
assert.ok(/placeholderGone|_rbPlaceholderGone/.test(MCP),
  'mcp_server.js: must check placeholderGone signal (paste placeholder disappeared)');
assert.ok(/claudeResponded|_rbClaudeResponded/.test(MCP),
  'mcp_server.js: must check claudeResponded signal (Claude rendered output)');
assert.ok(/\[Pasted text #/.test(MCP),
  'mcp_server.js: must reference [Pasted text # placeholder pattern');

// ─── 3. Retry loop with proper deadline (15s, not 5s) ─────────────────────
assert.ok(/Date\.now\(\)\s*\+\s*15000/.test(MCP),
  'mcp_server.js: submit verification deadline must be 15000ms (15s)');
assert.ok(/_nudges\s*<\s*5/.test(MCP) || /_rbNudges\s*<\s*5/.test(MCP) || /Nudges\s*<\s*5/i.test(MCP),
  'mcp_server.js: must retry CR up to 5 times');
assert.ok(/_lastNudgeAt|_rbLastNudgeAt/.test(MCP),
  'mcp_server.js: must throttle CR nudges (track _lastNudgeAt)');

// ─── 4. The OLD broken pattern must NOT be the only verification ──────────
//
// The old code was:
//   const _submitDeadline = Date.now() + 5000;
//   while (...) {
//     if (_vs.bytes.length > _missionPreLen + payload.length + 200) {
//       _submitVerified = true; break;
//     }
//   }
//
// We can't ban byte-count entirely (it remains as one of the new signals),
// but the deadline must NOT still be 5s in the fast-path.
const fastPathMatch = MCP.match(/Event-driven submit verification[\s\S]{0,2500}_submitVerified/);
assert.ok(fastPathMatch, 'fast-path verification block must exist');
const fastPathBody = fastPathMatch[0];
assert.ok(!/Date\.now\(\)\s*\+\s*5000/.test(fastPathBody),
  'fast-path: 5000ms deadline is the broken pattern; must be 15000ms');

// ─── 5. Diagnostic logging on verification failure ────────────────────────
assert.ok(/mission submit verification FAILED/.test(MCP) || /paste-collapse recovery: sent/.test(MCP),
  'mcp_server.js: must log diagnostic when submit verification fails or fires nudges');

// ─── 6. Proven baseline preserved (paste:true → sleep(300) → \r) ──────────
//
// The fix MUST NOT remove the proven baseline submit pattern.
assert.ok(/text:\s*payload,\s*newline:\s*false,\s*paste:\s*true/.test(MCP) ||
          /paste:\s*true,\s*newline:\s*false/.test(MCP),
  'mcp_server.js: fast-path baseline (paste:true newline:false) must be preserved');
assert.ok(/await\s+sleep\(300\)/.test(MCP),
  'mcp_server.js: 300ms sleep between paste and \\r must be preserved');

// ─── 7. runBlockingWorker proven baseline preserved ───────────────────────
assert.ok(/text:\s*payload,\s*newline:\s*true,\s*paste:\s*true/.test(MCP),
  'mcp_server.js: runBlockingWorker baseline (paste:true newline:true) must be preserved');

// ─── 8. dispatch_subworker paste-collapse recovery (LH-3 parity) ─────────
//
// Extract the dispatch_subworker watcher section, starting from the LH-3
// recovery comment block (anchored after the _dswMission paste-send) down
// to the first occurrence of '_setupDetachWatcher' (the watcher setup that
// follows the recovery block). '_dswTick' was the original terminator but was
// replaced by the shared _setupDetachWatcher helper in a later refactor.
const dswBlockMatch = MCP.match(/PASTE-COLLAPSE RECOVERY \(LH-3[\s\S]{0,3000}_setupDetachWatcher/);
assert.ok(dswBlockMatch,
  'mcp_server.js: dispatch_subworker block must contain LH-3 paste-collapse recovery section');
const dswBlock = dswBlockMatch[0];

assert.ok(/_dswRbPlaceholderGone/.test(dswBlock) || /_dswRb/.test(dswBlock),
  'dispatch_subworker: recovery loop must use _dswRb* prefix variables (_dswRbPlaceholderGone)');

assert.ok(/_dswRbClaudeResponded/.test(dswBlock),
  'dispatch_subworker: recovery loop must check _dswRbClaudeResponded signal');

assert.ok(/Date\.now\(\)\s*\+\s*15000/.test(dswBlock),
  'dispatch_subworker: paste-collapse recovery deadline must be 15000ms');

assert.ok(/text:\s*'\\r'/.test(dswBlock) && /_dswRbNudges\s*<\s*5/.test(dswBlock),
  'dispatch_subworker: recovery must send CR (\\r) up to 5 times (_dswRbNudges < 5)');

console.log('worker-boot-paste-collapse.test.js: 16/16 PASS');
console.log('  worker boot paste-collapse fix is LOCKED IN — must never regress');
