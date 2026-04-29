#!/usr/bin/env node
// Tests for M-24: uncaughtException/unhandledRejection handlers gated on
// CLAWS_DEBUG env var. When CLAWS_DEBUG=1, errors propagate visibly (non-zero
// exit) for debugging. Without it, silent exit 0 contract is preserved.
// Run: node extension/test/hook-debug-visibility.test.js
// Exits 0 on success, 1 on failure. No VS Code dependency.

'use strict';
const assert  = require('assert');
const path    = require('path');
const { spawnSync } = require('child_process');

const SESSION_START = path.resolve(__dirname, '../../scripts/hooks/session-start-claws.js');
const PRE_TOOL_USE  = path.resolve(__dirname, '../../scripts/hooks/pre-tool-use-claws.js');
const STOP          = path.resolve(__dirname, '../../scripts/hooks/stop-claws.js');

const assertions = [];
async function check(name, fn) {
  try {
    await fn();
    assertions.push({ name, ok: true });
  } catch (e) {
    assertions.push({ name, ok: false, err: e.message || String(e) });
  }
}

// Inline script that replicates the M-24 pattern and deliberately throws.
// Tests that the handler install / non-install behavior is correct.
const M24_PATTERN_SCRIPT = `
'use strict';
if (!process.env.CLAWS_DEBUG) {
  process.on('uncaughtException', () => { try { process.exit(0); } catch {} });
  process.on('unhandledRejection', () => { try { process.exit(0); } catch {} });
}
// Throw after tick so it's truly uncaught (not in a try/catch)
setImmediate(() => { throw new Error('test-uncaught-error'); });
`;

(async () => {

  // 1. Without CLAWS_DEBUG: uncaughtException handler IS installed → throw → exit 0
  await check('without CLAWS_DEBUG: uncaughtException handler catches throw → exit 0', () => {
    const r = spawnSync(process.execPath, ['-e', M24_PATTERN_SCRIPT], {
      encoding: 'utf8', timeout: 3000,
      env: { ...process.env },  // no CLAWS_DEBUG
    });
    assert.strictEqual(r.status, 0, `Without CLAWS_DEBUG, uncaughtException handler must catch throw and exit 0; got ${r.status}. stderr: ${r.stderr}`);
  });

  // 2. With CLAWS_DEBUG=1: handler NOT installed → throw propagates → exit non-zero
  await check('CLAWS_DEBUG=1: uncaughtException handler not installed → throw exits non-zero', () => {
    const r = spawnSync(process.execPath, ['-e', M24_PATTERN_SCRIPT], {
      encoding: 'utf8', timeout: 3000,
      env: { ...process.env, CLAWS_DEBUG: '1' },
    });
    assert.notStrictEqual(r.status, 0, `With CLAWS_DEBUG=1, uncaught throw must exit non-zero; got ${r.status}`);
  });

  // 3. Same test for unhandledRejection
  const M24_REJECTION_SCRIPT = `
'use strict';
if (!process.env.CLAWS_DEBUG) {
  process.on('uncaughtException', () => { try { process.exit(0); } catch {} });
  process.on('unhandledRejection', () => { try { process.exit(0); } catch {} });
}
setImmediate(() => { Promise.reject(new Error('test-rejection')); });
`;

  await check('without CLAWS_DEBUG: unhandledRejection handler catches rejection → exit 0', () => {
    const r = spawnSync(process.execPath, ['-e', M24_REJECTION_SCRIPT], {
      encoding: 'utf8', timeout: 3000,
      env: { ...process.env },
    });
    assert.strictEqual(r.status, 0, `Without CLAWS_DEBUG, unhandledRejection handler must exit 0; got ${r.status}. stderr: ${r.stderr}`);
  });

  await check('CLAWS_DEBUG=1: unhandledRejection handler not installed → exits non-zero', () => {
    const r = spawnSync(process.execPath, ['-e', M24_REJECTION_SCRIPT], {
      encoding: 'utf8', timeout: 3000,
      env: { ...process.env, CLAWS_DEBUG: '1' },
    });
    assert.notStrictEqual(r.status, 0, `With CLAWS_DEBUG=1, unhandled rejection must exit non-zero; got ${r.status}`);
  });

  // 4. Actual hooks: normal operation with CLAWS_DEBUG=1 still exits 0
  //    (normal hook logic is wrapped in try/catch, so CLAWS_DEBUG doesn't affect normal paths)
  const hooks = [
    { name: 'session-start-claws.js', path: SESSION_START },
    { name: 'pre-tool-use-claws.js',  path: PRE_TOOL_USE },
    { name: 'stop-claws.js',          path: STOP },
  ];
  for (const hook of hooks) {
    await check(`${hook.name} with CLAWS_DEBUG=1: normal operation still exits 0`, () => {
      const r = spawnSync(process.execPath, [hook.path], {
        input: '{}',
        encoding: 'utf8', timeout: 6000,
        env: { ...process.env, CLAWS_DEBUG: '1' },
      });
      assert.strictEqual(r.status, 0, `${hook.name} must exit 0 for normal operation with CLAWS_DEBUG=1; got ${r.status}. stderr: ${r.stderr}`);
    });
  }

  // 5. Verify hooks contain the CLAWS_DEBUG guard (static pattern check)
  for (const hook of hooks) {
    await check(`${hook.name} contains CLAWS_DEBUG guard for uncaughtException`, () => {
      const { readFileSync } = require('fs');
      const src = readFileSync(hook.path, 'utf8');
      assert.ok(
        src.includes('process.env.CLAWS_DEBUG') && src.includes('uncaughtException'),
        `${hook.name} must contain CLAWS_DEBUG guard for uncaughtException`
      );
    });
  }

  // Report
  const pass = assertions.filter(a => a.ok).length;
  const fail = assertions.filter(a => !a.ok).length;
  for (const a of assertions) {
    console.log(`${a.ok ? 'PASS' : 'FAIL'} — ${a.name}${a.ok ? '' : '\n     ' + a.err}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
