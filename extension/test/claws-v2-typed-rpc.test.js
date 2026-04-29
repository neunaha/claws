#!/usr/bin/env node
// L16 Typed RPC + L7 Schema Registry test suite.
// Tests rpc.call, rpc.response routing, correlation map, timeout, schema tools.
//
// Run: node extension/test/claws-v2-typed-rpc.test.js
// Exits 0 on success, 1 on failure.

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { randomUUID } = require('crypto');

const EXT_ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(EXT_ROOT, 'dist', 'extension.js');

if (!fs.existsSync(BUNDLE)) {
  console.error('FAIL: dist/extension.js not found. Run `npm run build` first.');
  process.exit(1);
}

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-rpc-'));
const logs = [];

// ─── Mock vscode ─────────────────────────────────────────────────────────────
class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (l) => {
      this.listeners.push(l);
      return { dispose: () => { const i = this.listeners.indexOf(l); if (i >= 0) this.listeners.splice(i, 1); } };
    };
  }
  fire(a) { for (const l of this.listeners.slice()) l(a); }
  dispose() { this.listeners = []; }
}
class TerminalProfile { constructor(o) { this.options = o; } }
class MarkdownString { constructor() { this.value = ''; this.isTrusted = false; } appendMarkdown(s) { this.value += s; return this; } }
class ThemeColor { constructor(id) { this.id = id; } }

const onOpen = new EventEmitter();
const onClose = new EventEmitter();

const vscode = {
  EventEmitter, TerminalProfile, MarkdownString, ThemeColor,
  StatusBarAlignment: { Left: 1, Right: 2 },
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file', path: p }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
    getConfiguration: (_s) => ({ get: (_k, fb) => fb }),
  },
  window: {
    terminals: [], activeTerminal: undefined,
    createOutputChannel: () => ({ appendLine: (m) => logs.push(m), show: () => {}, dispose: () => {} }),
    createStatusBarItem: () => ({ text: '', tooltip: '', color: undefined, command: '', name: '', show: () => {}, hide: () => {}, dispose: () => {} }),
    createTerminal: () => ({
      name: 'mock', processId: Promise.resolve(12345),
      shellIntegration: undefined, show: () => {}, sendText: () => {}, dispose: () => {},
    }),
    onDidOpenTerminal: onOpen.event,
    onDidCloseTerminal: onClose.event,
    registerTerminalProfileProvider: () => ({ dispose: () => {} }),
    showErrorMessage: () => ({ then: () => {} }),
    showInformationMessage: () => ({ then: () => {} }),
    showWarningMessage: () => ({ then: () => {} }),
    showQuickPick: () => Promise.resolve(undefined),
  },
  commands: {
    registerCommand: () => ({ dispose: () => {} }),
    executeCommand: () => Promise.resolve(),
  },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'vscode') return 'vscode';
  return origResolve.call(this, request, parent, ...rest);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscode };

const ext = require(BUNDLE);
ext.activate({ subscriptions: [], extensionPath: EXT_ROOT });

const sockPath = path.join(workspaceRoot, '.claws', 'claws.sock');

async function waitFor(fn, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function connect() {
  const s = net.createConnection(sockPath);
  const responses = new Map();
  const pushes = [];
  let buf = '';
  s.on('data', (d) => {
    buf += d.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.rid !== undefined) {
          responses.set(msg.rid, msg);
        } else if (msg.push) {
          pushes.push(msg);
        }
      } catch { /* ignore */ }
    }
  });
  let seq = 1;
  const send = (msg) => new Promise((resolve, reject) => {
    const id = seq++;
    msg.id = id;
    responses.set(id, null);
    s.write(JSON.stringify(msg) + '\n');
    const start = Date.now();
    const poll = setInterval(() => {
      const r = responses.get(id);
      if (r !== null) { clearInterval(poll); resolve(r); }
      if (Date.now() - start > 8000) {
        clearInterval(poll);
        reject(new Error(`timeout waiting for response to cmd: ${msg.cmd}`));
      }
    }, 10);
  });
  return { s, send, pushes, responses };
}

let pass = 0; let fail = 0;
function check(label, cond, extra) {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.error(`  ✗ ${label}${extra !== undefined ? ': ' + JSON.stringify(extra) : ''}`); fail++; }
}

async function run() {
  const sockReady = await waitFor(() => fs.existsSync(sockPath), 5000);
  if (!sockReady) { console.error('FAIL: socket not created within 5s'); process.exit(1); }

  // Lifecycle gate requires a plan before create
  {
    const c = connect();
    await waitFor(() => c.s.writable, 1000);
    const planResp = await c.send({ cmd: 'lifecycle.plan', plan: 'Wave 8 L16 typed-RPC test' });
    check('lifecycle plan accepted', planResp.ok, planResp);
    c.s.destroy();
  }

  // ── Suite 1: basic rpc.call — orchestrator calls, worker responds ──────────
  console.log('\n[Suite 1] rpc.call basic round-trip (<200ms)');
  {
    const orch = connect();
    const worker = connect();
    await waitFor(() => orch.s.writable && worker.s.writable, 1000);

    const hOrch = await orch.send({
      cmd: 'hello', protocol: 'claws/2', role: 'orchestrator', peerName: 'rpc-orch1',
    });
    check('orch hello ok', hOrch.ok, hOrch);
    const orchId = hOrch.peerId;

    const hWorker = await worker.send({
      cmd: 'hello', protocol: 'claws/2', role: 'worker', peerName: 'rpc-worker1',
    });
    check('worker hello ok', hWorker.ok, hWorker);
    const workerId = hWorker.peerId;

    // Worker subscribes to its RPC request topic
    const subResp = await worker.send({
      cmd: 'subscribe', protocol: 'claws/2', topic: `rpc.${workerId}.request`,
    });
    check('worker subscribed to rpc.<peerId>.request', subResp.ok, subResp);

    // Orchestrator issues rpc.call — blocks until worker responds (or timeout)
    const rpcCallPromise = orch.send({
      cmd: 'rpc.call',
      protocol: 'claws/2',
      targetPeerId: workerId,
      method: 'echo',
      params: { message: 'hello worker' },
      timeoutMs: 3000,
    });

    // Worker receives push frame on rpc.<workerId>.request
    const workerReceivedRpc = await waitFor(
      () => worker.pushes.some((p) => p.topic === `rpc.${workerId}.request`),
      2000,
    );
    check('worker received rpc push on rpc.<peerId>.request', workerReceivedRpc, worker.pushes);

    const rpcPush = worker.pushes.find((p) => p.topic === `rpc.${workerId}.request`);
    check('rpc push has requestId (string)', typeof rpcPush?.payload?.requestId === 'string', rpcPush);
    check('rpc push method === echo', rpcPush?.payload?.method === 'echo', rpcPush);
    check('rpc push params.message === hello worker', rpcPush?.payload?.params?.message === 'hello worker', rpcPush);
    check('rpc push callerPeerId === orchId', rpcPush?.payload?.callerPeerId === orchId, rpcPush);

    const requestId = rpcPush.payload.requestId;

    // Worker publishes response to rpc.response.<orchId>.<requestId>
    const t0 = Date.now();
    const pubResp = await worker.send({
      cmd: 'publish',
      protocol: 'claws/2',
      topic: `rpc.response.${orchId}.${requestId}`,
      payload: {
        requestId,
        ok: true,
        result: { echo: 'hello worker', received: true },
      },
    });
    check('worker publish response ok', pubResp.ok, pubResp);

    // Orchestrator's rpc.call should now resolve
    const rpcResult = await rpcCallPromise;
    const elapsed = Date.now() - t0;
    check('rpc.call resolved ok', rpcResult.ok, rpcResult);
    check('rpc.call result.requestId matches', rpcResult.requestId === requestId, rpcResult);
    check('rpc.call result has payload', rpcResult.result != null, rpcResult);
    check('rpc.call resolved < 500ms after response', elapsed < 500, { elapsed });

    orch.s.destroy(); worker.s.destroy();
  }

  // ── Suite 2: rpc.call timeout — worker never responds ────────────────────
  console.log('\n[Suite 2] rpc.call timeout');
  {
    const orch2 = connect();
    const worker2 = connect();
    await waitFor(() => orch2.s.writable && worker2.s.writable, 1000);

    const hO2 = await orch2.send({
      cmd: 'hello', protocol: 'claws/2', role: 'orchestrator', peerName: 'rpc-orch2',
    });
    check('orch2 hello ok', hO2.ok, hO2);

    const hW2 = await worker2.send({
      cmd: 'hello', protocol: 'claws/2', role: 'worker', peerName: 'rpc-worker2',
    });
    check('worker2 hello ok', hW2.ok, hW2);
    const workerId2 = hW2.peerId;

    // Worker subscribes but never publishes a response
    await worker2.send({
      cmd: 'subscribe', protocol: 'claws/2', topic: `rpc.${workerId2}.request`,
    });

    const t0 = Date.now();
    const timeoutResult = await orch2.send({
      cmd: 'rpc.call',
      protocol: 'claws/2',
      targetPeerId: workerId2,
      method: 'noreply',
      params: {},
      timeoutMs: 300,
    });
    const elapsed = Date.now() - t0;

    check('rpc.call timeout returns ok:false', !timeoutResult.ok, timeoutResult);
    check('rpc.call timeout error is rpc.call:timeout', timeoutResult.error === 'rpc.call:timeout', timeoutResult);
    check('rpc.call timeout has requestId', typeof timeoutResult.requestId === 'string', timeoutResult);
    check('rpc.call timeout fired within 600ms', elapsed < 600, { elapsed });

    orch2.s.destroy(); worker2.s.destroy();
  }

  // ── Suite 3: rpc.call to unknown peer returns error immediately ───────────
  console.log('\n[Suite 3] rpc.call to unknown peer');
  {
    const orch3 = connect();
    await waitFor(() => orch3.s.writable, 1000);
    const hO3 = await orch3.send({
      cmd: 'hello', protocol: 'claws/2', role: 'orchestrator', peerName: 'rpc-orch3',
    });
    check('orch3 hello ok', hO3.ok, hO3);

    const errResp = await orch3.send({
      cmd: 'rpc.call',
      protocol: 'claws/2',
      targetPeerId: 'p_ZZZZZZ_nonexistent',
      method: 'introspect',
      params: {},
      timeoutMs: 1000,
    });
    check('rpc.call to unknown peer returns error', !errResp.ok, errResp);
    check('error contains target-not-found', typeof errResp.error === 'string' && errResp.error.includes('target-not-found'), errResp);
    orch3.s.destroy();
  }

  // ── Suite 4: schema.list returns all registered schema names ─────────────
  console.log('\n[Suite 4] schema.list');
  {
    const c4 = connect();
    await waitFor(() => c4.s.writable, 1000);

    const listResp = await c4.send({ cmd: 'schema.list' });
    check('schema.list ok', listResp.ok, listResp);
    check('schema.list returns schemas array', Array.isArray(listResp.schemas), listResp);
    check('schema.list includes rpc-request-v1', Array.isArray(listResp.schemas) && listResp.schemas.includes('rpc-request-v1'), listResp.schemas);
    check('schema.list includes rpc-response-v1', Array.isArray(listResp.schemas) && listResp.schemas.includes('rpc-response-v1'), listResp.schemas);
    check('schema.list includes worker-boot-v1', Array.isArray(listResp.schemas) && listResp.schemas.includes('worker-boot-v1'), listResp.schemas);
    check('schema.list includes cmd-abort-v1', Array.isArray(listResp.schemas) && listResp.schemas.includes('cmd-abort-v1'), listResp.schemas);

    c4.s.destroy();
  }

  // ── Suite 5: schema.get returns schema definition ─────────────────────────
  console.log('\n[Suite 5] schema.get');
  {
    const c5 = connect();
    await waitFor(() => c5.s.writable, 1000);

    const getResp = await c5.send({ cmd: 'schema.get', name: 'rpc-request-v1' });
    check('schema.get rpc-request-v1 ok', getResp.ok, getResp);
    check('schema.get returns schema object', getResp.schema != null && typeof getResp.schema === 'object', getResp);
    check('schema type is object', getResp.schema?.type === 'object', getResp.schema);
    check('schema has fields', getResp.schema?.fields != null, getResp.schema);

    const notFound = await c5.send({ cmd: 'schema.get', name: 'nonexistent-schema-xyz' });
    check('schema.get unknown schema returns error', !notFound.ok, notFound);
    check('schema.get unknown error message', typeof notFound.error === 'string', notFound);

    // Validate worker-boot-v1 has the expected shape
    const workerBoot = await c5.send({ cmd: 'schema.get', name: 'worker-boot-v1' });
    check('schema.get worker-boot-v1 ok', workerBoot.ok, workerBoot);
    check('worker-boot-v1 schema is object type', workerBoot.schema?.type === 'object', workerBoot.schema);

    c5.s.destroy();
  }

  // ── Suite 6: rpc.call missing method returns error ────────────────────────
  console.log('\n[Suite 6] rpc.call validation');
  {
    const c6 = connect();
    await waitFor(() => c6.s.writable, 1000);
    const hO6 = await c6.send({
      cmd: 'hello', protocol: 'claws/2', role: 'orchestrator', peerName: 'rpc-orch6',
    });
    check('orch6 hello ok', hO6.ok, hO6);

    const noMethod = await c6.send({
      cmd: 'rpc.call', protocol: 'claws/2',
      targetPeerId: 'p_000001',
      // method intentionally omitted
      params: {},
    });
    check('rpc.call without method returns error', !noMethod.ok, noMethod);

    const noTarget = await c6.send({
      cmd: 'rpc.call', protocol: 'claws/2',
      // targetPeerId intentionally omitted
      method: 'test',
      params: {},
    });
    check('rpc.call without targetPeerId returns error', !noTarget.ok, noTarget);

    c6.s.destroy();
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch((err) => { console.error('FATAL:', err); process.exit(1); });
