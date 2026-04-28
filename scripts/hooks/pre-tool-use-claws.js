#!/usr/bin/env node
// Claws PreToolUse hook — Bash long-running enforcement.
//
// Default mode: long-running Bash patterns get a soft nudge on stderr, the
// tool call proceeds. Existing behavior since v0.6.1.
//
// CLAWS_STRICT=1 (env var, set in user shell or settings.json env block):
// long-running Bash patterns return permissionDecision:"deny" via the
// PreToolUse hookSpecificOutput. Claude Code blocks the tool call and shows
// the reason — which tells the model exactly what to use instead.
//
// Lifecycle gate moved server-side in v0.6.5 — removed from this hook.
'use strict';
const fs   = require('fs');
const path = require('path');

// Patterns that almost always indicate orchestration work — long-running
// servers, watchers, or background processes — where a wrapped Claws terminal
// is strictly better than a fire-and-forget Bash call. Conservative list:
// every entry should be unambiguously long-running so strict mode never
// blocks ordinary commands like `ls`, `git status`, or one-shot builds.
const LONG_RUNNING_PATTERNS = [
  /\bnpm (run )?(start|dev|serve|watch)\b/i,
  /\byarn (start|dev|serve|watch)\b/i,
  /\bpnpm (run )?(start|dev|serve|watch)\b/i,
  /\bbun (run )?(start|dev|serve|watch)\b/i,
  /\bnode\b.*\bserver\b/i,
  /\bpython\b.*\bserver\b/i,
  /\b(uvicorn|gunicorn|hypercorn)\b/i,
  /\bflask run\b/i,
  /\brails (server|s)\b/i,
  /\bcargo (watch|run)\b/i,
  /\bgo run\b/i,
  /\bmake (run|serve|start|dev)\b/i,
  /\bnodemon\b/i,
  /\bnohup\b/i,
];

const STRICT = process.env.CLAWS_STRICT === '1';

function denyBash(matchedPattern, command) {
  // Modern PreToolUse hard-block path. permissionDecision:"deny" is the
  // canonical signal; permissionDecisionReason is shown to the model so it
  // can pivot. See Claude Code SDK: entrypoints/sdk/coreTypes.ts (HOOK_EVENTS)
  // and types/hooks.ts (syncHookResponseSchema).
  const reason = [
    `[claws strict] Bash command matches a long-running pattern (${matchedPattern}).`,
    `Use Claws instead so the work runs in a visible, monitorable terminal:`,
    ``,
    `  1. claws_create({ name: "<slug>", wrapped: true })`,
    `  2. claws_send({ id: <N>, text: ${JSON.stringify(command)} })`,
    `  3. claws_read_log({ id: <N>, lines: 50 }) — to observe`,
    `  4. claws_close({ id: <N> }) — when done`,
    ``,
    `If you genuinely need a one-shot, short-running Bash call, narrow the command.`,
  ].join('\n');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  let data = {};
  try { data = JSON.parse(input); } catch { process.exit(0); }

  const toolName = data.tool_name || '';
  const cwd      = data.cwd || process.cwd();

  // Only act if Claws socket is present in the cwd
  const socketPath = path.join(cwd, '.claws', 'claws.sock');
  if (!fs.existsSync(socketPath)) process.exit(0);

  // --- Bash long-running guard ---
  if (toolName === 'Bash') {
    const cmd = (data.tool_input && data.tool_input.command) || '';
    const match = LONG_RUNNING_PATTERNS.find(p => p.test(cmd));
    if (match) {
      if (STRICT) {
        denyBash(match.toString(), cmd);
        return;
      }
      process.stderr.write(
        `[claws] Long-running command detected. Consider using claws_create + claws_send\n` +
        `        for visible, monitorable execution instead of Bash.\n` +
        `        (Set CLAWS_STRICT=1 to hard-block these and force the Claws path.)\n`
      );
    }
    process.exit(0);
  }

  process.exit(0);
});
