#!/usr/bin/env node
// Regression test: ensure bundle-native.mjs prebuilt path works correctly.
//
// Checks:
// 1. prebuilt/manifest.json is well-formed and has the darwin-arm64 entry.
// 2. The darwin-arm64 prebuilt pty.node sha256 matches the manifest entry.
// 3. bundle-native.mjs prebuiltPath() returns the correct path.
// 4. bundle-native.mjs verifySha256() passes for the current prebuilt.
// 5. After npm run build, the output pty.node sha256 matches the prebuilt manifest.
//
// Run: node extension/test/bundle-native-prebuilt.test.js
// Exits 0 on pass, 1 on fail.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const EXT_ROOT = path.resolve(__dirname, '..');
const PREBUILT_ROOT = path.join(EXT_ROOT, 'native', 'node-pty', 'prebuilt');
const MANIFEST_PATH = path.join(PREBUILT_ROOT, 'manifest.json');
const BUILD_PTY = path.join(EXT_ROOT, 'native', 'node-pty', 'build', 'Release', 'pty.node');
const SCRIPT_PATH = path.resolve(__dirname, '../scripts/bundle-native.mjs');

const checks = [];
async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, err: err.message || String(err) });
  }
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

(async () => {
  const { prebuiltPath, verifySha256 } = await import(SCRIPT_PATH);

  // 1. manifest.json is present and well-formed
  await check('prebuilt/manifest.json exists and parses', () => {
    assert(fs.existsSync(MANIFEST_PATH), `not found at ${MANIFEST_PATH}`);
    const m = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    assert(m.node_pty_version, 'missing node_pty_version');
    assert(typeof m.napi_version === 'number', 'napi_version should be a number');
    assert(m.binaries && typeof m.binaries === 'object', 'missing binaries map');
  });

  // 2. manifest has a darwin-arm64 entry with required fields
  await check('manifest has darwin-arm64 entry with sha256, built_at, host', () => {
    const m = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const entry = m.binaries['darwin-arm64'];
    assert(entry, 'no darwin-arm64 entry in manifest');
    assert(typeof entry.sha256 === 'string' && entry.sha256.length === 64, 'sha256 must be 64-char hex');
    assert(entry.built_at, 'missing built_at');
    assert(entry.host, 'missing host');
  });

  // 3. prebuiltPath() returns the expected location
  await check('prebuiltPath("darwin","arm64") returns correct path inside prebuilt/', () => {
    const p = prebuiltPath('darwin', 'arm64');
    const expected = path.join(PREBUILT_ROOT, 'darwin-arm64', 'pty.node');
    assert.strictEqual(p, expected, `expected ${expected}, got ${p}`);
  });

  // 4. darwin-arm64 prebuilt pty.node sha256 matches manifest
  await check('darwin-arm64/pty.node sha256 matches manifest entry', () => {
    const m = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const expected = m.binaries['darwin-arm64'].sha256;
    const pb = prebuiltPath('darwin', 'arm64');
    assert(fs.existsSync(pb), `prebuilt not found at ${pb}`);
    const actual = sha256File(pb);
    assert.strictEqual(
      actual, expected,
      `sha256 mismatch — prebuilt may be stale.\n  manifest: ${expected}\n  on disk:  ${actual}`,
    );
  });

  // 5. verifySha256() agrees
  await check('verifySha256() returns true for prebuilt against manifest sha256', () => {
    const m = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const expected = m.binaries['darwin-arm64'].sha256;
    const pb = prebuiltPath('darwin', 'arm64');
    assert(verifySha256(pb, expected), 'verifySha256() returned false for a known-good file');
  });

  // 6. verifySha256() returns false for wrong hash
  await check('verifySha256() returns false for wrong sha256', () => {
    const pb = prebuiltPath('darwin', 'arm64');
    const badHash = '0'.repeat(64);
    assert.strictEqual(verifySha256(pb, badHash), false, 'should return false for wrong hash');
  });

  // 7. build output sha256 matches prebuilt manifest (Mac regression contract)
  await check('build output pty.node sha256 matches darwin-arm64 manifest entry', () => {
    if (!fs.existsSync(BUILD_PTY)) {
      // Skip if no build output yet (CI pre-build step)
      return;
    }
    const m = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const expected = m.binaries['darwin-arm64'].sha256;
    const actual = sha256File(BUILD_PTY);
    assert.strictEqual(
      actual, expected,
      `Mac regression: build output sha256 drifted from committed prebuilt.\n` +
      `  manifest:     ${expected}\n` +
      `  build output: ${actual}\n` +
      `Run: cp extension/native/node-pty/build/Release/pty.node ` +
      `extension/native/node-pty/prebuilt/darwin-arm64/pty.node && update manifest.json`,
    );
  });

  let failed = 0;
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ' — ' + c.err}`);
    if (!c.ok) failed++;
  }

  if (failed > 0) {
    console.error(`\nFAIL: ${failed}/${checks.length} bundle-native-prebuilt check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${checks.length} bundle-native-prebuilt checks`);
  process.exit(0);
})();
