#!/usr/bin/env node
// L2 stable peerId + L3 capability enforcement tests.
//
// Test 1 — stable identity across reconnects:
//   hello(peerName, instanceNonce) → peerId.
//   Disconnect. Reconnect with same nonce → SAME peerId returned.
//   Subscriptions from the previous session are restored (push still delivered).
//
// Test 2 — capability gate:
//   hello with capabilities=['observe'] (no 'publish') → publish → ok:false capability:required.
//   hello with capabilities=['publish'] → publish → ok:true.
//
// Run: node extension/test/claws-v2-identity.test.js
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

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-identity-'));
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

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 1 — Stable identity across reconnects
  // ══════════════════════════════════════════════════════════════════════════

  // 1a. First connection with instanceNonce
  const p1 = connect();
  await new Promise((resolve) => p1.socket.on('connect', resolve));

  p1.socket.write(JSON.stringify({
    id: 10, cmd: 'hello', protocol: 'claws/2',
    role: 'worker', peerName: 'stable-worker', instanceNonce: 'test-nonce-abc',
    capabilities: ['publish', 'subscribe'],
  }) + '\n');
  await waitFor(() => p1.responses.has(10), 2000);

  let firstPeerId;
  check('hello with instanceNonce returns ok + stable peerId', () => {
    const r = p1.responses.get(10);
    if (!r || !r.ok) throw new Error(`hello failed: ${JSON.stringify(r)}`);
    if (typeof r.peerId !== 'string') throw new Error('no peerId');
    firstPeerId = r.peerId;
  });

  // 1b. Subscribe to a topic on the first connection
  p1.socket.write(JSON.stringify({
    id: 11, cmd: 'subscribe', protocol: 'claws/2', topic: 'stable.test.topic',
  }) + '\n');
  await waitFor(() => p1.responses.has(11), 2000);

  check('subscribe on first connection succeeds', () => {
    const r = p1.responses.get(11);
    if (!r || !r.ok) throw new Error(`subscribe failed: ${JSON.stringify(r)}`);
  });

  // 1c. Disconnect first connection
  await new Promise((resolve) => {
    p1.socket.once('close', resolve);
    p1.socket.destroy();
  });
  await new Promise((r) => setTimeout(r, 100));

  // 1d. Reconnect with same peerName + instanceNonce → SAME peerId
  const p2 = connect();
  await new Promise((resolve) => p2.socket.on('connect', resolve));

  p2.socket.write(JSON.stringify({
    id: 20, cmd: 'hello', protocol: 'claws/2',
    role: 'worker', peerName: 'stable-worker', instanceNonce: 'test-nonce-abc',
    capabilities: ['publish', 'subscribe'],
  }) + '\n');
  await waitFor(() => p2.responses.has(20), 2000);

  check('reconnect with same nonce returns SAME peerId', () => {
    const r = p2.responses.get(20);
    if (!r || !r.ok) throw new Error(`reconnect hello failed: ${JSON.stringify(r)}`);
    if (r.peerId !== firstPeerId) {
      throw new Error(`peerId changed on reconnect: ${firstPeerId} → ${r.peerId}`);
    }
  });

  // 1e. Different nonce → DIFFERENT peerId
  const p3 = connect();
  await new Promise((resolve) => p3.socket.on('connect', resolve));

  p3.socket.write(JSON.stringify({
    id: 30, cmd: 'hello', protocol: 'claws/2',
    role: 'worker', peerName: 'stable-worker', instanceNonce: 'different-nonce-xyz',
    capabilities: ['publish', 'subscribe'],
  }) + '\n');
  await waitFor(() => p3.responses.has(30), 2000);

  check('different nonce yields different peerId', () => {
    const r = p3.responses.get(30);
    if (!r || !r.ok) throw new Error(`hello failed: ${JSON.stringify(r)}`);
    if (r.peerId === firstPeerId) {
      throw new Error(`different nonce should produce different peerId, got same: ${r.peerId}`);
    }
  });

  // 1f. Subscription restoration: publish from p3 to stable.test.topic → p2 receives it
  //     (p2 has the restored subscription from the first connection session)
  const p4 = connect();
  await new Promise((resolve) => p4.socket.on('connect', resolve));

  p4.socket.write(JSON.stringify({
    id: 40, cmd: 'hello', protocol: 'claws/2',
    role: 'orchestrator', peerName: 'test-orc',
    capabilities: ['publish'],
  }) + '\n');
  await waitFor(() => p4.responses.has(40), 2000);

  const pushCountBefore = p2.pushes.length;
  p4.socket.write(JSON.stringify({
    id: 41, cmd: 'publish', protocol: 'claws/2',
    topic: 'stable.test.topic', payload: { restored: true },
  }) + '\n');
  await waitFor(() => p4.responses.has(41), 2000);
  await new Promise((r) => setTimeout(r, 150));

  check('subscription restored after reconnect — push delivered', () => {
    const pushed = p2.pushes.filter((p) => p.topic === 'stable.test.topic' && p.payload && p.payload.restored === true);
    if (pushed.length === 0) {
      throw new Error(`no push on stable.test.topic delivered to reconnected peer (total pushes: ${p2.pushes.length})`);
    }
  });

  p2.socket.destroy();
  p3.socket.destroy();
  p4.socket.destroy();
  await new Promise((r) => setTimeout(r, 100));

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 2 — Capability gate: publish requires 'publish' capability
  // ══════════════════════════════════════════════════════════════════════════

  // 2a. Worker with capabilities=['observe'] (no 'publish') — publish rejected
  const cap1 = connect();
  await new Promise((resolve) => cap1.socket.on('connect', resolve));

  cap1.socket.write(JSON.stringify({
    id: 50, cmd: 'hello', protocol: 'claws/2',
    role: 'worker', peerName: 'cap-worker-observe-only',
    capabilities: ['observe'],
  }) + '\n');
  await waitFor(() => cap1.responses.has(50), 2000);

  check('hello with observe-only capability succeeds', () => {
    const r = cap1.responses.get(50);
    if (!r || !r.ok) throw new Error(`hello failed: ${JSON.stringify(r)}`);
  });

  cap1.socket.write(JSON.stringify({
    id: 51, cmd: 'publish', protocol: 'claws/2',
    topic: 'cap.test.topic', payload: { x: 1 },
  }) + '\n');
  await waitFor(() => cap1.responses.has(51), 2000);

  check("publish without 'publish' capability returns capability:required", () => {
    const r = cap1.responses.get(51);
    if (!r) throw new Error('no response to publish');
    if (r.ok) throw new Error('expected ok:false but got ok:true');
    if (!/capability:required/.test(String(r.error || ''))) {
      throw new Error(`expected capability:required error, got: ${r.error}`);
    }
  });

  // 2b. Worker with capabilities=['publish'] — publish succeeds
  const cap2 = connect();
  await new Promise((resolve) => cap2.socket.on('connect', resolve));

  cap2.socket.write(JSON.stringify({
    id: 60, cmd: 'hello', protocol: 'claws/2',
    role: 'worker', peerName: 'cap-worker-with-publish',
    capabilities: ['publish'],
  }) + '\n');
  await waitFor(() => cap2.responses.has(60), 2000);

  check('hello with publish capability succeeds', () => {
    const r = cap2.responses.get(60);
    if (!r || !r.ok) throw new Error(`hello failed: ${JSON.stringify(r)}`);
  });

  cap2.socket.write(JSON.stringify({
    id: 61, cmd: 'publish', protocol: 'claws/2',
    topic: 'cap.test.topic', payload: { y: 2 },
  }) + '\n');
  await waitFor(() => cap2.responses.has(61), 2000);

  check("publish with 'publish' capability returns ok:true", () => {
    const r = cap2.responses.get(61);
    if (!r || !r.ok) throw new Error(`publish failed unexpectedly: ${JSON.stringify(r)}`);
  });

  // 2c. Worker with empty capabilities — backward compat, all commands allowed
  const cap3 = connect();
  await new Promise((resolve) => cap3.socket.on('connect', resolve));

  cap3.socket.write(JSON.stringify({
    id: 70, cmd: 'hello', protocol: 'claws/2',
    role: 'worker', peerName: 'cap-worker-legacy',
    capabilities: [],
  }) + '\n');
  await waitFor(() => cap3.responses.has(70), 2000);

  cap3.socket.write(JSON.stringify({
    id: 71, cmd: 'publish', protocol: 'claws/2',
    topic: 'cap.test.topic', payload: { legacy: true },
  }) + '\n');
  await waitFor(() => cap3.responses.has(71), 2000);

  check('empty capabilities → backward compat, publish allowed', () => {
    const r = cap3.responses.get(71);
    if (!r || !r.ok) throw new Error(`publish should be allowed for legacy peer: ${JSON.stringify(r)}`);
  });

  cap1.socket.destroy();
  cap2.socket.destroy();
  cap3.socket.destroy();

  await ext.deactivate();
  await new Promise((r) => setTimeout(r, 100));

  for (const a of assertions) {
    console.log(`  ${a.ok ? 'PASS' : 'FAIL'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
  }
  try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = assertions.filter((a) => !a.ok);
  if (failed.length > 0) { console.error(`\nFAIL: ${failed.length}/${assertions.length} check(s) failed.`); process.exit(1); }
  console.log(`\nPASS: ${assertions.length} checks`);
  process.exit(0);
})();
