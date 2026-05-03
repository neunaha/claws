#!/usr/bin/env node
// Wave D part 1 — extension publishes system.worker.terminated on onDidCloseTerminal.
// Verifies that when VS Code fires onDidCloseTerminal for a Claws-tracked WRAPPED
// terminal, ClawsServer emits system.worker.terminated on the bus with the correct
// terminal_id. Also verifies that closing an UNWRAPPED terminal does NOT emit it.
//
// Run: node extension/test/onDidCloseTerminal-publish.test.js
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

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-ondidclose-'));
const logs = [];

// ─── vscode mock ─────────────────────────────────────────────────────────────

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

class TerminalProfile { constructor(options) { this.options = options; } }
class MarkdownString {
  constructor() { this.value = ''; this.isTrusted = false; }
  appendMarkdown(s) { this.value += s; return this; }
}
class ThemeColor { constructor(id) { this.id = id; } }

const onOpen = new EventEmitter();
const onClose = new EventEmitter();

const createdTerminals = [];

const vscode = {
  EventEmitter, TerminalProfile, MarkdownString, ThemeColor,
  StatusBarAlignment: { Left: 1, Right: 2 },
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file', path: p }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
    getConfiguration: (_s) => ({ get: (_k, fb) => fb }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
  },
  window: {
    terminals: [],
    activeTerminal: undefined,
    createOutputChannel: () => ({ appendLine: (m) => logs.push(m), show: () => {}, dispose: () => {} }),
    createStatusBarItem: () => ({
      text: '', tooltip: '', color: undefined, command: '', name: '',
      show: () => {}, hide: () => {}, dispose: () => {},
    }),
    createTerminal: (opts) => {
      const t = {
        name: (opts && opts.name) || 'mock',
        processId: Promise.resolve(12345),
        shellIntegration: undefined,
        show: () => {},
        sendText: () => {},
        dispose: () => { onClose.fire(t); },
      };
      createdTerminals.push(t);
      vscode.window.terminals.push(t);
      if (opts && opts.pty && typeof opts.pty.open === 'function') {
        setTimeout(() => opts.pty.open({ columns: 80, rows: 24 }), 20);
      }
      return t;
    },
    onDidOpenTerminal: onOpen.event,
    onDidCloseTerminal: onClose.event,
    registerTerminalProfileProvider: () => ({ dispose: () => {} }),
    activeColorTheme: { kind: 2 },
  },
  commands: { registerCommand: () => ({ dispose: () => {} }) },
  extensions: { getExtension: () => undefined },
};

Module._resolveFilename = ((orig) => (req, parent, isMain, opts) => {
  if (req === 'vscode') return '__vscode__';
  return orig(req, parent, isMain, opts);
})(Module._resolveFilename);
Module._cache['__vscode__'] = { id: '__vscode__', filename: '__vscode__', loaded: true, exports: vscode };

const ext = require(BUNDLE);
ext.activate({ subscriptions: [], extensionPath: EXT_ROOT, extension: { packageJSON: { version: '0.7.10' } } });

const sockPath = path.join(workspaceRoot, '.claws', 'claws.sock');

// ─── helpers ─────────────────────────────────────────────────────────────────

async function waitFor(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return false;
}

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

function openSubscription(topic) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const s = net.createConnection(sockPath);
    let buf = '';
    let resolved = false;
    s.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (!resolved && msg.ok === true && msg.subscriptionId) {
          resolved = true;
          resolve({ frames, socket: s, subscriptionId: msg.subscriptionId });
        } else if (msg.push === 'message') {
          frames.push(msg);
        }
      }
    });
    s.on('error', reject);
    s.on('connect', () => {
      s.write(JSON.stringify({ id: 1, cmd: 'hello', protocol: 'claws/2', role: 'observer', peerName: 'test-observer' }) + '\n');
      setTimeout(() => {
        s.write(JSON.stringify({ id: 2, cmd: 'subscribe', protocol: 'claws/2', topic }) + '\n');
      }, 50);
    });
    setTimeout(() => { if (!resolved) reject(new Error('subscription timeout')); }, 3000);
  });
}

// ─── test runner ─────────────────────────────────────────────────────────────

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message || String(e) });
    console.log(`  FAIL  ${name}: ${e.message || e}`);
  }
}

// ─── tests ───────────────────────────────────────────────────────────────────

(async () => {
  const ready = await waitFor(() => fs.existsSync(sockPath), 4000);
  if (!ready) { console.error('FAIL: socket never appeared'); process.exit(1); }

  await check('socket is ready', () => {
    if (!ready) throw new Error('socket never appeared');
  });

  // Lifecycle plan + advance to SPAWN so canSpawn gate allows terminal creation.
  await rpc({ cmd: 'lifecycle.plan', plan: 'Wave D onDidCloseTerminal test', workerMode: 'single', expectedWorkers: 2 });
  await rpc({ cmd: 'lifecycle.advance', to: 'SPAWN' });

  // Subscribe to system.worker.terminated before creating terminals.
  let sub;
  await check('subscribe to system.worker.terminated returns subscriptionId', async () => {
    sub = await openSubscription('system.worker.terminated');
    assert.ok(sub.subscriptionId, 'expected subscriptionId');
  });
  if (!sub) { console.error('FAIL: subscription setup failed'); process.exit(1); }

  // ── Test 1: wrapped terminal close → system.worker.terminated published ──────
  let wrappedTermId;
  await check('create wrapped terminal succeeds', async () => {
    const r = await rpc({ cmd: 'create', wrapped: true, name: 'wave-d-wrapped' });
    assert.strictEqual(r.ok, true, `create failed: ${JSON.stringify(r)}`);
    assert.ok(r.id, 'expected terminal id');
    wrappedTermId = String(r.id);
  });

  if (!wrappedTermId) { console.error('FAIL: no wrapped terminal id'); process.exit(1); }

  // Simulate VS Code closing the wrapped terminal.
  const wrappedMockTerm = createdTerminals.find(t => t.name === 'wave-d-wrapped');
  await check('mock wrapped terminal found in createdTerminals', () => {
    assert.ok(wrappedMockTerm, 'could not find mock terminal wave-d-wrapped');
  });
  if (wrappedMockTerm) {
    onClose.fire(wrappedMockTerm);
  }

  await check('system.worker.terminated push frame received after wrapped terminal close', async () => {
    const ok = await waitFor(() => sub.frames.some(f =>
      f.topic === 'system.worker.terminated' && f.payload && String(f.payload.terminal_id) === wrappedTermId
    ), 2000);
    if (!ok) {
      throw new Error(
        `No system.worker.terminated frame for terminal_id=${wrappedTermId}. ` +
        `Frames: ${JSON.stringify(sub.frames.map(f => ({ topic: f.topic, payload: f.payload })))}`
      );
    }
  });

  await check('system.worker.terminated payload has terminal_id and terminated_at', async () => {
    const frame = sub.frames.find(f =>
      f.topic === 'system.worker.terminated' && f.payload && String(f.payload.terminal_id) === wrappedTermId
    );
    assert.ok(frame, 'terminated frame not found');
    assert.strictEqual(String(frame.payload.terminal_id), wrappedTermId, 'terminal_id mismatch');
    assert.ok(typeof frame.payload.terminated_at === 'string', 'terminated_at must be a string');
    assert.ok(!isNaN(Date.parse(frame.payload.terminated_at)), 'terminated_at must be ISO timestamp');
  });

  // ── Test 2: unwrapped (standard) terminal close → NO system.worker.terminated ─
  const frameCountBefore = sub.frames.length;
  let stdTermId;
  await check('create standard (unwrapped) terminal succeeds', async () => {
    const r = await rpc({ cmd: 'create', wrapped: false, name: 'wave-d-standard' });
    assert.strictEqual(r.ok, true, `create failed: ${JSON.stringify(r)}`);
    assert.ok(r.id, 'expected terminal id');
    stdTermId = String(r.id);
  });

  if (stdTermId) {
    const stdMockTerm = createdTerminals.find(t => t.name === 'wave-d-standard');
    if (stdMockTerm) onClose.fire(stdMockTerm);
  }

  // Wait briefly then confirm no new system.worker.terminated frame arrived for the standard terminal.
  await new Promise((r) => setTimeout(r, 300));
  await check('closing unwrapped terminal does NOT publish system.worker.terminated', () => {
    const newTerminatedFrames = sub.frames.slice(frameCountBefore).filter(f =>
      f.topic === 'system.worker.terminated' && f.payload && String(f.payload.terminal_id) === stdTermId
    );
    assert.strictEqual(
      newTerminatedFrames.length, 0,
      `Unexpected system.worker.terminated for unwrapped terminal: ${JSON.stringify(newTerminatedFrames)}`
    );
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────────
  sub.socket.destroy();

  // ── Results ──────────────────────────────────────────────────────────────────
  const pass = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok).length;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  process.exit(0);
})();
