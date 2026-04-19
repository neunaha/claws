#!/usr/bin/env node
// Tests the blocking claws_worker lifecycle end-to-end.
//
// Starts a fake socket server that emulates the extension's protocol
// (create/send/readLog/close) with in-memory state. When `send` receives a
// command containing "MISSION_COMPLETE", that string is appended to the
// terminal's synthetic log so the subsequent readLog polls see it.
//
// Spawns mcp_server.js as a real child process, sends an MCP tools/call for
// claws_worker via Content-Length framing, and asserts the response contains
// COMPLETED + the marker.

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const MCP = path.resolve(__dirname, '..', '..', 'mcp_server.js');
const SOCK = path.join(os.tmpdir(), `claws-worker-test-${process.pid}.sock`);

// ─── Fake extension socket ────────────────────────────────────────────────
const state = new Map(); // id → { log: string, closed: bool }
let nextId = 1;

function handle(req) {
  const { cmd } = req;
  if (cmd === 'list') return { ok: true, terminals: [] };
  if (cmd === 'create') {
    const id = String(nextId++);
    state.set(id, { log: '', closed: false });
    return { ok: true, id, wrapped: true };
  }
  if (cmd === 'send') {
    const s = state.get(String(req.id));
    if (!s) return { ok: false, error: 'unknown id' };
    s.log += (req.text || '') + (req.newline !== false ? '\n' : '');
    // Simulate shell echoing back the mission text. If it contains
    // MISSION_COMPLETE, leave it in the buffer for readLog to pick up.
    return { ok: true };
  }
  if (cmd === 'readLog') {
    const s = state.get(String(req.id));
    if (!s) return { ok: false, error: 'unknown id' };
    const text = s.log;
    return {
      ok: true, bytes: text,
      offset: 0, nextOffset: Buffer.byteLength(text),
      totalSize: Buffer.byteLength(text), truncated: false, logPath: null,
    };
  }
  if (cmd === 'close') {
    const s = state.get(String(req.id));
    if (!s) return { ok: false, error: 'unknown id' };
    s.closed = true;
    return { ok: true };
  }
  return { ok: false, error: `unknown cmd: ${cmd}` };
}

try { fs.unlinkSync(SOCK); } catch { /* ignore */ }
const server = net.createServer((sock) => {
  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let req;
      try { req = JSON.parse(line); } catch { continue; }
      const resp = handle(req);
      sock.write(JSON.stringify({ id: req.id, ...resp }) + '\n');
    }
  });
  sock.on('error', () => {});
});
server.listen(SOCK);

// ─── Spawn MCP server ─────────────────────────────────────────────────────
const mcp = spawn('node', [MCP], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, CLAWS_SOCKET: SOCK },
});

function frame(obj) {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

let stdoutBuf = '';
const pending = new Map();

mcp.stdout.on('data', (d) => {
  stdoutBuf += d.toString('utf8');
  if (process.env.DEBUG_WORKER_TEST) process.stderr.write(`[DATA ${d.length}B]`);
  while (true) {
    const hdrEnd = stdoutBuf.indexOf('\r\n\r\n');
    if (hdrEnd === -1) break;
    const hdr = stdoutBuf.slice(0, hdrEnd);
    const match = hdr.match(/Content-Length:\s*(\d+)/i);
    if (!match) { stdoutBuf = stdoutBuf.slice(hdrEnd + 4); continue; }
    const len = parseInt(match[1], 10);
    const bodyStart = hdrEnd + 4;
    const bodyByteLen = Buffer.byteLength(stdoutBuf.slice(bodyStart), 'utf8');
    if (bodyByteLen < len) break;
    // Slice by UTF-8 byte count, not JS string length, so multi-byte chars align.
    const bodyBuf = Buffer.from(stdoutBuf.slice(bodyStart), 'utf8').slice(0, len);
    const body = bodyBuf.toString('utf8');
    const consumedChars = Buffer.byteLength(stdoutBuf.slice(0, bodyStart), 'utf8') + len;
    stdoutBuf = Buffer.from(stdoutBuf, 'utf8').slice(consumedChars).toString('utf8');
    let msg;
    try { msg = JSON.parse(body); } catch (e) {
      if (process.env.DEBUG_WORKER_TEST) process.stderr.write(`[parse err: ${e.message}]`);
      continue;
    }
    if (process.env.DEBUG_WORKER_TEST) process.stderr.write(`[MSG id=${msg.id}]`);
    const waiter = pending.get(msg.id);
    if (waiter) { pending.delete(msg.id); waiter(msg); }
  }
});

function rpc(method, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`rpc timeout for ${method}`));
    }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    mcp.stdin.write(frame({ jsonrpc: '2.0', id, method, params }));
  });
}

// ─── Run ──────────────────────────────────────────────────────────────────
(async () => {
  const checks = [];
  const check = (name, ok, err) => checks.push({ name, ok, err });

  try {
    const init = await rpc('initialize', {});
    check('initialize returns claws', !!(init.result && init.result.serverInfo && init.result.serverInfo.name === 'claws'),
      `got ${JSON.stringify(init.result)}`);

    const call = await rpc('tools/call', {
      name: 'claws_worker',
      arguments: {
        name: 'test-worker',
        command: 'echo MISSION_COMPLETE: test ok',
        launch_claude: false,
        timeout_ms: 10000,
        poll_interval_ms: 200,
      },
    });

    const text = call.result && call.result.content && call.result.content[0] && call.result.content[0].text;
    check('tool call returned text', typeof text === 'string' && text.length > 0,
      `got ${JSON.stringify(call.result)}`);

    if (text) {
      check('status is COMPLETED', /COMPLETED/.test(text),
        `text was:\n${text.slice(0, 500)}`);
      check('marker line mentions MISSION_COMPLETE', /MISSION_COMPLETE/.test(text),
        `text was:\n${text.slice(0, 500)}`);
      check('cleaned_up: true', /cleaned_up:\s*true/.test(text),
        `text was:\n${text.slice(0, 500)}`);
    }

    // Detach mode smoke test
    const det = await rpc('tools/call', {
      name: 'claws_worker',
      arguments: {
        name: 'detach-worker',
        command: 'echo hello',
        launch_claude: false,
        detach: true,
      },
    });
    const detText = det.result && det.result.content && det.result.content[0] && det.result.content[0].text;
    check('detach returns SPAWNED', typeof detText === 'string' && /SPAWNED/.test(detText),
      `text was:\n${detText ? detText.slice(0, 300) : detText}`);

  } catch (e) {
    check('exception during test', false, e.message || String(e));
  }

  // Report
  let failed = 0;
  for (const c of checks) {
    console.log(`${c.ok ? '  ✓' : '  ✗'} ${c.name}${c.ok ? '' : ' — ' + c.err}`);
    if (!c.ok) failed++;
  }

  // Cleanup
  try { mcp.kill(); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
  try { fs.unlinkSync(SOCK); } catch { /* ignore */ }

  if (failed) {
    console.error(`\nFAIL: ${failed}/${checks.length} checks failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${checks.length} checks`);
  process.exit(0);
})();
