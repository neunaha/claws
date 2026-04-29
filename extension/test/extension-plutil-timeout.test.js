#!/usr/bin/env node
// Tests for M-42: extension.ts execFileSync('plutil', ...) must have { timeout: 3000 }
// to prevent blocking the VS Code extension host on network-mounted /Applications.
// Run: node extension/test/extension-plutil-timeout.test.js
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

// 1. M-42 comment present
check('extension.ts: M-42 comment present', () => {
  assert(src.includes('M-42'), 'M-42 comment not found in extension.ts');
});

// 2. execFileSync('plutil') has timeout option
check('extension.ts: execFileSync("plutil") has { timeout: 3000 }', () => {
  const plutilIdx = src.indexOf("execFileSync('plutil'");
  assert(plutilIdx !== -1, "execFileSync('plutil') not found");
  // The options object on this call should include timeout: 3000
  const call = src.slice(plutilIdx, plutilIdx + 200);
  assert(
    call.includes('timeout: 3000'),
    `timeout: 3000 not found in plutil execFileSync call. Context: ${call}`,
  );
});

// 3. encoding: 'utf8' still present (existing functionality preserved)
check('extension.ts: execFileSync("plutil") retains encoding: "utf8"', () => {
  const plutilIdx = src.indexOf("execFileSync('plutil'");
  const call = src.slice(plutilIdx, plutilIdx + 200);
  assert(call.includes("encoding: 'utf8'"), 'encoding option removed from plutil call');
});

// 4. existing catch { /* try next */ } still in place (exception handling preserved)
check('extension.ts: catch block after plutil still present', () => {
  const plutilIdx = src.indexOf("execFileSync('plutil'");
  const nearby = src.slice(plutilIdx, plutilIdx + 400);
  assert(
    nearby.includes('catch') && nearby.includes('try next'),
    'catch { /* try next */ } block missing — exception handling for plutil removed',
  );
});

// 5. No blocking path: timeout value is 3000 (not 0 or omitted)
check('extension.ts: plutil timeout value is exactly 3000ms', () => {
  const plutilIdx = src.indexOf("execFileSync('plutil'");
  const call = src.slice(plutilIdx, plutilIdx + 200);
  // Should not have timeout: 0 or timeout: 30000
  assert(!call.includes('timeout: 0'), 'timeout: 0 found (no timeout)');
  assert(call.includes('timeout: 3000'), 'timeout: 3000 not present');
});

// ─── results ─────────────────────────────────────────────────────────────────

for (const c of checks) {
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ' — ' + c.err}`);
}

const failed = checks.filter(c => !c.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${checks.length} extension-plutil-timeout check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS: ${checks.length} extension-plutil-timeout checks`);
process.exit(0);
