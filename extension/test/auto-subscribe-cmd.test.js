#!/usr/bin/env node
// L3.2 regression test: worker peers are auto-subscribed to cmd.<peerId>.** on hello.
// Verifies the subscription is present in the server's index by checking that
// a publish to cmd.<peerId>.anything reaches the worker socket without an explicit
// subscribe call.
//
// Run: node extension/test/auto-subscribe-cmd.test.js
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

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-asub-'));
const logs = [];

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
    createTerminal: () => {
      const t = { name: 'mock', processId: Promise.resolve(12345), shellIntegration: undefined, show: () => {}, sendText: () => {}, dispose: () => {} };
      setTimeout(() => onOpen.fire(t), 0);
      return t;
    },
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

(async () => {
  const ready = await waitFor(() => fs.existsSync(sockPath), 3000);
  check('socket ready', () => { if (!ready) throw new Error('no socket'); });

  // ── Connect orchestrator ──────────────────────────────────────────────────
  const orch = connect();
  await new Promise((resolve) => orch.socket.on('connect', resolve));

  orch.socket.write(JSON.stringify({
    id: 1, cmd: 'hello', protocol: 'claws/2', role: 'orchestrator', peerName: 'test-orch-asub',
  }) + '\n');
  await waitFor(() => orch.responses.has(1), 2000);

  check('orchestrator hello ok', () => {
    const r = orch.responses.get(1);
    if (!r || !r.ok) throw new Error(`orch hello failed: ${JSON.stringify(r)}`);
  });

  // ── Connect worker — NO explicit subscribe ────────────────────────────────
  const worker = connect();
  await new Promise((resolve) => worker.socket.on('connect', resolve));

  worker.socket.write(JSON.stringify({
    id: 2, cmd: 'hello', protocol: 'claws/2', role: 'worker', peerName: 'test-worker-asub',
  }) + '\n');
  await waitFor(() => worker.responses.has(2), 2000);

  let workerPeerId = null;
  check('worker hello ok and returns peerId', () => {
    const r = worker.responses.get(2);
    if (!r || !r.ok) throw new Error(`worker hello failed: ${JSON.stringify(r)}`);
    if (typeof r.peerId !== 'string') throw new Error('no peerId in worker hello response');
    workerPeerId = r.peerId;
  });

  // ── Orchestrator publishes to cmd.<workerPeerId>.approve ─────────────────
  // Worker should receive this push frame without having explicitly subscribed.
  const pushCountBefore = worker.pushes.length;

  // Use peerId captured above
  const cmdTopic = `cmd.${workerPeerId}.approve`;
  orch.socket.write(JSON.stringify({
    id: 10, cmd: 'publish', protocol: 'claws/2',
    topic: cmdTopic,
    payload: { kind: 'CMD', action: 'approve_request', requestId: 'r-test-1' },
    echo: true,
  }) + '\n');
  await waitFor(() => orch.responses.has(10), 2000);

  check('orchestrator publish ok', () => {
    const r = orch.responses.get(10);
    if (!r || !r.ok) throw new Error(`publish failed: ${JSON.stringify(r)}`);
  });

  // Worker auto-subscribed to cmd.<peerId>.** should receive the push
  await waitFor(() => worker.pushes.length > pushCountBefore, 2000);

  check('worker receives cmd.<peerId>.approve push without explicit subscribe', () => {
    const received = worker.pushes.slice(pushCountBefore).find((f) => f.topic === cmdTopic);
    if (!received) {
      throw new Error(
        `worker did not receive push on ${cmdTopic}. ` +
        `Pushes received: ${JSON.stringify(worker.pushes.slice(pushCountBefore))}`,
      );
    }
    if (received.push !== 'message') throw new Error(`wrong push type: ${received.push}`);
    if (received.rid != null) throw new Error('push frame must not have rid');
  });

  // ── Also verify deeper wildcard: cmd.<peerId>.sub.topic ──────────────────
  const pushCountBefore2 = worker.pushes.length;
  const deepTopic = `cmd.${workerPeerId}.sub.nested`;
  orch.socket.write(JSON.stringify({
    id: 20, cmd: 'publish', protocol: 'claws/2',
    topic: deepTopic,
    payload: { kind: 'CMD', action: 'pause' },
    echo: true,
  }) + '\n');
  await waitFor(() => orch.responses.has(20), 2000);
  await waitFor(() => worker.pushes.length > pushCountBefore2, 1000);

  check('worker receives cmd.<peerId>.sub.nested push (** wildcard depth)', () => {
    const received = worker.pushes.slice(pushCountBefore2).find((f) => f.topic === deepTopic);
    if (!received) {
      throw new Error(
        `worker did not receive deep push on ${deepTopic}. ` +
        `Pushes: ${JSON.stringify(worker.pushes.slice(pushCountBefore2))}`,
      );
    }
  });

  // ── Observer role should NOT get auto-subscribe ───────────────────────────
  const observer = connect();
  await new Promise((resolve) => observer.socket.on('connect', resolve));

  observer.socket.write(JSON.stringify({
    id: 3, cmd: 'hello', protocol: 'claws/2', role: 'observer', peerName: 'test-observer',
  }) + '\n');
  await waitFor(() => observer.responses.has(3), 2000);

  let observerPeerId = null;
  check('observer hello ok', () => {
    const r = observer.responses.get(3);
    if (!r || !r.ok) throw new Error(`observer hello failed: ${JSON.stringify(r)}`);
    observerPeerId = r.peerId;
  });

  const obsPushBefore = observer.pushes.length;
  const obsCmdTopic = `cmd.${observerPeerId}.test`;
  orch.socket.write(JSON.stringify({
    id: 30, cmd: 'publish', protocol: 'claws/2',
    topic: obsCmdTopic,
    payload: { kind: 'CMD', action: 'test' },
    echo: true,
  }) + '\n');
  await waitFor(() => orch.responses.has(30), 2000);
  // Small wait to ensure push would have arrived if auto-subscribed
  await new Promise((r) => setTimeout(r, 200));

  check('observer does NOT receive cmd.<peerId>.** auto-subscription push', () => {
    const received = observer.pushes.slice(obsPushBefore).find((f) => f.topic === obsCmdTopic);
    if (received) throw new Error('observer unexpectedly received cmd push — should not be auto-subscribed');
  });

  orch.socket.destroy();
  worker.socket.destroy();
  observer.socket.destroy();
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
