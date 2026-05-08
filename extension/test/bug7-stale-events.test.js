'use strict';
// Regression tests for Bug 7 — stream-events.js Check 2 identity matching.
//
// Bug 7: Check 2 originally matched system.worker.terminated by terminal_id,
// a session-local integer that VS Code recycles. A stale entry from a prior
// session with the same numeric terminal_id would false-exit 0 on the first
// rearm cycle. Fix: Check 2 uses corrId-only matching.
//
// (a) stale terminated entry (no corrId, sentAt 2h ago) — Check 2 must NOT
//     match; process must stay alive, rearming on recent liveness events.
// (b) current-session terminated entry with matching corrId — Check 2 MUST
//     match and exit 0.
//
// Together these prove the identity contract: stale-by-termId rejected,
// recent-by-corrId accepted.
//
// Mirrors the makeTmp() / startFakeServer() pattern from monitor-rearm.test.js.

const assert  = require('node:assert/strict');
const { spawn } = require('child_process');
const net     = require('net');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const crypto  = require('crypto');

const STREAM_EVENTS = path.resolve(__dirname, '../../scripts/stream-events.js');
const REARM_CYCLE   = '200';
const STALE_MS      = '5000';

function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-bug7-'));
  const clawsDir = path.join(dir, '.claws');
  fs.mkdirSync(clawsDir);
  const sock = path.join(clawsDir, 'claws.sock');
  return { dir, clawsDir, sock };
}

function writeEventsLog(clawsDir, lines) {
  fs.writeFileSync(path.join(clawsDir, 'events.log'), lines.join('\n') + '\n', 'utf8');
}

function eventLine(topic, extra, sentAt) {
  return JSON.stringify({
    type: 'event', push: 'message', protocol: 'claws/2',
    topic, from: 'server', payload: { ...extra },
    sentAt: sentAt ?? Date.now(),
    sequence: 1, recvTs: new Date().toISOString()
  });
}

// Creates a fake claws socket server that accepts connections, sends hello ack,
// and keeps the connection alive (so stream-events.js won't exit on socket close).
// Returns { server, cleanup() }.
function startFakeServer(sockPath) {
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.cmd === 'hello') {
            conn.write(JSON.stringify({ rid: msg.id, ok: true, peerId: 'test-peer-1' }) + '\n');
          } else if (msg.cmd === 'subscribe') {
            conn.write(JSON.stringify({ rid: msg.id, ok: true, subscriptionId: `sub-${msg.id}` }) + '\n');
          }
        } catch { /* ignore malformed */ }
      }
    });
    conn.on('error', () => {});
  });
  server.listen(sockPath);
  const cleanup = () => new Promise(res => server.close(() => res()));
  return { server, cleanup };
}

function waitForExit(proc, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    const t = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Process did not exit within ${timeoutMs}ms. stderr: ${stderr}`));
    }, timeoutMs);
    proc.on('exit', (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal, stderr });
    });
  });
}

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
    failed++;
  }
}

(async () => {
  console.log('bug7-stale-events.test.js');

  // (a) Stale terminated entry (no corrId, 2h ago) — must NOT trigger Check 2 exit 0.
  //     A recent liveness event ensures Check 3 rearmsthe process so it stays alive.
  //     On pre-fix code (terminal_id matching), Check 2 false-exits 0 → process gone.
  //     On fixed code (corrId-only), Check 2 is a no-op → process stays alive → PASS.
  await runTest('(a) stale worker.terminated entry (no corrId) is rejected by Check 2 — process stays alive', async () => {
    const { clawsDir, sock } = makeTmp();
    const corrId = crypto.randomUUID();
    const termId = 'T-recycled-id';
    const now = Date.now();

    writeEventsLog(clawsDir, [
      // Stale terminated entry from a prior session: same terminal_id, no corrId, 2h ago.
      eventLine('system.worker.terminated',
        { terminal_id: termId, terminated_at: new Date(now - 2 * 60 * 60 * 1000).toISOString() },
        now - 2 * 60 * 60 * 1000),
      // Recent liveness event so Check 3 rearmsthe process (terminal IS alive).
      eventLine('vehicle.1.state', { terminalId: termId }, now - 200),
    ]);

    const { cleanup } = startFakeServer(sock);
    const proc = spawn(process.execPath, [
      STREAM_EVENTS,
      '--wait', corrId,
      '--keep-alive-on', termId,
      '--rearm-cycle', REARM_CYCLE,
      '--stale-threshold', STALE_MS,
      '--timeout-ms', '600000',
    ], { env: { ...process.env, CLAWS_SOCKET: sock } });

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });

    let aliveAt1500 = false;
    await new Promise(resolve => {
      setTimeout(() => { aliveAt1500 = true; resolve(); }, 1500);
      proc.on('exit', () => resolve());
    });

    proc.kill('SIGKILL');
    await waitForExit(proc, 2000).catch(() => {});
    await cleanup();

    assert.equal(aliveAt1500, true,
      'process should still be alive at 1500ms — stale terminated entry must not trigger Check 2 false-positive exit');
    assert.ok(!stderr.includes('matched (raced) — system.worker.terminated'),
      `stderr must NOT contain matched line for system.worker.terminated (stale entry must be rejected). stderr: ${stderr}`);
  });

  // (b) Current-session terminated entry with matching corrId — Check 2 MUST exit 0.
  //     This proves the corrId-based match path still works for legitimate completions.
  await runTest('(b) current-session worker.terminated with matching corrId → exit 0', async () => {
    const { clawsDir, sock } = makeTmp();
    const corrId = crypto.randomUUID();
    const termId = 'T-current-id';
    const now = Date.now();

    writeEventsLog(clawsDir, [
      // Current-session terminated entry: matching corrId, sentAt < 100ms ago.
      eventLine('system.worker.terminated',
        { terminal_id: termId, terminated_at: new Date().toISOString(), correlation_id: corrId },
        now - 50),
    ]);

    const { cleanup } = startFakeServer(sock);
    const proc = spawn(process.execPath, [
      STREAM_EVENTS,
      '--wait', corrId,
      '--keep-alive-on', termId,
      '--rearm-cycle', REARM_CYCLE,
      '--stale-threshold', STALE_MS,
      '--timeout-ms', '600000',
    ], { env: { ...process.env, CLAWS_SOCKET: sock } });

    const { code } = await waitForExit(proc, 1500);
    await cleanup();

    assert.equal(code, 0,
      `expected exit 0 for current-session corrId match — Check 2 must fire on matching corrId. got ${code}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
