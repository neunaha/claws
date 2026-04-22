#!/usr/bin/env node
// Claws PreToolUse hook — nudge long-running Bash toward claws_create.
'use strict';
const fs   = require('fs');
const path = require('path');

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

  const cmd   = (data.tool_input && data.tool_input.command) || '';
  const cwd   = data.cwd || process.cwd();

  // Only nudge if Claws socket is present
  const socketPath = path.join(cwd, '.claws', 'claws.sock');
  if (!fs.existsSync(socketPath)) process.exit(0);

  const isLongRunning = LONG_RUNNING_PATTERNS.some(p => p.test(cmd));
  if (!isLongRunning) process.exit(0);

  // Non-blocking nudge — just print a warning, don't block
  process.stderr.write(
    `[claws] Long-running command detected. Consider using claws_create + claws_send\n` +
    `        for visible, monitorable execution instead of Bash.\n`
  );
  process.exit(0);
});
