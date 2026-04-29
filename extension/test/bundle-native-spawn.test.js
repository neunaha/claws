#!/usr/bin/env node
// Tests for runElectronRebuild() null-status detection in bundle-native.mjs (M-07).
// Verifies that signal-killed @electron/rebuild is caught and reported, not silently passed.
// Run: node extension/test/bundle-native-spawn.test.js
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
  const { runElectronRebuild } = await import(SCRIPT_PATH);

  // 1. Signal-killed rebuild (status=null, signal=SIGTERM, no error) → fail called
  await check('status=null + signal=SIGTERM + no error → fail called with helpful message', async () => {
    let failMsg = null;
    runElectronRebuild('39.8.5', 'arm64', {
      spawnFn: () => ({ status: null, signal: 'SIGTERM', error: undefined }),
      failFn: (msg) => { failMsg = msg; },
    });
    assert(failMsg !== null, 'failFn should have been called');
    assert(
      failMsg.includes('killed by signal') || failMsg.includes('timed out'),
      `expected fail message about signal/timeout, got: ${failMsg}`,
    );
    assert(
      failMsg.includes('re-run') || failMsg.includes('/claws-update') || failMsg.includes('network'),
      `expected fail message with actionable hint, got: ${failMsg}`,
    );
  });

  // 2. Signal-killed with SIGKILL → fail called
  await check('status=null + signal=SIGKILL → fail called', async () => {
    let failMsg = null;
    runElectronRebuild('39.8.5', 'arm64', {
      spawnFn: () => ({ status: null, signal: 'SIGKILL', error: undefined }),
      failFn: (msg) => { failMsg = msg; },
    });
    assert(failMsg !== null, 'failFn should have been called');
    assert(
      failMsg.includes('SIGKILL') || failMsg.includes('signal'),
      `expected SIGKILL mention in fail message, got: ${failMsg}`,
    );
  });

  // 3. Normal success (status=0) → fail NOT called
  await check('status=0 (success) → fail not called', async () => {
    let failCalled = false;
    runElectronRebuild('39.8.5', 'arm64', {
      spawnFn: () => ({ status: 0, signal: null, error: undefined }),
      failFn: () => { failCalled = true; },
    });
    assert.strictEqual(failCalled, false, 'failFn should not be called on success');
  });

  // 4. Non-zero exit status → fail called with exit code
  await check('status=1 (non-zero exit) → fail called', async () => {
    let failMsg = null;
    runElectronRebuild('39.8.5', 'arm64', {
      spawnFn: () => ({ status: 1, signal: null, error: undefined }),
      failFn: (msg) => { failMsg = msg; },
    });
    assert(failMsg !== null, 'failFn should have been called for non-zero exit');
    assert(failMsg.includes('1'), `expected status code 1 in message, got: ${failMsg}`);
  });

  // 5. Spawn error (result.error set) → fail called
  await check('result.error set → fail called', async () => {
    let failMsg = null;
    runElectronRebuild('39.8.5', 'arm64', {
      spawnFn: () => ({ status: null, signal: null, error: new Error('ENOENT: npx not found') }),
      failFn: (msg) => { failMsg = msg; },
    });
    assert(failMsg !== null, 'failFn should have been called for spawn error');
    assert(
      failMsg.includes('ENOENT') || failMsg.includes('npx') || failMsg.includes('spawn'),
      `expected spawn error message, got: ${failMsg}`,
    );
  });

  let failed = 0;
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ' — ' + c.err}`);
    if (!c.ok) failed++;
  }

  if (failed > 0) {
    console.error(`\nFAIL: ${failed}/${checks.length} bundle-native-spawn check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${checks.length} bundle-native-spawn checks`);
  process.exit(0);
})();
