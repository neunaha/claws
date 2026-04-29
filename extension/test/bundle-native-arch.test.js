#!/usr/bin/env node
// Tests for detectTargetArch() in extension/scripts/bundle-native.mjs (M-05).
// Verifies that Rosetta 2 detection overrides x64 to arm64 instead of just warning.
// Run: node extension/test/bundle-native-arch.test.js
// Exits 0 on success, 1 on failure. No VS Code dependency.

const assert = require('assert');
const path = require('path');

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

(async () => {
  const { detectTargetArch } = await import(SCRIPT_PATH);

  // 1. Rosetta detected (sysctl returns '1') → must return 'arm64', not 'x64'
  await check('Rosetta detected (sysctl=1) → returns arm64', async () => {
    const result = detectTargetArch({
      platform: 'darwin',
      arch: 'x64',
      execFn: () => '1\n',
    });
    assert.strictEqual(result, 'arm64', `expected 'arm64', got '${result}'`);
  });

  // 2. Rosetta not active (sysctl returns '0') → returns the passed-in arch
  await check('Not Rosetta (sysctl=0) → returns x64', async () => {
    const result = detectTargetArch({
      platform: 'darwin',
      arch: 'x64',
      execFn: () => '0\n',
    });
    assert.strictEqual(result, 'x64', `expected 'x64', got '${result}'`);
  });

  // 3. CLAWS_ELECTRON_ARCH env override takes priority over Rosetta detection
  await check('CLAWS_ELECTRON_ARCH env override wins over Rosetta', async () => {
    process.env.CLAWS_ELECTRON_ARCH = 'x64';
    try {
      const result = detectTargetArch({
        platform: 'darwin',
        arch: 'x64',
        execFn: () => '1\n', // would return arm64 without override
      });
      assert.strictEqual(result, 'x64', `expected 'x64' (override), got '${result}'`);
    } finally {
      delete process.env.CLAWS_ELECTRON_ARCH;
    }
  });

  // 4. Non-darwin platform → returns arch, sysctl never called
  await check('Linux platform → returns arch, sysctl not invoked', async () => {
    let sysctlCalled = false;
    const result = detectTargetArch({
      platform: 'linux',
      arch: 'x64',
      execFn: () => { sysctlCalled = true; return '1\n'; },
    });
    assert.strictEqual(result, 'x64');
    assert.strictEqual(sysctlCalled, false, 'sysctl should not be called on non-darwin');
  });

  // 5. sysctl throws (not macOS or very old) → falls back gracefully, no crash
  await check('sysctl throws → falls back to arch without crash', async () => {
    const result = detectTargetArch({
      platform: 'darwin',
      arch: 'x64',
      execFn: () => { throw new Error('ENOENT: sysctl not found'); },
    });
    assert.strictEqual(result, 'x64');
  });

  // 6. Native arm64 node (not under Rosetta) → returns arm64 without sysctl call
  await check('native arm64 node → returns arm64, sysctl not invoked', async () => {
    let sysctlCalled = false;
    const result = detectTargetArch({
      platform: 'darwin',
      arch: 'arm64',
      execFn: () => { sysctlCalled = true; return '1\n'; },
    });
    assert.strictEqual(result, 'arm64');
    assert.strictEqual(sysctlCalled, false, 'sysctl should not be called for native arm64');
  });

  let failed = 0;
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ' — ' + c.err}`);
    if (!c.ok) failed++;
  }

  if (failed > 0) {
    console.error(`\nFAIL: ${failed}/${checks.length} bundle-native-arch check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${checks.length} bundle-native-arch checks`);
  process.exit(0);
})();
