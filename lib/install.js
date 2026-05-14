'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawnSync } = require('child_process');

const { findAllEditorClis, longPathPreflight, dryRunLog } = require('./platform.js');
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
  const { failures: preflightFailures, warnings: preflightWarnings } =
    preflight.run(cliOverride ? { vscodeCli: cliOverride } : {});
  for (const w of preflightWarnings) _warn(w);
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
  installSkills(projectRoot, dryRun);
  installRules(projectRoot, dryRun);
  _ok('Skills and rules installed (project-local)');

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
    const hooksOk = _injectHooks(projectRoot, dryRun);
    if (hooksOk) _ok('Hooks registered');
  }

  // ── Phase 7: VS Code extension install ───────────────────────────────────
  _step('Install VS Code extension');
  const editorClis = cliOverride
    ? [{ label: 'override', cliPath: cliOverride }]
    : findAllEditorClis();
  _installExtension(editorClis, dryRun);

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
    _updateGitignore(projectRoot, dryRun);
    _updateVscodeExtensions(projectRoot, dryRun);
    return;
  }

  // Guard against reparse-point artifacts from macOS tarballs extracted on Windows.
  // rmSync clears any symlink/reparse-point that would cause EPERM on mkdir.
  try {
    fs.rmSync(clawsBin, { recursive: true, force: true });
  } catch (_) { /* ignore — dir may not exist or may be partially removable */ }

  try {
    fs.mkdirSync(clawsBin, { recursive: true });
    fs.mkdirSync(hooksDir,  { recursive: true });
  } catch (e) {
    if (e.code === 'EEXIST') {
      process.stdout.write('  [warn] .claws-bin/ directory conflict after cleanup — continuing\n');
    } else {
      throw e;
    }
  }

  for (const { src, name } of filesToCopy) {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(clawsBin, name));
    }
  }

  // Copy scripts/hooks/ into .claws-bin/hooks/ — atomic to avoid partial state
  // if the process is killed mid-copy (M-09 pattern from atomic-file.mjs).
  const hooksSrc = path.join(REPO_ROOT, 'scripts', 'hooks');
  if (fs.existsSync(hooksSrc)) {
    _copyDirAtomic(hooksSrc, hooksDir);
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

  // Add Claws runtime paths to .gitignore (W7h-9)
  _updateGitignore(projectRoot, dryRun);

  // Add neunaha.claws to .vscode/extensions.json recommendations (W7h-10)
  _updateVscodeExtensions(projectRoot, dryRun);
}

/**
 * Append Claws runtime entries to <projectRoot>/.gitignore if not already present.
 * Matches install.sh lines 1094-1106.
 * @param {string} projectRoot
 * @param {boolean} [dryRun]
 */
function _updateGitignore(projectRoot, dryRun) {
  const gitignore = path.join(projectRoot, '.gitignore');
  const entries   = ['.claws/', '.mcp.json', '.claws-bin/'];

  if (dryRun) {
    dryRunLog(`update ${gitignore} with claws entries`);
    return;
  }

  let existing = '';
  if (fs.existsSync(gitignore)) {
    existing = fs.readFileSync(gitignore, 'utf8');
  }

  const toAdd = entries.filter(e => !existing.includes(e));
  if (toAdd.length === 0) return;

  const append  = '\n# Claws runtime artifacts (auto-added by installer)\n' + toAdd.join('\n') + '\n';
  const tmp     = gitignore + '.claws-tmp.' + process.pid;
  fs.writeFileSync(tmp, existing + append, 'utf8');
  fs.renameSync(tmp, gitignore);
  _ok(`.gitignore updated (${toAdd.join(', ')})`);
}

/**
 * Merge neunaha.claws into .vscode/extensions.json workspace recommendations.
 * Tolerates JSONC comments via inline strip. Matches install.sh lines 1113-1144.
 * @param {string} projectRoot
 * @param {boolean} [dryRun]
 */
function _updateVscodeExtensions(projectRoot, dryRun) {
  const vscodeDir = path.join(projectRoot, '.vscode');
  const extFile   = path.join(vscodeDir, 'extensions.json');
  const EXT_ID    = 'neunaha.claws';

  if (dryRun) {
    dryRunLog(`merge ${EXT_ID} into ${extFile}`);
    return;
  }

  let config = { recommendations: [] };
  if (fs.existsSync(extFile)) {
    try {
      const raw = fs.readFileSync(extFile, 'utf8');
      config = JSON.parse(_stripJsonc(raw));
    } catch {
      _warn('.vscode/extensions.json is malformed — skipping');
      return;
    }
  }

  if (!Array.isArray(config.recommendations)) config.recommendations = [];
  if (config.recommendations.includes(EXT_ID)) return;

  config.recommendations.push(EXT_ID);
  fs.mkdirSync(vscodeDir, { recursive: true });
  const tmp = extFile + '.claws-tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, extFile);
  _ok('.vscode/extensions.json updated');
}

/**
 * Simple JSONC comment stripper — removes // line comments and /* block comments */,
 * then trailing commas. Sufficient for .vscode/*.json written by editors.
 * @param {string} text
 * @returns {string}
 */
function _stripJsonc(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/,(\s*[}\]])/g, '$1');
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

/**
 * Copy hook scripts from <repo>/scripts/hooks/*.js to a stable global directory
 * ($HOME/.claude/claws/hooks/) so that hooks registered in ~/.claude/settings.json
 * survive project moves or deletions (D02 / W7h-2 Option B).
 * Uses atomic temp+rename per file to avoid partial-copy races.
 * @param {boolean} [dryRun]
 * @returns {string} absolute path to the global hooks dir
 */
function installGlobalHooks(dryRun = false) {
  const globalHooksDir = path.join(HOME, '.claude', 'claws', 'hooks');
  const srcHooksDir    = path.join(REPO_ROOT, 'scripts', 'hooks');

  if (dryRun) {
    dryRunLog(`mkdir ${globalHooksDir}`);
    if (fs.existsSync(srcHooksDir)) {
      for (const f of fs.readdirSync(srcHooksDir)) {
        if (f.endsWith('.js')) dryRunLog(`copy hooks/${f} → ${globalHooksDir}/${f}`);
      }
    }
    return globalHooksDir;
  }

  fs.mkdirSync(globalHooksDir, { recursive: true });

  if (fs.existsSync(srcHooksDir)) {
    for (const file of fs.readdirSync(srcHooksDir)) {
      if (!file.endsWith('.js')) continue;
      const src = path.join(srcHooksDir, file);
      const tmp = path.join(globalHooksDir, file + '.claws-tmp.' + process.pid);
      const dst = path.join(globalHooksDir, file);
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, dst);
    }
  }

  return globalHooksDir;
}

function _injectHooks(projectRoot, dryRun, opts = {}) {
  const spawnFn   = opts.spawnFn || spawnSync;
  const script    = path.join(REPO_ROOT, 'scripts', 'inject-settings-hooks.js');
  const extraArgs = dryRun ? ['--dry-run', '--update'] : ['--update'];

  if (!fs.existsSync(script)) { _warn('inject-settings-hooks.js not found — hooks skipped'); return false; }

  // D02 / W7h-2: install hook scripts to a stable global location so that
  // settings.json hook commands survive project moves or deletions.
  const globalHooksDir = installGlobalHooks(dryRun);

  const r = spawnFn(process.execPath, [script, globalHooksDir, ...extraArgs], {
    cwd: REPO_ROOT, stdio: 'inherit', encoding: 'utf8',
  });
  if (r.status !== 0 && !dryRun) {
    _warn('inject-settings-hooks.js failed — hooks may not be registered');
    _warn('Fix: run `node scripts/inject-settings-hooks.js` manually, then verify ~/.claude/settings.json');
    return false;
  }
  return true;
}

function _installExtension(editorClis, dryRun) {
  const extDir = path.join(REPO_ROOT, 'extension');
  const isWin  = process.platform === 'win32';
  // shell:true on Windows passes the whole command through cmd.exe, which splits on unquoted spaces.
  // Wrap any path that contains spaces so cmd.exe treats it as one token.
  const wq = (p) => (isWin && p.includes(' ') ? `"${p}"` : p);

  if (dryRun) {
    dryRunLog('npm install --no-fund --no-audit --loglevel=error  (cwd: extension/)');
    dryRunLog('npm run build  (cwd: extension/)');
    dryRunLog('npx @vscode/vsce package --skip-license --no-git-tag-version --no-update-package-json --no-dependencies -o <tmpdir>/claws-code-<version>.vsix');
    for (const { label, cliPath } of editorClis) {
      dryRunLog(`${cliPath} --install-extension <tmpdir>/claws-code-<version>.vsix --force  [${label}]`);
    }
    return;
  }

  if (editorClis.length === 0) {
    _warn('No editor CLI found — extension not installed automatically');
    _info('Install VS Code/Cursor/Windsurf and add CLI to PATH (or set CLAWS_VSCODE_CLI), then re-run');
    return;
  }

  if (!fs.existsSync(extDir)) {
    _warn('extension/ not found in source — skipping extension install');
    return;
  }

  const version  = JSON.parse(fs.readFileSync(path.join(extDir, 'package.json'), 'utf8')).version;
  const vsixPath = path.join(os.tmpdir(), `claws-code-${version}.vsix`);

  // npm install — must include optionals (node-pty lives in optionalDependencies but is required by bundle-native.mjs)
  _info('npm install (with node-pty)...');
  const npmInstall = spawnSync('npm', ['install', '--no-fund', '--no-audit', '--loglevel=error'],
    { cwd: extDir, stdio: 'inherit', shell: isWin });
  if (npmInstall.status !== 0) {
    if (isWin) {
      _warn('npm install failed — node-pty likely needs C++ build tools');
      _info('Install: winget install Microsoft.VisualStudio.BuildTools');
      _info('Then re-run the Claws installer');
    } else {
      _warn('npm install failed — extension not installed');
    }
    return;
  }

  // Build extension bundle + native node-pty
  _info('npm run build...');
  const npmBuild = spawnSync('npm', ['run', 'build'],
    { cwd: extDir, stdio: 'inherit', shell: isWin });
  if (npmBuild.status !== 0) {
    _warn('Extension build failed — extension not installed');
    return;
  }

  // Package VSIX — flags match install.sh canonical set (line 686)
  _info('vsce package...');
  spawnSync('npx', ['--yes', '@vscode/vsce', 'package',
    '--skip-license', '--no-git-tag-version', '--no-update-package-json',
    '--no-dependencies', '-o', wq(vsixPath)],
    { cwd: extDir, stdio: 'inherit', shell: isWin });
  if (!fs.existsSync(vsixPath)) {
    _warn('VSIX not produced — extension not installed');
    return;
  }

  // Install extension into each found editor
  let anySucceeded = false;
  for (const { label, cliPath } of editorClis) {
    _info(`installing into ${label}...`);
    const install = spawnSync(wq(cliPath), ['--install-extension', wq(vsixPath), '--force'],
      { stdio: 'inherit', shell: isWin });
    if (install.status !== 0) {
      _warn(`Extension install failed for ${label} — VSIX at ${vsixPath}`);
    } else {
      const listR = spawnSync(wq(cliPath), ['--list-extensions'], { encoding: 'utf8', shell: isWin });
      if (listR.stdout && listR.stdout.includes('neunaha.claws')) {
        _ok(`neunaha.claws installed into ${label} (verified)`);
      } else {
        _ok(`Extension installed into ${label}`);
      }
      anySucceeded = true;
    }
  }

  if (!anySucceeded) {
    _warn('Extension install failed for all editors');
  }

  // Clean up VSIX from temp dir — matches install.sh /tmp approach
  try { fs.unlinkSync(vsixPath); } catch (_) {}
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

/**
 * Copy srcDir to destDir atomically via tmp → rename (M-09 pattern).
 *   1. Copy srcDir → destDir.claws-tmp.<pid>
 *   2. Move existing destDir aside → destDir.claws-old.<ts>
 *   3. Rename tmp → destDir
 *   4. Remove the moved-aside old dir (best-effort)
 * If killed before step 3, destDir is left untouched.
 * @param {string} srcDir
 * @param {string} destDir
 */
function _copyDirAtomic(srcDir, destDir) {
  const ts  = Date.now();
  const tmp = destDir + '.claws-tmp.' + process.pid;
  const old = destDir + '.claws-old.' + ts;

  try {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
    _copyDirSync(srcDir, tmp);
  } catch (err) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    throw err;
  }

  const destExists = fs.existsSync(destDir);
  try {
    if (destExists) fs.renameSync(destDir, old);
    fs.renameSync(tmp, destDir);
  } catch (err) {
    if (destExists) {
      try {
        if (!fs.existsSync(destDir)) fs.renameSync(old, destDir);
      } catch (_) {}
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    throw err;
  }

  if (destExists) {
    try { fs.rmSync(old, { recursive: true, force: true }); } catch (_) {}
  }
}

function _copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) _copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

function _printBanner() {
  // On Windows, install.ps1 already printed the ASCII banner before delegating to node.
  // Node's Unicode box-drawing chars garble in CP437/CP1252 consoles, so skip here.
  if (process.platform === 'win32') return;
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
  const kbd = process.platform === 'darwin' ? 'Cmd+Shift+P' : 'Ctrl+Shift+P';
  process.stdout.write('\n  \x1b[32m✓ Claws installed successfully\x1b[0m\n\n');
  process.stdout.write('  \x1b[1mNext steps:\x1b[0m\n');
  process.stdout.write(`    Reload VS Code: ${kbd} → Developer: Reload Window\n`);
  process.stdout.write('    Then: /claws-help\n');
  process.stdout.write('\n');
}

module.exports = { run, _injectHooks, installGlobalHooks };
