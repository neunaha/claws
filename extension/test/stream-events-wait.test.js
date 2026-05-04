#!/usr/bin/env node
// Unit tests for stream-events.js --wait mode (LH-12).
// Run: node extension/test/stream-events-wait.test.js
// Exits 0 on all 8 PASS, 1 on any FAIL.

'use strict';
const net  = require('net');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const cp   = require('child_process');

const SCRIPT     = path.resolve(__dirname, '../../scripts/stream-events.js');
const VALID_UUID = '12345678-1234-4000-8000-123456789abc';

let pass = 0, fail = 0;

function check(name, ok, detail) {
  if (ok) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${detail ? '\n        ' + detail : ''}`); fail++; }
}

function tmpSock() {
  return path.join(os.tmpdir(), `se-test-${process.pid}-${Date.now()}.sock`);
}

// Spawn SCRIPT with args+env, resolve when child exits or timeout fires.
// sigterm_ms: send SIGTERM to child after that many ms.
function spawnWait(args, env, { sigterm_ms = 0, timeout_ms = 5000 } = {}) {
  return new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    let resolved = false;
    const done = (code, signal) => {
      if (resolved) return; resolved = true;
      clearTimeout(killTimer);
      if (sigtermTimer) clearTimeout(sigtermTimer);
      resolve({ code, signal, stdout, stderr });
    };
    child.on('exit', done);

    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
      setTimeout(() => done(-1, 'SIGKILL'), 100);
    }, timeout_ms);

    const sigtermTimer = sigterm_ms > 0
      ? setTimeout(() => child.kill('SIGTERM'), sigterm_ms)
      : null;
  });
}

// Start a mock server that tracks connections for clean shutdown.
function startMockServer(sockPath, handler) {
  try { fs.unlinkSync(sockPath); } catch {}
  const openSockets = new Set();
  const server = net.createServer((socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
    handler(socket);
  });
  // Attach a destroy helper that closes all open connections before closing server.
  server._openSockets = openSockets;
  return new Promise((resolve) => server.listen(sockPath, () => resolve(server)));
}

// Close mock server: destroy open connections first so server.close() resolves quickly.
function stopServer(server) {
  if (server._openSockets) {
    for (const s of server._openSockets) try { s.destroy(); } catch {}
    server._openSockets.clear();
  }
  return new Promise((resolve) => server.close(() => resolve()));
}

// Mock server that performs hello + subscribe handshake, then calls
// afterHandshake(socket) once both subscribe acks have been sent.
function handshakeMock(sockPath, afterHandshake) {
  return startMockServer(sockPath, (socket) => {
    let buf = '', subsAcked = 0;
    const sendLine = (obj) => { if (!socket.destroyed) socket.write(JSON.stringify(obj) + '\n'); };
    socket.on('error', () => {});
    socket.on('end', () => socket.destroy());

    socket.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }

        if (msg.cmd === 'hello') {
          sendLine({ rid: msg.id, id: msg.id, ok: true, peerId: 'p_mock', protocol: 'claws/2' });
        } else if (msg.cmd === 'subscribe') {
          sendLine({ rid: msg.id, id: msg.id, ok: true, subscriptionId: `s_${msg.id}`, resumeCursor: '0000:0' });
          subsAcked++;
          if (subsAcked >= 2 && afterHandshake) {
            const cb = afterHandshake;
            afterHandshake = null;
            cb(socket);
          }
        }
      }
    });
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function test1() {
  // rejects missing --wait value — exits 1 immediately from arg validation
  const r = await spawnWait(['--wait'], {}, { timeout_ms: 2000 });
  check('rejects missing --wait value',
    r.code === 1 && r.stderr.includes('valid UUID'),
    `code=${r.code} stderr=${r.stderr.slice(0, 150)}`
  );
}

async function test2() {
  // rejects malformed correlation_id — UUID regex fails
  const r = await spawnWait(['--wait', 'foobar'], {}, { timeout_ms: 2000 });
  check('rejects malformed correlation_id',
    r.code === 1 && r.stderr.includes('valid UUID'),
    `code=${r.code} stderr=${r.stderr.slice(0, 150)}`
  );
}

async function test3() {
  // accepts valid uuid format — process waits (does not immediately reject)
  const sockPath = tmpSock();
  // Mock that accepts connections but does not send hello ack → child waits
  const server = await startMockServer(sockPath, (s) => {
    s.on('error', () => {});
    s.on('end', () => s.destroy());
  });

  // SIGTERM at 100ms — child's SIGTERM handler exits with 143
  const r = await spawnWait(['--wait', VALID_UUID], { CLAWS_SOCKET: sockPath }, { sigterm_ms: 100, timeout_ms: 2000 });

  await stopServer(server);
  try { fs.unlinkSync(sockPath); } catch {}

  // UUID accepted: not exit 1 from UUID validation. SIGTERM → 143, or 2 if socket errors.
  check('accepts valid uuid format',
    r.code !== 1 || !r.stderr.includes('valid UUID'),
    `code=${r.code} stderr=${r.stderr.slice(0, 150)}`
  );
}

async function test4() {
  // rejects --wait + --auto-sidecar — mutually exclusive
  const r = await spawnWait(['--wait', VALID_UUID, '--auto-sidecar'], {}, { timeout_ms: 2000 });
  check('rejects --wait + --auto-sidecar',
    r.code === 1 && r.stderr.includes('mutually exclusive'),
    `code=${r.code} stderr=${r.stderr.slice(0, 150)}`
  );
}

async function test5() {
  // matches event in drained buffer — server immediately pushes a historical terminal.closed
  // event after subscribe acks (simulates fromCursor='0000:0' replay)
  const sockPath = tmpSock();
  const corrId = VALID_UUID;

  const server = await handshakeMock(sockPath, (socket) => {
    // Simulate fromCursor replay: send matching terminal.closed immediately after handshake
    socket.write(JSON.stringify({
      push: 'message',
      topic: 'system.terminal.closed',
      from: 'server',
      payload: { correlation_id: corrId, terminal_id: '5' },
      sentAt: Date.now(),
      replayed: true,
    }) + '\n');
  });

  const r = await spawnWait(['--wait', corrId], { CLAWS_SOCKET: sockPath }, { timeout_ms: 2000 });

  await stopServer(server);
  try { fs.unlinkSync(sockPath); } catch {}

  let parsedTopic = null;
  try { parsedTopic = JSON.parse(r.stdout.trim()).topic; } catch {}
  check('matches event in drained buffer',
    r.code === 0 && parsedTopic === 'system.terminal.closed',
    `code=${r.code} stdout=${r.stdout.slice(0, 200)}`
  );
}

async function test6() {
  // matches event in live push — 200ms after handshake, server pushes matching worker.completed
  const sockPath = tmpSock();
  const corrId = VALID_UUID;

  const server = await handshakeMock(sockPath, (socket) => {
    setTimeout(() => {
      if (!socket.destroyed) {
        socket.write(JSON.stringify({
          push: 'message',
          topic: 'system.worker.completed',
          from: 'server',
          payload: { correlation_id: corrId, terminal_id: '6', status: 'completed' },
          sentAt: Date.now(),
        }) + '\n');
      }
    }, 200);
  });

  const r = await spawnWait(['--wait', corrId], { CLAWS_SOCKET: sockPath }, { timeout_ms: 2000 });

  await stopServer(server);
  try { fs.unlinkSync(sockPath); } catch {}

  let parsedTopic = null;
  try { parsedTopic = JSON.parse(r.stdout.trim()).topic; } catch {}
  check('matches event in live push',
    r.code === 0 && parsedTopic === 'system.worker.completed',
    `code=${r.code} stdout=${r.stdout.slice(0, 200)}`
  );
}

async function test7() {
  // ignores wrong correlation_id — pushes 3 non-matching events, must time out
  const sockPath = tmpSock();
  const corrId = VALID_UUID;

  const server = await handshakeMock(sockPath, (socket) => {
    for (let n = 0; n < 3; n++) {
      if (!socket.destroyed) {
        socket.write(JSON.stringify({
          push: 'message',
          topic: 'system.terminal.closed',
          from: 'server',
          payload: { correlation_id: '00000000-0000-0000-0000-000000000000', terminal_id: String(n) },
          sentAt: Date.now(),
        }) + '\n');
      }
    }
  });

  const r = await spawnWait(
    ['--wait', corrId, '--timeout-ms', '1500'],
    { CLAWS_SOCKET: sockPath },
    { timeout_ms: 4000 },
  );

  await stopServer(server);
  try { fs.unlinkSync(sockPath); } catch {}

  check('ignores wrong correlation_id',
    r.code === 3 && r.stderr.includes('timeout'),
    `code=${r.code} stderr=${r.stderr.slice(0, 200)}`
  );
}

async function test8() {
  // exits cleanly on socket close — server destroys the connection after 100ms
  const sockPath = tmpSock();
  const server = await startMockServer(sockPath, (socket) => {
    socket.on('error', () => {});
    setTimeout(() => socket.destroy(), 100);
  });

  const r = await spawnWait(['--wait', VALID_UUID], { CLAWS_SOCKET: sockPath }, { timeout_ms: 2000 });

  await stopServer(server);
  try { fs.unlinkSync(sockPath); } catch {}

  check('exits cleanly on socket close',
    r.code === 2 && r.stderr.includes('socket closed'),
    `code=${r.code} stderr=${r.stderr.slice(0, 200)}`
  );
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function run() {
  await test1();
  await test2();
  await test3();
  await test4();
  await test5();
  await test6();
  await test7();
  await test8();

  console.log(`\nPASS:${pass} FAIL:${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error('runner error:', e); process.exit(1); });
