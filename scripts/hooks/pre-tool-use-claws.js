#!/usr/bin/env node
// Claws PreToolUse hook — lifecycle gate + long-running Bash nudge.
'use strict';
const fs   = require('fs');
const path = require('path');
const { readState } = require('./lifecycle-state');

const LONG_RUNNING_PATTERNS = [
  /npm (run )?(start|dev|serve|watch)/i,
  /yarn (start|dev|serve|watch)/i,
  /node.*server/i,
  /python.*server/i,
  /uvicorn|gunicorn|flask run/i,
  /rails server|rails s\b/i,
  /cargo watch/i,
  /go run/i,
  /make (run|serve|start)/i,
];

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  let data = {};
  try { data = JSON.parse(input); } catch { process.exit(0); }

  const toolName = data.tool_name || '';
  const cwd      = data.cwd || process.cwd();

  // Only act if Claws socket is present
  const socketPath = path.join(cwd, '.claws', 'claws.sock');
  if (!fs.existsSync(socketPath)) process.exit(0);

  // --- Bash long-running nudge (advisory, non-blocking) ---
  if (toolName === 'Bash') {
    const cmd = (data.tool_input && data.tool_input.command) || '';
    if (LONG_RUNNING_PATTERNS.some(p => p.test(cmd))) {
      process.stderr.write(
        `[claws] Long-running command detected. Consider using claws_create + claws_send\n` +
        `        for visible, monitorable execution instead of Bash.\n`
      );
    }
    process.exit(0);
  }

  // --- Lifecycle gate: block claws_create when no PLAN exists ---
  if (toolName === 'mcp__claws__claws_create') {
    const state = readState(cwd);
    if (!state || state.phase === 'PLAN-REQUIRED') {
      process.stdout.write(JSON.stringify({
        type: 'error',
        content: '[LIFECYCLE GATE — PLAN REQUIRED] Run /claws-plan first to document your mission. This unlocks terminal creation.',
      }));
      process.exit(2);
    }
    process.exit(0);
  }

  // --- Lifecycle gate: block any claws_* tool when phase is PLAN-REQUIRED ---
  if (toolName.startsWith('mcp__claws__')) {
    const state = readState(cwd);
    if (!state || state.phase === 'PLAN-REQUIRED') {
      process.stdout.write(JSON.stringify({
        type: 'error',
        content: '[LIFECYCLE GATE — PLAN REQUIRED] Run /claws-plan first to document your mission. This unlocks terminal creation.',
      }));
      process.exit(2);
    }
  }

  process.exit(0);
});
