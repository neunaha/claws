#!/usr/bin/env node
// W8ac-1 — correlation_id substrate regression suite.
//
// Five test cases:
//   TC1 (static): CLAWS_TERMINAL_CORR_ID env var injection present in claws-pty.ts
//   TC2 (runtime): hello with correlation_id stores on peer AND publishes system.peer.connected
//   TC3 (runtime): hello with duplicate correlation_id is rejected
//   TC4 (static):  system.terminal.ready emitted exactly once via onFirstOutput guard in vscode-backend.ts
//   TC5 (runtime): hello without correlation_id does NOT publish system.peer.connected
//
// Run: node extension/test/claws-v2-correlation-events.test.js
// Exits 0 on success, 1 on failure.

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const EXT_ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(EXT_ROOT, 'dist', 'extension.js');
const SRC = path.join(EXT_ROOT, 'src');

// ─── TC1 + TC4: static analysis — no bundle required ─────────────────────────

const assertions = [];
function check(name, ok, detail) {
  assertions.push({ name, ok: !!ok, detail: detail || '' });
}

const CLAWS_PTY_SRC = fs.readFileSync(path.join(SRC, 'backends', 'vscode', 'claws-pty.ts'), 'utf8');
const VSCODE_BACKEND_SRC = fs.readFileSync(path.join(SRC, 'backends', 'vscode', 'vscode-backend.ts'), 'utf8');
const PEER_REGISTRY_SRC = fs.readFileSync(path.join(SRC, 'peer-registry.ts'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(SRC, 'server.ts'), 'utf8');
const PROTOCOL_SRC = fs.readFileSync(path.join(SRC, 'protocol.ts'), 'utf8');

// TC1: CLAWS_TERMINAL_CORR_ID env var injected when correlationId is present
check(
  'TC1a: claws-pty.ts injects CLAWS_TERMINAL_CORR_ID into pty env when correlationId set',
  /CLAWS_TERMINAL_CORR_ID/.test(CLAWS_PTY_SRC) &&
  /correlationId/.test(CLAWS_PTY_SRC),
);
check(
  'TC1b: protocol.ts CreateRequest has correlation_id field',
  /interface CreateRequest[\s\S]{0,600}correlation_id\?:\s*string/.test(PROTOCOL_SRC),
);
check(
  'TC1c: server.ts create handler extracts correlation_id and passes as correlationId',
  /corrIdForCreate/.test(SERVER_SRC) &&
  /correlation_id/.test(SERVER_SRC),
);

// TC4: system.terminal.ready emitted via onFirstOutput guard — exactly-once pattern
check(
  'TC4a: vscode-backend.ts has onFirstOutput callback wiring for terminal:ready',
  /onFirstOutput/.test(VSCODE_BACKEND_SRC) &&
  /terminal:ready/.test(VSCODE_BACKEND_SRC),
);
check(
  'TC4b: claws-pty.ts firstOutputFired guard ensures onFirstOutputHook fires exactly once',
  /firstOutputFired/.test(CLAWS_PTY_SRC) &&
  /onFirstOutputHook\?\.?\(\)/.test(CLAWS_PTY_SRC),
);
check(
  'TC4c: server.ts listens for terminal:ready and emits system.terminal.ready bus event',
  /terminal:ready/.test(SERVER_SRC) &&
  /system\.terminal\.ready/.test(SERVER_SRC),
);

// Peer registry field check
check(
  'TC-peer: PeerConnection interface has correlationId field',
  /correlationId\?:\s*string/.test(PEER_REGISTRY_SRC),
);

// ─── TC2, TC3, TC5: runtime integration via socket ───────────────────────────

if (!fs.existsSync(BUNDLE)) {
  console.error('FAIL: dist/extension.js not found. Run `npm run build` first.');
  process.exit(1);
}

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-ac1-'));
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
        const f = JSON.parse(line);
        if (f.rid != null) responses.set(f.rid, f);
        else pushes.push(f);
      } catch { /* ignore */ }
    }
  });
  return { socket: s, responses, pushes };
}

async function send(conn, req) {
  conn.socket.write(JSON.stringify(req) + '\n');
  await waitFor(() => conn.responses.has(req.id), 2000);
  return conn.responses.get(req.id);
}

async function checkAsync(name, fn) {
  try {
    await fn();
    assertions.push({ name, ok: true });
  } catch (e) {
    assertions.push({ name, ok: false, detail: e.message || String(e) });
  }
}

(async () => {
  const ready = await waitFor(() => fs.existsSync(sockPath), 3000);
  if (!ready) {
    assertions.push({ name: 'socket ready', ok: false, detail: 'no socket after 3s' });
    printReport();
    process.exit(1);
  }

  // ── Orchestrator connection (needed for lifecycle.plan to allow hello) ───
  const orcConn = connect();
  await new Promise((r) => orcConn.socket.on('connect', r));
  const orcHello = await send(orcConn, { id: 1, cmd: 'hello', protocol: 'claws/2', role: 'orchestrator', peerName: 'ac1-orc' });
  if (!orcHello || !orcHello.ok) {
    assertions.push({ name: 'orc hello', ok: false, detail: 'orchestrator hello failed' });
    printReport();
    process.exit(1);
  }

  // ── Observer connection subscribes to system.peer.connected ─────────────
  const obsConn = connect();
  await new Promise((r) => obsConn.socket.on('connect', r));
  await send(obsConn, { id: 10, cmd: 'hello', protocol: 'claws/2', role: 'observer', peerName: 'ac1-obs' });
  await send(obsConn, { id: 11, cmd: 'subscribe', topic: 'system.peer.connected' });

  // ── TC2: hello with correlation_id stores corrId and publishes system.peer.connected ──
  await checkAsync('TC2: hello with correlation_id publishes system.peer.connected with corr_id in payload', async () => {
    const CORR_ID = 'test-corr-' + Date.now();
    const workerConn = connect();
    await new Promise((r) => workerConn.socket.on('connect', r));
    const wRes = await send(workerConn, {
      id: 20, cmd: 'hello', protocol: 'claws/2',
      role: 'worker', peerName: 'ac1-worker-1',
      correlation_id: CORR_ID,
    });
    if (!wRes || !wRes.ok) throw new Error(`hello with corr_id failed: ${JSON.stringify(wRes)}`);

    // Wait for system.peer.connected push on the observer connection
    const ok = await waitFor(() => obsConn.pushes.some(
      p => p.topic === 'system.peer.connected' &&
           p.payload && p.payload.correlation_id === CORR_ID
    ), 2000);
    if (!ok) {
      throw new Error(
        `system.peer.connected not received. pushes: ${JSON.stringify(obsConn.pushes.map(p => ({ topic: p.topic, payload: p.payload })))}`
      );
    }
    // Verify payload shape
    const frame = obsConn.pushes.find(p => p.topic === 'system.peer.connected' && p.payload && p.payload.correlation_id === CORR_ID);
    if (!frame.payload.peer_id) throw new Error('payload missing peer_id');
    if (frame.payload.role !== 'worker') throw new Error(`wrong role: ${frame.payload.role}`);
    workerConn.socket.destroy();
  });

  // ── TC3: hello with duplicate correlation_id is rejected ────────────────
  await checkAsync('TC3: hello with duplicate correlation_id is rejected', async () => {
    const DUP_ID = 'dup-corr-' + Date.now();

    const w1 = connect();
    await new Promise((r) => w1.socket.on('connect', r));
    const r1 = await send(w1, { id: 30, cmd: 'hello', protocol: 'claws/2', role: 'worker', peerName: 'dup-w1', correlation_id: DUP_ID });
    if (!r1 || !r1.ok) throw new Error(`first hello failed: ${JSON.stringify(r1)}`);

    const w2 = connect();
    await new Promise((r) => w2.socket.on('connect', r));
    const r2 = await send(w2, { id: 31, cmd: 'hello', protocol: 'claws/2', role: 'worker', peerName: 'dup-w2', correlation_id: DUP_ID });
    if (!r2) throw new Error('no response to duplicate hello');
    if (r2.ok) throw new Error('expected ok:false for duplicate correlation_id');
    if (!String(r2.error || '').includes(DUP_ID)) {
      throw new Error(`error should mention the duplicate corr_id. got: ${r2.error}`);
    }
    w1.socket.destroy();
    w2.socket.destroy();
  });

  // ── TC5: hello WITHOUT correlation_id does NOT publish system.peer.connected ─
  await checkAsync('TC5: hello without correlation_id does NOT publish system.peer.connected', async () => {
    const framesBefore = obsConn.pushes.filter(p => p.topic === 'system.peer.connected').length;

    const noCorr = connect();
    await new Promise((r) => noCorr.socket.on('connect', r));
    const nr = await send(noCorr, { id: 40, cmd: 'hello', protocol: 'claws/2', role: 'worker', peerName: 'no-corr-worker' });
    if (!nr || !nr.ok) throw new Error(`hello without corr_id failed: ${JSON.stringify(nr)}`);

    // Wait 300ms — enough for any bus publish to arrive, none should come.
    await new Promise((r) => setTimeout(r, 300));
    const framesAfter = obsConn.pushes.filter(p => p.topic === 'system.peer.connected').length;
    if (framesAfter > framesBefore) {
      throw new Error(`system.peer.connected was published without correlation_id (frame count: ${framesBefore} → ${framesAfter})`);
    }
    noCorr.socket.destroy();
  });

  orcConn.socket.destroy();
  obsConn.socket.destroy();
  await ext.deactivate();
  await new Promise((r) => setTimeout(r, 100));

  printReport();
  try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = assertions.filter((a) => !a.ok);
  if (failed.length > 0) { console.error(`\nFAIL: ${failed.length}/${assertions.length} check(s) failed.`); process.exit(1); }
  process.exit(0);
})();

function printReport() {
  for (const a of assertions) {
    console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + a.detail}`);
  }
  console.log(`\nPASS: ${assertions.filter(a => a.ok).length}/${assertions.length} checks`);
}
