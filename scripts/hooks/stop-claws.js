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
      // LH-9: lifecycle-state is no longer read by the Stop hook. The
      // extension's TTL watchdog + reconcile-on-boot are the deterministic
      // close mechanism. This hook is now responsible only for cleaning up
      // sidecar/tail processes and the pre-tool-use grace file.

      let cwd = process.cwd();
      try {
        const parsed = JSON.parse(input);
        if (parsed.cwd) cwd = parsed.cwd;
      } catch { /* use process.cwd() */ }

      const socketPath = path.join(cwd, '.claws', 'claws.sock');
      if (!fs.existsSync(socketPath)) { process.exit(0); return; }

      // Kill stream-events.js sidecar daemon spawned by session-start-claws.js
      try {
        const { spawnSync } = require('child_process');
        const pg = spawnSync('pgrep', ['-f', 'stream-events\\.js.*--auto-sidecar'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        if (pg.status === 0 && pg.stdout) {
          const pids = pg.stdout.trim().split('\n').filter(Boolean);
          for (const pid of pids) {
            try { spawnSync('kill', ['-TERM', pid.trim()], { stdio: 'ignore' }); } catch {}
          }
        }
      } catch { /* sidecar kill failure must never block the hook */ }

      // Kill orphan tail -F processes monitoring events.log spawned this session.
      try {
        const { spawnSync } = require('child_process');
        const pg2 = spawnSync('pgrep', ['-f', 'tail.*\\.claws/events\\.log'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        if (pg2.status === 0 && pg2.stdout) {
          const pids = pg2.stdout.trim().split('\n').filter(Boolean);
          for (const pid of pids) {
            try { spawnSync('kill', ['-TERM', pid.trim()], { stdio: 'ignore' }); } catch {}
          }
        }
      } catch { /* tail kill failure must never block the hook */ }

      // Remove the pre-tool-use grace file so the next session starts with a
      // fresh 60 s window and the Monitor-arm enforcement resets cleanly.
      try {
        const cwdKey = Buffer.from(cwd).toString('base64').replace(/[+/=]/g, '_').slice(0, 12);
        const graceFile = `/tmp/claws-pretooluse-grace-${cwdKey}`;
        if (fs.existsSync(graceFile)) fs.unlinkSync(graceFile);
      } catch { /* grace file removal must never block the hook */ }

      // LH-9: force-close removed. The Stop hook fires at the end of every
      // assistant turn (Anthropic semantics) — not at session shutdown — so
      // closing detached workers here killed long-running missions between
      // turns. Worker lifetime is now governed by the TTL watchdog inside
      // the extension (default 10min idle, 4h hard ceiling), and stale
      // entries in lifecycle-state.json self-heal via reconcile-on-boot in
      // ClawsServer's constructor. The hook keeps only the sidecar/tail
      // cleanup above.
      process.exit(0);
    } catch {
      process.exit(0);
    }
  });
} catch {
  process.exit(0);
}
