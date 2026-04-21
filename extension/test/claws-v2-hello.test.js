#!/usr/bin/env node
// claws/2 hello handshake test. Activates the extension against a mocked
// vscode, connects a client, and asserts the hello/ping behaviour plus
// claws/1 backward compatibility.
//
// Run: node extension/test/claws-v2-hello.test.js
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
    if (r && typeof r.then === 'function') return r.then(() => assertions.push({ name, ok: true }), (e) => assertions.push({ name, ok: false, err: e.message || String(e) }));
    assertions.push({ name, ok: true });
  } catch (e) {
    assertions.push({ name, ok: false, err: e.message || String(e) });
  }
}

(async () => {
  const ready = await waitFor(() => fs.existsSync(sockPath), 3000);
  check('socket ready', () => { if (!ready) throw new Error('no socket'); });

  // ── 1. hello as orchestrator ─────────────────────────────────────────
  const a = connect();
  await new Promise((resolve) => a.socket.on('connect', resolve));

  a.socket.write(JSON.stringify({
    id: 1, cmd: 'hello', protocol: 'claws/2',
    role: 'orchestrator', peerName: 'test-orc',
  }) + '\n');

  await waitFor(() => a.responses.has(1), 2000);

  check('hello returns ok + peerId + protocol:claws/2', () => {
    const r = a.responses.get(1);
    if (!r || !r.ok) throw new Error(`hello failed: ${JSON.stringify(r)}`);
    if (typeof r.peerId !== 'string') throw new Error('no peerId');
    if (!/^p_[0-9a-f]{6}$/.test(r.peerId)) throw new Error(`peerId shape wrong: ${r.peerId}`);
    if (r.protocol !== 'claws/2') throw new Error(`wrong protocol tag: ${r.protocol}`);
  });

  // ── 2. second orchestrator on a fresh connection is rejected ─────────
  const b = connect();
  await new Promise((resolve) => b.socket.on('connect', resolve));

  b.socket.write(JSON.stringify({
    id: 2, cmd: 'hello', protocol: 'claws/2',
    role: 'orchestrator', peerName: 'test-orc-2',
  }) + '\n');

  await waitFor(() => b.responses.has(2), 2000);

  check('second orchestrator rejected', () => {
    const r = b.responses.get(2);
    if (!r) throw new Error('no response');
    if (r.ok) throw new Error('expected ok:false');
    if (!/orchestrator already registered/.test(String(r.error || ''))) {
      throw new Error(`wrong error: ${r.error}`);
    }
  });

  // ── 3. hello without protocol field is rejected ──────────────────────
  b.socket.write(JSON.stringify({
    id: 3, cmd: 'hello', role: 'worker', peerName: 'no-proto',
  }) + '\n');

  await waitFor(() => b.responses.has(3), 2000);

  check('hello without protocol rejected', () => {
    const r = b.responses.get(3);
    if (!r) throw new Error('no response');
    if (r.ok) throw new Error('expected ok:false');
  });

  // ── 4. ping returns ok + serverTime ──────────────────────────────────
  b.socket.write(JSON.stringify({ id: 4, cmd: 'ping' }) + '\n');
  await waitFor(() => b.responses.has(4), 2000);

  check('ping returns serverTime', () => {
    const r = b.responses.get(4);
    if (!r || !r.ok) throw new Error(`ping failed: ${JSON.stringify(r)}`);
    if (typeof r.serverTime !== 'number') throw new Error(`serverTime not a number: ${r.serverTime}`);
  });

  // ── 5. claws/1 client (no hello) can still use list — backward compat ─
  const c = connect();
  await new Promise((resolve) => c.socket.on('connect', resolve));

  c.socket.write(JSON.stringify({ id: 5, cmd: 'list' }) + '\n');
  await waitFor(() => c.responses.has(5), 2000);

  check('claws/1 list still works without hello', () => {
    const r = c.responses.get(5);
    if (!r || !r.ok) throw new Error(`list failed: ${JSON.stringify(r)}`);
    if (!Array.isArray(r.terminals)) throw new Error('no terminals array');
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
