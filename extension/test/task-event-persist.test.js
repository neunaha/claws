#!/usr/bin/env node
// Regression test: task.* events are persisted to the event log via emitServerEvent.
//
// Boots the extension bundle against a mocked vscode + fresh tmpdir, registers
// orchestrator + worker peers, drives task.assign → task.update → task.complete,
// then reads the .jsonl segment and asserts all three events landed with
// monotonically-increasing sequence numbers.
//
// Run: node extension/test/task-event-persist.test.js
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

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-task-persist-'));
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

async function rpc(peer, id, cmd, extra = {}) {
  peer.socket.write(JSON.stringify({ id, cmd, ...extra }) + '\n');
  await waitFor(() => peer.responses.has(id), 3000);
  return peer.responses.get(id);
}

function readSegmentLines(dir) {
  const segDir = path.join(dir, '.claws', 'events', 'default');
  if (!fs.existsSync(segDir)) return [];
  const files = fs.readdirSync(segDir).filter(n => /^\d{4}-.*\.jsonl$/.test(n)).sort();
  const lines = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(segDir, f), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) lines.push(JSON.parse(trimmed));
    }
  }
  return lines;
}

(async () => {
  const ready = await waitFor(() => fs.existsSync(sockPath), 5000);
  check('socket ready', () => { if (!ready) throw new Error('socket never appeared'); });
  if (!ready) { report(); return; }

  const orc = connect();
  await new Promise((r) => orc.socket.on('connect', r));
  const orcResp = await rpc(orc, 1, 'hello', { protocol: 'claws/2', role: 'orchestrator', peerName: 'test-orc' });
  check('orchestrator hello ok', () => { if (!orcResp?.ok) throw new Error(JSON.stringify(orcResp)); });
  const orcId = orcResp?.peerId;

  const wrk = connect();
  await new Promise((r) => wrk.socket.on('connect', r));
  const wrkResp = await rpc(wrk, 2, 'hello', { protocol: 'claws/2', role: 'worker', peerName: 'test-worker' });
  check('worker hello ok', () => { if (!wrkResp?.ok) throw new Error(JSON.stringify(wrkResp)); });
  const wrkId = wrkResp?.peerId;

  // ── task.assign → expect event logged with topic task.assigned.<wrkId> ──────
  const assignResp = await rpc(orc, 10, 'task.assign', {
    title: 'persist-test', assignee: wrkId, prompt: 'do the thing',
  });
  check('task.assign ok', () => { if (!assignResp?.ok) throw new Error(JSON.stringify(assignResp)); });
  const taskId = assignResp?.taskId;

  // Give emitServerEvent's async append a moment to flush.
  await new Promise((r) => setTimeout(r, 200));

  const linesAfterAssign = readSegmentLines(workspaceRoot);
  check('task.assigned event persisted', () => {
    const ev = linesAfterAssign.find(l => l.topic === `task.assigned.${wrkId}`);
    if (!ev) throw new Error(`no task.assigned.${wrkId} entry; got topics: ${linesAfterAssign.map(l => l.topic).join(', ')}`);
    if (ev.from !== 'server') throw new Error(`expected from=server, got ${ev.from}`);
    if (typeof ev.sequence !== 'number') throw new Error('sequence missing or not a number');
  });

  // ── task.update → expect task.status logged ───────────────────────────────
  const updateResp = await rpc(wrk, 20, 'task.update', { taskId, status: 'running', progressPct: 50 });
  check('task.update ok', () => { if (!updateResp?.ok) throw new Error(JSON.stringify(updateResp)); });

  await new Promise((r) => setTimeout(r, 200));

  const linesAfterUpdate = readSegmentLines(workspaceRoot);
  check('task.status event persisted', () => {
    const ev = linesAfterUpdate.find(l => l.topic === 'task.status');
    if (!ev) throw new Error(`no task.status entry; topics: ${linesAfterUpdate.map(l => l.topic).join(', ')}`);
    if (typeof ev.sequence !== 'number') throw new Error('sequence missing');
  });

  // ── task.complete → expect task.completed logged ──────────────────────────
  const completeResp = await rpc(wrk, 30, 'task.complete', { taskId, status: 'succeeded', result: { done: true } });
  check('task.complete ok', () => { if (!completeResp?.ok) throw new Error(JSON.stringify(completeResp)); });

  await new Promise((r) => setTimeout(r, 200));

  const linesAfterComplete = readSegmentLines(workspaceRoot);
  check('task.completed event persisted', () => {
    const ev = linesAfterComplete.find(l => l.topic === 'task.completed');
    if (!ev) throw new Error(`no task.completed entry; topics: ${linesAfterComplete.map(l => l.topic).join(', ')}`);
    if (typeof ev.sequence !== 'number') throw new Error('sequence missing');
  });

  // ── sequence numbers are monotonically increasing ─────────────────────────
  check('sequence numbers monotonically increasing', () => {
    const taskLines = linesAfterComplete.filter(l =>
      l.topic === `task.assigned.${wrkId}` ||
      l.topic === 'task.status' ||
      l.topic === 'task.completed',
    );
    if (taskLines.length < 3) throw new Error(`expected 3 task events, got ${taskLines.length}`);
    for (let i = 1; i < taskLines.length; i++) {
      if (taskLines[i].sequence <= taskLines[i - 1].sequence) {
        throw new Error(
          `sequence not monotonic: [${i - 1}]=${taskLines[i - 1].sequence} >= [${i}]=${taskLines[i].sequence}`,
        );
      }
    }
  });

  orc.socket.destroy();
  wrk.socket.destroy();

  // Cleanup
  try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ignore */ }

  report();
})();

function report() {
  let failed = 0;
  for (const a of assertions) {
    if (a.ok) {
      console.log(`  PASS  ${a.name}`);
    } else {
      console.log(`  FAIL  ${a.name}: ${a.err}`);
      failed++;
    }
  }
  console.log(`\n${assertions.length - failed}/${assertions.length} passed`);
  process.exit(failed > 0 ? 1 : 0);
}
