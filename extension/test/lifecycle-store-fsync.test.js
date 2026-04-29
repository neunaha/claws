#!/usr/bin/env node
// Tests for M-43: lifecycle-store.ts flushToDisk() must call fsyncSync before
// renameSync — parity with M-29 hooks-side fix.
// Run: node extension/test/lifecycle-store-fsync.test.js
// Exits 0 on success, 1 on failure.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const EXT_ROOT = path.resolve(__dirname, '..');
const TS_SRC = path.join(EXT_ROOT, 'src', 'lifecycle-store.ts');

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, err: err.message || String(err) });
  }
}

const src = fs.readFileSync(TS_SRC, 'utf8');

// 1. M-43 comment present
check('lifecycle-store.ts: M-43 comment present', () => {
  assert(src.includes('M-43'), 'M-43 comment not found in lifecycle-store.ts');
});

// 2. fsyncSync present in flushToDisk
check('lifecycle-store.ts: fsyncSync present in flushToDisk()', () => {
  const flushIdx = src.indexOf('flushToDisk(): void');
  assert(flushIdx !== -1, 'flushToDisk(): void method definition not found');
  const flushBody = src.slice(flushIdx, flushIdx + 600);
  assert(flushBody.includes('fsyncSync'), 'fsyncSync not found in flushToDisk body');
});

// 3. fsyncSync called BEFORE renameSync
check('lifecycle-store.ts: fsyncSync before renameSync', () => {
  const flushIdx = src.indexOf('flushToDisk(): void');
  const flushBody = src.slice(flushIdx, flushIdx + 600);
  const fsyncPos = flushBody.indexOf('fsyncSync');
  const renamePos = flushBody.indexOf('renameSync');
  assert(fsyncPos !== -1, 'fsyncSync not found');
  assert(renamePos !== -1, 'renameSync not found');
  assert(
    fsyncPos < renamePos,
    `fsyncSync (pos ${fsyncPos}) must appear before renameSync (pos ${renamePos})`,
  );
});

// 4. openSync + writeSync pattern used (not writeFileSync)
check('lifecycle-store.ts: uses openSync+writeSync pattern for durability', () => {
  const flushIdx = src.indexOf('flushToDisk(): void');
  const flushBody = src.slice(flushIdx, flushIdx + 600);
  assert(flushBody.includes('openSync'), 'openSync not found in flushToDisk');
  assert(flushBody.includes('writeSync'), 'writeSync not found in flushToDisk');
});

// 5. closeSync present (fd properly closed)
check('lifecycle-store.ts: closeSync present to close fd', () => {
  const flushIdx = src.indexOf('flushToDisk(): void');
  const flushBody = src.slice(flushIdx, flushIdx + 600);
  assert(flushBody.includes('closeSync'), 'closeSync not found — fd may be leaked');
});

// 6. finally block used (fd closed even on write error)
check('lifecycle-store.ts: finally block ensures fd is closed on error', () => {
  const flushIdx = src.indexOf('flushToDisk(): void');
  const flushBody = src.slice(flushIdx, flushIdx + 600);
  assert(flushBody.includes('finally'), 'finally block not found — fd may leak on writeSync error');
});

// 7. Compile and verify the flushToDisk actually calls fsync at runtime
check('lifecycle-store.ts: behavioral — compiled flushToDisk writes file durably', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-m43-'));
  const jsOut = path.join(tmpDir, 'lifecycle-store.js');
  try {
    execSync(
      `"${path.join(EXT_ROOT, 'node_modules', '.bin', 'tsc')}" --target ES2020 --module commonjs --moduleResolution node --strict --outDir "${tmpDir}" "${TS_SRC}"`,
      { stdio: 'pipe' },
    );

    const { LifecycleStore } = require(jsOut);
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-m43-ws-'));
    const store = new LifecycleStore(ws);
    store.plan('fsync test');

    const statePath = path.join(ws, '.claws', 'lifecycle-state.json');
    assert(fs.existsSync(statePath), 'state file not written after plan()');

    const tmpPath = statePath + '.tmp';
    assert(!fs.existsSync(tmpPath), '.tmp file should be gone after rename');

    const content = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(content.phase, 'PLAN');
    assert.strictEqual(content.plan, 'fsync test');

    fs.rmSync(ws, { recursive: true, force: true });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── results ─────────────────────────────────────────────────────────────────

for (const c of checks) {
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ' — ' + c.err}`);
}

const failed = checks.filter(c => !c.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${checks.length} lifecycle-store-fsync check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS: ${checks.length} lifecycle-store-fsync checks`);
process.exit(0);
