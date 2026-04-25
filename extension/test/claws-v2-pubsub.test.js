#!/usr/bin/env node
// claws/2 pub/sub test. Activates the extension against a mocked vscode,
// connects multiple peers, and asserts subscribe/unsubscribe/publish/broadcast
// behaviour including wildcard matching and role gating.
//
// Run: node extension/test/claws-v2-pubsub.test.js
// Exits 0 on success, 1 on failure.

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const EXT_ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(EXT_ROOT, 'dist', 'extension.js');

if (!fs.existsSync(BUNDLE)) {
  console.error('FAIL: dist/extension.js not found. Run `npm run build` first.');
  process.exit(1);
}

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-v2-'));
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
const _gs = new Map();
ext.activate({ subscriptions: [], extensionPath: EXT_ROOT, globalState: { get: (k) => _gs.get(k), update: (k,v) => { _gs.set(k,v); return Promise.resolve(); } } });

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
        const f = JSON.parse(line);
        if (f.rid != null) responses.set(f.rid, f);
        else pushes.push(f);
      } catch { /* ignore */ }
    }
  });
  return { socket: s, responses, pushes };
}

const assertions = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(() => assertions.push({ name, ok: true }), (e) => assertions.push({ name, ok: false, err: e.message || String(e) }));
    assertions.push({ name, ok: true });
  } catch (e) {
    assertions.push({ name, ok: false, err: e.message || String(e) });
  }
}

async function hello(peer, id, role, name) {
  peer.socket.write(JSON.stringify({
    id, cmd: 'hello', protocol: 'claws/2', role, peerName: name,
  }) + '\n');
  await waitFor(() => peer.responses.has(id), 2000);
  const r = peer.responses.get(id);
  if (!r || !r.ok) throw new Error(`hello failed for ${name}: ${JSON.stringify(r)}`);
  return r.peerId;
}

(async () => {
  const ready = await waitFor(() => fs.existsSync(sockPath), 3000);
  check('socket ready', () => { if (!ready) throw new Error('no socket'); });

  // ── 1. subscribe without hello -> ok:false, 'call hello first' ───────
  const noHello = connect();
  await new Promise((resolve) => noHello.socket.on('connect', resolve));
  noHello.socket.write(JSON.stringify({
    id: 100, cmd: 'subscribe', topic: 'anything',
  }) + '\n');
  await waitFor(() => noHello.responses.has(100), 2000);
  check('subscribe without hello rejected', () => {
    const r = noHello.responses.get(100);
    if (!r) throw new Error('no response');
    if (r.ok) throw new Error('expected ok:false');
    if (!/call hello first/.test(String(r.error || ''))) {
      throw new Error(`wrong error: ${r.error}`);
    }
  });
  noHello.socket.destroy();

  // ── 2. subscribe after hello -> ok:true, subscriptionId /^s_[0-9a-f]{4}$/
  const a = connect();
  await new Promise((resolve) => a.socket.on('connect', resolve));
  await hello(a, 1, 'orchestrator', 'orc');

  a.socket.write(JSON.stringify({
    id: 2, cmd: 'subscribe', topic: 'test.events',
  }) + '\n');
  await waitFor(() => a.responses.has(2), 2000);
  check('subscribe after hello returns subscriptionId', () => {
    const r = a.responses.get(2);
    if (!r || !r.ok) throw new Error(`subscribe failed: ${JSON.stringify(r)}`);
    if (typeof r.subscriptionId !== 'string') throw new Error('no subscriptionId');
    if (!/^s_[0-9a-f]{4}$/.test(r.subscriptionId)) throw new Error(`subId shape wrong: ${r.subscriptionId}`);
  });
  const subId = a.responses.get(2).subscriptionId;

  // ── 3. Two peers: A sub'd to test.events, B publishes -> A gets push
  const b = connect();
  await new Promise((resolve) => b.socket.on('connect', resolve));
  await hello(b, 10, 'worker', 'worker-b');

  b.socket.write(JSON.stringify({
    id: 11, cmd: 'publish', topic: 'test.events', payload: { hello: 'world' },
  }) + '\n');
  await waitFor(() => b.responses.has(11), 2000);
  await waitFor(() => a.pushes.length > 0, 2000);
  check('B publish delivered to A', () => {
    const resp = b.responses.get(11);
    if (!resp || !resp.ok) throw new Error(`publish failed: ${JSON.stringify(resp)}`);
    if (resp.deliveredTo !== 1) throw new Error(`expected deliveredTo=1, got ${resp.deliveredTo}`);
    const p = a.pushes[0];
    if (!p) throw new Error('no push frame');
    if (p.push !== 'message') throw new Error(`wrong push type: ${p.push}`);
    if (p.topic !== 'test.events') throw new Error(`wrong topic: ${p.topic}`);
    if (p.rid != null) throw new Error('push frame must have no rid');
    if (!p.payload || p.payload.hello !== 'world') throw new Error('payload mismatch');
  });

  // ── 4. publish with echo:true -> sender also gets push
  b.socket.write(JSON.stringify({
    id: 12, cmd: 'subscribe', topic: 'echo.topic',
  }) + '\n');
  await waitFor(() => b.responses.has(12), 2000);
  const bPushesBefore = b.pushes.length;
  b.socket.write(JSON.stringify({
    id: 13, cmd: 'publish', topic: 'echo.topic', payload: { x: 1 }, echo: true,
  }) + '\n');
  await waitFor(() => b.responses.has(13), 2000);
  await waitFor(() => b.pushes.length > bPushesBefore, 2000);
  check('publish with echo delivers to sender', () => {
    const p = b.pushes.find((f) => f.topic === 'echo.topic');
    if (!p) throw new Error('sender did not receive echoed push');
    if (p.from === undefined) throw new Error('push must include from');
  });

  // ── 5. unsubscribe -> ok:true, subsequent publish no longer delivers
  a.socket.write(JSON.stringify({
    id: 3, cmd: 'unsubscribe', subscriptionId: subId,
  }) + '\n');
  await waitFor(() => a.responses.has(3), 2000);
  check('unsubscribe ok', () => {
    const r = a.responses.get(3);
    if (!r || !r.ok) throw new Error(`unsubscribe failed: ${JSON.stringify(r)}`);
  });

  const aPushesBeforeUnsub = a.pushes.length;
  b.socket.write(JSON.stringify({
    id: 14, cmd: 'publish', topic: 'test.events', payload: { again: true },
  }) + '\n');
  await waitFor(() => b.responses.has(14), 2000);
  await new Promise((r) => setTimeout(r, 200));
  check('after unsubscribe, A no longer receives test.events', () => {
    const r = b.responses.get(14);
    if (!r || !r.ok) throw new Error(`publish failed: ${JSON.stringify(r)}`);
    if (r.deliveredTo !== 0) throw new Error(`expected 0, got ${r.deliveredTo}`);
    if (a.pushes.length !== aPushesBeforeUnsub) throw new Error('A received a push after unsubscribe');
  });

  // ── 6. broadcast from orchestrator -> all workers receive system.broadcast
  const bPushesBeforeBcast = b.pushes.length;
  a.socket.write(JSON.stringify({
    id: 4, cmd: 'broadcast', text: 'hello workers',
  }) + '\n');
  await waitFor(() => a.responses.has(4), 2000);
  await waitFor(() => b.pushes.length > bPushesBeforeBcast, 2000);
  check('orchestrator broadcast reaches worker', () => {
    const r = a.responses.get(4);
    if (!r || !r.ok) throw new Error(`broadcast failed: ${JSON.stringify(r)}`);
    if (typeof r.deliveredTo !== 'number' || r.deliveredTo < 1) {
      throw new Error(`expected deliveredTo>=1, got ${r.deliveredTo}`);
    }
    const p = b.pushes.slice(bPushesBeforeBcast).find((f) => f.topic === 'system.broadcast');
    if (!p) throw new Error('worker did not receive system.broadcast');
    if (!p.payload || p.payload.text !== 'hello workers') throw new Error('broadcast text mismatch');
  });

  // ── 7. broadcast from worker -> ok:false (requires orchestrator)
  b.socket.write(JSON.stringify({
    id: 15, cmd: 'broadcast', text: 'forbidden',
  }) + '\n');
  await waitFor(() => b.responses.has(15), 2000);
  check('worker broadcast rejected', () => {
    const r = b.responses.get(15);
    if (!r) throw new Error('no response');
    if (r.ok) throw new Error('expected ok:false');
    if (!/requires role/.test(String(r.error || ''))) throw new Error(`wrong error: ${r.error}`);
  });

  // ── 8. wildcard: subscribe to 'task.*'
  const c = connect();
  await new Promise((resolve) => c.socket.on('connect', resolve));
  await hello(c, 20, 'observer', 'obs');
  c.socket.write(JSON.stringify({
    id: 21, cmd: 'subscribe', topic: 'task.*',
  }) + '\n');
  await waitFor(() => c.responses.has(21), 2000);

  // publish task.status -> matches
  const cPushesBefore1 = c.pushes.length;
  b.socket.write(JSON.stringify({
    id: 22, cmd: 'publish', topic: 'task.status', payload: { s: 'run' },
  }) + '\n');
  await waitFor(() => b.responses.has(22), 2000);
  await waitFor(() => c.pushes.length > cPushesBefore1, 2000);
  check('wildcard task.* matches task.status', () => {
    const r = b.responses.get(22);
    if (!r || !r.ok) throw new Error(`publish failed: ${JSON.stringify(r)}`);
    if (r.deliveredTo !== 1) throw new Error(`expected 1, got ${r.deliveredTo}`);
    const p = c.pushes.slice(cPushesBefore1).find((f) => f.topic === 'task.status');
    if (!p) throw new Error('observer did not receive task.status');
  });

  // publish task.foo.bar -> no match (single star)
  const cPushesBefore2 = c.pushes.length;
  b.socket.write(JSON.stringify({
    id: 23, cmd: 'publish', topic: 'task.foo.bar', payload: { s: 'x' },
  }) + '\n');
  await waitFor(() => b.responses.has(23), 2000);
  await new Promise((r) => setTimeout(r, 200));
  check('single-star task.* does not match task.foo.bar', () => {
    const r = b.responses.get(23);
    if (!r || !r.ok) throw new Error(`publish failed: ${JSON.stringify(r)}`);
    if (r.deliveredTo !== 0) throw new Error(`expected 0, got ${r.deliveredTo}`);
    if (c.pushes.length !== cPushesBefore2) throw new Error('observer wrongly received task.foo.bar');
  });

  a.socket.destroy();
  b.socket.destroy();
  c.socket.destroy();
  await ext.deactivate();
  await new Promise((r) => setTimeout(r, 100));

  for (const a of assertions) {
    console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
  }
  try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = assertions.filter((a) => !a.ok);
  if (failed.length > 0) { console.error(`\nFAIL: ${failed.length}/${assertions.length} check(s) failed.`); process.exit(1); }
  console.log(`\nPASS: ${assertions.length} checks`);
  process.exit(0);
})();
