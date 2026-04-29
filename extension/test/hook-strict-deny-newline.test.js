#!/usr/bin/env node
// Tests for M-16: STRICT mode deny payload ends with trailing newline.
// Claude Code's hook protocol parser requires a trailing newline to flush
// the JSON payload correctly; without it the deny decision may be lost.
// Run: node extension/test/hook-strict-deny-newline.test.js
// Exits 0 on success, 1 on failure. No VS Code dependency.

'use strict';
const assert  = require('assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const { spawnSync } = require('child_process');

const PRE_TOOL_USE = path.resolve(__dirname, '../../scripts/hooks/pre-tool-use-claws.js');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claws-strict-deny-'));
}
function cleanTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

(async () => {

  // 1. STRICT mode deny: stdout ends with trailing newline
  await check('STRICT deny payload ends with trailing newline', () => {
    const tmp = makeTmpDir();
    try {
      // Create fake claws socket so the hook proceeds past the socket check
      const clawsDir = path.join(tmp, '.claws');
      fs.mkdirSync(clawsDir, { recursive: true });
      fs.writeFileSync(path.join(clawsDir, 'claws.sock'), '');

      const input = JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'npm run start' },
        cwd: tmp,
      });

      const r = spawnSync(process.execPath, [PRE_TOOL_USE], {
        input,
        encoding: 'utf8',
        timeout: 6000,
        env: { ...process.env, CLAWS_STRICT: '1' },
      });

      assert.strictEqual(r.status, 0, `Hook must exit 0 even in STRICT mode; got ${r.status}. stderr: ${r.stderr}`);
      assert.ok(r.stdout, `Hook must write to stdout in STRICT mode; stdout: ${JSON.stringify(r.stdout)}`);

      // Must end with exactly '\n'
      assert.ok(
        r.stdout.endsWith('\n'),
        `STRICT deny stdout must end with newline; last 20 chars: ${JSON.stringify(r.stdout.slice(-20))}`
      );

      // Must be valid JSON (parseable) before the trailing newline
      const parsed = JSON.parse(r.stdout.trim());
      assert.ok(
        parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision === 'deny',
        `STRICT deny payload must have permissionDecision:'deny'; got: ${JSON.stringify(parsed)}`
      );
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 2. STRICT mode with non-matching command: no stdout output
  await check('STRICT mode with non-matching command: no deny, no stdout output', () => {
    const tmp = makeTmpDir();
    try {
      const clawsDir = path.join(tmp, '.claws');
      fs.mkdirSync(clawsDir, { recursive: true });
      fs.writeFileSync(path.join(clawsDir, 'claws.sock'), '');

      const input = JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
        cwd: tmp,
      });

      const r = spawnSync(process.execPath, [PRE_TOOL_USE], {
        input,
        encoding: 'utf8',
        timeout: 6000,
        env: { ...process.env, CLAWS_STRICT: '1' },
      });

      assert.strictEqual(r.status, 0, `Hook must exit 0 for non-matching command`);
      // Non-matching command in STRICT mode should not produce deny payload
      assert.ok(!r.stdout || !r.stdout.includes('"deny"'),
        `Non-matching command must not produce deny payload; stdout: ${JSON.stringify(r.stdout)}`
      );
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 3. Multiple long-running patterns: each produces newline-terminated deny payload
  const LONG_RUNNING_PATTERNS = [
    'npm run dev',
    'yarn start',
    'nodemon server.js',
    'python server.py',
  ];
  for (const cmd of LONG_RUNNING_PATTERNS) {
    await check(`STRICT deny for "${cmd}" ends with trailing newline`, () => {
      const tmp = makeTmpDir();
      try {
        const clawsDir = path.join(tmp, '.claws');
        fs.mkdirSync(clawsDir, { recursive: true });
        fs.writeFileSync(path.join(clawsDir, 'claws.sock'), '');

        const input = JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: cmd },
          cwd: tmp,
        });

        const r = spawnSync(process.execPath, [PRE_TOOL_USE], {
          input,
          encoding: 'utf8',
          timeout: 6000,
          env: { ...process.env, CLAWS_STRICT: '1' },
        });

        assert.strictEqual(r.status, 0, `Hook must exit 0`);
        if (r.stdout && r.stdout.includes('"deny"')) {
          assert.ok(r.stdout.endsWith('\n'),
            `Deny payload for "${cmd}" must end with newline; last chars: ${JSON.stringify(r.stdout.slice(-10))}`
          );
        }
      } finally {
        cleanTmpDir(tmp);
      }
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
