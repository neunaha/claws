#!/usr/bin/env node
// Tests for M-13: hook stdin safety — single try-block for both listeners
// and 5-second self-kill timer so hooks can never hang the parent process.
// Run: node extension/test/hook-stdin-safety.test.js
// Exits 0 on success, 1 on failure. No VS Code dependency.

'use strict';
const assert  = require('assert');
const path    = require('path');
const { spawn } = require('child_process');

const SESSION_START  = path.resolve(__dirname, '../../scripts/hooks/session-start-claws.js');
const PRE_TOOL_USE   = path.resolve(__dirname, '../../scripts/hooks/pre-tool-use-claws.js');
const STOP           = path.resolve(__dirname, '../../scripts/hooks/stop-claws.js');

const HOOKS = [
  { name: 'session-start-claws.js', path: SESSION_START },
  { name: 'pre-tool-use-claws.js',  path: PRE_TOOL_USE },
  { name: 'stop-claws.js',          path: STOP },
];

const assertions = [];
async function check(name, fn) {
  try {
    await fn();
    assertions.push({ name, ok: true });
  } catch (e) {
    assertions.push({ name, ok: false, err: e.message || String(e) });
  }
}

// Spawn hook with stdin open but never closed — safety timer must fire within 5s.
function spawnWithOpenStdin(hookPath, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [hookPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const start = Date.now();
    const guard = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error(`Hook ${path.basename(hookPath)} did not exit within ${timeoutMs}ms (safety timer should fire at 5s)`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(guard);
      const elapsed = Date.now() - start;
      resolve({ code, elapsed });
    });

    proc.on('error', (err) => {
      clearTimeout(guard);
      reject(err);
    });

    // Intentionally DO NOT close stdin — this simulates a never-ending pipe.
    // The 5s safety timer in the hook must exit the process.
  });
}

(async () => {

  // Test each hook: never-closing stdin → exits within 5s with code 0
  for (const hook of HOOKS) {
    await check(`${hook.name}: never-closing stdin → exits within 5s (safety timer), exit 0`, async () => {
      const { code, elapsed } = await spawnWithOpenStdin(hook.path, 7000);
      assert.strictEqual(code, 0, `Hook must exit 0 (safety timer), got code ${code}`);
      // Allow some slack: 5s timer + 1s for process startup + OS scheduling
      assert.ok(elapsed < 6500, `Hook must exit within 6.5s; took ${elapsed}ms`);
    });
  }

  // Test that hooks still work normally (stdin closes immediately with empty input)
  for (const hook of HOOKS) {
    await check(`${hook.name}: immediate stdin close → exits 0 (normal path)`, async () => {
      const result = await new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [hook.path], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const timeout = setTimeout(() => {
          try { proc.kill(); } catch {}
          reject(new Error('Hook timed out on normal input'));
        }, 5000);
        let code = null;
        proc.on('close', (c) => { clearTimeout(timeout); code = c; resolve(c); });
        proc.on('error', reject);
        // Send empty input and close stdin
        proc.stdin.end('{}');
      });
      assert.strictEqual(result, 0, `Hook must exit 0 on normal input`);
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
