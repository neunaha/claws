#!/usr/bin/env node
// Loads dist/extension.js with a mocked `vscode` module, calls activate(),
// connects to the socket, exercises a few protocol commands, and verifies
// deactivate() cleans up.
//
// Run: node extension/test/smoke.test.js
// Exits 0 on success, 1 on any failure.

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

// ─── Mock vscode module ──────────────────────────────────────────────────
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-smoke-'));
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

const onOpen = new EventEmitter();
const onClose = new EventEmitter();

const vscode = {
  EventEmitter,
  TerminalProfile,
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file', path: p }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
    getConfiguration: (_section) => ({
      get: (_key, fallback) => fallback,
    }),
  },
  window: {
    terminals: [],
    activeTerminal: undefined,
    createOutputChannel: (_name) => ({
      appendLine: (m) => logs.push(m),
      show: () => {},
      dispose: () => {},
    }),
    createTerminal: (_opts) => ({
      name: 'mock',
      processId: Promise.resolve(12345),
      shellIntegration: undefined,
      show: () => {},
      sendText: () => {},
      dispose: () => {},
    }),
    onDidOpenTerminal: onOpen.event,
    onDidCloseTerminal: onClose.event,
    registerTerminalProfileProvider: (_id, _provider) => ({ dispose: () => {} }),
    // shell-integration APIs omitted — code path guarded by typeof === 'function'
  },
  commands: {
    registerCommand: (_name, _cb) => ({ dispose: () => {} }),
  },
};

// Intercept require('vscode') → return the mock
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'vscode') return 'vscode';
  return origResolve.call(this, request, parent, ...rest);
};
require.cache['vscode'] = {
  id: 'vscode',
  filename: 'vscode',
  loaded: true,
  exports: vscode,
};

// ─── Load the bundle ─────────────────────────────────────────────────────
const ext = require(BUNDLE);
if (typeof ext.activate !== 'function' || typeof ext.deactivate !== 'function') {
  console.error('FAIL: bundle is missing activate/deactivate exports.');
  process.exit(1);
}

const subscriptions = [];
const context = {
  subscriptions,
  extensionPath: EXT_ROOT,
};

ext.activate(context);

// ─── Assertions ──────────────────────────────────────────────────────────
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

// Activation log line
check('logs contain "activating (typescript)"', () => {
  if (!logs.some((l) => l.includes('activating (typescript)'))) {
    throw new Error(`logs were: ${JSON.stringify(logs)}`);
  }
});

// Wait for socket to be created (listen is async)
const sockPath = path.join(workspaceRoot, '.claws', 'claws.sock');

async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function sendRequest(cmd) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sockPath);
    let buf = '';
    s.on('connect', () => s.write(JSON.stringify(cmd) + '\n'));
    s.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        s.destroy();
        try { resolve(JSON.parse(line)); } catch (e) { reject(e); }
      }
    });
    s.on('error', (e) => reject(e));
    setTimeout(() => { s.destroy(); reject(new Error('socket timeout')); }, 5000);
  });
}

(async () => {
  const socketReady = await waitFor(() => fs.existsSync(sockPath), 2000);
  check('socket file created', () => {
    if (!socketReady) throw new Error(`socket not created at ${sockPath}`);
  });

  if (socketReady) {
    try {
      const resp = await sendRequest({ id: 1, cmd: 'list' });
      check('list cmd responds ok', () => {
        if (!resp.ok) throw new Error(`list not ok: ${JSON.stringify(resp)}`);
        if (!Array.isArray(resp.terminals)) throw new Error('no terminals array');
      });
    } catch (e) {
      check('list cmd responds ok', () => { throw e; });
    }

    try {
      const resp = await sendRequest({ id: 2, cmd: 'unknownCmd' });
      check('unknown cmd returns ok:false', () => {
        if (resp.ok !== false) throw new Error(`expected ok:false, got ${JSON.stringify(resp)}`);
        if (!/unknown cmd/.test(resp.error || '')) throw new Error(`unexpected error: ${resp.error}`);
      });
    } catch (e) {
      check('unknown cmd returns ok:false', () => { throw e; });
    }
  }

  ext.deactivate();
  await new Promise((r) => setTimeout(r, 100));

  check('socket file cleaned up after deactivate', () => {
    if (fs.existsSync(sockPath)) throw new Error('socket still present');
  });

  // Report
  const failed = assertions.filter((a) => !a.ok);
  for (const a of assertions) {
    console.log(`${a.ok ? '  ✓' : '  ✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
  }
  try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ignore */ }

  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${assertions.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${assertions.length} checks`);
  process.exit(0);
})();
