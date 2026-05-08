'use strict';
// Unit tests for scripts/monitor-arm-watch.js (Bug 6 Layer 1).
//
// Test 1: emits system.monitor.unarmed when no pgrep match
//   - makeTmp() with isolated .claws/ + fake socket server that records frames
//   - run monitor-arm-watch.js with a unique corrId, grace 100ms
//   - assert: socket received publish frame with topic 'system.monitor.unarmed'
//             and matching corrId; process exits 1
//
// Test 2: silent exit 0 when pgrep matches
//   - spawn a long-running dummy "stream-events.js --wait <fakeUuid>" process
//   - run monitor-arm-watch.js with the same fakeUuid, grace 100ms
//   - assert: monitor-arm-watch exits 0, NO publish frame received
//   - cleanup the dummy process

const assert  = require('node:assert/strict');
const { spawn } = require('child_process');
const net     = require('net');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const crypto  = require('crypto');

const MONITOR_ARM_WATCH = path.resolve(__dirname, '../../scripts/monitor-arm-watch.js');

function makeTmp() {
  const dir      = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-maw-'));
  const clawsDir = path.join(dir, '.claws');
  fs.mkdirSync(clawsDir);
  const sock = path.join(clawsDir, 'claws.sock');
  return { dir, clawsDir, sock };
}

// Fake socket server that accepts connections, responds to hello/publish,
// and records every frame it receives.
function startFakeServer(sockPath) {
  const received = [];
  const server   = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        received.push(msg);
        let resp;
        if (msg.cmd === 'hello')   { resp = { rid: msg.id, ok: true, peerId: 'test-peer-maw' }; }
        else if (msg.cmd === 'publish') { resp = { rid: msg.id, ok: true }; }
        else                           { resp = { rid: msg.id, ok: true }; }
        try { conn.write(JSON.stringify(resp) + '\n'); } catch {}
      }
    });
    conn.on('error', () => {});
  });
  server.listen(sockPath);
  const cleanup = () => new Promise(res => {
    try { server.closeAllConnections?.(); } catch {}
    server.close(() => res());
  });
  return { server, received, cleanup };
}

function runWatch(corrId, termId, sockPath, graceMs) {
  return spawn(process.execPath, [
    MONITOR_ARM_WATCH,
    '--corr-id',  corrId,
    '--term-id',  String(termId),
    '--grace-ms', String(graceMs ?? 100),
    '--socket',   sockPath,
  ]);
}

function waitForExit(proc, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    proc.stderr?.on('data', d => { stderr += d.toString(); });
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
  console.log('monitor-arm-watch.test.js');

  // Test 1: pgrep finds no match → publishes system.monitor.unarmed, exits 1
  await runTest('emits system.monitor.unarmed when no pgrep match', async () => {
    const { sock } = makeTmp();
    const corrId   = crypto.randomUUID(); // unique UUID — guaranteed no pgrep match
    const termId   = 'term-maw-1';

    const { received, cleanup } = startFakeServer(sock);
    const proc = runWatch(corrId, termId, sock, 100);
    const { code } = await waitForExit(proc, 5000);
    await cleanup();

    assert.equal(code, 1, `expected exit 1 (unarmed), got ${code}`);
    const pubFrame = received.find(r => r.cmd === 'publish' && r.topic === 'system.monitor.unarmed');
    assert.ok(pubFrame, `expected system.monitor.unarmed publish frame; got: ${JSON.stringify(received)}`);
    assert.equal(
      pubFrame.payload && pubFrame.payload.correlation_id,
      corrId,
      `expected corrId=${corrId} in payload; got: ${JSON.stringify(pubFrame.payload)}`
    );
  });

  // Test 2: pgrep finds a match → exits 0, no publish frame sent
  await runTest('silent exit 0 when pgrep matches', async () => {
    const { clawsDir, sock } = makeTmp();
    const corrId = crypto.randomUUID();
    const termId = 'term-maw-2';

    // Write a dummy "stream-events.js" that sleeps indefinitely so it shows in pgrep.
    const dummyScript = path.join(clawsDir, 'stream-events.js');
    fs.writeFileSync(dummyScript, 'setTimeout(() => {}, 60000);\n', 'utf8');

    // Spawn with the corrId in argv so pgrep -f matches stream-events.js.*--wait <corrId>
    const dummy = spawn(process.execPath, [dummyScript, '--wait', corrId], { stdio: 'ignore' });

    // Brief delay to ensure dummy is visible in the OS process table
    await new Promise(r => setTimeout(r, 200));

    const { received, cleanup } = startFakeServer(sock);
    const proc = runWatch(corrId, termId, sock, 100);
    const { code } = await waitForExit(proc, 5000);

    dummy.kill('SIGKILL');
    await waitForExit(dummy, 1000).catch(() => {});
    await cleanup();

    assert.equal(code, 0, `expected exit 0, got ${code}`);
    const pubFrame = received.find(r => r.cmd === 'publish');
    assert.ok(!pubFrame, `expected no publish frame, got: ${JSON.stringify(pubFrame)}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
