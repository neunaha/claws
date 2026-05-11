#!/usr/bin/env node
// Layer 1 of per-worker Monitor enforcement.
//
// Catches the gap where lifecycle.monitors[] is pre-populated by mcp_server
// atomically at spawn time, so the PostToolUse hook's monitors.some() check
// is vacuously satisfied even when no OS-level stream-events.js process is
// actually arming. This script sleeps grace_ms, then checks via pgrep whether
// a real stream-events.js --wait <corrId> process is alive. If not, it
// connects to the claws socket and publishes system.monitor.unarmed.
//
// Layer 2 (planned: hello-with-monitorCorrelationId) will close the loophole
// structurally by having stream-events.js register its corrId via hello;
// Layer 1 detects and emits a warning event.
//
// Idempotent: publishing system.monitor.unarmed twice for the same corrId is
// harmless — consumers can dedupe on correlation_id.
//
// Usage: node monitor-arm-watch.js --corr-id <uuid> --term-id <id>
//                                  [--grace-ms <ms>] --socket <path>
// Exit codes: 0 = monitor found, 1 = unarmed (event published), 2 = error
'use strict';

const { spawnSync } = require('child_process');
const net           = require('net');

const rawArgs = process.argv.slice(2);
let corrId     = null;
let termId     = null;
let graceMs    = 10000;
let socketPath = null;

for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if      (a === '--corr-id')  { corrId     = rawArgs[++i] || null; }
  else if (a === '--term-id')  { termId     = String(rawArgs[++i] ?? ''); }
  else if (a === '--grace-ms') { graceMs    = parseInt(rawArgs[++i], 10) || 10000; }
  else if (a === '--socket')   { socketPath = rawArgs[++i] || null; }
}

if (!corrId || !socketPath) {
  process.stderr.write(`monitor-arm-watch: exit 2 | reason=missing-args | corr=${corrId}\n`);
  process.exit(2);
}

// Emit a startup line immediately (before the grace-period sleep) so the log
// file is non-empty even if we crash during the sleep or pgrep phases.
process.stderr.write(
  `monitor-arm-watch: starting | corr=${corrId} | term=${termId}` +
  ` | socket=${socketPath} | cwd=${process.cwd()}\n`
);

(async () => {
  await sleep(graceMs);

  let pg;
  try {
    pg = spawnSync('/usr/bin/pgrep', ['-f', `stream-events.js.*--wait ${corrId}`], {
      encoding: 'utf8',
      timeout:  5000,
    });
  } catch (e) {
    process.stderr.write(`monitor-arm-watch: exit 2 | reason=pgrep-spawn-failed:${e.message} | corr=${corrId}\n`);
    process.exit(2);
  }

  if (pg.error) {
    process.stderr.write(`monitor-arm-watch: exit 2 | reason=pgrep-error:${pg.error.message} | corr=${corrId}\n`);
    process.exit(2);
  }

  if (pg.status === 0) {
    // Monitor process is alive — nothing to do.
    process.stderr.write(`monitor-arm-watch: exit 0 | reason=monitor-found | corr=${corrId}\n`);
    process.exit(0);
  }

  if (pg.status === 1) {
    // No matching process — publish warning event.
    try {
      await publishUnarmed(socketPath, {
        terminal_id:    termId,
        correlation_id: corrId,
        grace_ms:       graceMs,
        detected_at:    new Date().toISOString(),
      });
    } catch (e) {
      process.stderr.write(`monitor-arm-watch: exit 2 | reason=socket-error:${e.message} | corr=${corrId}\n`);
      process.exit(2);
    }
    process.stderr.write(`monitor-arm-watch: exit 1 | reason=unarmed-published | corr=${corrId}\n`);
    process.exit(1);
  }

  process.stderr.write(`monitor-arm-watch: exit 2 | reason=pgrep-unexpected-status:${pg.status} | corr=${corrId}\n`);
  process.exit(2);
})();

function publishUnarmed(sockPath, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath);
    let buf   = '';
    let state = 'hello'; // 'hello' → 'publish' → done
    let done  = false;

    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch {}
      if (err) reject(err);
      else resolve();
    };

    const timer = setTimeout(() => finish(new Error('socket timeout')), 5000);

    const send = (obj) => {
      const id = Math.random().toString(36).slice(2);
      try { sock.write(JSON.stringify({ id, ...obj }) + '\n'); } catch (e) { finish(e); }
    };

    sock.on('connect', () => {
      send({ cmd: 'hello', protocol: 'claws/2', peerName: 'monitor-arm-watch', role: 'observer' });
    });

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { JSON.parse(line); } catch { continue; }
        if (state === 'hello') {
          state = 'publish';
          send({
            cmd: 'publish', protocol: 'claws/2',
            topic: 'system.monitor.unarmed',
            payload,
          });
        } else if (state === 'publish') {
          finish(null);
        }
      }
    });

    sock.on('error', (e) => finish(e));
    sock.on('close', () => {
      if (!done) finish(new Error('connection closed before publish ack'));
    });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
