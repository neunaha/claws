'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawnSync } = require('child_process');

const { findCodeCli, longPathPreflight, dryRunLog } = require('./platform.js');
const preflight   = require('./preflight.js');
const { installCommands, installSkills, installRules } = require('./capabilities.js');
const { injectShellHook } = require('./shell-hook.js');
const { writeMcpJson }    = require('./mcp-setup.js');
const { verify }          = require('./verify.js');

const HOME      = os.homedir();
const REPO_ROOT = path.resolve(__dirname, '..');

const TOTAL = 8;
let _stepN = 0;

function _step(label)  { _stepN++; process.stdout.write(`\n\x1b[1m\x1b[34m[${_stepN}/${TOTAL}]\x1b[0m ${label}\n`); }
function _ok(msg)      { process.stdout.write(`  \x1b[32m✓\x1b[0m ${msg}\n`); }
function _warn(msg)    { process.stdout.write(`  \x1b[33m!\x1b[0m ${msg}\n`); }
function _info(msg)    { process.stdout.write(`  \x1b[2m${msg}\x1b[0m\n`); }

/**
 * Run the 8-phase installer.
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.noHooks]
 * @param {string|null} [opts.vscodeCli]
 * @param {boolean} [opts.force]
 */
function run(opts = {}) {
  const { dryRun = false, noHooks = false, vscodeCli: cliOverride = null } = opts;
  const projectRoot = process.cwd();
  _stepN = 0;

  _printBanner();

  const lpWarn = longPathPreflight(HOME);
  if (lpWarn) _warn(lpWarn);

  // ── Phase 1: validate env ──────────────────────────────────────────────────
  _step('Validate environment');
  const preflightFailures = preflight.run(cliOverride ? { vscodeCli: cliOverride } : {});
  if (preflightFailures.length > 0) {
    for (const f of preflightFailures) process.stderr.write(`  \x1b[31m✗\x1b[0m ${f}\n`);
    process.stderr.write('\nPreflight failed — fix the above before re-running.\n');
    process.exit(1);
  }
  _ok('Environment OK');

  // ── Phase 2: prepare .claws-bin/ ──────────────────────────────────────────
  _step('Prepare .claws-bin/');
  _prepareCLawsBin(projectRoot, dryRun);
  _ok('.claws-bin/ ready');

  // ── Phase 3: install commands + Bug 1 sweep (project-local, matches bash) ──
  _step('Install commands (Bug 1 sweep)');
  installCommands(projectRoot, dryRun);
  _writeInstallCommand(projectRoot, dryRun);
  _ok('Commands installed');

  // ── Phase 4: install skills + Bug 2 sweep ────────────────────────────────
  _step('Install skills + rules (Bug 2 sweep)');
  installSkills(HOME, dryRun);
  installRules(HOME, dryRun);
  _ok('Skills and rules installed');

  // ── Phase 5: CLAUDE.md injection (after commands so CMDS_LIST is populated) ─
  _step('Inject CLAUDE.md block');
  _injectClaudeMd(projectRoot, dryRun);
  _ok('CLAUDE.md updated');

  // ── Phase 6: hooks registration ───────────────────────────────────────────
  if (noHooks) {
    _step('Register lifecycle hooks (--no-hooks: skipped)');
    _info('Skipping ~/.claude/settings.json hook registration');
  } else {
    _step('Register lifecycle hooks');
    _injectHooks(dryRun);
    _ok('Hooks registered');
  }

  // ── Phase 7: VS Code extension install ───────────────────────────────────
  _step('Install VS Code extension');
  const codeCli = cliOverride || findCodeCli();
  _installExtension(codeCli, dryRun);

  // ── Phase 8: shell rc-file hook ───────────────────────────────────────────
  _step('Inject shell hook');
  if (dryRun) {
    dryRunLog('inject claws shell hook into rc file');
  } else {
    try {
      injectShellHook(REPO_ROOT, dryRun);
      _ok('Shell hook injected');
    } catch (err) {
      _warn(`Shell hook injection failed: ${err.message}`);
    }
  }

  // ── Post-install verify ───────────────────────────────────────────────────
  if (!dryRun) {
    const failures = verify(projectRoot);
    if (failures.length > 0) {
      process.stdout.write('\n');
      for (const f of failures) _warn(f);
    }
  }

  _printSuccess();
}

// ─────────────────────────────────────────────────────────────────────────────

function _prepareCLawsBin(projectRoot, dryRun) {
  const clawsBin = path.join(projectRoot, '.claws-bin');
  const hooksDir = path.join(clawsBin, 'hooks');

  const filesToCopy = [
    { src: path.join(REPO_ROOT, 'mcp_server.js'),                    name: 'mcp_server.js' },
    { src: path.join(REPO_ROOT, 'scripts', 'stream-events.js'),      name: 'stream-events.js' },
    { src: path.join(REPO_ROOT, 'scripts', 'monitor-arm-watch.js'),  name: 'monitor-arm-watch.js' },
    { src: path.join(REPO_ROOT, 'scripts', 'shell-hook.sh'),         name: 'shell-hook.sh' },
  ];

  if (dryRun) {
    dryRunLog(`mkdir ${clawsBin}`);
    dryRunLog(`mkdir ${hooksDir}`);
    for (const { src, name } of filesToCopy) {
      dryRunLog(`copy ${src} → .claws-bin/${name}`);
    }
    dryRunLog(`write .claws-bin/package.json shim`);
    dryRunLog(`write .claws-bin/README.md`);
    writeMcpJson(projectRoot, dryRun);
    return;
  }

  fs.mkdirSync(clawsBin, { recursive: true });
  fs.mkdirSync(hooksDir,  { recursive: true });

  for (const { src, name } of filesToCopy) {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(clawsBin, name));
    }
  }

  // Copy scripts/hooks/ into .claws-bin/hooks/
  const hooksSrc = path.join(REPO_ROOT, 'scripts', 'hooks');
  if (fs.existsSync(hooksSrc)) {
    fs.cpSync(hooksSrc, hooksDir, { recursive: true });
  }

  // Copy schemas/ (MCP tool schemas + JSON schemas + type definitions)
  const schemasSrc = path.join(REPO_ROOT, 'schemas');
  if (fs.existsSync(schemasSrc)) {
    fs.cpSync(schemasSrc, path.join(clawsBin, 'schemas'), { recursive: true });
  }

  // Copy claws-sdk.js (typed publish helpers for worker scripts)
  const sdkSrc = path.join(REPO_ROOT, 'claws-sdk.js');
  if (fs.existsSync(sdkSrc)) {
    fs.copyFileSync(sdkSrc, path.join(clawsBin, 'claws-sdk.js'));
  }

  // CommonJS shim so Node treats .claws-bin as CJS even in ESM-default workspaces
  const pkgShim = path.join(clawsBin, 'package.json');
  if (!fs.existsSync(pkgShim)) {
    fs.writeFileSync(pkgShim, '{"type":"commonjs"}\n', 'utf8');
  }

  // README so teammates can see what's in .claws-bin/
  fs.writeFileSync(path.join(clawsBin, 'README.md'),
    '# .claws-bin/\n\nProject-local Claws runtime. Auto-generated by the installer — do not edit.\n', 'utf8');

  // Write/update .mcp.json so the MCP server is registered in the project
  writeMcpJson(projectRoot, dryRun);
}

function _injectClaudeMd(projectRoot, dryRun) {
  const injectProject = path.join(REPO_ROOT, 'scripts', 'inject-claude-md.js');
  const injectGlobal  = path.join(REPO_ROOT, 'scripts', 'inject-global-claude-md.js');

  // inject-claude-md.js does not support --dry-run; guard the call ourselves.
  if (dryRun) {
    dryRunLog(`inject CLAWS:BEGIN block into ${path.join(projectRoot, 'CLAUDE.md')}`);
  } else if (fs.existsSync(injectProject)) {
    const r = spawnSync(process.execPath, [injectProject, projectRoot], {
      cwd: REPO_ROOT, stdio: 'inherit', encoding: 'utf8',
    });
    if (r.status !== 0) _warn('inject-claude-md.js failed — CLAUDE.md may be stale');
  }

  // inject-global-claude-md.js natively supports --dry-run.
  if (fs.existsSync(injectGlobal)) {
    const extraArgs = dryRun ? ['--dry-run'] : [];
    const r = spawnSync(process.execPath, [injectGlobal, ...extraArgs], {
      cwd: REPO_ROOT, stdio: 'inherit', encoding: 'utf8',
    });
    if (r.status !== 0 && !dryRun) _warn('inject-global-claude-md.js failed — ~/.claude/CLAUDE.md may be stale');
  }
}

function _injectHooks(dryRun) {
  const script    = path.join(REPO_ROOT, 'scripts', 'inject-settings-hooks.js');
  const hooksDir  = path.join(REPO_ROOT, 'scripts');
  const extraArgs = dryRun ? ['--dry-run', '--update'] : ['--update'];

  if (!fs.existsSync(script)) { _warn('inject-settings-hooks.js not found — hooks skipped'); return; }

  const r = spawnSync(process.execPath, [script, hooksDir, ...extraArgs], {
    cwd: REPO_ROOT, stdio: 'inherit', encoding: 'utf8',
  });
  if (r.status !== 0 && !dryRun) _warn('inject-settings-hooks.js failed — hooks may not be registered');
}

function _installExtension(codeCli, dryRun) {
  if (!codeCli) {
    _warn('VS Code CLI not found — extension not installed automatically');
    _info('Install VS Code, add "code" to PATH (or set CLAWS_VSCODE_CLI), then re-run');
    return;
  }

  if (dryRun) {
    dryRunLog(`${codeCli} --install-extension <claws.vsix> --force`);
    return;
  }

  // Check for a pre-built VSIX in os.tmpdir()
  const vsixInTmp = fs.readdirSync(os.tmpdir())
    .filter(f => f.startsWith('claws-') && f.endsWith('.vsix'))
    .map(f => path.join(os.tmpdir(), f));

  if (vsixInTmp.length > 0) {
    const vsix = vsixInTmp[vsixInTmp.length - 1]; // most recent by listing order
    const r = spawnSync(codeCli, ['--install-extension', vsix, '--force'], {
      stdio: 'inherit', encoding: 'utf8',
    });
    if (r.status === 0) { _ok(`Extension installed from ${vsix}`); return; }
    _warn('VSIX install failed — see above for details');
    return;
  }

  // Fall back: check if already installed
  const extDirs = [
    path.join(HOME, '.vscode', 'extensions'),
    path.join(HOME, '.cursor', 'extensions'),
  ];
  for (const dir of extDirs) {
    if (!fs.existsSync(dir)) continue;
    const found = fs.readdirSync(dir).filter(f => f.startsWith('neunaha.claws-'));
    if (found.length > 0) { _ok(`Extension already installed: ${found[0]}`); return; }
  }

  _warn('No VSIX found — build one first:');
  _info('  cd extension && npm install && npm run build && npx vsce package');
  _info(`  then: ${codeCli} --install-extension claws-*.vsix --force`);
}

function _writeInstallCommand(projectRoot, dryRun) {
  const cmdDir = path.join(projectRoot, '.claude', 'commands');
  const dest   = path.join(cmdDir, 'claws-install.md');
  const content = [
    '---',
    'name: claws-install',
    'description: Install or update Claws — Terminal Control Bridge for VS Code.',
    '---',
    '',
    '# /claws-install',
    '',
    'Install or update Claws in this project:',
    '',
    '```bash',
    'npx claws-code install',
    '```',
    '',
    'After the script completes:',
    '1. Reload VS Code: Cmd+Shift+P → Developer: Reload Window',
    '2. Restart Claude Code so the project-local `.mcp.json` is picked up.',
    '3. Try `/claws-help` or `/claws-status`.',
    '',
    'If MCP tools don\'t appear, run `/claws-fix` or `/claws-report`.',
    '',
  ].join('\n');
  if (dryRun) { dryRunLog(`write ${dest}`); return; }
  fs.mkdirSync(cmdDir, { recursive: true });
  fs.writeFileSync(dest, content, 'utf8');
}

function _printBanner() {
  const B = '\x1b[38;2;200;90;62m';
  const R = '\x1b[0m';
  process.stdout.write('\n');
  process.stdout.write(`  ${B}╔═══════════════════════════════════════════╗${R}\n`);
  process.stdout.write(`  ${B}║${R}                                           ${B}║${R}\n`);
  process.stdout.write(`  ${B}║${R}   \x1b[1mCLAWS\x1b[0m  Terminal Control Bridge         ${B}║${R}\n`);
  process.stdout.write(`  ${B}║${R}   \x1b[2mProject-local orchestration setup\x1b[0m       ${B}║${R}\n`);
  process.stdout.write(`  ${B}║${R}                                           ${B}║${R}\n`);
  process.stdout.write(`  ${B}╚═══════════════════════════════════════════╝${R}\n`);
  process.stdout.write('\n');
}

function _printSuccess() {
  process.stdout.write('\n  \x1b[32m✓ Claws installed successfully\x1b[0m\n\n');
  process.stdout.write('  \x1b[1mNext steps:\x1b[0m\n');
  process.stdout.write('    Reload VS Code: Cmd+Shift+P → Developer: Reload Window\n');
  process.stdout.write('    Then: /claws-help\n');
  process.stdout.write('\n');
}

module.exports = { run };
