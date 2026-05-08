'use strict';
// Unit tests for stream-events.js --wait rearm decision loop.
// Branch coverage: (a) completed corrId, (b) terminal.closed corrId,
// (c) terminated corrId, (d) alive terminal → rearm, (e) stale → exit 2,
// (f) live socket event → exit 0 [skipped, requires real socket — e2e],
// (g) no --keep-alive-on → exit 3 (backward compat).

const assert  = require('node:assert/strict');
const { spawn } = require('child_process');
const net     = require('net');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const crypto  = require('crypto');

const STREAM_EVENTS = path.resolve(__dirname, '../../scripts/stream-events.js');
const REARM_CYCLE   = '200';
const STALE_MS      = '1000';

function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-rearm-'));
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

function runWait(corrId, termId, sockPath, extraArgs = []) {
  const args = [STREAM_EVENTS, '--wait', corrId,
    '--rearm-cycle', REARM_CYCLE, '--stale-threshold', STALE_MS,
    ...(termId ? ['--keep-alive-on', termId] : []),
    ...extraArgs
  ];
  return spawn(process.execPath, args, { env: { ...process.env, CLAWS_SOCKET: sockPath } });
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
  console.log('monitor-rearm.test.js');

  // (a) events.log contains system.worker.completed with corrId → exit 0
  await runTest('(a) completed corrId → exit 0', async () => {
    const { clawsDir, sock } = makeTmp();
    const corrId = crypto.randomUUID();
    const termId = 'term-42';
    writeEventsLog(clawsDir, [
      eventLine('system.worker.completed', { correlation_id: corrId, terminal_id: termId })
    ]);
    const { cleanup } = startFakeServer(sock);
    const proc = runWait(corrId, termId, sock);
    const { code } = await waitForExit(proc);
    await cleanup();
    assert.equal(code, 0, `expected exit 0, got ${code}`);
  });

  // (b) events.log has system.terminal.closed with corrId → exit 0
  await runTest('(b) terminal.closed corrId → exit 0', async () => {
    const { clawsDir, sock } = makeTmp();
    const corrId = crypto.randomUUID();
    const termId = 'term-43';
    writeEventsLog(clawsDir, [
      eventLine('system.terminal.closed', { correlation_id: corrId, terminal_id: termId })
    ]);
    const { cleanup } = startFakeServer(sock);
    const proc = runWait(corrId, termId, sock);
    const { code } = await waitForExit(proc);
    await cleanup();
    assert.equal(code, 0, `expected exit 0, got ${code}`);
  });

  // (c) events.log has system.worker.terminated with corrId (Bug 7 corrId-only path) → exit 0
  await runTest('(c) worker.terminated corrId → exit 0', async () => {
    const { clawsDir, sock } = makeTmp();
    const corrId = crypto.randomUUID();
    const termId = 'term-44';
    writeEventsLog(clawsDir, [
      eventLine('system.worker.terminated', { terminal_id: termId, terminated_at: new Date().toISOString(), correlation_id: corrId })
    ]);
    const { cleanup } = startFakeServer(sock);
    const proc = runWait(corrId, termId, sock);
    const { code } = await waitForExit(proc);
    await cleanup();
    assert.equal(code, 0, `expected exit 0, got ${code}`);
  });

  // (d) events.log has recent terminal_id event → process rearms (still running after 500ms)
  await runTest('(d) alive terminal → rearms (still running at 500ms)', async () => {
    const { clawsDir, sock } = makeTmp();
    const corrId = crypto.randomUUID();
    const termId = 'term-45';
    // fresh event: sentAt = now - 200ms (within 1s stale threshold)
    writeEventsLog(clawsDir, [
      eventLine('vehicle.45.state', { terminalId: termId }, Date.now() - 200)
    ]);
    const { cleanup } = startFakeServer(sock);
    const proc = runWait(corrId, termId, sock);
    // Use a separate flag: set only if timeout fires first (process still alive at 500ms).
    let aliveAt500 = false;
    await new Promise(resolve => {
      setTimeout(() => { aliveAt500 = true; resolve(); }, 500);
      proc.on('exit', () => resolve());
    });
    proc.kill('SIGKILL');
    await waitForExit(proc, 1000).catch(() => {});
    await cleanup();
    assert.equal(aliveAt500, true, 'process should still be running at 500ms (rearming)');
  });

  // (e) events.log has only stale terminal_id event → exit 2
  await runTest('(e) stale terminal → exit 2', async () => {
    const { clawsDir, sock } = makeTmp();
    const corrId = crypto.randomUUID();
    const termId = 'term-46';
    // stale event: sentAt = now - 5000ms (outside 1s threshold)
    writeEventsLog(clawsDir, [
      eventLine('vehicle.46.state', { terminalId: termId }, Date.now() - 5000)
    ]);
    const { cleanup } = startFakeServer(sock);
    const proc = runWait(corrId, termId, sock);
    const { code } = await waitForExit(proc);
    await cleanup();
    assert.equal(code, 2, `expected exit 2, got ${code}`);
  });

  // (f) live socket event → exit 0  [skipped — requires real socket, deferred to e2e]
  console.log('  SKIP  (f) live socket event → exit 0  [e2e — deferred to Wave 4]');

  // (g) no --keep-alive-on, timer fires → exit 3 (backward compat)
  await runTest('(g) no --keep-alive-on → exit 3 (backward compat)', async () => {
    const { clawsDir, sock } = makeTmp();
    const corrId = crypto.randomUUID();
    writeEventsLog(clawsDir, []);
    const { cleanup } = startFakeServer(sock);
    // pass --timeout-ms equal to rearm cycle so it fires quickly; no --keep-alive-on
    const proc = runWait(corrId, null, sock, ['--timeout-ms', REARM_CYCLE]);
    const { code, stderr } = await waitForExit(proc);
    await cleanup();
    assert.equal(code, 3, `expected exit 3, got ${code}`);
    assert.ok(stderr.includes('timeout waiting for close event'), `stderr missing expected message: ${stderr}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
