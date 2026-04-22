#!/usr/bin/env node
// Claws SessionStart hook — detects Claws socket and emits lifecycle reminder.
'use strict';
const fs   = require('fs');
const path = require('path');

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  let cwd = process.cwd();
  try {
    const parsed = JSON.parse(input);
    if (parsed.cwd) cwd = parsed.cwd;
  } catch { /* use process.cwd() */ }

  const socketPath = path.join(cwd, '.claws', 'claws.sock');
  if (!fs.existsSync(socketPath)) process.exit(0);

  const reminder = [
    '## Claws Active — Terminal Orchestration MANDATORY',
    '',
    'The Claws MCP server is running. You MUST follow these rules:',
    '',
    '1. NEVER use Bash for long-lived processes. Use claws_create + claws_send.',
    '2. ALWAYS use wrapped=true on new terminals.',
    '3. Worker boot sequence (ALWAYS in this order):',
    '   Step 1: claws_create name="<slug>" wrapped=true',
    '   Step 2: claws_send id=<N> text="claude --model claude-sonnet-4-6 --dangerously-skip-permissions"',
    '   Step 3: Poll claws_read_log until "trust" appears (~20s)',
    '   Step 4: claws_send id=<N> text="1" newline=false',
    '   Step 5: Poll claws_read_log until "bypass" appears (~10s)',
    '   Step 6: claws_send id=<N> text="<mission>" newline=false',
    '   Step 7: claws_send id=<N> text="\\r" newline=false',
    '4. ALWAYS close every terminal you create when done.',
    '5. NEVER touch terminals you did not create.',
    '',
    'Lifecycle: PLAN → SPAWN → DEPLOY → OBSERVE → RECOVER → HARVEST → CLEANUP → REFLECT',
    'Slash commands: /claws-boot /claws-go /claws-fleet /claws-cleanup /claws-fix /claws-help',
  ].join('\n');

  process.stdout.write(JSON.stringify({ type: 'system', content: reminder }) + '\n');
  process.exit(0);
});
