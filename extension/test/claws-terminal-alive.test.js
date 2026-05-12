#!/usr/bin/env node
// Bug-15 regression test: verify system.terminal.<id>.alive events are emitted
// each heartbeat cycle with a terminal_id field.
//
// Run: node extension/test/claws-terminal-alive.test.js
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

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-alive-'));
const logs = [];

// ─── Mock vscode ──────────────────────────────────────────────────────────
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

// Use a short heartbeat interval so the test completes in < 1 s.
const FAST_HEARTBEAT_MS = 200;

const vscode = {
  EventEmitter, TerminalProfile, MarkdownString, ThemeColor,
  StatusBarAlignment: { Left: 1, Right: 2 },
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file', path: p }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
    getConfiguration: (_s) => ({
      get: (key, fallback) => key === 'heartbeatIntervalMs' ? FAST_HEARTBEAT_MS : fallback,
    }),
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
    registerCommand: () => ({ dispatch: () => {} }),
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
  while (Date.now() < deadline) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
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

(async () => {
  const ready = await waitFor(() => fs.existsSync(sockPath), 3000);
  check('socket ready', () => { if (!ready) throw new Error('no socket'); });
  if (!ready) {
    console.error('FAIL: socket not ready');
    process.exit(1);
  }

  // ── Register a mock terminal so liveTerminalIds() returns a non-empty set ──
  const mockTerminal = {
    name: 'alive-test-terminal',
    processId: Promise.resolve(99999),
    shellIntegration: undefined,
    show: () => {},
    sendText: () => {},
    dispose: () => {},
  };
  onOpen.fire(mockTerminal);

  // ── Connect as observer and subscribe to system.terminal.* ─────────────
  const obs = connect();
  await new Promise((resolve) => obs.socket.on('connect', resolve));

  obs.socket.write(JSON.stringify({ id: 1, cmd: 'hello', protocol: 'claws/2', role: 'observer', peerName: 'alive-test-obs' }) + '\n');
  const helloOk = await waitFor(() => obs.responses.has(1), 2000);
  check('observer hello ok', () => {
    if (!helloOk) throw new Error('hello timed out');
    const r = obs.responses.get(1);
    if (!r || !r.ok) throw new Error(`hello failed: ${JSON.stringify(r)}`);
  });

  obs.socket.write(JSON.stringify({ id: 2, cmd: 'subscribe', topic: 'system.terminal.**' }) + '\n');
  const subOk = await waitFor(() => obs.responses.has(2), 2000);
  check('subscribe system.terminal.** ok', () => {
    if (!subOk) throw new Error('subscribe timed out');
    const r = obs.responses.get(2);
    if (!r || !r.ok) throw new Error(`subscribe failed: ${JSON.stringify(r)}`);
  });

  // ── Wait for at least one system.terminal.<id>.alive push frame ─────────
  // Heartbeat fires every FAST_HEARTBEAT_MS (200ms). Allow 4× that as margin.
  const aliveReceived = await waitFor(
    () => obs.pushes.some((f) => f.topic && /^system\.terminal\.\d+\.alive$/.test(f.topic)),
    FAST_HEARTBEAT_MS * 4,
  );

  check('system.terminal.<id>.alive event received', () => {
    if (!aliveReceived) throw new Error('no alive event within timeout');
  });

  // ── Verify payload structure ─────────────────────────────────────────────
  const aliveFrame = obs.pushes.find((f) => f.topic && /^system\.terminal\.\d+\.alive$/.test(f.topic));
  check('alive event has terminal_id (snake_case) in payload', () => {
    if (!aliveFrame) throw new Error('no alive frame');
    const p = aliveFrame.payload;
    if (!p) throw new Error('no payload');
    if (typeof p.terminal_id !== 'string') throw new Error(`terminal_id missing or not a string: ${JSON.stringify(p)}`);
    if (p.terminal_id === '') throw new Error('terminal_id is empty string');
  });

  check('alive event terminal_id matches topic id', () => {
    if (!aliveFrame) throw new Error('no alive frame');
    const topicId = aliveFrame.topic.replace('system.terminal.', '').replace('.alive', '');
    if (aliveFrame.payload.terminal_id !== topicId) {
      throw new Error(`topic id "${topicId}" !== payload terminal_id "${aliveFrame.payload.terminal_id}"`);
    }
  });

  check('alive event has ts field', () => {
    if (!aliveFrame) throw new Error('no alive frame');
    if (typeof aliveFrame.payload.ts !== 'string') throw new Error(`ts missing: ${JSON.stringify(aliveFrame.payload)}`);
  });

  obs.socket.destroy();
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
