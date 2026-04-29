#!/usr/bin/env node
// Tests for M-41: extension.ts runRebuildPty() must add a 5-minute SIGKILL
// ceiling to the @electron/rebuild spawn so it doesn't hang VS Code forever.
// Run: node extension/test/extension-rebuild-pty-timeout.test.js
// Exits 0 on success, 1 on failure.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const EXT_TS = path.resolve(__dirname, '..', 'src', 'extension.ts');

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, err: err.message || String(err) });
  }
}

const src = fs.readFileSync(EXT_TS, 'utf8');

// 1. M-41 comment present
check('extension.ts: M-41 comment present', () => {
  assert(src.includes('M-41'), 'M-41 comment not found in extension.ts');
});

// 2. killTimer created with 5-minute timeout
check('extension.ts: killTimer uses 5 * 60 * 1000 (5-minute ceiling)', () => {
  assert(
    src.includes('5 * 60 * 1000'),
    'Expected "5 * 60 * 1000" timeout for killTimer not found',
  );
});

// 3. SIGKILL used (not just SIGTERM)
check('extension.ts: proc.kill("SIGKILL") called in kill timer', () => {
  assert(
    src.includes("proc.kill('SIGKILL')") || src.includes('proc.kill("SIGKILL")'),
    'SIGKILL not found in timeout handler',
  );
});

// 4. clearTimeout called in exit handler (timer cancelled on normal exit)
check('extension.ts: clearTimeout(killTimer) in exit handler', () => {
  const exitIdx = src.indexOf("proc.on('exit'");
  assert(exitIdx !== -1, "proc.on('exit') not found");
  const clearIdx = src.indexOf('clearTimeout(killTimer)', exitIdx);
  assert(
    clearIdx !== -1 && clearIdx < exitIdx + 500,
    'clearTimeout(killTimer) not found in/near exit handler',
  );
});

// 5. clearTimeout called in error handler
check('extension.ts: clearTimeout(killTimer) in error handler', () => {
  const errIdx = src.indexOf("proc.on('error'");
  assert(errIdx !== -1, "proc.on('error') not found");
  const clearIdx = src.indexOf('clearTimeout(killTimer)', errIdx);
  assert(
    clearIdx !== -1 && clearIdx < errIdx + 300,
    'clearTimeout(killTimer) not found in error handler',
  );
});

// 6. User-visible error message on timeout
check('extension.ts: showErrorMessage on timeout', () => {
  assert(
    src.includes('rebuild timed out'),
    'User-visible timeout error message not found',
  );
});

// ─── results ─────────────────────────────────────────────────────────────────

for (const c of checks) {
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ' — ' + c.err}`);
}

const failed = checks.filter(c => !c.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${checks.length} extension-rebuild-pty-timeout check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS: ${checks.length} extension-rebuild-pty-timeout checks`);
process.exit(0);
