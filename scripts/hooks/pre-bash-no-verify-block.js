#!/usr/bin/env node
// PreToolUse hook: blocks `git commit --no-verify` (and similar bypass flags)
// per advisory-mechanism-audit Finding F32.
//
// Workers/orchestrators that try to skip pre-commit hooks get a hard
// rejection with a clear error message.
//
// Hook input: Claude Code passes JSON via stdin: { tool: 'Bash', args: { command: '...' } }
// Hook output: exit 0 = allow; exit 1 with stderr message = block.

'use strict';

if (!process.env.CLAWS_DEBUG) {
  process.on('uncaughtException', () => { try { process.exit(0); } catch {} });
  process.on('unhandledRejection', () => { try { process.exit(0); } catch {} });
}

const fs = require('fs');
const LOG = '/tmp/claws-hook-no-verify.log';

function log(msg) {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch (_) {}
}

// Self-kill safety — hook can never hang the parent process.
setTimeout(() => { log('hook self-kill 5s'); process.exit(0); }, 5000).unref();

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let parsed;
  try {
    parsed = JSON.parse(input || '{}');
  } catch (e) {
    log(`malformed input: ${e.message}`);
    process.exit(0);
  }

  const cmd = (parsed.tool_input && parsed.tool_input.command) ||
              (parsed.args && parsed.args.command) || '';
  if (typeof cmd !== 'string') process.exit(0);

  // Match git commit/rebase/push with bypass flags.
  // The -n short form regex uses a negative lookahead to avoid matching -name, -no, etc.
  const blockedPatterns = [
    /\bgit\s+commit\b[^|;&\n]*--no-verify\b/,
    /\bgit\s+commit\b[^|;&\n]*\s-n(?![a-zA-Z0-9_-])/,
    /\bgit\s+commit\b[^|;&\n]*--no-gpg-sign\b/,
    /\bgit\s+rebase\b[^|;&\n]*--no-verify\b/,
    /\bgit\s+push\b[^|;&\n]*--no-verify\b/,
    /\bcommit\.gpgsign=false\b/,
  ];

  for (const re of blockedPatterns) {
    if (re.test(cmd)) {
      const reason =
        '[claws-hook] BLOCKED: bypass flag detected in git command. ' +
        'Pre-commit hooks exist for a reason (tests, lint, type checks). ' +
        'Fix the underlying issue instead of bypassing. ' +
        'If you genuinely need to bypass, ask the human user explicitly. ' +
        `Pattern matched: ${re.source}`;
      log(`BLOCKED: ${cmd.slice(0, 200)}`);
      process.stderr.write(reason + '\n');
      process.exit(1);
    }
  }

  log(`ALLOWED: ${cmd.slice(0, 100)}`);
  process.exit(0);
});
