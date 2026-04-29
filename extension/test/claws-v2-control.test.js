#!/usr/bin/env node
// L10 Structured Control — deliver-cmd + cmd.ack test suite.
// Tests schema-validated command delivery from orchestrator to worker, with
// idempotent re-delivery via idempotencyKey and ACK close-loop.
//
// Run: node extension/test/claws-v2-control.test.js
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

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-v2-ctrl-'));
const logs = [];

// ─── Mock vscode ─────────────────────────────────────────────────────────
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
    createTerminal: () => ({ name: 'mock', processId: Promise.resolve(12345), shellIntegration: undefined, show: () => {}, sendText: () => {}, dispose: () => {} }),
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
  while (Date.now() < deadline) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); }
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
      if (Date.now() - start > 5000) { clearInterval(poll); reject(new Error(`timeout on cmd: ${msg.cmd}`)); }
    }, 10);
  });
  return { s, send, pushes, responses };
}

let pass = 0; let fail = 0;
function check(label, cond, extra) {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.error(`  ✗ ${label}${extra ? ': ' + JSON.stringify(extra) : ''}`); fail++; }
}

async function run() {
  // Wait for socket to appear
  const sockReady = await waitFor(() => fs.existsSync(sockPath), 5000);
  if (!sockReady) { console.error('FAIL: socket not created within 5s'); process.exit(1); }

  // Set up lifecycle plan (gate requires a plan before create)
  {
    const c = connect();
    await waitFor(() => c.s.writable, 1000);
    const planResp = await c.send({ cmd: 'lifecycle.plan', plan: 'Wave 6 L10 control test' });
    check('lifecycle plan accepted', planResp.ok, planResp);
    c.s.destroy();
  }

  // ── Suite 1: deliver-cmd basic delivery ───────────────────────────────────
  console.log('\n[Suite 1] deliver-cmd basic delivery');
  {
    const orch = connect();
    const worker = connect();
    await waitFor(() => orch.s.writable && worker.s.writable, 1000);

    const helloOrch = await orch.send({ cmd: 'hello', protocol: 'claws/2', role: 'orchestrator', peerName: 'orch1' });
    check('orchestrator hello ok', helloOrch.ok, helloOrch);
    const orchId = helloOrch.peerId;

    const helloWorker = await worker.send({ cmd: 'hello', protocol: 'claws/2', role: 'worker', peerName: 'w1' });
    check('worker hello ok', helloWorker.ok, helloWorker);
    const workerId = helloWorker.peerId;

    // Subscribe orchestrator to cmd.<workerId>.ack to observe ACKs
    const subResp = await orch.send({ cmd: 'subscribe', protocol: 'claws/2', topic: `cmd.${workerId}.ack` });
    check('orchestrator subscribed to cmd.ack', subResp.ok, subResp);

    // Orchestrator delivers a structured command
    const ikey = randomUUID();
    const payload = {
      v: 1, id: randomUUID(), from_peer: orchId, from_name: 'orch1',
      ts_published: new Date().toISOString(), schema: 'cmd-abort-v1',
      data: { reason: 'test abort' },
    };
    const deliverResp = await orch.send({
      cmd: 'deliver-cmd',
      protocol: 'claws/2',
      targetPeerId: workerId,
      cmdTopic: `cmd.${workerId}.abort`,
      payload,
      idempotencyKey: ikey,
    });
    check('deliver-cmd returns ok', deliverResp.ok, deliverResp);
    check('deliver-cmd returns seq number', typeof deliverResp.seq === 'number', deliverResp);
    const seq = deliverResp.seq;

    // Worker should receive push frame on cmd.<workerId>.abort
    const workerPushReceived = await waitFor(
      () => worker.pushes.some((p) => p.topic === `cmd.${workerId}.abort`),
      2000,
    );
    check('worker received cmd push frame', workerPushReceived, worker.pushes);

    const cmdPush = worker.pushes.find((p) => p.topic === `cmd.${workerId}.abort`);
    check('push frame has sequence number', typeof cmdPush?.sequence === 'number', cmdPush);
    check('push frame sequence matches deliver-cmd seq', cmdPush?.sequence === seq, { cmdPush, seq });

    // Worker ACKs the command
    const ackResp = await worker.send({
      cmd: 'cmd.ack',
      protocol: 'claws/2',
      seq,
      status: 'executed',
    });
    check('cmd.ack returns ok', ackResp.ok, ackResp);

    // Orchestrator observes the ACK within 50ms
    const orchAckReceived = await waitFor(
      () => orch.pushes.some((p) => p.topic === `cmd.${workerId}.ack`),
      500,
    );
    check('orchestrator received cmd.ack push', orchAckReceived, orch.pushes);

    const ackPush = orch.pushes.find((p) => p.topic === `cmd.${workerId}.ack`);
    check('ack push has seq', ackPush?.payload?.seq === seq, ackPush);
    check('ack push has status executed', ackPush?.payload?.status === 'executed', ackPush);

    orch.s.destroy(); worker.s.destroy();
  }

  // ── Suite 2: idempotency — duplicate deliver-cmd not re-delivered ─────────
  console.log('\n[Suite 2] idempotency — duplicate deliver-cmd');
  {
    const orch2 = connect();
    const worker2 = connect();
    await waitFor(() => orch2.s.writable && worker2.s.writable, 1000);

    const hO = await orch2.send({ cmd: 'hello', protocol: 'claws/2', role: 'orchestrator', peerName: 'orch2' });
    check('orch2 hello ok', hO.ok, hO);
    const oId = hO.peerId;

    const hW = await worker2.send({ cmd: 'hello', protocol: 'claws/2', role: 'worker', peerName: 'w2' });
    check('worker2 hello ok', hW.ok, hW);
    const wId = hW.peerId;

    const ikey = randomUUID();
    const payload = {
      v: 1, id: randomUUID(), from_peer: oId, from_name: 'orch2',
      ts_published: new Date().toISOString(), schema: 'cmd-abort-v1',
      data: { reason: 'idempotency test' },
    };

    // First delivery — should succeed and push to worker
    const r1 = await orch2.send({
      cmd: 'deliver-cmd', protocol: 'claws/2',
      targetPeerId: wId, cmdTopic: `cmd.${wId}.abort`,
      payload, idempotencyKey: ikey,
    });
    check('first deliver-cmd ok', r1.ok && !r1.duplicate, r1);

    const pushCountBefore = worker2.pushes.filter((p) => p.topic === `cmd.${wId}.abort`).length;
    await waitFor(() => worker2.pushes.filter((p) => p.topic === `cmd.${wId}.abort`).length > pushCountBefore, 1000);

    // Second delivery with same idempotencyKey — must return duplicate:true, NOT re-push
    const pushCountMid = worker2.pushes.filter((p) => p.topic === `cmd.${wId}.abort`).length;
    const r2 = await orch2.send({
      cmd: 'deliver-cmd', protocol: 'claws/2',
      targetPeerId: wId, cmdTopic: `cmd.${wId}.abort`,
      payload, idempotencyKey: ikey,
    });
    check('duplicate deliver-cmd returns ok:true', r2.ok, r2);
    check('duplicate deliver-cmd returns duplicate:true', r2.duplicate === true, r2);

    // Wait briefly to confirm no extra push
    await new Promise((r) => setTimeout(r, 200));
    const pushCountAfter = worker2.pushes.filter((p) => p.topic === `cmd.${wId}.abort`).length;
    check('duplicate not re-delivered to worker', pushCountAfter === pushCountMid, { pushCountAfter, pushCountMid });

    orch2.s.destroy(); worker2.s.destroy();
  }

  // ── Suite 3: deliver-cmd to unknown peer returns error ────────────────────
  console.log('\n[Suite 3] deliver-cmd to unknown peer');
  {
    const orch3 = connect();
    await waitFor(() => orch3.s.writable, 1000);
    const hO3 = await orch3.send({ cmd: 'hello', protocol: 'claws/2', role: 'orchestrator', peerName: 'orch3' });
    check('orch3 hello ok', hO3.ok, hO3);
    const oId3 = hO3.peerId;

    const r = await orch3.send({
      cmd: 'deliver-cmd', protocol: 'claws/2',
      targetPeerId: 'p_999999',
      cmdTopic: 'cmd.p_999999.abort',
      payload: {
        v: 1, id: randomUUID(), from_peer: oId3, from_name: 'orch3',
        ts_published: new Date().toISOString(), schema: 'cmd-abort-v1',
        data: { reason: 'unknown target test' },
      },
      idempotencyKey: randomUUID(),
    });
    check('deliver-cmd to unknown peer returns error', !r.ok, r);
    orch3.s.destroy();
  }

  // ── Suite 4: cmd.ack role gate (only worker may ack) ─────────────────────
  console.log('\n[Suite 4] cmd.ack role gating');
  {
    const orch4 = connect();
    await waitFor(() => orch4.s.writable, 1000);
    const hO4 = await orch4.send({ cmd: 'hello', protocol: 'claws/2', role: 'orchestrator', peerName: 'orch4' });
    check('orch4 hello ok', hO4.ok, hO4);

    // Orchestrator trying to call cmd.ack should be rejected
    const ackResp = await orch4.send({ cmd: 'cmd.ack', protocol: 'claws/2', seq: 0, status: 'executed' });
    check('orchestrator cannot call cmd.ack', !ackResp.ok, ackResp);
    orch4.s.destroy();
  }

  // ── Suite 5: cmd.ack durably logged ──────────────────────────────────────
  console.log('\n[Suite 5] cmd.ack push logged to event log');
  {
    const orch5 = connect();
    const worker5 = connect();
    await waitFor(() => orch5.s.writable && worker5.s.writable, 1000);

    const hO5 = await orch5.send({ cmd: 'hello', protocol: 'claws/2', role: 'orchestrator', peerName: 'orch5' });
    check('orch5 hello ok', hO5.ok, hO5);
    const oId5 = hO5.peerId;
    const hW5 = await worker5.send({ cmd: 'hello', protocol: 'claws/2', role: 'worker', peerName: 'w5' });
    check('worker5 hello ok', hW5.ok, hW5);
    const wId5 = hW5.peerId;

    const ikey5 = randomUUID();
    const payload5 = {
      v: 1, id: randomUUID(), from_peer: oId5, from_name: 'orch5',
      ts_published: new Date().toISOString(), schema: 'cmd-abort-v1',
      data: { reason: 'log test' },
    };

    const dResp = await orch5.send({
      cmd: 'deliver-cmd', protocol: 'claws/2',
      targetPeerId: wId5, cmdTopic: `cmd.${wId5}.abort`,
      payload: payload5, idempotencyKey: ikey5,
    });
    check('orch5 deliver-cmd ok', dResp.ok, dResp);

    await waitFor(() => worker5.pushes.some((p) => p.topic === `cmd.${wId5}.abort`), 1000);

    const aResp = await worker5.send({ cmd: 'cmd.ack', protocol: 'claws/2', seq: dResp.seq, status: 'executed' });
    check('worker5 cmd.ack ok', aResp.ok, aResp);

    // Verify event log captured the ack (check the .jsonl files exist)
    const logDir = path.join(workspaceRoot, '.claws', 'events', 'default');
    const logExists = await waitFor(() => {
      if (!fs.existsSync(logDir)) return false;
      return fs.readdirSync(logDir).some((f) => f.endsWith('.jsonl'));
    }, 2000);
    check('event log directory has .jsonl segments', logExists, { logDir });

    orch5.s.destroy(); worker5.s.destroy();
  }

  // ── Suite 6: cmd.*.ack topic registered ──────────────────────────────────
  console.log('\n[Suite 6] cmd.*.ack topic in registry');
  {
    // The topic-registry must have cmd.*.ack registered; we verify it by
    // subscribing to it and confirming subscription is accepted.
    const obs = connect();
    await waitFor(() => obs.s.writable, 1000);
    const hObs = await obs.send({ cmd: 'hello', protocol: 'claws/2', role: 'observer', peerName: 'obs6' });
    check('observer hello ok', hObs.ok, hObs);

    const subResp = await obs.send({ cmd: 'subscribe', protocol: 'claws/2', topic: 'cmd.*.ack' });
    check('cmd.*.ack subscription accepted', subResp.ok, subResp);
    check('cmd.*.ack returns subscriptionId', typeof subResp.subscriptionId === 'string', subResp);
    obs.s.destroy();
  }

  // ─── Results ──────────────────────────────────────────────────────────────
  console.log(`\n[claws-v2-control] ${pass} passed, ${fail} failed`);
  ext.deactivate?.();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((err) => { console.error('FATAL:', err); process.exit(1); });
