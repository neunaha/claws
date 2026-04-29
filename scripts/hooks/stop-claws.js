#!/usr/bin/env node
// Claws Stop hook — enforce CLEANUP and REFLECT before session ends.
//
// SAFETY CONTRACT (v0.7.3): never crash, never block, never exit non-zero.
// Hooks are advisory; failure to load lifecycle-state.js (e.g. file missing
// after partial install) must not surface as "hook error" in Claude Code.
'use strict';

// M-24: gate error handlers on CLAWS_DEBUG — when CLAWS_DEBUG=1, errors
// propagate visibly for debugging instead of being silently swallowed.
if (!process.env.CLAWS_DEBUG) {
  process.on('uncaughtException', () => { try { process.exit(0); } catch {} });
  process.on('unhandledRejection', () => { try { process.exit(0); } catch {} });
}

// M-13: 5-second self-kill safety timer — hook can never hang the parent process.
setTimeout(() => { process.exit(0); }, 5000).unref();

let input = '';
// M-13: single try block for both 'data' and 'end' — fail together or not at all.
try {
  process.stdin.on('data', d => { input += d; });
  process.stdin.on('end', () => {
    try {
      const fs   = require('fs');
      const path = require('path');
      // Lazy-require lifecycle-state so a missing dep file never crashes
      // the hook at module-load time. If readState is unavailable, we just
      // skip the workers/reflect checks and exit 0.
      let readState = null;
      try { readState = require('./lifecycle-state').readState; } catch {}

      let cwd = process.cwd();
      try {
        const parsed = JSON.parse(input);
        if (parsed.cwd) cwd = parsed.cwd;
      } catch { /* use process.cwd() */ }

      const socketPath = path.join(cwd, '.claws', 'claws.sock');
      if (!fs.existsSync(socketPath)) { process.exit(0); return; }

      const state = readState ? (function () { try { return readState(cwd); } catch { return null; } })() : null;

      if (!state) {
        try {
          process.stderr.write(
            `[claws] Session ending — if you created terminals this session, close them now:\n` +
            `        claws_list → identify terminals you own → claws_close each one.\n`
          );
        } catch {}
        process.exit(0);
        return;
      }

      // Check for unclosed workers
      const workers = Array.isArray(state.workers) ? state.workers : [];
      const unclosed = workers.filter(w => typeof w === 'object' ? !w.closed : false);
      if (unclosed.length > 0) {
        const ids = unclosed.map(w => w.id).join(', ');
        try {
          process.stderr.write(
            `[LIFECYCLE CLEANUP] ${unclosed.length} terminal(s) still open: ${ids}.\n` +
            `        Close them with claws_close before ending.\n`
          );
        } catch {}
      }

      // Check for missing REFLECT phase
      const phases_completed = Array.isArray(state.phases_completed) ? state.phases_completed : [];
      if (!phases_completed.includes('REFLECT')) {
        try {
          process.stderr.write(
            `[LIFECYCLE REFLECT] Write your reflect summary to .claws/lifecycle-reflect.md\n` +
            `        — what succeeded, what failed, what to improve next time.\n`
          );
        } catch {}
      }

      process.exit(0);
    } catch {
      process.exit(0);
    }
  });
} catch {
  process.exit(0);
}
