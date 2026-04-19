#!/usr/bin/env node
// Multi-connection socket test. Opens 3 concurrent socket connections to the
// Claws server, interleaves requests with distinct ids, and asserts that
// every response carries the correct `rid` echoing its request — no cross-
// talk between connections.
//
// Also exercises the new `introspect` command to confirm its fields are
// populated (and no rid drift across connections).
//
// Run: node extension/test/multi-connection.test.js
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

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-multiconn-'));
const logs = [];

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

class TerminalProfile {
  constructor(options) { this.options = options; }
}
class MarkdownString {
  constructor() { this.value = ''; this.isTrusted = false; }
  appendMarkdown(s) { this.value += s; return this; }
}
class ThemeColor { constructor(id) { this.id = id; } }

const onOpen = new EventEmitter();
const onClose = new EventEmitter();

const vscode = {
  EventEmitter,
  TerminalProfile,
  MarkdownString,
  ThemeColor,
  StatusBarAlignment: { Left: 1, Right: 2 },
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file', path: p }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
    getConfiguration: (_section) => ({ get: (_k, fb) => fb }),
  },
  window: {
    terminals: [],
    activeTerminal: undefined,
    createOutputChannel: (_name) => ({
      appendLine: (m) => logs.push(m),
      show: () => {},
      dispose: () => {},
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

async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/**
 * Opens a socket connection and lets the caller send a sequence of requests
 * over it. Responses are collected keyed by rid.
 */
function connect() {
  const s = net.createConnection(sockPath);
  const responses = new Map();
  let buf = '';
  s.on('data', (d) => {
    buf += d.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const resp = JSON.parse(line);
        const key = resp.rid ?? resp.id;
        responses.set(key, resp);
      } catch { /* ignore */ }
    }
  });
  return { socket: s, responses };
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

  // Three concurrent connections, each sends 3 interleaved requests.
  const a = connect();
  const b = connect();
  const c = connect();

  await new Promise((resolve) => {
    let left = 3;
    const done = () => { if (--left === 0) resolve(); };
    a.socket.on('connect', done);
    b.socket.on('connect', done);
    c.socket.on('connect', done);
  });

  // Interleave request writes — every connection writes each of its 3
  // requests with distinct rids that collectively span 100..108.
  a.socket.write(JSON.stringify({ id: 100, cmd: 'list' }) + '\n');
  b.socket.write(JSON.stringify({ id: 200, cmd: 'list' }) + '\n');
  c.socket.write(JSON.stringify({ id: 300, cmd: 'list' }) + '\n');

  a.socket.write(JSON.stringify({ id: 101, cmd: 'poll' }) + '\n');
  b.socket.write(JSON.stringify({ id: 201, cmd: 'poll' }) + '\n');
  c.socket.write(JSON.stringify({ id: 301, cmd: 'poll' }) + '\n');

  a.socket.write(JSON.stringify({ id: 102, cmd: 'introspect', clientVersion: '0.5.0', clientName: 'test' }) + '\n');
  b.socket.write(JSON.stringify({ id: 202, cmd: 'introspect', clientVersion: '0.5.0', clientName: 'test' }) + '\n');
  c.socket.write(JSON.stringify({ id: 302, cmd: 'introspect', clientVersion: '0.5.0', clientName: 'test' }) + '\n');

  // Drain all 9 responses — each connection should see 3 of them.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && (a.responses.size < 3 || b.responses.size < 3 || c.responses.size < 3)) {
    await new Promise((r) => setTimeout(r, 50));
  }

  check('connection A received 3 responses', () => {
    if (a.responses.size !== 3) throw new Error(`got ${a.responses.size}, rids=${[...a.responses.keys()]}`);
  });
  check('connection B received 3 responses', () => {
    if (b.responses.size !== 3) throw new Error(`got ${b.responses.size}, rids=${[...b.responses.keys()]}`);
  });
  check('connection C received 3 responses', () => {
    if (c.responses.size !== 3) throw new Error(`got ${c.responses.size}, rids=${[...c.responses.keys()]}`);
  });

  check('connection A only sees its own rids (100, 101, 102)', () => {
    const expected = [100, 101, 102];
    for (const e of expected) {
      if (!a.responses.has(e)) throw new Error(`missing rid ${e}`);
      if (a.responses.get(e).rid !== e) throw new Error(`rid mismatch: ${a.responses.get(e).rid} !== ${e}`);
    }
    for (const got of a.responses.keys()) {
      if (!expected.includes(got)) throw new Error(`A got foreign rid ${got}`);
    }
  });
  check('connection B only sees its own rids (200, 201, 202)', () => {
    const expected = [200, 201, 202];
    for (const e of expected) {
      if (!b.responses.has(e)) throw new Error(`missing rid ${e}`);
    }
    for (const got of b.responses.keys()) {
      if (!expected.includes(got)) throw new Error(`B got foreign rid ${got}`);
    }
  });
  check('connection C only sees its own rids (300, 301, 302)', () => {
    const expected = [300, 301, 302];
    for (const e of expected) {
      if (!c.responses.has(e)) throw new Error(`missing rid ${e}`);
    }
    for (const got of c.responses.keys()) {
      if (!expected.includes(got)) throw new Error(`C got foreign rid ${got}`);
    }
  });

  check('introspect response has the expected shape', () => {
    const resp = a.responses.get(102);
    if (!resp || !resp.ok) throw new Error(`introspect failed: ${JSON.stringify(resp)}`);
    if (typeof resp.extensionVersion !== 'string') throw new Error('no extensionVersion');
    if (typeof resp.nodeVersion !== 'string') throw new Error('no nodeVersion');
    if (typeof resp.electronAbi !== 'number') throw new Error('no electronAbi');
    if (typeof resp.platform !== 'string') throw new Error('no platform');
    if (typeof resp.terminals !== 'number') throw new Error('no terminals count');
    if (typeof resp.uptime_ms !== 'number') throw new Error('no uptime_ms');
    if (!Array.isArray(resp.servers)) throw new Error('no servers array');
    if (resp.nodePty == null) throw new Error('no nodePty block');
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
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${assertions.length} multi-connection check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${assertions.length} multi-connection checks`);
  process.exit(0);
})();
