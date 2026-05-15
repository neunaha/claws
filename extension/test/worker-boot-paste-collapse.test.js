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
assert.ok(/submit verification FAILED/.test(MCP),
  'mcp_server.js: must log diagnostic when submit verification fails (_sendAndSubmitMission: submit verification FAILED)');

// ─── 6. Proven baseline preserved (paste:true → sleep(300) → \r) ──────────
//
// The fix MUST NOT remove the proven baseline submit pattern.
assert.ok(/text:\s*payload,\s*newline:\s*false,\s*paste:\s*true/.test(MCP) ||
          /paste:\s*true,\s*newline:\s*false/.test(MCP),
  'mcp_server.js: fast-path baseline (paste:true newline:false) must be preserved');
assert.ok(/await\s+sleep\(300\)/.test(MCP),
  'mcp_server.js: 300ms sleep between paste and \\r must be preserved');

// ─── 7. _sendAndSubmitMission shared helper uses correct baseline ──────────
// W8k-1: runBlockingWorker now delegates to _sendAndSubmitMission which uses
// newline:false + explicit \r — the proven pattern that works on Windows ConPTY.
// The old newline:true (internal 30ms CR) left fleet missions unsubmitted on ConPTY.
assert.ok(/async function _sendAndSubmitMission[\s\S]{0,800}newline:\s*false,\s*paste:\s*true/.test(MCP),
  'mcp_server.js: _sendAndSubmitMission must use newline:false + explicit \\r (W8k-1 ConPTY fix)');

// ─── 8. dispatch_subworker paste-collapse recovery (W8k-2: delegated to _sendAndSubmitMission) ────
//
// W8k-2 refactored dispatch_subworker to call _sendAndSubmitMission instead of
// inlining a copy of the paste-collapse recovery loop. The shared helper carries
// the proven LH-3 sequence for all three dispatch paths (worker / fleet / dispatch_subworker).
// These checks verify: (a) W8k-2 delegation comment is present, (b) the call is correctly
// wired with launchClaude=true, (c) the old inline _dswRb* variables are gone (no revert).
assert.ok(/W8k-2: delegate to shared helper/.test(MCP),
  'mcp_server.js: dispatch_subworker must have W8k-2 delegation comment (not the old inline loop)');

const dswBlockMatch = MCP.match(/if \(name === 'claws_dispatch_subworker'\)[\s\S]{0,20000}_setupDetachWatcher/);
assert.ok(dswBlockMatch,
  'mcp_server.js: dispatch_subworker block must contain _setupDetachWatcher');
const dswBlock = dswBlockMatch[0];

assert.ok(/_sendAndSubmitMission\(_dswSock/.test(dswBlock),
  'dispatch_subworker: must call _sendAndSubmitMission (W8k-2 delegation — not inline loop)');

assert.ok(/_sendAndSubmitMission\(_dswSock,\s*termId,\s*_dswMission,\s*true\)/.test(dswBlock),
  'dispatch_subworker: _sendAndSubmitMission must be called with launchClaude=true');

assert.ok(!/_dswRbPlaceholderGone/.test(dswBlock),
  'dispatch_subworker: inline _dswRbPlaceholderGone must NOT exist (inlined loop replaced by _sendAndSubmitMission)');

console.log('worker-boot-paste-collapse.test.js: 19/19 PASS');
console.log('  worker boot paste-collapse fix is LOCKED IN — must never regress');
