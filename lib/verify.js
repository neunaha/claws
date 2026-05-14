'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawnSync, spawn } = require('child_process');

/**
 * Post-install verification. Returns array of failure strings (empty = OK).
 * All checks use project-local paths under projectRoot/.claude/ — matching
 * where lib/install.js (W7-6) places skills and rules.
 * @param {string} projectRoot
 * @returns {string[]}
 */
function verify(projectRoot) {
  const failures = [];

  if (!fs.existsSync(path.join(projectRoot, '.claws-bin', 'mcp_server.js'))) {
    failures.push('.claws-bin/mcp_server.js missing');
  }
  if (!fs.existsSync(path.join(projectRoot, '.mcp.json'))) {
    failures.push('.mcp.json missing');
  }
  if (!fs.existsSync(path.join(projectRoot, '.claude', 'commands', 'claws.md'))) {
    failures.push('claws commands missing from .claude/commands/');
  }
  if (!fs.existsSync(path.join(projectRoot, '.claude', 'skills', 'claws-prompt-templates'))) {
    failures.push('claws skills missing from .claude/skills/');
  }
  if (!fs.existsSync(path.join(projectRoot, '.claude', 'rules', 'claws-default-behavior.md'))) {
    failures.push('claws rule missing from .claude/rules/');
  }

  // W7h-28: Live MCP server handshake test (matches install.sh:1540-1557).
  // Spawns mcp_server.js, sends an initialize JSON-RPC request, expects
  // a response containing "claws" within 3s.
  const mcpServer = path.join(projectRoot, '.claws-bin', 'mcp_server.js');
  if (fs.existsSync(mcpServer)) {
    const handshakeResult = _mcpHandshake(mcpServer);
    if (!handshakeResult) {
      failures.push(`MCP server failed to respond — run: node ${mcpServer}`);
    }
  }

  // W7h-29: Hook registration check (matches install.sh:1508-1528).
  // Parse ~/.claude/settings.json and assert PreToolUse + PostToolUse hooks
  // are registered with Claws _source.
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    const hookFailures = _checkHooksRegistered(settingsPath);
    for (const f of hookFailures) failures.push(f);
  }

  return failures;
}

/**
 * Spawn mcp_server.js, send initialize JSON-RPC, expect response with "claws" in 3s.
 * Returns true if handshake succeeded, false otherwise.
 * @param {string} mcpServerPath
 * @returns {boolean}
 */
function _mcpHandshake(mcpServerPath) {
  try {
    const req = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'claws-verify', version: '1' } },
    }) + '\n';

    // Run the handshake in a synchronous subprocess via a self-contained node -e script.
    const script = `
const {spawn} = require('child_process');
const mcp = spawn('node', [process.argv[1]], {stdio:['pipe','pipe','ignore']});
let buf = '';
const done = (ok) => { try{mcp.kill()}catch{} process.exit(ok ? 0 : 1); };
const timer = setTimeout(() => done(false), 3000);
mcp.stdout.on('data', d => {
  buf += d.toString();
  if (buf.includes('claws')) { clearTimeout(timer); done(true); }
});
mcp.on('error', () => { clearTimeout(timer); done(false); });
mcp.stdin.write(${JSON.stringify(req)});
`;
    const r = spawnSync(process.execPath, ['-e', script, mcpServerPath],
      { encoding: 'utf8', timeout: 5000 });
    return r.status === 0;
  } catch (_) {
    return false;
  }
}

/**
 * Parse ~/.claude/settings.json and check that PreToolUse + PostToolUse
 * spawn-class hooks are registered (W7h-29). Matches install.sh:1508-1528.
 * @param {string} settingsPath
 * @returns {string[]} array of failure strings
 */
function _checkHooksRegistered(settingsPath) {
  const failures = [];
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (_) {
    return [];
  }

  const hooks   = settings.hooks || {};
  const preHooks = Array.isArray(hooks.PreToolUse)  ? hooks.PreToolUse  : [];
  const postHooks = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];

  const hasClawsPre  = preHooks.some(h => h.matcher && h.matcher.includes('mcp__claws__claws_worker'));
  const hasClawsPost = postHooks.some(h => h.matcher && h.matcher.includes('mcp__claws__claws_worker'));

  if (!hasClawsPre) {
    failures.push('MCP spawn-class PreToolUse hooks missing — re-run: node scripts/inject-settings-hooks.js');
  }
  if (!hasClawsPost) {
    failures.push('PostToolUse spawn-class hooks missing — re-run: node scripts/inject-settings-hooks.js');
  }
  return failures;
}

/**
 * Print a human-readable status dashboard for the current project.
 * Sets process.exitCode = 1 when any check fails.
 * All path checks are project-local (cwd-relative), matching install.sh behavior.
 */
function status() {
  const cwd = process.cwd();
  process.stdout.write('\nClaws installation status\n\n');

  const checks = [
    ['Node.js ≥ 18',             _nodeOk()],
    ['git in PATH',              _gitOk()],
    ['.claws-bin/ present',      fs.existsSync(path.join(cwd, '.claws-bin'))],
    ['.mcp.json present',        fs.existsSync(path.join(cwd, '.mcp.json'))],
    ['mcp_server.js in .claws-bin', fs.existsSync(path.join(cwd, '.claws-bin', 'mcp_server.js'))],
    ['commands present',         fs.existsSync(path.join(cwd, '.claude', 'commands', 'claws.md'))],
    ['skills present',           fs.existsSync(path.join(cwd, '.claude', 'skills', 'claws-prompt-templates'))],
    ['behavior rule present',    fs.existsSync(path.join(cwd, '.claude', 'rules', 'claws-default-behavior.md'))],
  ];

  let passing = 0;
  for (const [label, pass] of checks) {
    const icon  = pass ? '✓' : '✗';
    const color = pass ? '\x1b[32m' : '\x1b[31m';
    process.stdout.write(`  ${color}${icon}\x1b[0m ${label}\n`);
    if (pass) passing++;
  }

  process.stdout.write(`\n  ${passing}/${checks.length} checks passing\n\n`);
  if (passing < checks.length) {
    process.stdout.write('  Run: claws-code install\n\n');
    process.exitCode = 1;
  }
}

function _nodeOk() {
  return Number(process.versions.node.split('.')[0]) >= 18;
}

function _gitOk() {
  return spawnSync('git', ['--version'], { stdio: 'pipe' }).status === 0;
}

module.exports = { verify, status };
