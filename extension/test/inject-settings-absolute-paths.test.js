#!/usr/bin/env node
// Regression test: inject-settings-hooks.js must always emit ABSOLUTE paths in hook
// commands, regardless of whether CLAWS_BIN was passed as a relative path.
//
// Bug: when process.argv[2] is relative (e.g. "scripts"), CLAWS_BIN was used
// as-is → scriptPath became "scripts/hooks/foo.js" (relative) → hooks broke
// when Claude Code's CWD wasn't the project root (ERR_MODULE_NOT_FOUND).
//
// Fix: path.resolve() on the CLAWS_BIN argument before use.
//
// Run: node extension/test/inject-settings-absolute-paths.test.js
// Exits 0 on pass, 1 on failure. No VS Code dependency.

'use strict';
const assert        = require('assert');
const fs            = require('fs');
const os            = require('os');
const path          = require('path');
const { spawnSync } = require('child_process');

const INJECT_SETTINGS = path.resolve(__dirname, '../../scripts/inject-settings-hooks.js');
const HOOK_SCRIPTS    = ['session-start-claws.js', 'pre-tool-use-claws.js', 'stop-claws.js'];
const EVENTS          = ['SessionStart', 'PreToolUse', 'Stop'];

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claws-abs-paths-'));
}
function cleanTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Create a minimal canonical hooks directory under `base/hooks/` with stub scripts.
function makeHooksDir(base) {
  const hooksDir = path.join(base, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const name of HOOK_SCRIPTS) {
    fs.writeFileSync(path.join(hooksDir, name), '#!/usr/bin/env node\n// stub\n', 'utf8');
  }
  // package.json shim required by some hook scripts
  const pkgPath = path.join(hooksDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, '{"type":"commonjs"}\n', 'utf8');
  }
  return hooksDir;
}

// Extract the bare path string embedded in a hook command.
// Handles both `node "/abs/path"` and `sh -c '...' "/abs/path"` forms.
function extractPath(cmd) {
  // Try `node "<path>"` form first
  const nodeMatch = cmd.match(/^node\s+"([^"]+)"/);
  if (nodeMatch) return nodeMatch[1];
  // Try `sh -c '...' "<path>"` form (path is the $0 argument at the end)
  const shMatch = cmd.match(/'[^']*'\s+"([^"]+)"\s*$/);
  if (shMatch) return shMatch[1];
  return null;
}

function runInject(clawsBin, home, cwd) {
  return spawnSync(process.execPath, [INJECT_SETTINGS, clawsBin], {
    encoding: 'utf8',
    timeout: 10000,
    cwd: cwd || undefined,
    env: { ...process.env, HOME: home },
  });
}

(async () => {

  // 1. Relative CLAWS_BIN (canonical: hooks/ dir + scripts present) → absolute paths
  await check('relative CLAWS_BIN (canonical, hooks present) → all commands have absolute paths', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{}', 'utf8');

      // Create fakehooks/ with hook scripts inside tmp
      makeHooksDir(path.join(tmp, 'fakehooks'));

      // Pass RELATIVE path "fakehooks" — CWD set to tmp so the relative path resolves
      const r = runInject('fakehooks', tmp, tmp);
      assert.strictEqual(r.status, 0, `Inject must succeed: ${r.stderr}`);

      const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
      for (const event of EVENTS) {
        const cmd = settings.hooks[event][0].hooks[0].command;
        const embeddedPath = extractPath(cmd);
        assert.ok(embeddedPath !== null, `${event}: could not extract path from command: ${cmd}`);
        assert.ok(
          path.isAbsolute(embeddedPath),
          `${event}: embedded path must be absolute; got: ${embeddedPath} (full cmd: ${cmd})`
        );
        assert.ok(
          !cmd.includes('"scripts/hooks/'),
          `${event}: command must not contain literal "scripts/hooks/": ${cmd}`
        );
      }
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 2. Relative CLAWS_BIN (non-canonical: no hooks/ dir) → absolute paths in wrapped form
  await check('relative CLAWS_BIN (non-canonical, no hooks dir) → all commands have absolute paths', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{}', 'utf8');

      // Create fakehooks/ WITHOUT any scripts (non-canonical → wrapped form)
      fs.mkdirSync(path.join(tmp, 'emptyhooks'), { recursive: true });

      const r = runInject('emptyhooks', tmp, tmp);
      assert.strictEqual(r.status, 0, `Inject must succeed: ${r.stderr}`);

      const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
      for (const event of EVENTS) {
        const cmd = settings.hooks[event][0].hooks[0].command;
        const embeddedPath = extractPath(cmd);
        assert.ok(embeddedPath !== null, `${event}: could not extract path from sh-c command: ${cmd}`);
        assert.ok(
          path.isAbsolute(embeddedPath),
          `${event}: embedded path must be absolute even in wrapped form; got: ${embeddedPath}`
        );
      }
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 3. Absolute CLAWS_BIN still works → absolute paths (regression guard)
  await check('absolute CLAWS_BIN (canonical) → all commands have absolute paths', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{}', 'utf8');

      const absBin = path.join(tmp, 'abshooks');
      makeHooksDir(absBin);

      const r = runInject(absBin, tmp);
      assert.strictEqual(r.status, 0, `Inject must succeed: ${r.stderr}`);

      const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
      for (const event of EVENTS) {
        const cmd = settings.hooks[event][0].hooks[0].command;
        const embeddedPath = extractPath(cmd);
        assert.ok(embeddedPath !== null, `${event}: could not extract path from command: ${cmd}`);
        assert.ok(
          path.isAbsolute(embeddedPath),
          `${event}: embedded path must be absolute for absolute CLAWS_BIN; got: ${embeddedPath}`
        );
      }
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // 4. No CLAWS_BIN arg (__dirname default) → absolute paths
  await check('no CLAWS_BIN arg (__dirname default) → all commands have absolute paths', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{}', 'utf8');

      // No clawsBin arg — uses __dirname (scripts/)
      const r = spawnSync(process.execPath, [INJECT_SETTINGS], {
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, HOME: tmp },
      });
      assert.strictEqual(r.status, 0, `Inject must succeed: ${r.stderr}`);

      const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
      for (const event of EVENTS) {
        const cmd = settings.hooks[event][0].hooks[0].command;
        const embeddedPath = extractPath(cmd);
        assert.ok(embeddedPath !== null, `${event}: could not extract path from command: ${cmd}`);
        assert.ok(
          path.isAbsolute(embeddedPath),
          `${event}: embedded path must be absolute with __dirname default; got: ${embeddedPath}`
        );
      }
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // Report
  const pass = assertions.filter(a => a.ok).length;
  const fail = assertions.filter(a => !a.ok).length;
  for (const a of assertions) {
    console.log(`${a.ok ? 'PASS' : 'FAIL'} — ${a.name}${a.ok ? '' : '\n     ' + a.err}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
