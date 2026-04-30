#!/usr/bin/env node
// L15 REPLAY — fromCursor catch-up test.
// TDD: written BEFORE implementation. Must FAIL until EventLogReader + server
// subscribe fromCursor wiring are implemented.
//
// Run: node extension/test/claws-event-log-replay.test.js
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

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-replay-'));
const logs = [];

// ── Mock vscode ──────────────────────────────────────────────────────────────
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
    if (r && typeof r.then === 'function') return r.then(
      () => assertions.push({ name, ok: true }),
      (e) => assertions.push({ name, ok: false, err: e.message || String(e) })
    );
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

// Publish a lifecycle plan so create is not blocked
async function ensurePlan(peer, id) {
  peer.socket.write(JSON.stringify({
    id, cmd: 'lifecycle.plan', plan: 'replay test plan',
  }) + '\n');
  await waitFor(() => peer.responses.has(id), 2000);
}

(async () => {
  const ready = await waitFor(() => fs.existsSync(sockPath), 3000);
  check('socket ready', () => { if (!ready) throw new Error('no socket'); });

  // ── Peer A: orchestrator that will publish events and then subscribe ───────
  const a = connect();
  await new Promise((resolve) => a.socket.on('connect', resolve));
  const aId = await hello(a, 1, 'orchestrator', 'replay-orc');

  await ensurePlan(a, 99);

  // ── Step 1: capture the "start" cursor before publishing events ───────────
  // The event log starts at "0001:0" (first segment, offset 0) after server boots.
  // We subscribe with fromCursor "0001:0" AFTER publishing N events to trigger replay.
  const N = 10;
  const TOPIC = 'test.replay.events';

  // Publish N events so they land in the event log
  for (let i = 0; i < N; i++) {
    a.socket.write(JSON.stringify({
      id: 200 + i,
      cmd: 'publish',
      protocol: 'claws/2',
      topic: TOPIC,
      payload: { seq: i, msg: `replay-event-${i}` },
    }) + '\n');
  }
  // Wait for all publish ACKs
  await waitFor(() => a.responses.has(200 + N - 1), 3000);

  check(`all ${N} publish calls acknowledged`, () => {
    for (let i = 0; i < N; i++) {
      const r = a.responses.get(200 + i);
      if (!r || !r.ok) throw new Error(`publish ${i} failed: ${JSON.stringify(r)}`);
    }
  });

  // ── Step 2: Peer B subscribes with fromCursor "0001:0" ───────────────────
  const b = connect();
  await new Promise((resolve) => b.socket.on('connect', resolve));
  await hello(b, 1, 'worker', 'replay-sub');

  b.socket.write(JSON.stringify({
    id: 300,
    cmd: 'subscribe',
    protocol: 'claws/2',
    topic: TOPIC,
    fromCursor: '0001:0',
  }) + '\n');
  await waitFor(() => b.responses.has(300), 2000);

  check('subscribe with fromCursor returns ok:true', () => {
    const r = b.responses.get(300);
    if (!r || !r.ok) throw new Error(`subscribe fromCursor failed: ${JSON.stringify(r)}`);
    if (typeof r.subscriptionId !== 'string') throw new Error('no subscriptionId');
  });

  const subId = b.responses.get(300)?.subscriptionId;

  // ── Step 3: Expect N replayed frames with replayed:true ──────────────────
  // Wait for caught-up frame or N+1 pushes
  const gotCaughtUp = await waitFor(
    () => b.pushes.some(p => p.push === 'caught-up'),
    5000
  );

  const replayedFrames = b.pushes.filter(p => p.push === 'message' && p.replayed === true && p.topic === TOPIC);
  const caughtUpFrame = b.pushes.find(p => p.push === 'caught-up');

  check(`received at least ${N} replayed push frames`, () => {
    if (replayedFrames.length < N) {
      throw new Error(`expected >= ${N} replayed frames, got ${replayedFrames.length}. All pushes: ${JSON.stringify(b.pushes.map(p=>({push:p.push,topic:p.topic,replayed:p.replayed})))}`);
    }
  });

  check('all replayed frames have replayed:true', () => {
    for (const f of replayedFrames) {
      if (f.replayed !== true) throw new Error(`frame missing replayed:true: ${JSON.stringify(f)}`);
    }
  });

  check('all replayed frames have correct topic', () => {
    for (const f of replayedFrames) {
      if (f.topic !== TOPIC) throw new Error(`wrong topic: ${f.topic}`);
    }
  });

  check('received caught-up push frame', () => {
    if (!gotCaughtUp || !caughtUpFrame) throw new Error('no caught-up frame received');
  });

  check('caught-up frame has subscriptionId', () => {
    if (!caughtUpFrame) throw new Error('no caught-up frame');
    if (caughtUpFrame.subscriptionId !== subId) {
      throw new Error(`wrong subscriptionId in caught-up: got ${caughtUpFrame.subscriptionId}, expected ${subId}`);
    }
  });

  check('caught-up frame has replayedCount >= N', () => {
    if (!caughtUpFrame) throw new Error('no caught-up frame');
    if (typeof caughtUpFrame.replayedCount !== 'number') {
      throw new Error(`replayedCount missing or non-number: ${caughtUpFrame.replayedCount}`);
    }
    if (caughtUpFrame.replayedCount < N) {
      throw new Error(`replayedCount ${caughtUpFrame.replayedCount} < expected ${N}`);
    }
  });

  check('caught-up frame arrives after replayed frames', () => {
    if (!caughtUpFrame) throw new Error('no caught-up frame');
    const caughtUpIdx = b.pushes.indexOf(caughtUpFrame);
    const lastReplayedIdx = b.pushes.lastIndexOf(replayedFrames[replayedFrames.length - 1]);
    if (caughtUpIdx <= lastReplayedIdx) {
      throw new Error(`caught-up at index ${caughtUpIdx} should be after last replayed at ${lastReplayedIdx}`);
    }
  });

  // ── Step 4: Live frames after caught-up have no replayed flag ─────────────
  const pushesBeforeLive = b.pushes.length;

  // Peer C publishes a live event after subscription
  const c = connect();
  await new Promise((resolve) => c.socket.on('connect', resolve));
  await hello(c, 1, 'worker', 'live-pub');

  c.socket.write(JSON.stringify({
    id: 400,
    cmd: 'publish',
    protocol: 'claws/2',
    topic: TOPIC,
    payload: { msg: 'live-event-after-replay' },
  }) + '\n');
  await waitFor(() => c.responses.has(400), 2000);

  // Wait for B to receive the live push
  await waitFor(() => b.pushes.length > pushesBeforeLive, 2000);

  const liveFrames = b.pushes.filter(
    (p, i) => i >= pushesBeforeLive && p.push === 'message' && p.topic === TOPIC
  );

  check('live event received by subscriber after caught-up', () => {
    if (liveFrames.length === 0) throw new Error('no live frames received after caught-up');
  });

  check('live frames do NOT have replayed:true', () => {
    for (const f of liveFrames) {
      if (f.replayed === true) throw new Error(`live frame incorrectly has replayed:true: ${JSON.stringify(f)}`);
    }
  });

  // ── Step 5: subscribe with invalid cursor returns ok:false ────────────────
  const d = connect();
  await new Promise((resolve) => d.socket.on('connect', resolve));
  await hello(d, 1, 'worker', 'bad-cursor');

  d.socket.write(JSON.stringify({
    id: 500,
    cmd: 'subscribe',
    protocol: 'claws/2',
    topic: TOPIC,
    fromCursor: 'not-a-valid-cursor',
  }) + '\n');
  await waitFor(() => d.responses.has(500), 2000);

  check('subscribe with invalid cursor returns ok:false', () => {
    const r = d.responses.get(500);
    if (!r) throw new Error('no response to invalid cursor subscribe');
    if (r.ok) throw new Error('expected ok:false for invalid cursor');
  });

  // Cleanup
  a.socket.destroy();
  b.socket.destroy();
  c.socket.destroy();
  d.socket.destroy();

  await new Promise((r) => setTimeout(r, 100));

  // ── Report ────────────────────────────────────────────────────────────────
  let passed = 0, failed = 0;
  for (const a of assertions) {
    if (a.ok) {
      console.log(`  PASS  ${a.name}`);
      passed++;
    } else {
      console.error(`  FAIL  ${a.name}: ${a.err}`);
      failed++;
    }
  }
  console.log(`${passed} passed, ${failed} failed (${assertions.length} total)`);
  process.exit(failed > 0 ? 1 : 0);
})();
