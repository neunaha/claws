#!/usr/bin/env node
/**
 * Claws CLI — one-command installer for Claude Code plugin
 *
 * Usage:
 *   npx claws-cli            # install everything
 *   npx claws-cli install    # same
 *   npx claws-cli update     # pull latest + re-inject
 *   npx claws-cli status     # check if everything is wired
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const INSTALL_DIR = process.env.CLAWS_DIR || path.join(HOME, '.claws-src');
const REPO = 'https://github.com/neunaha/claws.git';

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: opts.silent ? 'pipe' : 'inherit', ...opts });
  } catch (e) {
    if (!opts.ignoreError) throw e;
    return '';
  }
}

function banner() {
  console.log('');
  console.log('  \x1b[38;2;200;90;62m╔═══════════════════════════════════════════╗\x1b[0m');
  console.log('  \x1b[38;2;200;90;62m║\x1b[0m                                           \x1b[38;2;200;90;62m║\x1b[0m');
  console.log('  \x1b[38;2;200;90;62m║\x1b[0m   \x1b[1;37mCLAWS\x1b[0m  Terminal Control Bridge         \x1b[38;2;200;90;62m║\x1b[0m');
  console.log('  \x1b[38;2;200;90;62m║\x1b[0m   \x1b[90mPowered by Claude Opus\x1b[0m                  \x1b[38;2;200;90;62m║\x1b[0m');
  console.log('  \x1b[38;2;200;90;62m║\x1b[0m                                           \x1b[38;2;200;90;62m║\x1b[0m');
  console.log('  \x1b[38;2;200;90;62m╚═══════════════════════════════════════════╝\x1b[0m');
  console.log('');
}

function detectExtDir() {
  const candidates = [
    path.join(HOME, '.vscode', 'extensions'),
    path.join(HOME, '.vscode-insiders', 'extensions'),
    path.join(HOME, '.cursor', 'extensions'),
    path.join(HOME, '.windsurf', 'extensions'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  const def = candidates[0];
  fs.mkdirSync(def, { recursive: true });
  return def;
}

function install() {
  banner();

  // 1. Clone or pull
  if (fs.existsSync(INSTALL_DIR)) {
    console.log('[1/7] Updating existing install...');
    run(`cd "${INSTALL_DIR}" && git pull origin main --quiet`, { ignoreError: true });
  } else {
    console.log('[1/7] Cloning...');
    run(`git clone --quiet "${REPO}" "${INSTALL_DIR}"`, { ignoreError: true });
  }

  // 2. Extension symlink
  console.log('[2/7] Installing VS Code extension...');
  const extDir = detectExtDir();
  const extLink = path.join(extDir, 'neunaha.claws-0.1.0');
  try { fs.unlinkSync(extLink); } catch {}
  try {
    fs.symlinkSync(path.join(INSTALL_DIR, 'extension'), extLink);
    console.log('  ✓ Extension linked');
  } catch {
    try {
      // Windows: junction
      run(`mklink /J "${extLink}" "${path.join(INSTALL_DIR, 'extension')}"`, { silent: true, ignoreError: true });
      console.log('  ✓ Extension linked (junction)');
    } catch {
      console.log('  ! Manual link needed: ln -s ' + path.join(INSTALL_DIR, 'extension') + ' ' + extLink);
    }
  }

  // 3. Permissions
  console.log('[3/7] Setting permissions...');
  ['scripts/terminal-wrapper.sh', 'scripts/install.sh', 'scripts/test-install.sh', 'mcp_server.js'].forEach(f => {
    try { fs.chmodSync(path.join(INSTALL_DIR, f), 0o755); } catch {}
  });
  console.log('  ✓ Scripts executable');

  // 4. MCP server — use claude mcp add if available, fall back to settings.json
  console.log('[4/7] Registering MCP server...');
  const mcpPath = path.join(INSTALL_DIR, 'mcp_server.js');
  const claudeMcpResult = spawnSync('claude', ['mcp', 'add', 'claws', '-s', 'user', '--', 'node', mcpPath], {
    encoding: 'utf8', stdio: 'pipe', timeout: 10000,
  });
  if (claudeMcpResult.status === 0) {
    console.log('  ✓ MCP server registered via claude mcp add');
  } else {
    // Fall back to settings.json
    const settingsPath = path.join(HOME, '.claude', 'settings.json');
    try {
      fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
      let cfg = {};
      if (fs.existsSync(settingsPath)) {
        cfg = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      }
      if (!cfg.mcpServers) cfg.mcpServers = {};
      cfg.mcpServers.claws = {
        command: 'node',
        args: [mcpPath],
        env: { CLAWS_SOCKET: '.claws/claws.sock' },
      };
      fs.writeFileSync(settingsPath, JSON.stringify(cfg, null, 2));
      console.log('  ✓ MCP server registered in ~/.claude/settings.json');
    } catch (e) {
      console.log('  ! Could not register MCP — add manually');
    }
  }

  // 5. Global context injection
  console.log('[5/7] Injecting rules + skills + commands...');
  const claudeDir = path.join(HOME, '.claude');
  const dirs = ['rules', 'skills', 'commands'];
  dirs.forEach(d => fs.mkdirSync(path.join(claudeDir, d), { recursive: true }));

  // Behavior rule
  const ruleSrc = path.join(INSTALL_DIR, 'rules', 'claws-default-behavior.md');
  if (fs.existsSync(ruleSrc)) {
    fs.copyFileSync(ruleSrc, path.join(claudeDir, 'rules', 'claws-default-behavior.md'));
  }

  // Skills
  const skills = ['claws-orchestration-engine', 'prompt-templates'];
  skills.forEach(skill => {
    const src = path.join(INSTALL_DIR, '.claude', 'skills', skill);
    const dest = path.join(claudeDir, 'skills', skill === 'prompt-templates' ? 'claws-prompt-templates' : skill);
    if (fs.existsSync(src)) {
      fs.mkdirSync(dest, { recursive: true });
      fs.readdirSync(src).forEach(f => {
        fs.copyFileSync(path.join(src, f), path.join(dest, f));
      });
    }
  });

  // Commands
  const cmdSrc = path.join(INSTALL_DIR, '.claude', 'commands');
  if (fs.existsSync(cmdSrc)) {
    fs.readdirSync(cmdSrc).filter(f => f.startsWith('claws-')).forEach(f => {
      fs.copyFileSync(path.join(cmdSrc, f), path.join(claudeDir, 'commands', f));
    });
  }
  console.log('  ✓ Rules + skills + 11 slash commands injected');

  // 6. Shell hook
  console.log('[6/7] Injecting shell hook...');
  const hookLine = `\n# CLAWS terminal hook\nsource "${path.join(INSTALL_DIR, 'scripts', 'shell-hook.sh')}"\n`;
  ['.zshrc', '.bashrc', '.bash_profile'].forEach(rc => {
    const rcPath = path.join(HOME, rc);
    if (fs.existsSync(rcPath)) {
      const content = fs.readFileSync(rcPath, 'utf8');
      if (!content.includes('CLAWS terminal hook')) {
        fs.appendFileSync(rcPath, hookLine);
        console.log(`  ✓ Hook added to ~/${rc}`);
      }
    }
  });

  // 7. Verify
  console.log('[7/7] Verifying...');
  let checks = 0;
  if (fs.existsSync(extLink)) { checks++; console.log('  ✓ Extension'); }
  if (fs.existsSync(mcpPath)) { checks++; console.log('  ✓ MCP server'); }
  if (fs.existsSync(path.join(claudeDir, 'rules', 'claws-default-behavior.md'))) { checks++; console.log('  ✓ Behavior rule'); }
  if (fs.existsSync(path.join(claudeDir, 'skills', 'claws-orchestration-engine'))) { checks++; console.log('  ✓ Orchestration engine'); }

  console.log('');
  console.log(`  \x1b[32m✓ Claws installed — ${checks}/4 checks passed\x1b[0m`);
  console.log('');
  console.log('  \x1b[1mReload VS Code:\x1b[0m Cmd+Shift+P → Developer: Reload Window');
  console.log('');
  console.log('  \x1b[1mThen try:\x1b[0m');
  console.log('    /claws-help          see the full prompt guide');
  console.log('    /claws-status        check if the bridge is live');
  console.log('    "run tests in a visible terminal"');
  console.log('    "spawn 3 parallel workers for lint, test, build"');
  console.log('');
}

function status() {
  banner();
  const checks = [];
  const extLink = path.join(detectExtDir(), 'neunaha.claws-0.1.0');
  checks.push(['Extension', fs.existsSync(extLink)]);
  checks.push(['MCP server', fs.existsSync(path.join(INSTALL_DIR, 'mcp_server.js'))]);
  checks.push(['Behavior rule', fs.existsSync(path.join(HOME, '.claude', 'rules', 'claws-default-behavior.md'))]);
  checks.push(['Orchestration skill', fs.existsSync(path.join(HOME, '.claude', 'skills', 'claws-orchestration-engine'))]);
  checks.push(['Node.js', spawnSync('node', ['--version'], { stdio: 'pipe' }).status === 0]);
  checks.forEach(([name, ok]) => console.log(`  ${ok ? '✓' : '✗'} ${name}`));
  console.log('');
}

// Main
const cmd = process.argv[2] || 'install';
if (cmd === 'install' || cmd === 'i') install();
else if (cmd === 'update' || cmd === 'u') install(); // update = re-run install (idempotent)
else if (cmd === 'status' || cmd === 's') status();
else {
  console.log('Usage: npx claws-cli [install|update|status]');
}
