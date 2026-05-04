#!/usr/bin/env node
// Regression test: TerminalManager.close() must invoke onTerminalClose callback
// synchronously, before deleting byTerminal map entry. Without this, the async
// onDidCloseTerminal path bails on missing map entry and system.worker.terminated
// never emits.
//
// Root cause: .local/audits/lifecycle-silent-mutation-trace.md
// Fix: commit that adds this test.
//
// Run: node extension/test/terminal-manager.test.js
// Exits 0 on success, 1 on failure.

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const src = fs.readFileSync(
  path.resolve(__dirname, '../src/terminal-manager.ts'),
  'utf8'
);

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

// Extract the close() method body for analysis.
// Match from `close(id: string | number): boolean {` to the matching `}` by
// scanning for the closing brace at the same indent level.
function extractCloseBody(source) {
  const sig = 'close(id: string | number): boolean {';
  const start = source.indexOf(sig);
  assert.ok(start >= 0, 'close() method signature not found in terminal-manager.ts');
  let depth = 0;
  let i = start + sig.length - 1; // position of opening '{'
  const end_search = source.slice(start);
  let pos = sig.length - 1; // offset within end_search of '{'
  while (pos < end_search.length) {
    if (end_search[pos] === '{') depth++;
    else if (end_search[pos] === '}') {
      depth--;
      if (depth === 0) { return end_search.slice(0, pos + 1); }
    }
    pos++;
  }
  throw new Error('Could not find closing brace of close() method');
}

const closeBody = extractCloseBody(src);

check('close() method is present in source', () => {
  assert.ok(closeBody.length > 0, 'close() body is empty');
});

check('close() calls onTerminalClose before byTerminal.delete', () => {
  // Use 'this.onTerminalClose?.' and 'this.byTerminal.delete' to match code lines
  // only — the comment text says 'byTerminal.delete' (without 'this.') and would
  // otherwise give a false-positive first match before the actual code call.
  const callbackIdx = closeBody.indexOf('this.onTerminalClose?.');
  const deleteIdx   = closeBody.indexOf('this.byTerminal.delete');
  assert.ok(callbackIdx > 0,
    'this.onTerminalClose?. call missing from close() — callback will never fire for programmatic closes');
  assert.ok(deleteIdx > 0,
    'this.byTerminal.delete missing from close() — unexpected structural change');
  assert.ok(callbackIdx < deleteIdx,
    `this.onTerminalClose?. (offset ${callbackIdx}) must come BEFORE this.byTerminal.delete (offset ${deleteIdx}). ` +
    'If delete runs first, VS Code\'s async onDidCloseTerminal path bails at ' +
    '"if (!id) return" and system.worker.terminated never emits.');
});

check('close() calls onTerminalClose before terminal.dispose', () => {
  const callbackIdx = closeBody.indexOf('this.onTerminalClose?.');
  const disposeIdx  = closeBody.indexOf('.dispose()');
  assert.ok(callbackIdx > 0, 'this.onTerminalClose?. call missing');
  assert.ok(disposeIdx > 0,  '.dispose() call missing');
  assert.ok(callbackIdx < disposeIdx,
    `this.onTerminalClose?. (offset ${callbackIdx}) must come BEFORE .dispose() (offset ${disposeIdx}). ` +
    'dispose() triggers the async VS Code event; callback must be invoked before that.');
});

check('onTerminalClosed() guard "if (!id) return" is present (idempotency)', () => {
  const guardPat = /onTerminalClosed[\s\S]{0,200}if\s*\(!id\)\s*return/;
  assert.ok(guardPat.test(src),
    'onTerminalClosed() missing early-return guard — double-callback risk if both paths fire');
});

const pass = results.filter(r => r.ok).length;
const fail = results.filter(r => !r.ok).length;
console.log(`\nterminal-manager.test.js: ${pass}/${results.length} PASS`);
if (fail > 0) process.exit(1);
process.exit(0);
