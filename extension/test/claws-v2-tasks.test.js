#!/usr/bin/env node
// claws/2 task registry test. Activates the extension against a mocked vscode,
// connects multiple peers, and asserts task.assign/update/complete/cancel/list
// behaviour including role gating, ownership, idempotency, and push frames.
//
// Run: node extension/test/claws-v2-tasks.test.js
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

  // ── 1. task.assign without hello -> ok:false (call hello first) ──────
  const noHello = connect();
  await new Promise((resolve) => noHello.socket.on('connect', resolve));
  noHello.socket.write(JSON.stringify({
    id: 100, cmd: 'task.assign', title: 't', assignee: 'p_000001', prompt: 'p',
  }) + '\n');
  await waitFor(() => noHello.responses.has(100), 2000);
  check('task.assign without hello rejected', () => {
    const r = noHello.responses.get(100);
    if (!r) throw new Error('no response');
    if (r.ok) throw new Error('expected ok:false');
    if (!/call hello first/.test(String(r.error || ''))) {
      throw new Error(`wrong error: ${r.error}`);
    }
  });
  noHello.socket.destroy();

  // Establish: orchestrator A, worker B, worker C
  const a = connect();
  await new Promise((resolve) => a.socket.on('connect', resolve));
  const orcPeerId = await hello(a, 1, 'orchestrator', 'orc');

  const b = connect();
  await new Promise((resolve) => b.socket.on('connect', resolve));
  const workerBId = await hello(b, 2, 'worker', 'worker-b');

  const c = connect();
  await new Promise((resolve) => c.socket.on('connect', resolve));
  const workerCId = await hello(c, 3, 'worker', 'worker-c');

  // Orchestrator subscribes to task.completed so we can assert push delivery
  a.socket.write(JSON.stringify({
    id: 4, cmd: 'subscribe', topic: 'task.completed',
  }) + '\n');
  await waitFor(() => a.responses.has(4), 2000);

  // ── 2. task.assign from worker role -> ok:false (requires orchestrator)
  b.socket.write(JSON.stringify({
    id: 200, cmd: 'task.assign', title: 't', assignee: workerCId, prompt: 'p',
  }) + '\n');
  await waitFor(() => b.responses.has(200), 2000);
  check('task.assign from worker rejected', () => {
    const r = b.responses.get(200);
    if (!r) throw new Error('no response');
    if (r.ok) throw new Error('expected ok:false');
    if (!/requires role/.test(String(r.error || ''))) throw new Error(`wrong error: ${r.error}`);
  });

  // ── 3. task.assign from orchestrator with valid assignee -> ok:true, taskId matches /^t_\d{3}$/
  a.socket.write(JSON.stringify({
    id: 300, cmd: 'task.assign', title: 'Fix bug', assignee: workerBId, prompt: 'please fix bug',
  }) + '\n');
  await waitFor(() => a.responses.has(300), 2000);
  const assignResp = a.responses.get(300);
  check('task.assign from orchestrator returns taskId', () => {
    if (!assignResp || !assignResp.ok) throw new Error(`task.assign failed: ${JSON.stringify(assignResp)}`);
    if (typeof assignResp.taskId !== 'string') throw new Error('no taskId');
    if (!/^t_\d{3}$/.test(assignResp.taskId)) throw new Error(`taskId shape wrong: ${assignResp.taskId}`);
    if (typeof assignResp.assignedAt !== 'number') throw new Error('no assignedAt');
  });
  const taskId = assignResp.taskId;

  // ── 4. task.assign with missing prompt -> ok:false
  a.socket.write(JSON.stringify({
    id: 400, cmd: 'task.assign', title: 't', assignee: workerBId,
  }) + '\n');
  await waitFor(() => a.responses.has(400), 2000);
  check('task.assign with missing prompt rejected', () => {
    const r = a.responses.get(400);
    if (!r) throw new Error('no response');
    if (r.ok) throw new Error('expected ok:false');
    if (!/title, assignee, and prompt are required/.test(String(r.error || ''))) {
      throw new Error(`wrong error: ${r.error}`);
    }
  });

  // ── 5. task.assign with nonexistent assignee peerId -> ok:false
  a.socket.write(JSON.stringify({
    id: 500, cmd: 'task.assign', title: 't', assignee: 'p_ffffff', prompt: 'p',
  }) + '\n');
  await waitFor(() => a.responses.has(500), 2000);
  check('task.assign with unknown assignee rejected', () => {
    const r = a.responses.get(500);
    if (!r) throw new Error('no response');
    if (r.ok) throw new Error('expected ok:false');
    if (!/assignee peer not found/.test(String(r.error || ''))) throw new Error(`wrong error: ${r.error}`);
  });

  // ── 6. task.update from orchestrator role -> ok:false (requires worker)
  a.socket.write(JSON.stringify({
    id: 600, cmd: 'task.update', taskId, status: 'running',
  }) + '\n');
  await waitFor(() => a.responses.has(600), 2000);
  check('task.update from orchestrator rejected', () => {
    const r = a.responses.get(600);
    if (!r) throw new Error('no response');
    if (r.ok) throw new Error('expected ok:false');
    if (!/requires role/.test(String(r.error || ''))) throw new Error(`wrong error: ${r.error}`);
  });

  // ── 7. task.update from correct worker -> ok:true
  b.socket.write(JSON.stringify({
    id: 700, cmd: 'task.update', taskId, status: 'running', progressPct: 50, note: 'halfway',
  }) + '\n');
  await waitFor(() => b.responses.has(700), 2000);
  check('task.update from correct worker ok', () => {
    const r = b.responses.get(700);
    if (!r || !r.ok) throw new Error(`task.update failed: ${JSON.stringify(r)}`);
  });

  // ── 13. Orchestrator receives task.completed push when worker completes
  const orchPushesBefore = a.pushes.length;

  // ── 9. task.complete from worker -> ok:true
  b.socket.write(JSON.stringify({
    id: 900, cmd: 'task.complete', taskId, status: 'succeeded', result: { ok: true },
  }) + '\n');
  await waitFor(() => b.responses.has(900), 2000);
  check('task.complete from worker ok', () => {
    const r = b.responses.get(900);
    if (!r || !r.ok) throw new Error(`task.complete failed: ${JSON.stringify(r)}`);
  });

  // Assert push delivered to orchestrator
  await waitFor(() => a.pushes.length > orchPushesBefore, 2000);
  check('orchestrator receives task.completed push', () => {
    const p = a.pushes.slice(orchPushesBefore).find((f) => f.topic === 'task.completed');
    if (!p) throw new Error('orchestrator did not receive task.completed push');
    if (p.push !== 'message') throw new Error(`wrong push type: ${p.push}`);
    if (p.rid != null) throw new Error('push frame must have no rid');
    if (!p.payload || p.payload.taskId !== taskId) throw new Error('payload taskId mismatch');
    if (p.payload.status !== 'succeeded') throw new Error(`wrong status: ${p.payload.status}`);
  });

  // ── 9b. task.list shows status=succeeded
  b.socket.write(JSON.stringify({
    id: 901, cmd: 'task.list',
  }) + '\n');
  await waitFor(() => b.responses.has(901), 2000);
  check('task.list shows completed task status=succeeded', () => {
    const r = b.responses.get(901);
    if (!r || !r.ok) throw new Error(`task.list failed: ${JSON.stringify(r)}`);
    if (!Array.isArray(r.tasks)) throw new Error('no tasks array');
    const t = r.tasks.find((x) => x.taskId === taskId);
    if (!t) throw new Error('task not in list');
    if (t.status !== 'succeeded') throw new Error(`wrong status: ${t.status}`);
  });

  // ── 10. task.complete again (idempotent) -> ok:true
  b.socket.write(JSON.stringify({
    id: 1000, cmd: 'task.complete', taskId, status: 'succeeded',
  }) + '\n');
  await waitFor(() => b.responses.has(1000), 2000);
  check('task.complete idempotent on completed task', () => {
    const r = b.responses.get(1000);
    if (!r || !r.ok) throw new Error(`task.complete idempotent failed: ${JSON.stringify(r)}`);
  });

  // ── 8. task.update on completed task -> ok:false
  b.socket.write(JSON.stringify({
    id: 800, cmd: 'task.update', taskId, status: 'running',
  }) + '\n');
  await waitFor(() => b.responses.has(800), 2000);
  check('task.update on completed task rejected', () => {
    const r = b.responses.get(800);
    if (!r) throw new Error('no response');
    if (r.ok) throw new Error('expected ok:false');
    if (!/task already completed/.test(String(r.error || ''))) throw new Error(`wrong error: ${r.error}`);
  });

  // ── 11. task.cancel from orchestrator -> ok:true, cancelRequested visible in task.list
  // Create a fresh task to cancel
  a.socket.write(JSON.stringify({
    id: 1100, cmd: 'task.assign', title: 'to-cancel', assignee: workerCId, prompt: 'do stuff',
  }) + '\n');
  await waitFor(() => a.responses.has(1100), 2000);
  const cancelTaskId = a.responses.get(1100).taskId;

  a.socket.write(JSON.stringify({
    id: 1101, cmd: 'task.cancel', taskId: cancelTaskId, reason: 'no longer needed',
  }) + '\n');
  await waitFor(() => a.responses.has(1101), 2000);
  check('task.cancel from orchestrator ok', () => {
    const r = a.responses.get(1101);
    if (!r || !r.ok) throw new Error(`task.cancel failed: ${JSON.stringify(r)}`);
  });

  a.socket.write(JSON.stringify({
    id: 1102, cmd: 'task.list',
  }) + '\n');
  await waitFor(() => a.responses.has(1102), 2000);
  check('task.list shows cancelRequested after cancel', () => {
    const r = a.responses.get(1102);
    if (!r || !r.ok) throw new Error(`task.list failed: ${JSON.stringify(r)}`);
    const t = r.tasks.find((x) => x.taskId === cancelTaskId);
    if (!t) throw new Error('canceled task not in list');
    if (t.cancelRequested !== true) throw new Error('cancelRequested not set');
    if (t.cancelReason !== 'no longer needed') throw new Error('cancelReason not set');
  });

  // ── 12. task.list with assignee filter returns only tasks for that assignee
  a.socket.write(JSON.stringify({
    id: 1200, cmd: 'task.list', assignee: workerBId,
  }) + '\n');
  await waitFor(() => a.responses.has(1200), 2000);
  check('task.list with assignee filter returns only matching tasks', () => {
    const r = a.responses.get(1200);
    if (!r || !r.ok) throw new Error(`task.list filter failed: ${JSON.stringify(r)}`);
    if (!Array.isArray(r.tasks)) throw new Error('no tasks array');
    for (const t of r.tasks) {
      if (t.assignee !== workerBId) throw new Error(`task ${t.taskId} has wrong assignee ${t.assignee}`);
    }
    if (!r.tasks.find((t) => t.taskId === taskId)) throw new Error('expected first task in filter');
    if (r.tasks.find((t) => t.taskId === cancelTaskId)) {
      throw new Error('cancelTask should not be in workerB filter');
    }
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
