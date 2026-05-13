'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawnSync } = require('child_process');

const { findCodeCli, getDefaultShellRcFile, dryRunLog } = require('./platform.js');
const { sweepCommands, sweepSkills }  = require('./capabilities.js');
const { removeShellHook }             = require('./shell-hook.js');
const { removeMcpEntry }              = require('./mcp-setup.js');

const HOME      = os.homedir();
const REPO_ROOT = path.resolve(__dirname, '..');

function _step(label) { process.stdout.write(`\n\x1b[1m${label}\x1b[0m\n`); }
function _ok(msg)     { process.stdout.write(`  \x1b[32m✓\x1b[0m ${msg}\n`); }
function _warn(msg)   { process.stdout.write(`  \x1b[33m!\x1b[0m ${msg}\n`); }

/**
 * Reverse of install: remove all Claws artifacts from the current project and ~/.claude/.
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]
 */
function run(opts = {}) {
  const { dryRun = false } = opts;
  const projectRoot = process.cwd();
  const claudeDir   = path.join(HOME, '.claude');

  process.stdout.write('\nUninstalling Claws...\n');

  // 1. VS Code extension
  _step('Uninstall VS Code extension');
  _uninstallExtension(dryRun);

  // 2. .claws-bin/
  _step('Remove .claws-bin/');
  const clawsBin = path.join(projectRoot, '.claws-bin');
  if (dryRun) {
    dryRunLog(`rm -rf ${clawsBin}`);
  } else if (fs.existsSync(clawsBin)) {
    fs.rmSync(clawsBin, { recursive: true });
    _ok('.claws-bin/ removed');
  }

  // 3. .mcp.json claws entry
  _step('Remove claws entry from .mcp.json');
  removeMcpEntry(projectRoot, dryRun);
  if (!dryRun) _ok('.mcp.json updated');

  // 4. CLAUDE.md CLAWS:BEGIN block (project)
  _step('Remove CLAWS:BEGIN block from CLAUDE.md');
  _removeClawsBlock(
    path.join(projectRoot, 'CLAUDE.md'),
    /<!-- CLAWS:BEGIN(?:[^>]*)-->/,
    /<!-- CLAWS:END(?:[^>]*)-->/,
    dryRun
  );

  // 5. ~/.claude/CLAUDE.md CLAWS-GLOBAL:BEGIN block
  _step('Remove CLAWS-GLOBAL:BEGIN block from ~/.claude/CLAUDE.md');
  _removeClawsBlock(
    path.join(HOME, '.claude', 'CLAUDE.md'),
    /<!-- CLAWS-GLOBAL:BEGIN(?:[^>]*)-->/,
    /<!-- CLAWS-GLOBAL:END(?:[^>]*)-->/,
    dryRun
  );

  // 6. Hooks from settings.json
  _step('Remove hooks from ~/.claude/settings.json');
  _removeHooks(dryRun);

  // 7. claws-default-behavior.md rule
  _step('Remove claws-default-behavior.md');
  const rulePath = path.join(claudeDir, 'rules', 'claws-default-behavior.md');
  if (dryRun) {
    dryRunLog(`rm ${rulePath}`);
  } else if (fs.existsSync(rulePath)) {
    fs.rmSync(rulePath);
    _ok('claws-default-behavior.md removed');
  }

  // 8. Commands + skills (global)
  _step('Remove commands and skills from ~/.claude/');
  sweepCommands(path.join(claudeDir, 'commands'), dryRun);
  sweepSkills(path.join(claudeDir, 'skills'),    dryRun);
  if (!dryRun) _ok('Commands and skills removed');

  // 9. Shell hook
  _step('Remove shell hook');
  const rcFile = getDefaultShellRcFile();
  removeShellHook(rcFile, dryRun);
  if (!dryRun) _ok(`Shell hook removed from ${rcFile}`);

  process.stdout.write('\n  \x1b[32m✓ Claws uninstalled\x1b[0m\n\n');
}

function _uninstallExtension(dryRun) {
  const codeCli = findCodeCli();
  if (!codeCli) {
    _warn('VS Code CLI not found — extension may still be installed; remove manually');
    return;
  }

  if (dryRun) { dryRunLog(`${codeCli} --uninstall-extension neunaha.claws`); return; }

  const r = spawnSync(codeCli, ['--uninstall-extension', 'neunaha.claws'], {
    stdio: 'inherit', encoding: 'utf8',
  });
  if (r.status === 0) { _ok('VS Code extension uninstalled'); return; }

  // CLI failed — remove extension directory directly
  const extDirs = [
    path.join(HOME, '.vscode', 'extensions'),
    path.join(HOME, '.cursor', 'extensions'),
  ];
  let removed = false;
  for (const dir of extDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir).filter(f => f.startsWith('neunaha.claws-'))) {
      fs.rmSync(path.join(dir, entry), { recursive: true });
      removed = true;
    }
  }
  if (removed) { _ok('Extension directory removed'); } else { _warn('Extension not found in extensions dirs'); }
}

function _removeClawsBlock(filePath, beginRe, endRe, dryRun) {
  if (!fs.existsSync(filePath)) return;

  if (dryRun) { dryRunLog(`remove claws block from ${filePath}`); return; }

  let content = fs.readFileSync(filePath, 'utf8');
  const beginMatch = content.match(beginRe);
  if (!beginMatch) return;

  const beginIdx = content.indexOf(beginMatch[0]);
  const endMatch  = content.match(endRe);
  if (!endMatch) return;

  const endIdx = content.lastIndexOf(endMatch[0]) + endMatch[0].length;
  content = (content.slice(0, beginIdx) + content.slice(endIdx)).replace(/\n{3,}/g, '\n\n');

  const tmp = filePath + '.claws-tmp.' + process.pid;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
  _ok(`CLAWS block removed from ${path.basename(filePath)}`);
}

function _removeHooks(dryRun) {
  const script    = path.join(REPO_ROOT, 'scripts', 'inject-settings-hooks.js');
  const hooksDir  = path.join(REPO_ROOT, 'scripts');
  const extraArgs = dryRun ? [hooksDir, '--dry-run', '--remove'] : [hooksDir, '--remove'];

  if (!fs.existsSync(script)) { _warn('inject-settings-hooks.js not found — hooks not removed'); return; }

  spawnSync(process.execPath, [script, ...extraArgs], {
    cwd: REPO_ROOT, stdio: 'inherit', encoding: 'utf8',
  });
}

module.exports = { run };
