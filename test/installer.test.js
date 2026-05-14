'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const crypto  = require('crypto');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI       = path.join(REPO_ROOT, 'bin', 'cli.js');
const PKG       = require(path.join(REPO_ROOT, 'package.json'));

// ─── helpers ────────────────────────────────────────────────────────────────

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claws-test-'));
}

function rm(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function hashDir(dir) {
  const h = crypto.createHash('sha256');
  if (!fs.existsSync(dir)) return h.digest('hex');
  const walk = (d) => {
    for (const e of fs.readdirSync(d).sort()) {
      const full = path.join(d, e);
      if (fs.statSync(full).isDirectory()) walk(full);
      else { h.update(e); h.update(fs.readFileSync(full)); }
    }
  };
  walk(dir);
  return h.digest('hex');
}

function makeStubCli(dir) {
  const stub = path.join(dir, 'code-stub');
  fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n', 'utf8');
  fs.chmodSync(stub, 0o755);
  return stub;
}

/**
 * Run bin/cli.js as a sandboxed child process.
 * HOME is always overridden; PATH defaults to the test process's PATH.
 * extraEnv keys with value undefined are omitted from the child environment.
 */
function runCli(args, { tmpHome, tmpProject, extraEnv = {} } = {}) {
  const base = {
    HOME: tmpHome  || os.tmpdir(),
    PATH: process.env.PATH || '',
    SHELL: process.env.SHELL || '/bin/zsh',
  };
  // merge + drop undefined values
  const env = Object.fromEntries(
    Object.entries({ ...base, ...extraEnv }).filter(([, v]) => v !== undefined)
  );
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd:      tmpProject || os.tmpdir(),
    env,
    encoding: 'utf8',
    stdio:    'pipe',
  });
}

// ─── suite ──────────────────────────────────────────────────────────────────

describe('installer — 11-scenario matrix', () => {
  let tmpHome, tmpProject, stubCli, extraCleanup;

  beforeEach(() => {
    tmpHome       = mkTmpDir();
    tmpProject    = mkTmpDir();
    stubCli       = makeStubCli(tmpHome);
    extraCleanup  = [];
  });

  afterEach(() => {
    rm(tmpHome);
    rm(tmpProject);
    for (const d of extraCleanup) rm(d);
  });

  // ── (a) Fresh install ────────────────────────────────────────────────────
  test('(a) fresh install succeeds and status confirms', () => {
    const r = runCli(['install'], {
      tmpHome, tmpProject,
      extraEnv: { CLAWS_VSCODE_CLI: stubCli },
    });
    assert.equal(r.status, 0, `install failed:\n${r.stderr}`);

    // Project artifacts
    assert.ok(
      fs.existsSync(path.join(tmpProject, '.claws-bin', 'mcp_server.js')),
      '.claws-bin/mcp_server.js must exist'
    );
    assert.ok(
      fs.existsSync(path.join(tmpProject, '.mcp.json')),
      '.mcp.json must exist'
    );
    const mcp = JSON.parse(fs.readFileSync(path.join(tmpProject, '.mcp.json'), 'utf8'));
    assert.ok(mcp.mcpServers && mcp.mcpServers.claws, '.mcp.json must have claws server entry');

    // Global capabilities
    const claudeDir = path.join(tmpHome, '.claude');
    assert.ok(
      fs.existsSync(path.join(claudeDir, 'commands', 'claws.md')),
      '~/.claude/commands/claws.md must be installed'
    );
    assert.ok(
      fs.existsSync(path.join(claudeDir, 'skills', 'claws-prompt-templates')),
      '~/.claude/skills/claws-prompt-templates must be installed'
    );
    assert.ok(
      fs.existsSync(path.join(claudeDir, 'rules', 'claws-default-behavior.md')),
      '~/.claude/rules/claws-default-behavior.md must be installed'
    );

    // status command confirms
    const s = runCli(['status'], { tmpHome, tmpProject });
    assert.ok(s.stdout.includes('✓'), 'status must show at least one passing check');
    assert.ok(s.stdout.includes('checks passing'), 'status must show summary line');
  });

  // ── (b) Re-install idempotent ────────────────────────────────────────────
  test('(b) re-install is idempotent — no duplicate CLAUDE.md blocks or hooks', () => {
    const env = { CLAWS_VSCODE_CLI: stubCli };
    assert.equal(runCli(['install'], { tmpHome, tmpProject, extraEnv: env }).status, 0);
    assert.equal(runCli(['install'], { tmpHome, tmpProject, extraEnv: env }).status, 0);

    const claudeMd = path.join(tmpProject, 'CLAUDE.md');
    if (fs.existsSync(claudeMd)) {
      const content = fs.readFileSync(claudeMd, 'utf8');
      const count = (content.match(/CLAWS:BEGIN/g) || []).length;
      assert.equal(count, 1, `CLAUDE.md must have exactly 1 CLAWS:BEGIN block; found ${count}`);
    }

    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      // File must still be valid JSON after double-install
      assert.doesNotThrow(
        () => JSON.parse(fs.readFileSync(settingsPath, 'utf8')),
        'settings.json must remain valid JSON after re-install'
      );
    }
  });

  // ── (c) Upgrade sweeps ───────────────────────────────────────────────────
  test('(c) upgrade: Bug 1 sweeps stale commands, Bug 2 sweeps stale skill dirs', () => {
    // Seed stale commands (Bug 1)
    const cmdDir = path.join(tmpHome, '.claude', 'commands');
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.writeFileSync(path.join(cmdDir, 'claws-v0714-stale.md'), '# stale', 'utf8');
    fs.writeFileSync(path.join(cmdDir, 'claws.md'), '# old-claws', 'utf8');
    fs.writeFileSync(path.join(cmdDir, 'user-custom.md'), '# keep', 'utf8');

    // Seed stale skill dir (Bug 2)
    const skillsDir = path.join(tmpHome, '.claude', 'skills');
    fs.mkdirSync(path.join(skillsDir, 'claws-stale-skill'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'claws-stale-skill', 'index.md'), '# stale', 'utf8');
    fs.mkdirSync(path.join(skillsDir, 'user-skill'), { recursive: true });

    const r = runCli(['install'], {
      tmpHome, tmpProject,
      extraEnv: { CLAWS_VSCODE_CLI: stubCli },
    });
    assert.equal(r.status, 0, `install failed:\n${r.stderr}`);

    // Bug 1: stale commands gone
    assert.ok(
      !fs.existsSync(path.join(cmdDir, 'claws-v0714-stale.md')),
      'claws-v0714-stale.md must be swept by Bug 1 sweep'
    );
    // Bug 1: new claws.md from repo present (overwrite)
    assert.ok(
      fs.existsSync(path.join(cmdDir, 'claws.md')),
      'claws.md must be re-installed'
    );
    // User command untouched
    assert.ok(
      fs.existsSync(path.join(cmdDir, 'user-custom.md')),
      'user-custom.md must NOT be swept'
    );

    // Bug 2: stale skill dir gone
    assert.ok(
      !fs.existsSync(path.join(skillsDir, 'claws-stale-skill')),
      'claws-stale-skill/ must be swept by Bug 2 sweep'
    );
    // User skill dir untouched
    assert.ok(
      fs.existsSync(path.join(skillsDir, 'user-skill')),
      'user-skill/ must NOT be swept'
    );
  });

  // ── (d) Dry-run ──────────────────────────────────────────────────────────
  test('(d) --dry-run prints actions and makes zero fs changes', () => {
    const hashBefore = hashDir(tmpProject) + '|' + hashDir(tmpHome);

    const r = runCli(['install', '--dry-run'], {
      tmpHome, tmpProject,
      extraEnv: { CLAWS_VSCODE_CLI: stubCli },
    });

    assert.equal(r.status, 0, `dry-run should exit 0:\n${r.stderr}`);
    assert.ok(r.stdout.includes('[dry-run]'), 'stdout must contain [dry-run] lines');

    const hashAfter = hashDir(tmpProject) + '|' + hashDir(tmpHome);
    assert.equal(hashBefore, hashAfter, '--dry-run must not modify any files');
  });

  // ── (e) --no-hooks ───────────────────────────────────────────────────────
  test('(e) --no-hooks skips settings.json hook registration', () => {
    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');

    const r = runCli(['install', '--no-hooks'], {
      tmpHome, tmpProject,
      extraEnv: { CLAWS_VSCODE_CLI: stubCli },
    });
    assert.equal(r.status, 0, `install --no-hooks should exit 0:\n${r.stderr}`);

    // settings.json must not contain any claws-sourced hooks
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf8');
      assert.ok(
        !raw.includes('"_source"') || !raw.includes('"claws"'),
        'settings.json must not have claws hooks when --no-hooks is used'
      );
    }
    // stdout confirms step was skipped
    assert.ok(
      r.stdout.includes('--no-hooks'),
      'install output should mention --no-hooks'
    );
  });

  // ── (f) --vscode-cli override ────────────────────────────────────────────
  test('(f) --vscode-cli override is honored — install succeeds with provided CLI path', () => {
    const fakeCli = path.join(tmpHome, 'my-editor');
    fs.writeFileSync(fakeCli, '#!/bin/sh\nexit 0\n', 'utf8');
    fs.chmodSync(fakeCli, 0o755);

    const r = runCli(['install', '--vscode-cli', fakeCli], {
      tmpHome, tmpProject,
      extraEnv: {
        CLAWS_VSCODE_CLI: undefined, // ensure no env override
      },
    });

    assert.equal(r.status, 0, `install with --vscode-cli override should exit 0:\n${r.stderr}`);
    assert.ok(
      fs.existsSync(path.join(tmpProject, '.claws-bin')),
      '.claws-bin must exist after install with --vscode-cli override'
    );
  });

  // ── (g) Missing code CLI → graceful error ────────────────────────────────
  test('(g) missing VS Code CLI produces a clean error — no crash, no unhandled exception', () => {
    // Run without any CLAWS_VSCODE_CLI — on any machine this exits 0 (found) or 1 (not found).
    // The invariant is: no crash (no unhandled TypeError / ReferenceError / stack trace).
    const r = runCli(['install'], {
      tmpHome, tmpProject,
      extraEnv: { CLAWS_VSCODE_CLI: undefined },
    });

    // Must exit cleanly — 0 (VS Code found on this machine) or 1 (not found)
    assert.ok(
      r.status === 0 || r.status === 1,
      `install should exit 0 or 1, got ${r.status}`
    );
    assert.ok(!r.stderr.includes('TypeError:'), 'must not produce TypeError');
    assert.ok(!r.stderr.includes('ReferenceError:'), 'must not produce ReferenceError');
    assert.ok(!r.stderr.includes('at Object.<anonymous>'), 'must not dump a stack trace');
  });

  // ── (h) Uninstall ────────────────────────────────────────────────────────
  test('(h) uninstall removes .claws-bin, CLAUDE.md block, rule, and hooks', () => {
    const env = { CLAWS_VSCODE_CLI: stubCli };

    // Install first
    const install = runCli(['install'], { tmpHome, tmpProject, extraEnv: env });
    assert.equal(install.status, 0, `pre-condition: install must succeed:\n${install.stderr}`);
    assert.ok(fs.existsSync(path.join(tmpProject, '.claws-bin')), '.claws-bin must exist before uninstall');

    // Uninstall
    const r = runCli(['uninstall'], { tmpHome, tmpProject, extraEnv: env });
    assert.equal(r.status, 0, `uninstall should exit 0:\n${r.stderr}`);

    // .claws-bin gone
    assert.ok(
      !fs.existsSync(path.join(tmpProject, '.claws-bin')),
      '.claws-bin must be removed by uninstall'
    );

    // CLAUDE.md has no CLAWS:BEGIN block
    const claudeMd = path.join(tmpProject, 'CLAUDE.md');
    if (fs.existsSync(claudeMd)) {
      assert.ok(
        !fs.readFileSync(claudeMd, 'utf8').includes('CLAWS:BEGIN'),
        'CLAUDE.md must not contain CLAWS:BEGIN after uninstall'
      );
    }

    // claws-default-behavior.md removed
    assert.ok(
      !fs.existsSync(path.join(tmpHome, '.claude', 'rules', 'claws-default-behavior.md')),
      'claws-default-behavior.md must be removed by uninstall'
    );

    // settings.json has no claws-sourced hooks
    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf8');
      assert.ok(
        !raw.includes('session-start-claws'),
        'settings.json must not reference session-start-claws after uninstall'
      );
    }
  });

  // ── (i) status command ───────────────────────────────────────────────────
  test('(i) status command reports installed state correctly', () => {
    // Manually create the expected installed artifacts
    const claudeDir = path.join(tmpHome, '.claude');
    fs.mkdirSync(path.join(tmpProject, '.claws-bin'), { recursive: true });
    fs.writeFileSync(path.join(tmpProject, '.claws-bin', 'mcp_server.js'), '// stub', 'utf8');
    fs.writeFileSync(path.join(tmpProject, '.mcp.json'), '{"mcpServers":{}}', 'utf8');
    fs.mkdirSync(path.join(claudeDir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'commands', 'claws.md'), '# claws', 'utf8');
    fs.mkdirSync(path.join(claudeDir, 'skills', 'claws-prompt-templates'), { recursive: true });
    fs.mkdirSync(path.join(claudeDir, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'rules', 'claws-default-behavior.md'), '# rule', 'utf8');

    const r = runCli(['status'], { tmpHome, tmpProject });
    assert.equal(r.status, 0, `status should exit 0 when installed:\n${r.stderr}`);
    assert.ok(r.stdout.includes('✓'), 'status must show passing checks');
    assert.ok(r.stdout.includes('checks passing'), 'status must show summary line');
  });

  // ── (j) --version ────────────────────────────────────────────────────────
  test('(j) --version returns the package.json version', () => {
    const r = runCli(['--version'], { tmpHome, tmpProject });
    assert.equal(r.status, 0, '--version must exit 0');
    assert.ok(
      r.stdout.trim().includes(PKG.version),
      `expected version "${PKG.version}" in output; got: "${r.stdout.trim()}"`
    );
  });

  // ── (l) Global hooks installed to ~/.claude/claws/hooks/ (W7h-2) ──────────
  test('(l) install creates ~/.claude/claws/hooks/ with hook scripts', () => {
    const r = runCli(['install'], {
      tmpHome, tmpProject,
      extraEnv: { CLAWS_VSCODE_CLI: stubCli },
    });
    assert.equal(r.status, 0, `install failed:\n${r.stderr}`);

    const globalHooksDir = path.join(tmpHome, '.claude', 'claws', 'hooks');
    assert.ok(
      fs.existsSync(globalHooksDir),
      '~/.claude/claws/hooks/ must be created by install'
    );
    // At least session-start-claws.js must be present
    assert.ok(
      fs.existsSync(path.join(globalHooksDir, 'session-start-claws.js')),
      'session-start-claws.js must be copied to global hooks dir'
    );

    // settings.json hook commands must reference the global hooks dir, NOT .claws-bin/
    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf8');
      assert.ok(
        raw.includes('.claude/claws/hooks'),
        'settings.json hook commands must reference ~/.claude/claws/hooks path'
      );
      assert.ok(
        !raw.includes('.claws-bin/hooks'),
        'settings.json must NOT reference project-local .claws-bin/hooks path'
      );
    }
  });

  // ── (m) Hooks survive project deletion — global path is stable (W7h-2) ────
  test('(m) hooks registered in settings.json point at stable global path (survives project delete)', () => {
    const r = runCli(['install'], {
      tmpHome, tmpProject,
      extraEnv: { CLAWS_VSCODE_CLI: stubCli },
    });
    assert.equal(r.status, 0, `install failed:\n${r.stderr}`);

    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) return; // hooks registration skipped (e.g. CI env)

    const rawBefore = fs.readFileSync(settingsPath, 'utf8');

    // Simulate project deletion
    fs.rmSync(path.join(tmpProject, '.claws-bin'), { recursive: true, force: true });

    // After project deletion, the global hooks dir must still exist
    const globalHooksDir = path.join(tmpHome, '.claude', 'claws', 'hooks');
    assert.ok(
      fs.existsSync(globalHooksDir),
      'global hooks dir must survive project deletion'
    );

    // settings.json hook commands must still reference the global path
    const rawAfter = fs.readFileSync(settingsPath, 'utf8');
    assert.equal(rawBefore, rawAfter, 'settings.json must be unchanged after project deletion');
    assert.ok(
      rawAfter.includes('.claude/claws/hooks'),
      'hook commands must still reference stable global path after project deletion'
    );
  });

  // ── (k) Preflight failure → no partial state ─────────────────────────────
  test('(k) preflight failure aborts install cleanly — no partial state written', () => {
    // Create an empty bin dir to use as PATH — git won't be found
    const emptyBin = mkTmpDir();
    extraCleanup.push(emptyBin);

    const hashBefore = hashDir(tmpProject) + '|' + hashDir(tmpHome);

    const r = runCli(['install'], {
      tmpHome, tmpProject,
      extraEnv: {
        PATH: emptyBin,               // no git → preflight fails
        CLAWS_VSCODE_CLI: stubCli,    // pass VS Code check so git is the trigger
      },
    });

    // git not in PATH → preflight must fail → exit 1
    assert.notEqual(r.status, 0, 'preflight failure must produce non-zero exit');
    assert.ok(
      r.stderr.length > 0 || r.stdout.includes('✗') || r.stdout.includes('failed'),
      'must emit a failure message'
    );

    // No files must have been written
    const hashAfter = hashDir(tmpProject) + '|' + hashDir(tmpHome);
    assert.equal(hashBefore, hashAfter, 'preflight failure must leave no partial state');
  });
});
