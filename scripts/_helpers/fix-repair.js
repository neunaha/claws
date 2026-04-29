#!/usr/bin/env node
// M-45/M-46: safe repair helper for fix.sh — replaces inline node -e repair
// scripts that used JSON.parse (silent-reset on malformed, M-02) + writeFileSync
// (non-atomic, M-30) + embedded paths (injection risk, M-20).
//
// Uses json-safe.mjs: abort-on-malformed, atomic write, JSONC-tolerant.
// Paths passed via env vars — no string interpolation into JS source.
//
// Usage (called by fix.sh):
//   CLAWS_REPAIR_TARGET=<path> node fix-repair.js mcp
//   CLAWS_REPAIR_TARGET=<path> node fix-repair.js extensions

'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

const HELPERS_URL = pathToFileURL(path.resolve(__dirname, 'json-safe.mjs')).href;

(async () => {
  const { mergeIntoFile } = await import(HELPERS_URL);
  const op = process.argv[2];
  const target = process.env.CLAWS_REPAIR_TARGET;

  if (!op || !target) {
    console.error('[fix-repair] Usage: CLAWS_REPAIR_TARGET=<path> node fix-repair.js <mcp|extensions>');
    process.exit(1);
  }

  let result;

  if (op === 'mcp') {
    result = await mergeIntoFile(target, (cfg) => {
      if (!cfg.mcpServers) cfg.mcpServers = {};
      cfg.mcpServers.claws = {
        command: 'node',
        args: ['./.claws-bin/mcp_server.js'],
        env: { CLAWS_SOCKET: '.claws/claws.sock' },
      };
    });
  } else if (op === 'extensions') {
    result = await mergeIntoFile(target, (cfg) => {
      if (!Array.isArray(cfg.recommendations)) cfg.recommendations = [];
      if (!cfg.recommendations.includes('neunaha.claws')) {
        cfg.recommendations.push('neunaha.claws');
      }
    });
  } else {
    console.error('[fix-repair] Unknown operation:', op);
    process.exit(1);
  }

  if (!result.ok) {
    console.error(`[fix-repair] ${op} repair failed: ${result.error.message}`);
    if (result.error.backupSavedAt) {
      console.error('  Malformed original backed up to:', result.error.backupSavedAt);
      console.error('  File left unchanged — manual intervention required.');
    }
    process.exit(1);
  }
  console.log(`[fix-repair] ${op === 'mcp' ? '.mcp.json' : 'extensions.json'} repaired (atomic write)`);
})().catch(e => {
  console.error('[fix-repair] unexpected error:', e.message);
  process.exit(1);
});
