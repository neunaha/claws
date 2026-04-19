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

class MarkdownString {
  constructor() { this.value = ''; this.isTrusted = false; }
  appendMarkdown(s) { this.value += s; return this; }
}
class ThemeColor { constructor(id) { this.id = id; } }

const vscode = {
  EventEmitter,
  TerminalProfile,
  MarkdownString,
  ThemeColor,
  StatusBarAlignment: { Left: 1, Right: 2 },
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
    createStatusBarItem: (_align, _prio) => ({
      text: '', tooltip: '', color: undefined, command: '', name: '',
      show: () => {}, hide: () => {}, dispose: () => {},
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
    showErrorMessage: () => ({ then: (cb) => cb && cb(undefined) }),
    showInformationMessage: () => ({ then: (cb) => cb && cb(undefined) }),
    showWarningMessage: () => ({ then: (cb) => cb && cb(undefined) }),
    showQuickPick: () => Promise.resolve(undefined),
    // shell-integration APIs omitted — code path guarded by typeof === 'function'
  },
  commands: {
    registerCommand: (_name, _cb) => ({ dispose: () => {} }),
    executeCommand: () => Promise.resolve(),
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

// Activation log line — proves the v0.4 TypeScript path ran (vs legacy JS).
check('logs contain activation signature', () => {
  const hasSignature = logs.some(
    (l) => l.includes('(typescript)') || l.includes('activation complete'),
  );
  if (!hasSignature) throw new Error(`logs were: ${JSON.stringify(logs)}`);
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

    // Protocol tag is present in every response.
    try {
      const resp = await sendRequest({ id: 3, cmd: 'list' });
      check('response carries protocol=claws/1 tag', () => {
        if (resp.protocol !== 'claws/1') throw new Error(`protocol=${resp.protocol}`);
      });
    } catch (e) {
      check('response carries protocol=claws/1 tag', () => { throw e; });
    }

    // rid mirrors request id even when the body shadows `id` (e.g. terminal
    // id on `create`). Use a plain list to keep the path simple.
    try {
      const resp = await sendRequest({ id: 42, cmd: 'list' });
      check('response echoes rid back', () => {
        if (resp.rid !== 42) throw new Error(`rid=${resp.rid}`);
      });
    } catch (e) {
      check('response echoes rid back', () => { throw e; });
    }

    // Incompatible protocol version is rejected.
    try {
      const resp = await sendRequest({ id: 4, cmd: 'list', protocol: 'claws/99' });
      check('incompatible protocol is rejected', () => {
        if (resp.ok !== false) throw new Error(`expected rejection, got ${JSON.stringify(resp)}`);
        if (!/incompatible protocol/.test(resp.error || '')) {
          throw new Error(`unexpected error: ${resp.error}`);
        }
      });
    } catch (e) {
      check('incompatible protocol is rejected', () => { throw e; });
    }

    // close on unknown id is idempotent — returns ok:true with alreadyClosed:true.
    try {
      const resp = await sendRequest({ cmd: 'close', id: 'no-such-terminal-42' });
      check('close on unknown id is idempotent (ok:true, alreadyClosed)', () => {
        if (resp.ok !== true) throw new Error(`expected ok:true, got ${JSON.stringify(resp)}`);
        if (resp.alreadyClosed !== true) throw new Error(`alreadyClosed=${resp.alreadyClosed}`);
      });
    } catch (e) {
      check('close on unknown id is idempotent (ok:true, alreadyClosed)', () => { throw e; });
    }

    // poll returns truncated + limit fields.
    try {
      const resp = await sendRequest({ cmd: 'poll' });
      check('poll response exposes limit + truncated fields', () => {
        if (resp.ok !== true) throw new Error(`poll not ok: ${JSON.stringify(resp)}`);
        if (typeof resp.limit !== 'number') throw new Error(`limit missing: ${JSON.stringify(resp)}`);
        if (typeof resp.truncated !== 'boolean') throw new Error(`truncated missing: ${JSON.stringify(resp)}`);
      });
    } catch (e) {
      check('poll response exposes limit + truncated fields', () => { throw e; });
    }

    // Client-supplied limit in poll is capped at server config (default 100).
    try {
      const resp = await sendRequest({ cmd: 'poll', limit: 999999 });
      check('poll caps client-requested limit at server-configured max', () => {
        if (resp.limit > 100) throw new Error(`limit should be <=100, got ${resp.limit}`);
      });
    } catch (e) {
      check('poll caps client-requested limit at server-configured max', () => { throw e; });
    }
  }

  await ext.deactivate();
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
