#!/usr/bin/env node
// Tests for M-37: ClawsSDK.connect() must time out (5s) + _send() must time out per-request.
// Verifies static structure and behavioral per-request timeout.
// Run: node extension/test/sdk-socket-timeout.test.js
// Exits 0 on success, 1 on failure. No VS Code dependency.

'use strict';
const assert = require('assert');
const net    = require('net');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');

const SDK_PATH = path.resolve(__dirname, '../../claws-sdk.js');
const { ClawsSDK } = require(SDK_PATH);

const checks = [];
async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, err: err.message || String(err) });
  }
}

function makeSockPath() {
  return path.join(os.tmpdir(), `claws-m37-${process.pid}-${Date.now()}.sock`);
}

(async () => {
  // 1. Static: sock.setTimeout(5000) present in connect() — M-37 connect ceiling
  await check('claws-sdk.js: sock.setTimeout(5000) present in connect()', async () => {
    const src = fs.readFileSync(SDK_PATH, 'utf8');
    assert(src.includes('sock.setTimeout(5000)'), 'sock.setTimeout(5000) not found in connect()');
    assert(src.includes('M-37'), 'M-37 comment not found in claws-sdk.js');
  });

  // 2. Static: connect() destroys socket on timeout with user-actionable message
  await check('claws-sdk.js: timeout handler calls sock.destroy() with /claws-fix hint', async () => {
    const src = fs.readFileSync(SDK_PATH, 'utf8');
    assert(src.includes("sock.destroy(new Error("), 'sock.destroy(new Error(...)) not found in timeout handler');
    assert(src.includes('claws-fix') || src.includes('claws running'), 'timeout error message should hint at /claws-fix');
  });

  // 3. Static: connect() disables timeout after successful connect (no false fires during use)
  await check('claws-sdk.js: sock.setTimeout(0) called on connect event (disables after connect)', async () => {
    const src = fs.readFileSync(SDK_PATH, 'utf8');
    assert(src.includes('sock.setTimeout(0)'), 'sock.setTimeout(0) not found — timeout not disabled after connect');
  });

  // 4. Static: _send() has timeoutMs parameter and clearTimeout cleanup
  await check('claws-sdk.js: _send() has timeoutMs param + clearTimeout cleanup', async () => {
    const src = fs.readFileSync(SDK_PATH, 'utf8');
    assert(src.includes('timeoutMs'), '_send() should accept timeoutMs parameter');
    assert(src.includes('clearTimeout(timer)'), '_send() should clearTimeout on successful resolve');
  });

  // 5. Behavioral: _send() rejects after timeoutMs when server never replies
  await check('_send() rejects within timeoutMs when server never responds', async () => {
    const sockPath = makeSockPath();
    const connections = [];
    // Server accepts connections and consumes writes, but never replies.
    const srv = net.createServer(socket => {
      connections.push(socket);
      socket.on('data', () => {}); // consume but never reply
      socket.on('error', () => {});
    });
    await new Promise((resolve, reject) => { srv.on('error', reject); srv.listen(sockPath, resolve); });
    let sock;
    try {
      sock = net.createConnection(sockPath);
      sock.setEncoding('utf8');
      await new Promise((resolve, reject) => { sock.on('connect', resolve); sock.on('error', reject); });
      const sdk = new ClawsSDK({ socketPath: sockPath });
      sdk._sock = sock;
      // Use 150ms for test speed — should time out quickly
      await assert.rejects(
        sdk._send({ cmd: 'ping' }, 150),
        /timed out/,
        '_send should reject when server does not respond within timeoutMs',
      );
    } finally {
      if (sock) sock.destroy();
      connections.forEach(c => { try { c.destroy(); } catch {} });
      await new Promise(r => srv.close(r)).catch(() => {});
      try { fs.unlinkSync(sockPath); } catch {}
    }
  });

  // 6. Behavioral: _pending Map is cleaned up after timeout (no leak)
  await check('_send() timeout cleans up pending Map entry (no leak)', async () => {
    const sockPath = makeSockPath();
    const connections = [];
    const srv = net.createServer(socket => {
      connections.push(socket);
      socket.on('error', () => {});
    });
    await new Promise((resolve, reject) => { srv.on('error', reject); srv.listen(sockPath, resolve); });
    let sock;
    try {
      sock = net.createConnection(sockPath);
      sock.setEncoding('utf8');
      await new Promise((resolve, reject) => { sock.on('connect', resolve); sock.on('error', reject); });
      const sdk = new ClawsSDK({ socketPath: sockPath });
      sdk._sock = sock;
      const sizeBefore = sdk._pending.size;
      try { await sdk._send({ cmd: 'ping' }, 100); } catch { /* expected */ }
      const sizeAfter = sdk._pending.size;
      assert.strictEqual(sizeAfter, sizeBefore, `pending map should be back to ${sizeBefore} after timeout, got ${sizeAfter}`);
    } finally {
      if (sock) sock.destroy();
      connections.forEach(c => { try { c.destroy(); } catch {} });
      await new Promise(r => srv.close(r)).catch(() => {});
      try { fs.unlinkSync(sockPath); } catch {}
    }
  });

  // 7. Behavioral: successful _send() resolves immediately without timeout interference
  await check('_send() resolves normally when server replies within timeout', async () => {
    const sockPath = makeSockPath();
    const connections = [];
    // Echo server — replies with the same id as received.
    const srv = net.createServer(socket => {
      connections.push(socket);
      let buf = '';
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const req = JSON.parse(line);
            socket.write(JSON.stringify({ id: req.id, rid: req.rid, ok: true }) + '\n');
          } catch {}
        }
      });
      socket.on('error', () => {});
    });
    await new Promise((resolve, reject) => { srv.on('error', reject); srv.listen(sockPath, resolve); });
    let sock;
    try {
      sock = net.createConnection(sockPath);
      sock.setEncoding('utf8');
      await new Promise((resolve, reject) => { sock.on('connect', resolve); sock.on('error', reject); });
      const sdk = new ClawsSDK({ socketPath: sockPath });
      sdk._sock = sock;
      sock.on('data', chunk => {
        sdk._buf += chunk;
        let nl;
        while ((nl = sdk._buf.indexOf('\n')) !== -1) {
          const line = sdk._buf.slice(0, nl).trim();
          sdk._buf = sdk._buf.slice(nl + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            const p = sdk._pending.get(msg.id ?? msg.rid);
            if (p) { sdk._pending.delete(msg.id ?? msg.rid); p(msg); }
          } catch {}
        }
      });
      const resp = await sdk._send({ cmd: 'ping' }, 2000);
      assert.strictEqual(resp.ok, true, `expected ok:true response, got: ${JSON.stringify(resp)}`);
      assert.strictEqual(sdk._pending.size, 0, 'pending map should be empty after resolved send');
    } finally {
      if (sock) sock.destroy();
      connections.forEach(c => { try { c.destroy(); } catch {} });
      await new Promise(r => srv.close(r)).catch(() => {});
      try { fs.unlinkSync(sockPath); } catch {}
    }
  });

  let failed = 0;
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ' — ' + c.err}`);
    if (!c.ok) failed++;
  }

  if (failed > 0) {
    console.error(`\nFAIL: ${failed}/${checks.length} sdk-socket-timeout check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${checks.length} sdk-socket-timeout checks`);
  process.exit(0);
})();
