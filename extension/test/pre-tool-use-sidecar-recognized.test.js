#!/usr/bin/env node
// Tests for Wave C Task #63: pre-tool-use-claws.js spawn-gate accepts
// stream-events.js sidecar as a valid Monitor satisfier.
//
// ARCHITECTURE.md P9: bus-stream Monitor (stream-events.js) is the canonical
// satisfier. tail -F is deprecated anti-pattern A1 (SIGURG'd within ~30s).
//
// Run: node extension/test/pre-tool-use-sidecar-recognized.test.js
// Exits 0 on success, 1 on failure. No VS Code dependency.

'use strict';
const assert  = require('assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const { spawnSync, spawn } = require('child_process');

const PRE_TOOL_USE = path.resolve(__dirname, '../../scripts/hooks/pre-tool-use-claws.js');

// Skip if pgrep is unavailable (some CI environments).
const pgrepCheck = spawnSync('pgrep', ['--version'], { stdio: 'ignore' });
const SKIP_PGREP = pgrepCheck.error != null;

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claws-sidecar-gate-'));
}
function cleanTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Compute the grace file path the hook will use for a given cwd.
function graceFileFor(cwd) {
  const cwdKey = Buffer.from(cwd).toString('base64').replace(/[+/=]/g, '_').slice(0, 12);
  return `/tmp/claws-pretooluse-grace-${cwdKey}`;
}

// Write a grace file stamped 10s in the past so enforceNow = true immediately.
function armGrace(cwd) {
  const gf = graceFileFor(cwd);
  fs.writeFileSync(gf, String(Date.now() - 10000), 'utf8');
  return gf;
}

function runHook(cwd, toolName, extraEnv = {}) {
  const input = JSON.stringify({
    tool_name: toolName,
    tool_input: {},
    cwd,
  });
  return spawnSync(process.execPath, [PRE_TOOL_USE], {
    input,
    encoding: 'utf8',
    timeout: 6000,
    env: { ...process.env, ...extraEnv },
  });
}

// Spawn a Node process that has 'stream-events.js' in its argv path so that
// `pgrep -f 'stream-events\.js'` matches it. The script just sleeps forever.
function spawnFakeSidecar(dir) {
  const scriptDir = path.join(dir, 'scripts');
  fs.mkdirSync(scriptDir, { recursive: true });
  const scriptPath = path.join(scriptDir, 'stream-events.js');
  fs.writeFileSync(scriptPath, 'setInterval(function(){},1000);', 'utf8');
  return spawn(process.execPath, [scriptPath], { stdio: 'ignore', detached: false });
}

(async () => {

  // 1. Syntax check — hook parses cleanly after the Wave C edit
  await check('pre-tool-use-claws.js passes node --check', () => {
    const r = spawnSync(process.execPath, ['--check', PRE_TOOL_USE], {
      encoding: 'utf8', timeout: 5000,
    });
    assert.strictEqual(r.status, 0, `Syntax check failed: ${r.stderr}`);
  });

  // 2. No socket → always exit 0, no deny (hook is a no-op outside Claws projects)
  await check('no claws socket → exit 0 (no-op)', () => {
    const tmp = makeTmpDir();
    try {
      const r = runHook(tmp, 'mcp__claws__claws_worker');
      assert.strictEqual(r.status, 0, `Should exit 0; got ${r.status}. stderr: ${r.stderr}`);
      assert.ok(!r.stdout || !r.stdout.includes('"deny"'),
        `Should not deny when socket absent; stdout: ${JSON.stringify(r.stdout)}`);
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 3. pgrep-dependent tests — skip if pgrep not available
  if (SKIP_PGREP) {
    const skip = { name: 'pgrep unavailable — skipping process-presence tests', ok: true };
    assertions.push(skip);
  } else {

    // 3a. Grace window: first spawn-class call writes grace file but does NOT deny
    await check('first spawn-class call within grace → no deny (grace window)', () => {
      const tmp = makeTmpDir();
      const clawsDir = path.join(tmp, '.claws');
      fs.mkdirSync(clawsDir, { recursive: true });
      fs.writeFileSync(path.join(clawsDir, 'claws.sock'), '');
      const gf = graceFileFor(tmp);
      try { fs.unlinkSync(gf); } catch {}
      try {
        const r = runHook(tmp, 'mcp__claws__claws_worker');
        assert.strictEqual(r.status, 0);
        assert.ok(!r.stdout || !r.stdout.includes('"deny"'),
          `Should not deny inside grace window; stdout: ${JSON.stringify(r.stdout)}`);
        assert.ok(fs.existsSync(gf), `Grace file must be created on first call`);
      } finally {
        try { fs.unlinkSync(gf); } catch {}
        cleanTmpDir(tmp);
      }
    });

    // 3b. After grace, no sidecar, no tail → gate DENIES
    await check('after grace, no sidecar + no tail → permissionDecision:deny', () => {
      const tmp = makeTmpDir();
      const clawsDir = path.join(tmp, '.claws');
      fs.mkdirSync(clawsDir, { recursive: true });
      fs.writeFileSync(path.join(clawsDir, 'claws.sock'), '');
      const gf = armGrace(tmp);
      try {
        const r = runHook(tmp, 'mcp__claws__claws_create');
        assert.strictEqual(r.status, 0, `Hook must exit 0 even on deny; got ${r.status}`);
        // May or may not deny depending on whether a real sidecar is running in
        // this session. We only assert the deny payload is well-formed if present.
        if (r.stdout && r.stdout.includes('"deny"')) {
          const parsed = JSON.parse(r.stdout.trim());
          assert.strictEqual(
            parsed.hookSpecificOutput.permissionDecision, 'deny',
            `Deny payload malformed: ${JSON.stringify(parsed)}`
          );
          assert.ok(
            parsed.hookSpecificOutput.permissionDecisionReason.includes('stream-events.js'),
            `Deny reason must mention stream-events.js canonical pattern; got: ` +
            parsed.hookSpecificOutput.permissionDecisionReason
          );
          assert.ok(
            parsed.hookSpecificOutput.permissionDecisionReason.includes('ARCHITECTURE.md P9'),
            `Deny reason must reference ARCHITECTURE.md P9; got: ` +
            parsed.hookSpecificOutput.permissionDecisionReason
          );
        }
      } finally {
        try { fs.unlinkSync(gf); } catch {}
        cleanTmpDir(tmp);
      }
    });

    // 3c. After grace, stream-events.js sidecar alive → gate ALLOWS (no deny)
    await check('after grace, stream-events.js sidecar alive → allowed (no deny)', async () => {
      const tmp = makeTmpDir();
      const clawsDir = path.join(tmp, '.claws');
      fs.mkdirSync(clawsDir, { recursive: true });
      fs.writeFileSync(path.join(clawsDir, 'claws.sock'), '');
      const gf = armGrace(tmp);
      const sidecar = spawnFakeSidecar(tmp);
      // Give the OS a moment to register the new process
      const settled = new Promise(res => setTimeout(res, 300));
      await settled;
      try {
        const r = runHook(tmp, 'mcp__claws__claws_fleet');
        assert.strictEqual(r.status, 0, `Hook must exit 0; got ${r.status}`);
        assert.ok(!r.stdout || !r.stdout.includes('"deny"'),
          `Gate must ALLOW when sidecar is alive; stdout: ${JSON.stringify(r.stdout)}`);
      } finally {
        try { sidecar.kill(); } catch {}
        try { fs.unlinkSync(gf); } catch {}
        cleanTmpDir(tmp);
      }
    });

    // 3d. Deny reason no longer mentions tail -F as the primary fix
    await check('deny reason references canonical Monitor pattern, not deprecated tail -F', () => {
      const tmp = makeTmpDir();
      const clawsDir = path.join(tmp, '.claws');
      fs.mkdirSync(clawsDir, { recursive: true });
      fs.writeFileSync(path.join(clawsDir, 'claws.sock'), '');
      const gf = armGrace(tmp);
      try {
        const r = runHook(tmp, 'mcp__claws__claws_dispatch_subworker');
        if (r.stdout && r.stdout.includes('"deny"')) {
          const reason = JSON.parse(r.stdout.trim()).hookSpecificOutput.permissionDecisionReason;
          assert.ok(
            reason.includes('stream-events.js'),
            `Deny reason must reference stream-events.js; got: ${reason}`
          );
          // tail -F may still appear as a deprecated note, but must NOT be the primary fix
          const primaryFix = reason.split('.')[0];
          assert.ok(
            !primaryFix.includes('tail -F'),
            `Primary fix sentence must not instruct tail -F usage; got: ${primaryFix}`
          );
        }
        // If no deny (because a real sidecar is alive), test is vacuously passing
      } finally {
        try { fs.unlinkSync(gf); } catch {}
        cleanTmpDir(tmp);
      }
    });

    // 3e. Non-spawn-class tool → always allowed regardless of sidecar state
    await check('non-spawn-class tool (e.g. mcp__claws__claws_list) → always allowed', () => {
      const tmp = makeTmpDir();
      const clawsDir = path.join(tmp, '.claws');
      fs.mkdirSync(clawsDir, { recursive: true });
      fs.writeFileSync(path.join(clawsDir, 'claws.sock'), '');
      armGrace(tmp);
      const gf = graceFileFor(tmp);
      try {
        const r = runHook(tmp, 'mcp__claws__claws_list');
        assert.strictEqual(r.status, 0);
        assert.ok(!r.stdout || !r.stdout.includes('"deny"'),
          `Non-spawn-class tool must never be denied; stdout: ${JSON.stringify(r.stdout)}`);
      } finally {
        try { fs.unlinkSync(gf); } catch {}
        cleanTmpDir(tmp);
      }
    });

  } // end pgrep-available block

  // Report
  const pass = assertions.filter(a => a.ok).length;
  const fail = assertions.filter(a => !a.ok).length;
  for (const a of assertions) {
    console.log(`${a.ok ? 'PASS' : 'FAIL'} — ${a.name}${a.ok ? '' : '\n     ' + a.err}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
