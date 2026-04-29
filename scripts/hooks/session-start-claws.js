#!/usr/bin/env node
// Claws SessionStart hook — detects Claws socket and emits lifecycle reminder.
//
// SAFETY CONTRACT: this hook MUST NEVER block, crash, or exit non-zero.
// Any internal error → silent exit 0. Hooks are advisory; failing loud
// blocks the user's tool calls and creates the very "hook errors" we're
// trying to eliminate. v0.7.3 hardening.
'use strict';

// M-24: gate error handlers on CLAWS_DEBUG — when CLAWS_DEBUG=1, errors
// propagate visibly for debugging instead of being silently swallowed.
if (!process.env.CLAWS_DEBUG) {
  process.on('uncaughtException', () => { try { process.exit(0); } catch {} });
  process.on('unhandledRejection', () => { try { process.exit(0); } catch {} });
}

// M-13: 5-second self-kill safety timer — hook can never hang the parent process.
// .unref() so the timer doesn't prevent normal early exit.
setTimeout(() => { process.exit(0); }, 5000).unref();

let input = '';
// M-13: single try block wrapping both 'data' and 'end' listeners — if either
// registration throws (pathological stdin state), both fail together cleanly.
try {
  process.stdin.on('data', d => { input += d; });
  process.stdin.on('end', () => {
    try {
      const fs   = require('fs');
      const path = require('path');

      let cwd = process.cwd();
      try {
        const parsed = JSON.parse(input);
        if (parsed.cwd) cwd = parsed.cwd;
      } catch { /* use process.cwd() */ }

      const socketPath = path.join(cwd, '.claws', 'claws.sock');
      if (!fs.existsSync(socketPath)) { process.exit(0); return; }

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

      try { process.stdout.write(JSON.stringify({ type: 'system', content: reminder }) + '\n'); } catch {}
      process.exit(0);
    } catch {
      process.exit(0);
    }
  });
} catch {
  process.exit(0);
}
