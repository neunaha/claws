#!/usr/bin/env node
// L3.1 regression test: server injects monotonic seq= into [CLAWS_CMD ...] text.
// Simulates 3 broadcasts with [CLAWS_CMD r=...] text and asserts seq=1/2/3.
//
// Run: node extension/test/broadcast-seq.test.js
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

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-bseq-'));
const logs = [];
const injectedCalls = [];
let capturedPty = null;

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
    createTerminal: (opts) => {
      const t = { name: opts?.name || 'mock', processId: Promise.resolve(12345), shellIntegration: undefined, show: () => {}, sendText: () => {}, dispose: () => {} };
      if (opts && opts.pty && !capturedPty) {
        capturedPty = opts.pty;
        capturedPty.isOpen = true;
        capturedPty.writeInjected = (text, newline, paste) => {
          injectedCalls.push({ text, newline, paste });
        };
      }
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

(async () => {
  const ready = await waitFor(() => fs.existsSync(sockPath), 3000);
  check('socket ready', () => { if (!ready) throw new Error('no socket'); });

  // lifecycle.plan then create a wrapped terminal
  const setup = connect();
  await new Promise((resolve) => setup.socket.on('connect', resolve));

  setup.socket.write(JSON.stringify({ id: 50, cmd: 'lifecycle.plan', plan: 'broadcast-seq test' }) + '\n');
  await waitFor(() => setup.responses.has(50), 2000);

  setup.socket.write(JSON.stringify({ id: 51, cmd: 'create', name: 'seq-test-worker', wrapped: true }) + '\n');
  await waitFor(() => setup.responses.has(51), 2000);
  const createResp = setup.responses.get(51);
  const wrappedId = createResp && createResp.ok ? createResp.id : null;
  await waitFor(() => capturedPty !== null, 500);

  const orch = connect();
  await new Promise((resolve) => orch.socket.on('connect', resolve));
  await hello(orch, 1, 'orchestrator', 'test-orch-seq');

  const worker = connect();
  await new Promise((resolve) => worker.socket.on('connect', resolve));
  await hello(worker, 2, 'worker', 'test-worker-seq', wrappedId);

  // ── broadcast 1 ──────────────────────────────────────────────────────────
  const b1Before = injectedCalls.length;
  orch.socket.write(JSON.stringify({
    id: 10, cmd: 'broadcast',
    text: '[CLAWS_CMD r=req-aaa] approve_request: {"ok":true}',
    targetRole: 'worker', inject: true,
  }) + '\n');
  await waitFor(() => orch.responses.has(10), 2000);
  await waitFor(() => injectedCalls.length > b1Before, 500);

  check('broadcast 1: seq=1 injected into [CLAWS_CMD]', () => {
    const call = injectedCalls.slice(b1Before).find((c) => c.text.includes('[CLAWS_CMD'));
    if (!call) throw new Error('no writeInjected call after broadcast 1');
    const expected = '[CLAWS_CMD seq=1 r=req-aaa] approve_request: {"ok":true}';
    if (call.text !== expected) throw new Error(`expected "${expected}", got "${call.text}"`);
  });

  // ── broadcast 2 ──────────────────────────────────────────────────────────
  const b2Before = injectedCalls.length;
  orch.socket.write(JSON.stringify({
    id: 20, cmd: 'broadcast',
    text: '[CLAWS_CMD r=req-bbb] reject_request: {"reason":"timeout"}',
    targetRole: 'worker', inject: true,
  }) + '\n');
  await waitFor(() => orch.responses.has(20), 2000);
  await waitFor(() => injectedCalls.length > b2Before, 500);

  check('broadcast 2: seq=2 injected into [CLAWS_CMD]', () => {
    const call = injectedCalls.slice(b2Before).find((c) => c.text.includes('[CLAWS_CMD'));
    if (!call) throw new Error('no writeInjected call after broadcast 2');
    const expected = '[CLAWS_CMD seq=2 r=req-bbb] reject_request: {"reason":"timeout"}';
    if (call.text !== expected) throw new Error(`expected "${expected}", got "${call.text}"`);
  });

  // ── broadcast 3 ──────────────────────────────────────────────────────────
  const b3Before = injectedCalls.length;
  orch.socket.write(JSON.stringify({
    id: 30, cmd: 'broadcast',
    text: '[CLAWS_CMD r=req-ccc] abort: {"reason":"done"}',
    targetRole: 'worker', inject: true,
  }) + '\n');
  await waitFor(() => orch.responses.has(30), 2000);
  await waitFor(() => injectedCalls.length > b3Before, 500);

  check('broadcast 3: seq=3 injected into [CLAWS_CMD]', () => {
    const call = injectedCalls.slice(b3Before).find((c) => c.text.includes('[CLAWS_CMD'));
    if (!call) throw new Error('no writeInjected call after broadcast 3');
    const expected = '[CLAWS_CMD seq=3 r=req-ccc] abort: {"reason":"done"}';
    if (call.text !== expected) throw new Error(`expected "${expected}", got "${call.text}"`);
  });

  // ── free-form broadcast (no [CLAWS_CMD]) should pass through unchanged ────
  const b4Before = injectedCalls.length;
  orch.socket.write(JSON.stringify({
    id: 40, cmd: 'broadcast',
    text: 'hello workers, status check please',
    targetRole: 'worker', inject: true,
  }) + '\n');
  await waitFor(() => orch.responses.has(40), 2000);
  await waitFor(() => injectedCalls.length > b4Before, 500);

  check('free-form broadcast: text unchanged, seq not bumped', () => {
    const call = injectedCalls.slice(b4Before)[0];
    if (!call) throw new Error('no writeInjected call for free-form broadcast');
    const expected = 'hello workers, status check please';
    if (call.text !== expected) throw new Error(`expected unchanged text "${expected}", got "${call.text}"`);
  });

  // seq counter must NOT have advanced for free-form broadcast — next [CLAWS_CMD] gets seq=4
  const b5Before = injectedCalls.length;
  orch.socket.write(JSON.stringify({
    id: 50, cmd: 'broadcast',
    text: '[CLAWS_CMD r=req-ddd] resume: {}',
    targetRole: 'worker', inject: true,
  }) + '\n');
  await waitFor(() => orch.responses.has(50), 2000);
  await waitFor(() => injectedCalls.length > b5Before, 500);

  check('broadcast 4 (after free-form): seq=4 (counter only bumped for [CLAWS_CMD])', () => {
    const call = injectedCalls.slice(b5Before).find((c) => c.text.includes('[CLAWS_CMD'));
    if (!call) throw new Error('no writeInjected call after broadcast 4');
    const expected = '[CLAWS_CMD seq=4 r=req-ddd] resume: {}';
    if (call.text !== expected) throw new Error(`expected "${expected}", got "${call.text}"`);
  });

  setup.socket.destroy();
  orch.socket.destroy();
  worker.socket.destroy();
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
