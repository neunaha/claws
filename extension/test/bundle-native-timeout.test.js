#!/usr/bin/env node
// Tests for runElectronRebuild() timeout option in bundle-native.mjs (M-08).
// Verifies that spawnSync is called with timeout:5min and SIGTERM → network message.
// Run: node extension/test/bundle-native-timeout.test.js
// Exits 0 on success, 1 on failure. No VS Code dependency.

const assert = require('assert');
const path = require('path');

const SCRIPT_PATH = path.resolve(__dirname, '../scripts/bundle-native.mjs');
const FIVE_MINUTES_MS = 5 * 60 * 1000;

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
  const { runElectronRebuild } = await import(SCRIPT_PATH);

  // 1. spawnSync called with timeout: 5 * 60 * 1000
  await check('spawnSync receives timeout option of 5 minutes (300000ms)', async () => {
    let capturedOpts = null;
    runElectronRebuild('39.8.5', 'arm64', {
      spawnFn: (cmd, args, opts) => {
        capturedOpts = opts;
        return { status: 0, signal: null, error: undefined };
      },
      failFn: () => {},
    });
    assert(capturedOpts !== null, 'spawnFn should have been called');
    assert.strictEqual(
      capturedOpts.timeout,
      FIVE_MINUTES_MS,
      `expected timeout=${FIVE_MINUTES_MS}, got ${capturedOpts.timeout}`,
    );
  });

  // 2. SIGTERM (timeout scenario) → fail message mentions 5min / network / headers
  await check('SIGTERM → fail message hints at slow headers download (not generic re-run)', async () => {
    let failMsg = null;
    runElectronRebuild('39.8.5', 'arm64', {
      spawnFn: () => ({ status: null, signal: 'SIGTERM', error: undefined }),
      failFn: (msg) => { failMsg = msg; },
    });
    assert(failMsg !== null, 'failFn should have been called');
    assert(
      failMsg.includes('5min') || failMsg.includes('timed out') || failMsg.includes('timeout'),
      `expected timeout message, got: ${failMsg}`,
    );
    assert(
      failMsg.includes('network') || failMsg.includes('headers') || failMsg.includes('proxy'),
      `expected network hint, got: ${failMsg}`,
    );
  });

  // 3. SIGKILL → fail message is the generic signal message (not the timeout one)
  await check('SIGKILL → generic signal fail message, not timeout message', async () => {
    let failMsg = null;
    runElectronRebuild('39.8.5', 'arm64', {
      spawnFn: () => ({ status: null, signal: 'SIGKILL', error: undefined }),
      failFn: (msg) => { failMsg = msg; },
    });
    assert(failMsg !== null, 'failFn should have been called');
    assert(
      failMsg.includes('SIGKILL') || failMsg.includes('signal'),
      `expected signal mention, got: ${failMsg}`,
    );
  });

  // 4. Timeout option is numeric (not string, not undefined)
  await check('timeout option is a positive number', async () => {
    let capturedOpts = null;
    runElectronRebuild('39.8.5', 'x64', {
      spawnFn: (cmd, args, opts) => { capturedOpts = opts; return { status: 0 }; },
      failFn: () => {},
    });
    assert.strictEqual(typeof capturedOpts.timeout, 'number', 'timeout must be a number');
    assert(capturedOpts.timeout > 0, 'timeout must be positive');
  });

  let failed = 0;
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ' — ' + c.err}`);
    if (!c.ok) failed++;
  }

  if (failed > 0) {
    console.error(`\nFAIL: ${failed}/${checks.length} bundle-native-timeout check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${checks.length} bundle-native-timeout checks`);
  process.exit(0);
})();
