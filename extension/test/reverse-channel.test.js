#!/usr/bin/env node
// claws/2 reverse channel integration test. Activates the extension against a
// mocked vscode, connects orchestrator + worker peers, and asserts the full
// broadcast inject path: [CLAWS_CMD r=<id>] text delivered to mock PTY via
// writeInjected AND via the pub/sub push frame on the worker socket.
//
// Run: node extension/test/reverse-channel.test.js
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

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-rc-'));
const logs = [];

// ─── PTY call capture ─────────────────────────────────────────────────────
const injectedCalls = [];
let capturedPty = null;

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
    // Intercept createTerminal to capture the ClawsPty and patch writeInjected
    createTerminal: (opts) => {
      const t = { name: opts?.name || 'mock', processId: Promise.resolve(12345), shellIntegration: undefined, show: () => {}, sendText: () => {}, dispose: () => {} };
      if (opts && opts.pty && !capturedPty) {
        capturedPty = opts.pty;
        // Force isOpen=true so writeInjected doesn't bail early
        capturedPty.isOpen = true;
        // Intercept writeInjected — the real impl calls ptyProc.write which doesn't exist in tests
        capturedPty.writeInjected = (text, newline, paste) => {
          injectedCalls.push({ text, newline, paste });
        };
      }
      // Fire onOpen so TerminalManager registers this terminal
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

async function hello(peer, id, role, name, terminalId) {
  const req = { id, cmd: 'hello', protocol: 'claws/2', role, peerName: name };
  if (terminalId != null) req.terminalId = terminalId;
  peer.socket.write(JSON.stringify(req) + '\n');
  await waitFor(() => peer.responses.has(id), 2000);
  const r = peer.responses.get(id);
  if (!r || !r.ok) throw new Error(`hello failed for ${name}: ${JSON.stringify(r)}`);
  return r.peerId;
}

const CMD_TEXT = '[CLAWS_CMD r=r1] approve_request: {"approved":true}';
// After L3.1 the server injects seq=N after [CLAWS_CMD, so injected/pushed text is
// "[CLAWS_CMD seq=<N> r=r1] approve_request: ..."
const CMD_TEXT_RE = /^\[CLAWS_CMD seq=\d+ r=r1\] approve_request/;

(async () => {
  const ready = await waitFor(() => fs.existsSync(sockPath), 3000);
  check('socket ready', () => { if (!ready) throw new Error('no socket'); });

  // ── Setup: lifecycle plan (required before create) + wrapped terminal ─────
  const setup = connect();
  await new Promise((resolve) => setup.socket.on('connect', resolve));

  setup.socket.write(JSON.stringify({
    id: 50, cmd: 'lifecycle.plan', plan: 'reverse-channel integration test',
  }) + '\n');
  await waitFor(() => setup.responses.has(50), 2000);

  setup.socket.write(JSON.stringify({
    id: 51, cmd: 'create', name: 'rc-test-worker', wrapped: true,
  }) + '\n');
  await waitFor(() => setup.responses.has(51), 2000);

  const createResp = setup.responses.get(51);
  check('create wrapped terminal succeeds', () => {
    if (!createResp || !createResp.ok) throw new Error(`create failed: ${JSON.stringify(createResp)}`);
    if (!createResp.id) throw new Error('no id returned from create');
  });

  const wrappedTerminalId = createResp && createResp.ok ? createResp.id : null;

  // Wait for PTY to be captured (createTerminal fires async onOpen)
  await waitFor(() => capturedPty !== null, 500);

  // ── Connect orchestrator and worker (worker uses the wrapped terminal id) ──
  const orch = connect();
  await new Promise((resolve) => orch.socket.on('connect', resolve));
  await hello(orch, 1, 'orchestrator', 'test-orch');

  const worker = connect();
  await new Promise((resolve) => worker.socket.on('connect', resolve));
  await hello(worker, 2, 'worker', 'test-worker', wrappedTerminalId);

  // Worker subscribes to system.broadcast so push frames arrive on its socket
  worker.socket.write(JSON.stringify({ id: 3, cmd: 'subscribe', topic: 'system.broadcast' }) + '\n');
  await waitFor(() => worker.responses.has(3), 2000);
  check('worker subscribed to system.broadcast', () => {
    const r = worker.responses.get(3);
    if (!r || !r.ok) throw new Error(`subscribe failed: ${JSON.stringify(r)}`);
  });

  // ── 1. Non-orchestrator attempting broadcast -> ok:false ──────────────────
  worker.socket.write(JSON.stringify({
    id: 10, cmd: 'broadcast', text: CMD_TEXT, targetRole: 'worker', inject: true,
  }) + '\n');
  await waitFor(() => worker.responses.has(10), 2000);
  check('non-orchestrator broadcast rejected', () => {
    const r = worker.responses.get(10);
    if (!r) throw new Error('no response');
    if (r.ok) throw new Error('expected ok:false for non-orchestrator broadcast');
  });

  // ── 2. Orchestrator broadcast with inject=true -> deliveredTo:1 ───────────
  const pushCountBefore = worker.pushes.length;
  const injCountBefore = injectedCalls.length;

  orch.socket.write(JSON.stringify({
    id: 20, cmd: 'broadcast', text: CMD_TEXT, targetRole: 'worker', inject: true,
  }) + '\n');
  await waitFor(() => orch.responses.has(20), 2000);

  check('broadcast returns ok:true', () => {
    const r = orch.responses.get(20);
    if (!r || !r.ok) throw new Error(`broadcast failed: ${JSON.stringify(r)}`);
  });

  check('broadcast deliveredTo is 1', () => {
    const r = orch.responses.get(20);
    if (!r) throw new Error('no response');
    if (r.deliveredTo !== 1) throw new Error(`expected deliveredTo:1, got ${r.deliveredTo}`);
  });

  // ── 3. Push frame delivered to worker socket ──────────────────────────────
  await waitFor(() => worker.pushes.length > pushCountBefore, 2000);
  check('push frame delivered to worker socket', () => {
    const p = worker.pushes.slice(pushCountBefore).find((f) => f.topic === 'system.broadcast');
    if (!p) throw new Error('worker did not receive system.broadcast push frame');
    if (p.push !== 'message') throw new Error(`wrong push type: ${p.push}`);
    if (p.rid != null) throw new Error('push frame must not have rid');
    if (!p.payload || !CMD_TEXT_RE.test(p.payload.text)) {
      throw new Error(`push payload text mismatch: ${JSON.stringify(p.payload)}`);
    }
  });

  // ── 4. writeInjected called with exact [CLAWS_CMD] string ────────────────
  await waitFor(() => injectedCalls.length > injCountBefore, 500);
  check('writeInjected called with exact [CLAWS_CMD] text', () => {
    if (!capturedPty) throw new Error('PTY was not captured from createTerminal — test infrastructure issue');
    const call = injectedCalls.slice(injCountBefore).find((c) => CMD_TEXT_RE.test(c.text));
    if (!call) throw new Error(`writeInjected not called with expected text. Calls: ${JSON.stringify(injectedCalls)}`);
    if (!CMD_TEXT_RE.test(call.text)) throw new Error(`text mismatch: ${call.text}`);
  });

  // ── 5. Worker without terminalId -> push frame delivered, no PTY call ─────
  const worker2 = connect();
  await new Promise((resolve) => worker2.socket.on('connect', resolve));
  await hello(worker2, 4, 'worker', 'test-worker-no-tid');

  worker2.socket.write(JSON.stringify({ id: 5, cmd: 'subscribe', topic: 'system.broadcast' }) + '\n');
  await waitFor(() => worker2.responses.has(5), 2000);

  const injCountBefore2 = injectedCalls.length;
  const pushCountBefore2 = worker2.pushes.length;
  const pushCountBefore3 = worker.pushes.length;

  orch.socket.write(JSON.stringify({
    id: 30, cmd: 'broadcast', text: CMD_TEXT, targetRole: 'worker', inject: true,
  }) + '\n');
  await waitFor(() => orch.responses.has(30), 2000);

  check('broadcast to 2 workers -> deliveredTo:2', () => {
    const r = orch.responses.get(30);
    if (!r || !r.ok) throw new Error(`broadcast failed: ${JSON.stringify(r)}`);
    if (r.deliveredTo !== 2) throw new Error(`expected deliveredTo:2, got ${r.deliveredTo}`);
  });

  await waitFor(() => worker2.pushes.length > pushCountBefore2, 2000);
  check('worker2 (no terminalId) receives push frame', () => {
    const p = worker2.pushes.slice(pushCountBefore2).find((f) => f.topic === 'system.broadcast');
    if (!p) throw new Error('worker2 did not receive push frame');
  });

  // writeInjected only fires for worker WITH terminalId (at most 1 more call)
  check('no writeInjected for worker without terminalId', () => {
    const extra = injectedCalls.length - injCountBefore2;
    if (extra > 1) throw new Error(`unexpected extra writeInjected calls: ${extra}`);
  });

  // ── 6. Both workers receive push frame on second broadcast ─────────────────
  await waitFor(() => worker.pushes.length > pushCountBefore3, 2000);
  check('original worker also receives push frame on second broadcast', () => {
    const p = worker.pushes.slice(pushCountBefore3).find((f) => f.topic === 'system.broadcast');
    if (!p) throw new Error('original worker did not receive second broadcast push frame');
  });

  // ─── Teardown ─────────────────────────────────────────────────────────────
  setup.socket.destroy();
  orch.socket.destroy();
  worker.socket.destroy();
  worker2.socket.destroy();
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
