#!/usr/bin/env node
// pconn-identity.test.js
// Unit-integration tests for the _pconn socket-identity guard and ok-checks
// introduced in Bug 12 fix (W26 Fixes 1, 2, 3).
//
// All five scenarios are exercised by spawning mcp_server.js as a child process
// against a minimal fake claws socket server, then calling claws_done via MCP.
// claws_done is the simplest tool that exercises the full _pconnEnsureRegistered
// → _pconnWriteOrThrow(publish) path internally.
//
// Limitation: _pconn.socketId and _pconn.helloSocketId are private to the child
// process and cannot be directly inspected. Tests infer correctness from the
// number of hello/publish frames the fake server receives.
//
// Run: node extension/test/pconn-identity.test.js
// Exits 0 on success, 1 on failure.

'use strict';

const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MCP_SERVER = path.join(REPO_ROOT, 'mcp_server.js');

if (!fs.existsSync(MCP_SERVER)) {
  console.error(`FAIL: mcp_server.js not found at ${MCP_SERVER}`);
  process.exit(1);
}

function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-pconn-id-'));
  const clawsDir = path.join(dir, '.claws');
  fs.mkdirSync(clawsDir);
  return { dir, clawsDir, sockPath: path.join(clawsDir, 'claws.sock') };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(fn, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
}

// ─── Minimal fake claws socket server ────────────────────────────────────────
// Tracks hello and publish frame counts. hello/publish responders are swappable
// per-test so we can simulate ok:false responses.
class FakeClawsServer {
  constructor({ helloOk = true, publishOk = true, orchestratorHelloSeq = null } = {}) {
    // All hellos (any role)
    this.helloCount = 0;
    // Only hellos from role='orchestrator' — this is the _pconn path we're testing.
    // Other roles (observer, worker) come from the sidecar or other clients.
    this.orchestratorHelloCount = 0;
    this.publishCount = 0;
    this.publishedTopics = [];
    this.connections = [];
    this._helloOk = helloOk;
    this._publishOk = publishOk;
    // Per-call orchestrator hello response sequence. Array of booleans (true=ok, false=fail).
    // If the array is shorter than the call count, the last element is repeated.
    // null means use _helloOk for all calls.
    this._orchestratorHelloSeq = orchestratorHelloSeq;
    this._nextPeerId = 1;
    this.server = null;
  }

  listen(sockPath) {
    return new Promise((resolve) => {
      this.server = net.createServer((conn) => {
        this.connections.push(conn);
        let buf = '';
        conn.on('data', (d) => {
          buf += d.toString('utf8');
          let idx;
          while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            if (!line.trim()) continue;
            try {
              const req = JSON.parse(line);
              const rid = req.id;
              if (req.cmd === 'hello') {
                this.helloCount++;
                // Track orchestrator-role hellos separately — those are from _pconn.
                if (req.role === 'orchestrator') this.orchestratorHelloCount++;
                // Return ok:false only for orchestrator hellos (matches real extension behavior).
                const isOrchestrator = req.role === 'orchestrator';
                let ok;
                if (isOrchestrator && this._orchestratorHelloSeq !== null) {
                  const seqIdx = this.orchestratorHelloCount - 1;
                  ok = seqIdx < this._orchestratorHelloSeq.length
                    ? this._orchestratorHelloSeq[seqIdx]
                    : this._orchestratorHelloSeq[this._orchestratorHelloSeq.length - 1];
                } else {
                  ok = isOrchestrator ? this._helloOk : true;
                }
                const resp = ok
                  ? { ok: true, rid, peerId: `p_${this._nextPeerId++}`, serverCapabilities: [] }
                  : { ok: false, rid, error: 'orchestrator already registered' };
                conn.write(JSON.stringify(resp) + '\n');
              } else if (req.cmd === 'publish') {
                this.publishCount++;
                this.publishedTopics.push(req.topic || '');
                const resp = this._publishOk
                  ? { ok: true, rid, deliveredTo: 0 }
                  : { ok: false, rid, error: 'call hello first' };
                conn.write(JSON.stringify(resp) + '\n');
              } else if (req.cmd === 'subscribe') {
                conn.write(JSON.stringify({ ok: true, rid, subscriptionId: 'sub1' }) + '\n');
              } else {
                // close, readLog, send, etc. — return ok:false (non-fatal in mcp_server)
                conn.write(JSON.stringify({ ok: false, rid, error: 'not-implemented' }) + '\n');
              }
            } catch { /* ignore malformed frames */ }
          }
        });
        conn.on('error', () => {});
      });
      this.server.listen(sockPath, resolve);
    });
  }

  // Destroy all active connections (simulates socket disconnect from server side)
  dropAllConnections() {
    for (const c of this.connections) { try { c.destroy(); } catch { /* ignore */ } }
    this.connections = [];
  }

  close() {
    return new Promise((resolve) => {
      for (const c of this.connections) { try { c.destroy(); } catch { /* ignore */ } }
      this.server.close(resolve);
    });
  }
}

// ─── MCP child session ────────────────────────────────────────────────────────
class McpSession {
  constructor(sockPath, extraEnv = {}) {
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.child = spawn(process.execPath, [MCP_SERVER], {
      env: { ...process.env, CLAWS_SOCKET: sockPath, CLAWS_TERMINAL_ID: 'test-term-1', ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', () => {}); // suppress noise
    this.child.stdout.on('data', (d) => {
      this.buf += d.toString('utf8');
      let nl;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && this.pending.has(msg.id)) {
            const { resolve } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            resolve(msg);
          }
        } catch { /* ignore */ }
      }
    });
  }

  send(method, params, timeoutMs = 8000) {
    const id = this.nextId++;
    const frame = { jsonrpc: '2.0', id, method };
    if (params !== undefined) frame.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP timeout: ${method} id=${id}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (msg) => { clearTimeout(timer); resolve(msg); }, reject });
      this.child.stdin.write(JSON.stringify(frame) + '\n');
    });
  }

  async init() {
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'pconn-identity-test', version: '0.0.1' },
      capabilities: {},
    });
  }

  callTool(name, args = {}, timeoutMs) {
    return this.send('tools/call', { name, arguments: args }, timeoutMs);
  }

  close() {
    try { this.child.stdin.end(); } catch { /* ignore */ }
    setTimeout(() => { try { this.child.kill(); } catch { /* ignore */ } }, 300);
  }
}

// ─── Test runner ─────────────────────────────────────────────────────────────
const assertions = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => assertions.push({ name, ok: true }),
        (e) => assertions.push({ name, ok: false, err: e.message || String(e) }),
      );
    }
    assertions.push({ name, ok: true });
  } catch (e) {
    assertions.push({ name, ok: false, err: e.message || String(e) });
  }
}

// ─── Test body ───────────────────────────────────────────────────────────────
(async () => {

  // ── Test 1: Fresh _pconnEnsureRegistered — succeeds, sets peerId, binds to socketId=1 ─
  {
    const tmp = makeTmp();
    const srv = new FakeClawsServer({ helloOk: true, publishOk: true });
    await srv.listen(tmp.sockPath);
    const mcp = new McpSession(tmp.sockPath);
    await mcp.init();

    const resp = await mcp.callTool('claws_done');
    await sleep(200); // let async callbacks settle

    check('fresh registration: orchestrator hello sent exactly once', () => {
      if (srv.orchestratorHelloCount !== 1) throw new Error(`expected orchestratorHelloCount=1, got ${srv.orchestratorHelloCount}`);
    });
    check('fresh registration: system.worker.completed published', () => {
      if (!srv.publishedTopics.includes('system.worker.completed'))
        throw new Error(`expected system.worker.completed, got [${srv.publishedTopics.join(', ')}]`);
    });
    check('fresh registration: claws_done returns ok:true', () => {
      if (!resp.result) throw new Error(`no result: ${JSON.stringify(resp)}`);
      if (resp.result.isError) throw new Error(`unexpected error: ${resp.result.content[0].text}`);
      const d = JSON.parse(resp.result.content[0].text);
      if (d.ok !== true) throw new Error(`expected ok:true, got ${JSON.stringify(d)}`);
    });

    // ── Test 2: Skip hello on identity match — no re-hello on second call ────
    // pconn socket is still connected; socketId==helloSocketId → guard passes → skip hello.
    const orchHellosBefore = srv.orchestratorHelloCount;
    await mcp.callTool('claws_done');
    await sleep(200);

    check('identity match: no re-hello on second consecutive call', () => {
      if (srv.orchestratorHelloCount !== orchHellosBefore)
        throw new Error(`expected orchestratorHelloCount unchanged (${orchHellosBefore}), got ${srv.orchestratorHelloCount}`);
    });
    check('identity match: second publish landed', () => {
      const completedCount = srv.publishedTopics.filter((t) => t === 'system.worker.completed').length;
      if (completedCount < 2) throw new Error(`expected ≥2 system.worker.completed, got ${completedCount}`);
    });

    mcp.close();
    await srv.close();
    try { fs.rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // ── Test 3: Re-hello after socket close — peerId=null, helloSocketId=null → re-hello ─
  {
    const tmp = makeTmp();
    const srv = new FakeClawsServer({ helloOk: true, publishOk: true });
    await srv.listen(tmp.sockPath);
    const mcp = new McpSession(tmp.sockPath);
    await mcp.init();

    // First call — registers on socket 1
    await mcp.callTool('claws_done');
    await sleep(200);
    check('re-hello: initial orchestratorHelloCount=1', () => {
      if (srv.orchestratorHelloCount !== 1) throw new Error(`expected 1, got ${srv.orchestratorHelloCount}`);
    });

    // Drop the persistent socket — triggers _pconnHandleClose → peerId=null, helloSocketId=null
    srv.dropAllConnections();
    // Wait for the 1000ms reconnect timer + socket setup + re-hello
    await sleep(1600);

    const orchHellosAfterFirst = srv.orchestratorHelloCount;
    await mcp.callTool('claws_done');
    await sleep(200);

    check('re-hello after close: at least one more orchestrator hello occurred', () => {
      // Either the reconnect timer re-hellos (count=2) or the next tool call re-hellos.
      // Either way, orchestratorHelloCount must be > 1.
      if (srv.orchestratorHelloCount <= 1)
        throw new Error(`expected orchestratorHelloCount>1 after disconnect, got ${srv.orchestratorHelloCount}`);
    });
    check('re-hello after close: second system.worker.completed published', () => {
      const completedCount = srv.publishedTopics.filter((t) => t === 'system.worker.completed').length;
      if (completedCount < 2) throw new Error(`expected ≥2 system.worker.completed, got ${completedCount}`);
    });

    mcp.close();
    await srv.close();
    try { fs.rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // ── Test 4: Reject silent hello failure — hello ok:false → throw, no publish ─
  {
    const tmp = makeTmp();
    const srv = new FakeClawsServer({ helloOk: false, publishOk: true });
    await srv.listen(tmp.sockPath);
    const mcp = new McpSession(tmp.sockPath);
    await mcp.init();

    const resp = await mcp.callTool('claws_done');
    await sleep(200);

    check('hello ok:false: orchestrator hello frame received by server', () => {
      if (srv.orchestratorHelloCount < 1) throw new Error(`expected server to receive hello, got orchestratorHelloCount=${srv.orchestratorHelloCount}`);
    });
    check('hello ok:false: no publish sent after hello rejection', () => {
      // _pconnEnsureRegistered throws → publish never reaches _pconnWriteOrThrow
      const completedCount = srv.publishedTopics.filter((t) => t === 'system.worker.completed').length;
      if (completedCount > 0) throw new Error(`expected 0 system.worker.completed publishes, got ${completedCount}`);
    });
    check('hello ok:false: claws_done still returns ok:true (non-fatal suppression)', () => {
      if (!resp.result) throw new Error(`no result: ${JSON.stringify(resp)}`);
      if (resp.result.isError) throw new Error(`unexpected MCP error: ${resp.result.content[0].text}`);
      const d = JSON.parse(resp.result.content[0].text);
      if (d.ok !== true) throw new Error(`expected ok:true, got ${JSON.stringify(d)}`);
    });

    mcp.close();
    await srv.close();
    try { fs.rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // ── Test 5: _pconnWriteOrThrow — ok:false publish throws, caught by claws_done ─
  {
    const tmp = makeTmp();
    const srv = new FakeClawsServer({ helloOk: true, publishOk: false });
    await srv.listen(tmp.sockPath);
    const mcp = new McpSession(tmp.sockPath);
    await mcp.init();

    const resp = await mcp.callTool('claws_done');
    await sleep(200);

    check('_pconnWriteOrThrow: hello ok:true → registered successfully (orchestrator)', () => {
      if (srv.orchestratorHelloCount < 1) throw new Error(`expected hello, got orchestratorHelloCount=${srv.orchestratorHelloCount}`);
    });
    check('_pconnWriteOrThrow: publish frame reached server (was attempted)', () => {
      // _pconnWriteOrThrow was called; server received the frame but returned ok:false
      if (srv.publishCount < 1) throw new Error(`expected publish attempt, got publishCount=${srv.publishCount}`);
    });
    check('_pconnWriteOrThrow: claws_done still returns ok:true despite publish failure', () => {
      // The throw from _pconnWriteOrThrow was caught by claws_done's non-fatal catch
      if (!resp.result) throw new Error(`no result: ${JSON.stringify(resp)}`);
      if (resp.result.isError) throw new Error(`unexpected MCP error: ${resp.result.content[0].text}`);
      const d = JSON.parse(resp.result.content[0].text);
      if (d.ok !== true) throw new Error(`expected ok:true, got ${JSON.stringify(d)}`);
    });
    check('_pconnWriteOrThrow: orchestratorHelloCount=1 (no double-hello on publish failure)', () => {
      // Publish ok:false causes a throw; the catch suppresses it. But we should NOT see
      // a second hello attempt as a result of the failed publish.
      if (srv.orchestratorHelloCount !== 1) throw new Error(`expected orchestratorHelloCount=1, got ${srv.orchestratorHelloCount}`);
    });

    mcp.close();
    await srv.close();
    try { fs.rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // ── Test 6: Retry-on-already-registered (positive) — 2 failures then success ─
  // Simulates the Bug 12 race: extension still has the old peer in its Map on the
  // first 2 hellos, then clears it so the 3rd hello succeeds.
  {
    const tmp = makeTmp();
    // Seq: [false, false, true] → first 2 orchestrator hellos fail, 3rd succeeds.
    const srv = new FakeClawsServer({ orchestratorHelloSeq: [false, false, true] });
    await srv.listen(tmp.sockPath);
    const mcp = new McpSession(tmp.sockPath);
    await mcp.init();

    // Allow extra time for 2 retry delays (100ms + 200ms = 300ms overhead).
    const resp = await mcp.callTool('claws_done', {}, 10000);
    await sleep(300);

    check('retry-positive: 3 orchestrator hellos sent (1 initial + 2 retries)', () => {
      if (srv.orchestratorHelloCount !== 3)
        throw new Error(`expected orchestratorHelloCount=3, got ${srv.orchestratorHelloCount}`);
    });
    check('retry-positive: system.worker.completed published after retry success', () => {
      if (!srv.publishedTopics.includes('system.worker.completed'))
        throw new Error(`expected system.worker.completed, got [${srv.publishedTopics.join(', ')}]`);
    });
    check('retry-positive: claws_done returns ok:true', () => {
      if (!resp.result) throw new Error(`no result: ${JSON.stringify(resp)}`);
      if (resp.result.isError) throw new Error(`unexpected error: ${resp.result.content[0].text}`);
      const d = JSON.parse(resp.result.content[0].text);
      if (d.ok !== true) throw new Error(`expected ok:true, got ${JSON.stringify(d)}`);
    });

    mcp.close();
    await srv.close();
    try { fs.rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // ── Test 7: Retry-on-already-registered (negative) — all hellos fail, exhausted ─
  // Simulates the race persisting through all retries. Expects:
  //   - 4 total orchestrator hellos (1 initial + 3 retries)
  //   - 0 publish attempts (throw before publish)
  //   - claws_done still returns ok:true (non-fatal suppression)
  {
    const tmp = makeTmp();
    // Seq: all false (last element repeated for any call beyond the array length).
    const srv = new FakeClawsServer({ orchestratorHelloSeq: [false, false, false, false] });
    await srv.listen(tmp.sockPath);
    const mcp = new McpSession(tmp.sockPath);
    await mcp.init();

    // Allow extra time for 3 retry delays (100ms + 200ms + 400ms = 700ms overhead).
    const resp = await mcp.callTool('claws_done', {}, 12000);
    await sleep(300);

    check('retry-exhausted: 12 orchestrator hellos sent (3 handleTool calls × 4 attempts each)', () => {
      // handleTool calls _pconnEnsureRegistered 3 times: pre-invoke, inside claws_done, post-invoke.
      // Each call: 1 initial + 3 retries = 4 attempts. Total: 3 × 4 = 12.
      if (srv.orchestratorHelloCount !== 12)
        throw new Error(`expected orchestratorHelloCount=12 (3 calls × 4 attempts each), got ${srv.orchestratorHelloCount}`);
    });
    check('retry-exhausted: no publish attempted after all retries fail', () => {
      if (srv.publishCount !== 0)
        throw new Error(`expected publishCount=0, got ${srv.publishCount}`);
    });
    check('retry-exhausted: claws_done still returns ok:true (non-fatal suppression)', () => {
      if (!resp.result) throw new Error(`no result: ${JSON.stringify(resp)}`);
      if (resp.result.isError) throw new Error(`unexpected MCP error: ${resp.result.content[0].text}`);
      const d = JSON.parse(resp.result.content[0].text);
      if (d.ok !== true) throw new Error(`expected ok:true, got ${JSON.stringify(d)}`);
    });

    mcp.close();
    await srv.close();
    try { fs.rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // ─── Results ───────────────────────────────────────────────────────────────
  await sleep(300); // let child processes exit

  for (const a of assertions) {
    console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
  }
  const failed = assertions.filter((a) => !a.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${assertions.length} pconn-identity check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${assertions.length} pconn-identity checks`);
  process.exit(0);
})();
