#!/usr/bin/env node
// H2 regression: TerminalManager.close() must dispose BEFORE deleting byTerminal
// so VS Code's onDidCloseTerminal lookup succeeds and onTerminalClose fires.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.resolve(__dirname, '../src/terminal-manager.ts'), 'utf8');

// Find close() method body (non-greedy stops at first `\n  }` — the method closer).
const closeMatch = src.match(/close\(id: string \| number\): boolean \{([\s\S]*?)\n  \}/);
assert.ok(closeMatch, 'close() method not found');
const body = closeMatch[1];

// Use '.dispose(' and 'this.byTerminal.delete' to match actual code lines only.
// Plain 'byTerminal.delete' also appears in the explanatory comment above the
// dispose call — using 'this.' prefix skips that false-positive.
const disposeIdx = body.indexOf('.dispose(');
const byTerminalDeleteIdx = body.indexOf('this.byTerminal.delete');

assert.ok(disposeIdx > -1, 'dispose() not found in close()');
assert.ok(byTerminalDeleteIdx > -1, 'this.byTerminal.delete not found in close()');
assert.ok(disposeIdx < byTerminalDeleteIdx,
  `H2 violation: this.byTerminal.delete (idx ${byTerminalDeleteIdx}) must come AFTER .dispose() (idx ${disposeIdx}) — ` +
  'otherwise async onDidCloseTerminal lookup fails because the map entry is already gone when the event fires');

console.log('terminal-manager-h2.test.js: PASS — close() correctly disposes before deleting byTerminal');
