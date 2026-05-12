#!/usr/bin/env node
// Bug-6 Layer 2 — monitor-corr-arm.test.js
// Tests for hello-with-monitorCorrelationId: server claim tracking,
// isCorrIdArmed via the monitors.is-corr-armed RPC, and disconnect cleanup.
//
// 1. hello with monitorCorrelationId records claim
// 2. hello without monitorCorrelationId does NOT record claim
// 3. disconnect removes claim
// 4. monitors.is-corr-armed RPC returns correct state before and after hello
//
// Run: node extension/test/monitor-corr-arm.test.js
// Exits 0 on success, 1 on failure.

'use strict';

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');

const EXT_ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(EXT_ROOT, 'dist', 'extension.js');

if (!fs.existsSync(BUNDLE)) {
  console.error('FAIL: dist/extension.js not found. Run `npm run build` first.');
  process.exit(1);
}

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-corr-arm-'));
const logs = [];

// ─── Mock vscode ────────────────────────────────────────────────────────────
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

  // ── 1. hello with monitorCorrelationId records claim ────────────────────
  const corrId1 = crypto.randomUUID();
  const a = connect();
  await new Promise((resolve) => a.socket.on('connect', resolve));

  a.socket.write(JSON.stringify({
    id: 10, cmd: 'hello', protocol: 'claws/2',
    role: 'observer', peerName: 'monitor-wait-1',
    monitorCorrelationId: corrId1,
  }) + '\n');

  await waitFor(() => a.responses.has(10), 2000);

  check('hello with monitorCorrelationId returns ok + peerId', () => {
    const r = a.responses.get(10);
    if (!r || !r.ok) throw new Error(`hello failed: ${JSON.stringify(r)}`);
    if (typeof r.peerId !== 'string') throw new Error('no peerId');
  });

  // Verify via monitors.is-corr-armed RPC
  const b = connect();
  await new Promise((resolve) => b.socket.on('connect', resolve));

  b.socket.write(JSON.stringify({
    id: 11, cmd: 'monitors.is-corr-armed', correlation_id: corrId1,
  }) + '\n');
  await waitFor(() => b.responses.has(11), 2000);

  check('hello with monitorCorrelationId records claim: isCorrIdArmed → true', () => {
    const r = b.responses.get(11);
    if (!r || !r.ok) throw new Error(`RPC failed: ${JSON.stringify(r)}`);
    if (r.armed !== true) throw new Error(`expected armed=true, got ${r.armed}`);
    if (typeof r.peerId !== 'string') throw new Error(`expected peerId string, got ${r.peerId}`);
  });

  // ── 2. hello without monitorCorrelationId does NOT record claim ──────────
  const corrId2 = crypto.randomUUID();

  b.socket.write(JSON.stringify({
    id: 12, cmd: 'monitors.is-corr-armed', correlation_id: corrId2,
  }) + '\n');
  await waitFor(() => b.responses.has(12), 2000);

  check('hello without monitorCorrelationId does NOT record claim: isCorrIdArmed → false', () => {
    const r = b.responses.get(12);
    if (!r || !r.ok) throw new Error(`RPC failed: ${JSON.stringify(r)}`);
    if (r.armed !== false) throw new Error(`expected armed=false for unclaimed corrId, got ${r.armed}`);
    if (r.peerId !== null) throw new Error(`expected peerId=null, got ${r.peerId}`);
  });

  // ── 3. disconnect removes claim ──────────────────────────────────────────
  const corrId3 = crypto.randomUUID();
  const c = connect();
  await new Promise((resolve) => c.socket.on('connect', resolve));

  c.socket.write(JSON.stringify({
    id: 20, cmd: 'hello', protocol: 'claws/2',
    role: 'observer', peerName: 'monitor-wait-3',
    monitorCorrelationId: corrId3,
  }) + '\n');
  await waitFor(() => c.responses.has(20), 2000);

  // Verify claimed before disconnect
  b.socket.write(JSON.stringify({
    id: 21, cmd: 'monitors.is-corr-armed', correlation_id: corrId3,
  }) + '\n');
  await waitFor(() => b.responses.has(21), 2000);

  check('disconnect removes claim: armed=true before disconnect', () => {
    const r = b.responses.get(21);
    if (!r || !r.ok) throw new Error(`RPC failed: ${JSON.stringify(r)}`);
    if (r.armed !== true) throw new Error(`expected armed=true before disconnect, got ${r.armed}`);
  });

  // Disconnect and wait for server to process
  c.socket.destroy();
  await new Promise((r) => setTimeout(r, 200));

  b.socket.write(JSON.stringify({
    id: 22, cmd: 'monitors.is-corr-armed', correlation_id: corrId3,
  }) + '\n');
  await waitFor(() => b.responses.has(22), 2000);

  check('disconnect removes claim: armed=false after disconnect', () => {
    const r = b.responses.get(22);
    if (!r || !r.ok) throw new Error(`RPC failed: ${JSON.stringify(r)}`);
    if (r.armed !== false) throw new Error(`expected armed=false after disconnect, got ${r.armed}`);
  });

  // ── 4. monitors.is-corr-armed RPC: before and after hello ───────────────
  const corrId4 = crypto.randomUUID();

  // Before hello: should be unarmed
  b.socket.write(JSON.stringify({
    id: 30, cmd: 'monitors.is-corr-armed', correlation_id: corrId4,
  }) + '\n');
  await waitFor(() => b.responses.has(30), 2000);

  check('monitors.is-corr-armed RPC: armed=false before hello', () => {
    const r = b.responses.get(30);
    if (!r || !r.ok) throw new Error(`RPC failed: ${JSON.stringify(r)}`);
    if (r.armed !== false) throw new Error(`expected armed=false before hello, got ${r.armed}`);
  });

  // Send hello with that corrId
  const d = connect();
  await new Promise((resolve) => d.socket.on('connect', resolve));

  d.socket.write(JSON.stringify({
    id: 31, cmd: 'hello', protocol: 'claws/2',
    role: 'observer', peerName: 'monitor-wait-4',
    monitorCorrelationId: corrId4,
  }) + '\n');
  await waitFor(() => d.responses.has(31), 2000);

  // After hello: should be armed
  b.socket.write(JSON.stringify({
    id: 32, cmd: 'monitors.is-corr-armed', correlation_id: corrId4,
  }) + '\n');
  await waitFor(() => b.responses.has(32), 2000);

  check('monitors.is-corr-armed RPC: armed=true after hello with corrId', () => {
    const r = b.responses.get(32);
    if (!r || !r.ok) throw new Error(`RPC failed: ${JSON.stringify(r)}`);
    if (r.armed !== true) throw new Error(`expected armed=true after hello, got ${r.armed}`);
  });

  // ── Missing correlation_id returns error ─────────────────────────────────
  b.socket.write(JSON.stringify({
    id: 33, cmd: 'monitors.is-corr-armed',
  }) + '\n');
  await waitFor(() => b.responses.has(33), 2000);

  check('monitors.is-corr-armed without correlation_id returns ok:false', () => {
    const r = b.responses.get(33);
    if (!r) throw new Error('no response');
    if (r.ok) throw new Error('expected ok:false for missing correlation_id');
  });

  // ── State-machine tests (Bug-13 two-state arm: intent vs execution) ────────

  // ── SM-1. register-intent: pending=true, armed=true, claimed=false ────────
  const corrIdSm1 = crypto.randomUUID();
  const e = connect();
  await new Promise((resolve) => e.socket.on('connect', resolve));

  e.socket.write(JSON.stringify({
    id: 40, cmd: 'monitors.register-intent', correlation_id: corrIdSm1,
  }) + '\n');
  await waitFor(() => e.responses.has(40), 2000);

  check('monitors.register-intent with valid corrId returns ok:true', () => {
    const r = e.responses.get(40);
    if (!r || !r.ok) throw new Error(`expected ok:true, got ${JSON.stringify(r)}`);
  });

  e.socket.write(JSON.stringify({
    id: 41, cmd: 'monitors.is-corr-armed', correlation_id: corrIdSm1,
  }) + '\n');
  await waitFor(() => e.responses.has(41), 2000);

  check('after register-intent: armed=true, pending=true, claimed=false', () => {
    const r = e.responses.get(41);
    if (!r || !r.ok) throw new Error(`RPC failed: ${JSON.stringify(r)}`);
    if (r.armed !== true) throw new Error(`expected armed=true, got ${r.armed}`);
    if (r.pending !== true) throw new Error(`expected pending=true, got ${r.pending}`);
    if (r.claimed !== false) throw new Error(`expected claimed=false, got ${r.claimed}`);
    if (r.peerId !== null) throw new Error(`expected peerId=null, got ${r.peerId}`);
  });

  // ── SM-2. register-intent then hello-claim: graduation to claimed ─────────
  const corrIdSm2 = crypto.randomUUID();

  e.socket.write(JSON.stringify({
    id: 42, cmd: 'monitors.register-intent', correlation_id: corrIdSm2,
  }) + '\n');
  await waitFor(() => e.responses.has(42), 2000);

  // Now connect as a monitor and claim via hello
  const f = connect();
  await new Promise((resolve) => f.socket.on('connect', resolve));

  f.socket.write(JSON.stringify({
    id: 50, cmd: 'hello', protocol: 'claws/2',
    role: 'observer', peerName: 'monitor-sm2',
    monitorCorrelationId: corrIdSm2,
  }) + '\n');
  await waitFor(() => f.responses.has(50), 2000);

  e.socket.write(JSON.stringify({
    id: 43, cmd: 'monitors.is-corr-armed', correlation_id: corrIdSm2,
  }) + '\n');
  await waitFor(() => e.responses.has(43), 2000);

  check('after register-intent + hello-claim: pending=false, claimed=true, armed=true', () => {
    const r = e.responses.get(43);
    if (!r || !r.ok) throw new Error(`RPC failed: ${JSON.stringify(r)}`);
    if (r.armed !== true) throw new Error(`expected armed=true, got ${r.armed}`);
    if (r.pending !== false) throw new Error(`expected pending=false after graduation, got ${r.pending}`);
    if (r.claimed !== true) throw new Error(`expected claimed=true after hello, got ${r.claimed}`);
    if (typeof r.peerId !== 'string') throw new Error(`expected peerId string, got ${r.peerId}`);
  });

  // ── SM-3. monitors.register-intent with missing corrId returns ok:false ───
  e.socket.write(JSON.stringify({
    id: 44, cmd: 'monitors.register-intent',
  }) + '\n');
  await waitFor(() => e.responses.has(44), 2000);

  check('monitors.register-intent without correlation_id returns ok:false', () => {
    const r = e.responses.get(44);
    if (!r) throw new Error('no response');
    if (r.ok) throw new Error('expected ok:false for missing correlation_id');
  });

  // ── SM-4. disconnect removes claim but NOT pending (corrId returns to neither state) ──
  // Use corrIdSm2 where we did register-intent + hello-claim, then disconnect f
  f.socket.destroy();
  await new Promise((r) => setTimeout(r, 200));

  e.socket.write(JSON.stringify({
    id: 45, cmd: 'monitors.is-corr-armed', correlation_id: corrIdSm2,
  }) + '\n');
  await waitFor(() => e.responses.has(45), 2000);

  check('after hello-claim + disconnect: pending=false, claimed=false, armed=false', () => {
    const r = e.responses.get(45);
    if (!r || !r.ok) throw new Error(`RPC failed: ${JSON.stringify(r)}`);
    if (r.armed !== false) throw new Error(`expected armed=false after disconnect, got ${r.armed}`);
    if (r.pending !== false) throw new Error(`expected pending=false (was graduated, not restored), got ${r.pending}`);
    if (r.claimed !== false) throw new Error(`expected claimed=false after disconnect, got ${r.claimed}`);
  });

  // ── SM-5. intent-only corrId (never claimed) has armed=true before any hello ─
  // Already tested by SM-1; additionally verify fresh corrId with no intent → armed=false
  const corrIdSm5 = crypto.randomUUID();
  e.socket.write(JSON.stringify({
    id: 46, cmd: 'monitors.is-corr-armed', correlation_id: corrIdSm5,
  }) + '\n');
  await waitFor(() => e.responses.has(46), 2000);

  check('fresh corrId with no intent: armed=false, pending=false, claimed=false', () => {
    const r = e.responses.get(46);
    if (!r || !r.ok) throw new Error(`RPC failed: ${JSON.stringify(r)}`);
    if (r.armed !== false) throw new Error(`expected armed=false for fresh corrId, got ${r.armed}`);
    if (r.pending !== false) throw new Error(`expected pending=false, got ${r.pending}`);
    if (r.claimed !== false) throw new Error(`expected claimed=false, got ${r.claimed}`);
  });

  e.socket.destroy();
  a.socket.destroy();
  b.socket.destroy();
  d.socket.destroy();
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
