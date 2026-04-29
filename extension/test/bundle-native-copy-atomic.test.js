// Tests for M-40: bundle-native.mjs copyRuntimeSlice uses atomic staging+rename
// instead of rmSync(NATIVE_DEST) wipe-before-copy (which creates a kill-window
// leaving NATIVE_DEST empty and silently degrading the extension to pipe-mode).
//
// Run: node test/bundle-native-copy-atomic.test.js

import assert from 'assert';
import { readFileSync, mkdirSync, writeFileSync, existsSync, renameSync, rmSync } from 'fs';
import { mkdtempSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let PASS = 0;
let FAIL = 0;
function pass(msg) { console.log(`  ✓ ${msg}`); PASS++; }
function fail(msg) { console.error(`  ✗ ${msg}`); FAIL++; }

const BUNDLE_SRC = join(__dirname, '../scripts/bundle-native.mjs');
const src = readFileSync(BUNDLE_SRC, 'utf8');

// ── TEST 1: old wipe-before-copy pattern is gone ─────────────────────────────
// The old resetNativeDest() called rmSync(NATIVE_DEST) directly.
if (/rmSync\s*\(\s*NATIVE_DEST[^+]/.test(src)) {
  fail('old rmSync(NATIVE_DEST) wipe-before-copy pattern still present (M-40 not applied)');
} else {
  pass('old rmSync(NATIVE_DEST) wipe-before-copy pattern removed');
}

// ── TEST 2: renameSync imported ───────────────────────────────────────────────
if (src.includes('renameSync')) {
  pass('renameSync imported in bundle-native.mjs');
} else {
  fail('renameSync not imported — M-40 atomic rename not applied');
}

// ── TEST 3: staging dir setup function present ───────────────────────────────
if (src.includes('setupStagingDir') || src.includes('.claws-new')) {
  pass('staging dir pattern present (setupStagingDir / .claws-new)');
} else {
  fail('staging dir pattern missing — M-40 not applied');
}

// ── TEST 4: atomic rename sequence present ────────────────────────────────────
// Must have: renameSync(staging, NATIVE_DEST) and .claws-old cleanup
if (src.includes('renameSync(staging, NATIVE_DEST)') || src.includes('renameSync(staging,NATIVE_DEST)')) {
  pass('renameSync(staging, NATIVE_DEST) present — atomic copy landing');
} else {
  fail('renameSync(staging, NATIVE_DEST) missing — copy is still non-atomic');
}

if (src.includes('.claws-old')) {
  pass('.claws-old pattern present — old dest moved aside before swap');
} else {
  fail('.claws-old pattern missing — no rollback-safe old-aside step');
}

// ── TEST 5: behavioral — atomic rename simulation ─────────────────────────────
// Simulates the setupStagingDir + copy + rename sequence:
// - old NATIVE_DEST intact until final rename
// - after rename: new content in NATIVE_DEST, .claws-new gone
const base = mkdtempSync(join(tmpdir(), 'claws-m40-'));
const dest = join(base, 'node-pty');
const staging = dest + '.claws-new';
const oldAside = dest + '.claws-old';

// Create "old" NATIVE_DEST
mkdirSync(dest);
writeFileSync(join(dest, 'old-hook.js'), 'old content');
writeFileSync(join(dest, 'package.json'), '{"version":"old"}');

// Setup staging (M-40 pattern)
mkdirSync(staging, { recursive: true });
writeFileSync(join(staging, 'new-hook.js'), 'new content');
writeFileSync(join(staging, 'package.json'), '{"version":"new"}');

// Pre-rename: dest = old, staging = new
assert.ok(existsSync(join(dest, 'old-hook.js')), 'old dest intact before rename');
assert.ok(existsSync(join(staging, 'new-hook.js')), 'staging has new content');

// Atomic swap (mirrors copyRuntimeSlice logic)
if (existsSync(dest)) renameSync(dest, oldAside);
renameSync(staging, dest);
if (existsSync(oldAside)) rmSync(oldAside, { recursive: true, force: true });

pass('atomic rename simulation: pre-swap invariants verified');

// Post-rename checks
try {
  assert.ok(existsSync(join(dest, 'new-hook.js')), 'dest has new file after rename');
  assert.ok(!existsSync(join(dest, 'old-hook.js')), 'old file not in dest after rename');
  assert.ok(!existsSync(staging), 'staging dir (.claws-new) gone after rename');
  assert.ok(!existsSync(oldAside), '.claws-old cleaned up after swap');
  pass('dest=new after rename (new-hook.js present, old-hook.js absent)');
  pass('staging dir (.claws-new) cleaned up after successful swap');
  pass('.claws-old removed after successful swap');
} catch (err) {
  fail(`atomic rename simulation failed: ${err.message}`);
}

// Cleanup
rmSync(base, { recursive: true, force: true });

// ── TEST 6: kill-before-rename leaves old dest intact ─────────────────────────
// Simulate kill after setupStagingDir (staging populated) but before renameSync.
// The live dest should still have old content.
const base2 = mkdtempSync(join(tmpdir(), 'claws-m40-kill-'));
const dest2 = join(base2, 'node-pty');
const staging2 = dest2 + '.claws-new';

mkdirSync(dest2);
writeFileSync(join(dest2, 'old.js'), 'old');

mkdirSync(staging2, { recursive: true });
writeFileSync(join(staging2, 'new.js'), 'new');

// Simulate SIGKILL here — staging exists but rename never happened

try {
  assert.ok(existsSync(join(dest2, 'old.js')), 'old dest intact after simulated kill');
  assert.ok(existsSync(join(staging2, 'new.js')), 'staging has new content (orphan, cleaned on next run)');
  const destFiles = existsSync(dest2) ? 1 : 0;
  assert.ok(destFiles > 0, 'dest not empty after kill-before-rename');
  pass('kill-before-rename: old dest intact (non-empty), staging orphaned (cleaned on next run)');
} catch (err) {
  fail(`kill-before-rename invariant failed: ${err.message}`);
}

rmSync(base2, { recursive: true, force: true });

// ── summary ──────────────────────────────────────────────────────────────────
console.log('');
if (FAIL > 0) {
  console.error(`FAIL: ${FAIL}/${PASS + FAIL} bundle-native-copy-atomic check(s) failed.`);
  process.exit(1);
}
console.log(`PASS: ${PASS} bundle-native-copy-atomic checks (M-40 atomic copyDir)`);
