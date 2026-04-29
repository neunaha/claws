#!/usr/bin/env node
// Tests for M-29: lifecycle-state.js writeState() must write atomically.
// Mirrors extension/src/lifecycle-store.ts which was already atomic.
// Run: node extension/test/hooks-lifecycle-state-atomic.test.js
// Exits 0 on success, 1 on failure. No VS Code dependency.

'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE_PATH = path.resolve(__dirname, '../../scripts/hooks/lifecycle-state.js');

const assertions = [];

async function check(name, fn) {
  try {
    await fn();
    assertions.push({ name, ok: true });
  } catch (e) {
    assertions.push({ name, ok: false, err: e.message || String(e) });
  }
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claws-lifecycle-state-'));
}

function cleanTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

(async () => {
  const { readState, writeState, PHASES, phaseIndex } = require(MODULE_PATH);

  // 1. writeState + readState round-trip
  await check('writeState/readState: round-trip preserves state', () => {
    const dir = makeTmpDir();
    try {
      const state = { phase: 'SPAWN', sessionId: 'test-123', workers: [] };
      writeState(dir, state);
      const read = readState(dir);
      assert.deepStrictEqual(read, state);
    } finally { cleanTmpDir(dir); }
  });

  // 2. writeState creates parent .claws/ dir if missing
  await check('writeState: creates .claws/ directory if missing', () => {
    const dir = makeTmpDir();
    try {
      writeState(dir, { phase: 'PLAN' });
      const statefile = path.join(dir, '.claws', 'lifecycle-state.json');
      assert.ok(fs.existsSync(statefile), '.claws/lifecycle-state.json not created');
    } finally { cleanTmpDir(dir); }
  });

  // 3. writeState no .claws-tmp.* leftover
  await check('writeState: no .claws-tmp.* file leftover after write', () => {
    const dir = makeTmpDir();
    try {
      writeState(dir, { phase: 'OBSERVE' });
      const clawsDir = path.join(dir, '.claws');
      const leftovers = fs.readdirSync(clawsDir).filter(n => n.includes('.claws-tmp.'));
      assert.deepStrictEqual(leftovers, [], `tmp files leaked: ${leftovers.join(', ')}`);
    } finally { cleanTmpDir(dir); }
  });

  // 4. writeState atomic: content is never partial — file is valid JSON after write
  await check('writeState: written file is always valid JSON', () => {
    const dir = makeTmpDir();
    try {
      const state = { phase: 'HARVEST', workers: ['w1', 'w2'], metadata: { ts: Date.now() } };
      writeState(dir, state);
      const raw = fs.readFileSync(path.join(dir, '.claws', 'lifecycle-state.json'), 'utf8');
      const parsed = JSON.parse(raw);
      assert.deepStrictEqual(parsed, state);
    } finally { cleanTmpDir(dir); }
  });

  // 5. concurrent writeState calls — no collisions (nonce ensures unique tmp)
  await check('writeState: 5 concurrent writes all succeed, no tmp leftover', async () => {
    const dir = makeTmpDir();
    try {
      const writes = Array.from({ length: 5 }, (_, i) =>
        new Promise((resolve, reject) => {
          try { writeState(dir, { phase: 'OBSERVE', iteration: i }); resolve(); }
          catch (e) { reject(e); }
        })
      );
      await Promise.all(writes);
      const clawsDir = path.join(dir, '.claws');
      const leftovers = fs.readdirSync(clawsDir).filter(n => n.includes('.claws-tmp.'));
      assert.deepStrictEqual(leftovers, [], `tmp files leaked: ${leftovers.join(', ')}`);
      // Final state must be valid JSON
      const raw = fs.readFileSync(path.join(clawsDir, 'lifecycle-state.json'), 'utf8');
      JSON.parse(raw);
    } finally { cleanTmpDir(dir); }
  });

  // 6. readState returns null for missing file (no crash)
  await check('readState: returns null for missing lifecycle-state.json', () => {
    const dir = makeTmpDir();
    try {
      const result = readState(dir);
      assert.strictEqual(result, null, 'should return null for missing file');
    } finally { cleanTmpDir(dir); }
  });

  // 7. lifecycle-state.js source: uses atomic write (static check)
  await check('lifecycle-state.js: source uses atomic write (M-29)', () => {
    const src = fs.readFileSync(MODULE_PATH, 'utf8');
    assert.ok(src.includes('renameSync'), 'renameSync not found — not using atomic rename pattern');
    assert.ok(src.includes('.claws-tmp.'), '.claws-tmp. suffix not found');
    assert.ok(src.includes('M-29'), 'M-29 comment not found');
    // fs.writeFileSync(p, ...) direct write must be gone (only writeFileSync to tmp allowed)
    const directWrite = src.match(/fs\.writeFileSync\(\s*p\s*,/g);
    assert.ok(!directWrite, `Direct fs.writeFileSync(p, ...) found — not using atomic write`);
  });

  // 8. PHASES array includes all expected phases
  await check('PHASES: contains all 9 lifecycle phases', () => {
    const expected = ['PLAN-REQUIRED', 'PLAN', 'SPAWN', 'DEPLOY', 'OBSERVE', 'RECOVER', 'HARVEST', 'CLEANUP', 'REFLECT'];
    assert.deepStrictEqual(PHASES, expected);
  });

  // 9. phaseIndex returns correct indices
  await check('phaseIndex: returns correct 0-based index', () => {
    assert.strictEqual(phaseIndex('PLAN-REQUIRED'), 0);
    assert.strictEqual(phaseIndex('REFLECT'), 8);
    assert.strictEqual(phaseIndex('UNKNOWN'), -1);
  });

  // ─── results ─────────────────────────────────────────────────────────────
  for (const a of assertions) {
    console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
  }

  const failed = assertions.filter(a => !a.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${assertions.length} hooks-lifecycle-state-atomic check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${assertions.length} hooks-lifecycle-state-atomic checks`);
  process.exit(0);

})().catch(err => {
  console.error('FAIL: uncaught error in test runner:', err);
  process.exit(1);
});
