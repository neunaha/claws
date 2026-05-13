'use strict';

const fs   = require('fs');
const path = require('path');
const { dryRunLog } = require('./platform.js');

const CLAWS_MCP_ENTRY = {
  command: 'node',
  args: ['.claws-bin/mcp_server.js'],
};

/**
 * Idempotently write (or update) the claws entry in <projectRoot>/.mcp.json.
 * Preserves all other mcpServers entries. Atomic write (tmp + rename).
 * @param {string} projectRoot
 * @param {boolean} [dryRun]
 */
function writeMcpJson(projectRoot, dryRun = false) {
  const mcpPath = path.join(projectRoot, '.mcp.json');

  if (dryRun) {
    dryRunLog(`merge claws entry into ${mcpPath}`);
    return;
  }

  let config = {};
  if (fs.existsSync(mcpPath)) {
    try {
      config = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    } catch {
      process.stderr.write(`  ! .mcp.json is malformed — preserving original, skipping merge\n`);
      return;
    }
  }

  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers.claws = CLAWS_MCP_ENTRY;

  const tmp = mcpPath + '.claws-tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, mcpPath);
}

/**
 * Remove the claws entry from <projectRoot>/.mcp.json (uninstall path).
 * @param {string} projectRoot
 * @param {boolean} [dryRun]
 */
function removeMcpEntry(projectRoot, dryRun = false) {
  const mcpPath = path.join(projectRoot, '.mcp.json');
  if (!fs.existsSync(mcpPath)) return;

  if (dryRun) {
    dryRunLog(`remove claws entry from ${mcpPath}`);
    return;
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
  } catch {
    process.stderr.write(`  ! .mcp.json is malformed — skipping\n`);
    return;
  }

  if (config.mcpServers && config.mcpServers.claws) {
    delete config.mcpServers.claws;
    const tmp = mcpPath + '.claws-tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, mcpPath);
  }
}

module.exports = { writeMcpJson, removeMcpEntry };
