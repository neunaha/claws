#!/usr/bin/env node
// Integration tests for server-side publish validation (§4.2).
// Tests against a live ClawsServer on a Unix socket.
// Run: node extension/test/server-validation.test.js
// Exits 0 on success, 1 on failure.

const assert = require('assert');
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

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-srv-val-'));
const logs = [];

// ─── vscode mock with toggleable strictEventValidation ───────────────────────

// Toggle this before each test that needs strict mode.
let strictEventValidation = false;

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => {
        const i = this.listeners.indexOf(listener);
        if (i >= 0) this.listeners.splice(i, 1);
      }};
    };
  }
  fire(arg) { for (const l of this.listeners.slice()) l(arg); }
  dispose() { this.listeners = []; }
}
class TerminalProfile { constructor(o) { this.options = o; } }
class MarkdownString {
  constructor() { this.value = ''; this.isTrusted = false; }
  appendMarkdown(s) { this.value += s; return this; }
}
class ThemeColor { constructor(id) { this.id = id; } }

const onOpen = new EventEmitter();
const onClose = new EventEmitter();

const vscode = {
  EventEmitter, TerminalProfile, MarkdownString, ThemeColor,
  StatusBarAlignment: { Left: 1, Right: 2 },
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file', path: p }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
    getConfiguration: (_section) => ({
      get: (key, fb) => key === 'strictEventValidation' ? strictEventValidation : fb,
    }),
  },
  window: {
    terminals: [],
    activeTerminal: undefined,
    createOutputChannel: (_name) => ({
      appendLine: (m) => logs.push(m),
      show: () => {}, dispose: () => {},
    }),
    createStatusBarItem: () => ({
      text: '', tooltip: '', color: undefined, command: '', name: '',
      show: () => {}, hide: () => {}, dispose: () => {},
    }),
    createTerminal: (_opts) => ({
      name: 'mock', processId: Promise.resolve(12345),
      shellIntegration: undefined, show: () => {}, sendText: () => {}, dispose: () => {},
    }),
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

// ─── helpers ─────────────────────────────────────────────────────────────────

async function waitFor(fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
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

async function hello(peer, id, role, name) {
  peer.socket.write(JSON.stringify({ id, cmd: 'hello', protocol: 'claws/2', role, peerName: name }) + '\n');
  await waitFor(() => peer.responses.has(id));
  const r = peer.responses.get(id);
  if (!r || !r.ok) throw new Error(`hello failed for ${name}: ${JSON.stringify(r)}`);
  return r.peerId;
}

const validUuid = '550e8400-e29b-41d4-a716-446655440000';
const validTs   = '2026-04-28T12:00:00.000Z';

const validBootEnvelope = {
  v: 1,
  id: validUuid,
  from_peer: 'p_test',
  from_name: 'test-worker',
  ts_published: validTs,
  schema: 'worker-boot-v1',
  data: {
    model: 'claude-sonnet-4-6',
    role: 'worker',
    parent_peer_id: null,
    mission_summary: 'test mission',
    capabilities: [],
    cwd: '/tmp',
    terminal_id: 'term-1',
  },
};

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

// ─── lifecycle plan (required before create) ─────────────────────────────────

function rpc(payload) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sockPath);
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx !== -1) {
        try { resolve(JSON.parse(buf.slice(0, idx))); } catch (e) { reject(e); }
        s.destroy();
      }
    });
    s.on('error', reject);
    s.on('connect', () => s.write(JSON.stringify({ id: 1, ...payload }) + '\n'));
  });
}

// ─── tests ───────────────────────────────────────────────────────────────────

(async () => {
  const ready = await waitFor(() => fs.existsSync(sockPath), 3000);
  check('socket ready', () => { if (!ready) throw new Error('no socket'); });
  if (!ready) { console.error('FAIL: socket never appeared'); process.exit(1); }

  // Prime lifecycle so subsequent create calls succeed
  await rpc({ cmd: 'lifecycle.plan', plan: 'validation test session' });

  // ── 1. Valid worker.boot publish — soft mode, passes through ─────────────
  await check('valid worker.boot publish accepted (soft mode)', async () => {
    strictEventValidation = false;
    const pub = connect();
    const sub = connect();
    await new Promise((r) => { pub.socket.on('connect', r); });
    await new Promise((r) => { sub.socket.on('connect', r); });
    await hello(pub, 1, 'worker', 'pub-worker');
    await hello(sub, 10, 'orchestrator', 'sub-orc');
    sub.socket.write(JSON.stringify({ id: 11, cmd: 'subscribe', topic: 'worker.**' }) + '\n');
    await waitFor(() => sub.responses.has(11));
    const peerId = pub.responses.get(1).peerId;
    pub.socket.write(JSON.stringify({
      id: 2, cmd: 'publish',
      topic: `worker.${peerId}.boot`,
      payload: validBootEnvelope,
    }) + '\n');
    await waitFor(() => pub.responses.has(2));
    const resp = pub.responses.get(2);
    assert.strictEqual(resp.ok, true, `expected ok:true, got: ${JSON.stringify(resp)}`);
    assert.strictEqual(resp.deliveredTo, 1);
    await waitFor(() => sub.pushes.length > 0);
    assert.ok(sub.pushes.length > 0, 'subscriber should receive the push frame');
    assert.ok(!sub.pushes.some((p) => p.topic === 'system.malformed.received'), 'no malformed event for valid payload');
    pub.socket.destroy();
    sub.socket.destroy();
  });

  // ── 2. Invalid envelope — soft mode: still fans out + malformed emitted ──
  await check('invalid envelope → system.malformed.received emitted (soft mode)', async () => {
    strictEventValidation = false;
    const pub = connect();
    const sub = connect();
    await new Promise((r) => { pub.socket.on('connect', r); });
    await new Promise((r) => { sub.socket.on('connect', r); });
    await hello(pub, 1, 'worker', 'pub-w2');
    await hello(sub, 10, 'orchestrator', 'sub-o2');
    sub.socket.write(JSON.stringify({ id: 11, cmd: 'subscribe', topic: 'worker.**' }) + '\n');
    sub.socket.write(JSON.stringify({ id: 12, cmd: 'subscribe', topic: 'system.malformed.received' }) + '\n');
    await waitFor(() => sub.responses.has(11) && sub.responses.has(12));
    pub.socket.write(JSON.stringify({
      id: 2, cmd: 'publish',
      topic: 'worker.p_000099.boot',
      payload: { bad: true },   // not a valid EnvelopeV1
    }) + '\n');
    await waitFor(() => pub.responses.has(2));
    const resp = pub.responses.get(2);
    // Soft mode: ok:true even on bad payload
    assert.strictEqual(resp.ok, true, `soft mode should return ok:true, got: ${JSON.stringify(resp)}`);
    // The original event fans out (subscriber sees it)
    await waitFor(() => sub.pushes.some((p) => p.topic === 'worker.p_000099.boot'), 1500);
    assert.ok(sub.pushes.some((p) => p.topic === 'worker.p_000099.boot'), 'original event should still fan out');
    // Malformed event is also emitted
    await waitFor(() => sub.pushes.some((p) => p.topic === 'system.malformed.received'), 1500);
    const malformed = sub.pushes.find((p) => p.topic === 'system.malformed.received');
    assert.ok(malformed, 'system.malformed.received push expected');
    assert.ok(malformed.payload, 'malformed payload should contain details');
    assert.strictEqual(malformed.payload.from, pub.responses.get(1).peerId);
    assert.strictEqual(malformed.payload.topic, 'worker.p_000099.boot');
    pub.socket.destroy();
    sub.socket.destroy();
  });

  // ── 3. Valid envelope but bad data schema — soft mode ───────────────────
  await check('invalid data schema → system.malformed.received emitted (soft mode)', async () => {
    strictEventValidation = false;
    const pub = connect();
    const sub = connect();
    await new Promise((r) => { pub.socket.on('connect', r); });
    await new Promise((r) => { sub.socket.on('connect', r); });
    await hello(pub, 1, 'worker', 'pub-w3');
    await hello(sub, 10, 'orchestrator', 'sub-o3');
    sub.socket.write(JSON.stringify({ id: 11, cmd: 'subscribe', topic: 'system.malformed.received' }) + '\n');
    await waitFor(() => sub.responses.has(11));
    // Valid envelope shape, but data.role is invalid
    pub.socket.write(JSON.stringify({
      id: 2, cmd: 'publish',
      topic: 'worker.p_000088.boot',
      payload: {
        ...validBootEnvelope,
        data: { ...validBootEnvelope.data, role: 'UNKNOWN_ROLE' },
      },
    }) + '\n');
    await waitFor(() => pub.responses.has(2));
    assert.strictEqual(pub.responses.get(2).ok, true, 'soft mode: still ok:true');
    await waitFor(() => sub.pushes.some((p) => p.topic === 'system.malformed.received'), 1500);
    assert.ok(sub.pushes.some((p) => p.topic === 'system.malformed.received'), 'malformed event for bad data schema');
    pub.socket.destroy();
    sub.socket.destroy();
  });

  // ── 4. Strict mode: invalid envelope → hard rejected ────────────────────
  await check('strict mode: invalid envelope → rejected with payload:invalid', async () => {
    strictEventValidation = true;
    const pub = connect();
    await new Promise((r) => { pub.socket.on('connect', r); });
    await hello(pub, 1, 'worker', 'pub-w4');
    pub.socket.write(JSON.stringify({
      id: 2, cmd: 'publish',
      topic: 'worker.p_000077.boot',
      payload: { not_an_envelope: true },
    }) + '\n');
    await waitFor(() => pub.responses.has(2));
    const resp = pub.responses.get(2);
    assert.strictEqual(resp.ok, false, `strict mode should reject, got: ${JSON.stringify(resp)}`);
    assert.strictEqual(resp.error, 'payload:invalid', `expected payload:invalid, got: ${resp.error}`);
    assert.ok(Array.isArray(resp.details), 'details should be an array of issues');
    pub.socket.destroy();
    strictEventValidation = false;
  });

  // ── 5. Unknown topic — no schema registered, passes through ─────────────
  await check('unknown topic → passes through without validation', async () => {
    strictEventValidation = true;  // even in strict mode, unregistered topics are not validated
    const pub = connect();
    const sub = connect();
    await new Promise((r) => { pub.socket.on('connect', r); });
    await new Promise((r) => { sub.socket.on('connect', r); });
    await hello(pub, 1, 'worker', 'pub-w5');
    await hello(sub, 10, 'orchestrator', 'sub-o5');
    sub.socket.write(JSON.stringify({ id: 11, cmd: 'subscribe', topic: 'custom.**' }) + '\n');
    await waitFor(() => sub.responses.has(11));
    pub.socket.write(JSON.stringify({
      id: 2, cmd: 'publish',
      topic: 'custom.vendor.event',
      payload: { anything: 'goes', for: 'unregistered topics' },
    }) + '\n');
    await waitFor(() => pub.responses.has(2));
    const resp = pub.responses.get(2);
    assert.strictEqual(resp.ok, true, `unregistered topic should pass through, got: ${JSON.stringify(resp)}`);
    await waitFor(() => sub.pushes.length > 0);
    assert.ok(sub.pushes.some((p) => p.topic === 'custom.vendor.event'), 'event should be delivered');
    pub.socket.destroy();
    sub.socket.destroy();
    strictEventValidation = false;
  });

  // ── 6. Two subscribers both receive system.malformed.received ────────────
  await check('two subscribers both receive system.malformed.received fan-out', async () => {
    strictEventValidation = false;
    const pub = connect();
    const subA = connect();
    const subB = connect();
    await new Promise((r) => { pub.socket.on('connect', r); });
    await new Promise((r) => { subA.socket.on('connect', r); });
    await new Promise((r) => { subB.socket.on('connect', r); });
    await hello(pub, 1, 'worker', 'pub-w6');
    await hello(subA, 10, 'observer', 'sub-a6');
    await hello(subB, 20, 'observer', 'sub-b6');
    subA.socket.write(JSON.stringify({ id: 11, cmd: 'subscribe', topic: 'system.malformed.received' }) + '\n');
    subB.socket.write(JSON.stringify({ id: 21, cmd: 'subscribe', topic: 'system.malformed.received' }) + '\n');
    await waitFor(() => subA.responses.has(11) && subB.responses.has(21));
    pub.socket.write(JSON.stringify({
      id: 2, cmd: 'publish',
      topic: 'worker.p_000066.boot',
      payload: { bad_envelope: true },
    }) + '\n');
    await waitFor(() => pub.responses.has(2));
    await waitFor(() =>
      subA.pushes.some((p) => p.topic === 'system.malformed.received') &&
      subB.pushes.some((p) => p.topic === 'system.malformed.received'),
      2000,
    );
    assert.ok(subA.pushes.some((p) => p.topic === 'system.malformed.received'), 'subA should receive malformed');
    assert.ok(subB.pushes.some((p) => p.topic === 'system.malformed.received'), 'subB should receive malformed');
    pub.socket.destroy();
    subA.socket.destroy();
    subB.socket.destroy();
  });

  await ext.deactivate();
  await new Promise((r) => setTimeout(r, 100));

  try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ignore */ }

  for (const a of assertions) {
    console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
  }
  const failed = assertions.filter((a) => !a.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${assertions.length} server-validation check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${assertions.length} server-validation checks`);
  process.exit(0);
})();
