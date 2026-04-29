#!/usr/bin/env node
// L4 vehicle state machine — integration tests.
// Verifies vehicle.<id>.state push frames on terminal lifecycle transitions,
// vehicleState field in list responses, and transition ordering.
//
// Run: node extension/test/claws-v2-vehicle-state.test.js
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

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-vehicle-state-'));
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

// Pseudoterminals returned from createTerminal: simulate VS Code calling pty.open()
const createdTerminals = [];

const vscode = {
  EventEmitter, TerminalProfile, MarkdownString, ThemeColor,
  StatusBarAlignment: { Left: 1, Right: 2 },
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file', path: p }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
    getConfiguration: (_s) => ({ get: (_k, fb) => fb }),
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
      // Simulate VS Code calling Pseudoterminal.open() for wrapped terminals.
      // This fires ~20ms after creation, matching real VS Code behaviour.
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
  workspace: {
    workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
    getConfiguration: (_s) => ({ get: (_k, fb) => fb }),
    onDidChangeConfiguration: (cb) => ({ dispose: () => {} }),
  },
  extensions: { getExtension: () => undefined },
};

Module._resolveFilename = ((orig) => (req, parent, isMain, opts) => {
  if (req === 'vscode') return '__vscode__';
  return orig(req, parent, isMain, opts);
})(Module._resolveFilename);
Module._cache['__vscode__'] = { id: '__vscode__', filename: '__vscode__', loaded: true, exports: vscode };

const ext = require(BUNDLE);
ext.activate({ subscriptions: [], extensionPath: EXT_ROOT, extension: { packageJSON: { version: '0.7.5' } } });

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

// Opens a persistent subscription socket. Returns { frames, socket, subscriptionId }.
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
      // First hello, then subscribe
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
  await check('socket is ready', () => {
    if (!ready) throw new Error('socket never appeared');
  });
  if (!ready) { console.error('FAIL: no socket'); process.exit(1); }

  // Set up lifecycle plan (required by server gate before create)
  await check('lifecycle.plan succeeds', async () => {
    const r = await rpc({ cmd: 'lifecycle.plan', plan: 'W1/L4 vehicle state machine test' });
    assert.strictEqual(r.ok, true, `expected ok:true got: ${JSON.stringify(r)}`);
  });

  // Open persistent subscription to observe all vehicle state push frames
  let sub;
  await check('subscribe to vehicle.**.state returns subscriptionId', async () => {
    sub = await openSubscription('vehicle.**.state');
    assert.ok(sub.subscriptionId, 'expected subscriptionId in subscribe response');
    assert.match(sub.subscriptionId, /^s_/, 'subscriptionId should start with s_');
  });

  if (!sub) { console.error('FAIL: subscription setup failed'); process.exit(1); }

  // Create a wrapped terminal and observe state transitions
  let terminalId;
  let createResp;
  await check('create wrapped=true returns ok:true with id', async () => {
    createResp = await rpc({ cmd: 'create', wrapped: true, name: 'vehicle-state-test' });
    assert.strictEqual(createResp.ok, true, `create failed: ${JSON.stringify(createResp)}`);
    assert.ok(createResp.id, 'expected id in create response');
    terminalId = String(createResp.id);
  });

  if (!terminalId) { console.error('FAIL: no terminal id'); process.exit(1); }

  // Wait for at least BOOTING state push frame (PROVISIONING → BOOTING in createWrapped)
  await check('vehicle.<id>.state push frame received with to:"BOOTING" on create', async () => {
    const ok = await waitFor(() => sub.frames.some(f =>
      f.topic === `vehicle.${terminalId}.state` && f.payload && f.payload.to === 'BOOTING'
    ), 2000);
    if (!ok) {
      throw new Error(
        `No BOOTING frame received. Frames so far: ${JSON.stringify(sub.frames.map(f => ({ topic: f.topic, payload: f.payload })))}`
      );
    }
  });

  // Wait for READY state push frame (BOOTING → READY when pty.open() fires)
  await check('vehicle.<id>.state push frame received with to:"READY" after pty.open()', async () => {
    const ok = await waitFor(() => sub.frames.some(f =>
      f.topic === `vehicle.${terminalId}.state` && f.payload && f.payload.to === 'READY'
    ), 2000);
    if (!ok) {
      throw new Error(
        `No READY frame received. Frames so far: ${JSON.stringify(sub.frames.map(f => ({ topic: f.topic, payload: f.payload })))}`
      );
    }
  });

  await check('push frame topic matches vehicle.<id>.state pattern', async () => {
    const bootingFrame = sub.frames.find(f =>
      f.topic === `vehicle.${terminalId}.state` && f.payload && f.payload.to === 'BOOTING'
    );
    assert.ok(bootingFrame, 'BOOTING frame not found');
    assert.strictEqual(bootingFrame.topic, `vehicle.${terminalId}.state`);
    assert.strictEqual(bootingFrame.push, 'message');
  });

  await check('push frame payload has terminalId field matching created terminal', async () => {
    const frame = sub.frames.find(f =>
      f.topic === `vehicle.${terminalId}.state` && f.payload && f.payload.to === 'BOOTING'
    );
    assert.ok(frame, 'BOOTING frame not found');
    assert.strictEqual(String(frame.payload.terminalId), terminalId);
  });

  await check('push frame payload has ts field (ISO timestamp)', async () => {
    const frame = sub.frames.find(f =>
      f.topic === `vehicle.${terminalId}.state` && f.payload
    );
    assert.ok(frame, 'no vehicle state frame found');
    assert.ok(frame.payload.ts, 'expected ts field');
    assert.doesNotThrow(() => new Date(frame.payload.ts), 'ts should be parseable as date');
  });

  await check('push frame payload has from field', async () => {
    const frame = sub.frames.find(f =>
      f.topic === `vehicle.${terminalId}.state` && f.payload && f.payload.to === 'BOOTING'
    );
    assert.ok(frame, 'BOOTING frame not found');
    assert.strictEqual(frame.payload.from, 'PROVISIONING');
  });

  await check('list response includes vehicleState field for wrapped terminal', async () => {
    const r = await rpc({ cmd: 'list' });
    assert.strictEqual(r.ok, true);
    const desc = r.terminals.find(t => String(t.id) === terminalId);
    assert.ok(desc, `terminal ${terminalId} not found in list`);
    assert.ok('vehicleState' in desc, `vehicleState field missing from TerminalDescriptor: ${JSON.stringify(desc)}`);
  });

  await check('vehicleState in list is "READY" after pty.open() fires', async () => {
    // Ensure READY frame was received (pty.open() already fired in earlier assertion)
    const r = await rpc({ cmd: 'list' });
    const desc = r.terminals.find(t => String(t.id) === terminalId);
    assert.ok(desc, `terminal ${terminalId} not found in list`);
    assert.strictEqual(desc.vehicleState, 'READY', `expected READY, got: ${desc.vehicleState}`);
  });

  await check('state transitions are ordered: BOOTING arrives before READY', async () => {
    const bootingIdx = sub.frames.findIndex(f =>
      f.topic === `vehicle.${terminalId}.state` && f.payload && f.payload.to === 'BOOTING'
    );
    const readyIdx = sub.frames.findIndex(f =>
      f.topic === `vehicle.${terminalId}.state` && f.payload && f.payload.to === 'READY'
    );
    assert.ok(bootingIdx >= 0, 'BOOTING frame not found');
    assert.ok(readyIdx >= 0, 'READY frame not found');
    assert.ok(bootingIdx < readyIdx, `BOOTING (idx ${bootingIdx}) must come before READY (idx ${readyIdx})`);
  });

  await check('PROVISIONING→BOOTING transition is valid (from=PROVISIONING to=BOOTING)', async () => {
    const frame = sub.frames.find(f =>
      f.topic === `vehicle.${terminalId}.state` &&
      f.payload && f.payload.from === 'PROVISIONING' && f.payload.to === 'BOOTING'
    );
    assert.ok(frame, 'expected PROVISIONING→BOOTING frame, none found');
  });

  await check('BOOTING→READY transition is valid (from=BOOTING to=READY)', async () => {
    const frame = sub.frames.find(f =>
      f.topic === `vehicle.${terminalId}.state` &&
      f.payload && f.payload.from === 'BOOTING' && f.payload.to === 'READY'
    );
    assert.ok(frame, 'expected BOOTING→READY frame, none found');
  });

  // Close the terminal and observe CLOSING → CLOSED transitions
  const framesBeforeClose = sub.frames.length;
  await check('close command returns ok:true', async () => {
    const r = await rpc({ cmd: 'close', id: terminalId });
    assert.strictEqual(r.ok, true, `close failed: ${JSON.stringify(r)}`);
  });

  await check('vehicle.<id>.state push frame with to:"CLOSING" received after close', async () => {
    const ok = await waitFor(() => sub.frames.slice(framesBeforeClose).some(f =>
      f.topic === `vehicle.${terminalId}.state` && f.payload && f.payload.to === 'CLOSING'
    ), 2000);
    if (!ok) {
      throw new Error(
        `No CLOSING frame received after close. Frames after close: ${JSON.stringify(
          sub.frames.slice(framesBeforeClose).map(f => ({ topic: f.topic, payload: f.payload }))
        )}`
      );
    }
  });

  await check('vehicle.<id>.state push frame with to:"CLOSED" received after close', async () => {
    const ok = await waitFor(() => sub.frames.slice(framesBeforeClose).some(f =>
      f.topic === `vehicle.${terminalId}.state` && f.payload && f.payload.to === 'CLOSED'
    ), 2000);
    if (!ok) {
      throw new Error(
        `No CLOSED frame received after close. Frames after close: ${JSON.stringify(
          sub.frames.slice(framesBeforeClose).map(f => ({ topic: f.topic, payload: f.payload }))
        )}`
      );
    }
  });

  await check('CLOSING arrives before CLOSED after close', async () => {
    const closingIdx = sub.frames.findIndex(f =>
      f.topic === `vehicle.${terminalId}.state` && f.payload && f.payload.to === 'CLOSING'
    );
    const closedIdx = sub.frames.findIndex(f =>
      f.topic === `vehicle.${terminalId}.state` && f.payload && f.payload.to === 'CLOSED'
    );
    assert.ok(closingIdx >= 0, 'CLOSING frame not found');
    assert.ok(closedIdx >= 0, 'CLOSED frame not found');
    assert.ok(closingIdx < closedIdx, `CLOSING (idx ${closingIdx}) must come before CLOSED (idx ${closedIdx})`);
  });

  // Clean up subscription socket
  try { sub.socket.destroy(); } catch {}

  // ─── results ───────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log('');
  console.log(`${passed} passed, ${failed} failed (${results.length} total)`);
  if (failed > 0) {
    console.log('\nFailed assertions:');
    for (const r of results.filter(r => !r.ok)) {
      console.log(`  - ${r.name}: ${r.err}`);
    }
    process.exit(1);
  }
  process.exit(0);
})();
