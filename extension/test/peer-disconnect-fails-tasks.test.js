#!/usr/bin/env node
// L4.3 regression test: peer disconnect fails orphaned tasks.
// Registers an orchestrator + worker, assigns 2 tasks to the worker,
// destroys the worker socket, and asserts:
//   1. Both tasks have status='failed' in task.list
//   2. A task.completed push frame fires for each failed task
//
// Run: node extension/test/peer-disconnect-fails-tasks.test.js
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

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-disc-fail-'));
const logs = [];

// ─── Mock vscode ──────────────────────────────────────────────────────────────
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

async function hello(peer, id, role, name) {
  peer.socket.write(JSON.stringify({ id, cmd: 'hello', protocol: 'claws/2', role, peerName: name }) + '\n');
  await waitFor(() => peer.responses.has(id), 2000);
  const r = peer.responses.get(id);
  if (!r || !r.ok) throw new Error(`hello failed for ${name}: ${JSON.stringify(r)}`);
  return r.peerId;
}

(async () => {
  const ready = await waitFor(() => fs.existsSync(sockPath), 3000);
  check('socket ready', () => { if (!ready) throw new Error('no socket'); });

  // ── 1. Register orchestrator + worker ──────────────────────────────────────
  const orc = connect();
  await new Promise((resolve) => orc.socket.on('connect', resolve));
  const orcId = await hello(orc, 1, 'orchestrator', 'orc');

  const worker = connect();
  await new Promise((resolve) => worker.socket.on('connect', resolve));
  const workerId = await hello(worker, 2, 'worker', 'worker-x');

  check('peers registered', () => {
    if (!orcId) throw new Error('no orchestrator peerId');
    if (!workerId) throw new Error('no worker peerId');
  });

  // ── 2. Orchestrator subscribes to task.completed ──────────────────────────
  orc.socket.write(JSON.stringify({ id: 3, cmd: 'subscribe', protocol: 'claws/2', topic: 'task.completed' }) + '\n');
  await waitFor(() => orc.responses.has(3), 2000);

  // ── 3. Assign 2 tasks to the worker ───────────────────────────────────────
  orc.socket.write(JSON.stringify({ id: 10, cmd: 'task.assign', title: 'task-A', assignee: workerId, prompt: 'do A' }) + '\n');
  await waitFor(() => orc.responses.has(10), 2000);
  const r10 = orc.responses.get(10);

  orc.socket.write(JSON.stringify({ id: 11, cmd: 'task.assign', title: 'task-B', assignee: workerId, prompt: 'do B' }) + '\n');
  await waitFor(() => orc.responses.has(11), 2000);
  const r11 = orc.responses.get(11);

  check('two tasks assigned', () => {
    if (!r10?.ok) throw new Error(`task-A assign failed: ${JSON.stringify(r10)}`);
    if (!r11?.ok) throw new Error(`task-B assign failed: ${JSON.stringify(r11)}`);
  });

  const taskAId = r10?.taskId;
  const taskBId = r11?.taskId;

  // ── 4. Destroy the worker socket (simulates disconnect) ───────────────────
  worker.socket.destroy();

  // Wait for disconnect to propagate and task.completed pushes to fire
  await waitFor(() => orc.pushes.filter(p => p.topic === 'task.completed').length >= 2, 3000);

  // ── 5. Assert both tasks are now failed in task.list ─────────────────────
  orc.socket.write(JSON.stringify({ id: 20, cmd: 'task.list' }) + '\n');
  await waitFor(() => orc.responses.has(20), 2000);
  const listResp = orc.responses.get(20);

  await check('task.list returns tasks', async () => {
    if (!listResp?.ok) throw new Error(`task.list failed: ${JSON.stringify(listResp)}`);
    if (!Array.isArray(listResp.tasks)) throw new Error('tasks not an array');
  });

  await check('task-A is failed', async () => {
    const tasks = listResp?.tasks ?? [];
    const taskA = tasks.find(t => t.taskId === taskAId);
    if (!taskA) throw new Error(`task-A (${taskAId}) not found in list`);
    if (taskA.status !== 'failed') throw new Error(`task-A status=${taskA.status}, expected failed`);
    if (taskA.note !== 'assignee disconnected') throw new Error(`task-A note="${taskA.note}", expected "assignee disconnected"`);
  });

  await check('task-B is failed', async () => {
    const tasks = listResp?.tasks ?? [];
    const taskB = tasks.find(t => t.taskId === taskBId);
    if (!taskB) throw new Error(`task-B (${taskBId}) not found in list`);
    if (taskB.status !== 'failed') throw new Error(`task-B status=${taskB.status}, expected failed`);
    if (taskB.note !== 'assignee disconnected') throw new Error(`task-B note="${taskB.note}", expected "assignee disconnected"`);
  });

  // ── 6. Assert task.completed push frames fired for both tasks ────────────
  await check('task.completed push fired for task-A', async () => {
    const completed = orc.pushes.filter(p => p.topic === 'task.completed');
    const forA = completed.find(p => p.payload?.taskId === taskAId);
    if (!forA) throw new Error(`no task.completed push for task-A (${taskAId}); got: ${JSON.stringify(completed)}`);
    if (forA.payload?.status !== 'failed') throw new Error(`push status=${forA.payload?.status}, expected failed`);
  });

  await check('task.completed push fired for task-B', async () => {
    const completed = orc.pushes.filter(p => p.topic === 'task.completed');
    const forB = completed.find(p => p.payload?.taskId === taskBId);
    if (!forB) throw new Error(`no task.completed push for task-B (${taskBId}); got: ${JSON.stringify(completed)}`);
    if (forB.payload?.status !== 'failed') throw new Error(`push status=${forB.payload?.status}, expected failed`);
  });

  orc.socket.destroy();
  try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ignore */ }

  const failed = assertions.filter(a => !a.ok);
  for (const a of assertions) {
    console.log(`${a.ok ? 'PASS' : 'FAIL'} ${a.name}${a.err ? ': ' + a.err : ''}`);
  }
  console.log(`\n${assertions.length - failed.length}/${assertions.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
})();
