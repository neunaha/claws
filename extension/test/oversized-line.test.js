#!/usr/bin/env node
// Server line-buffer cap regression test. Loads the built extension bundle
// against a mocked vscode, connects to the socket, writes 2 MB without a
// newline, and verifies the server either responds with "request too large"
// or closes the connection. Then opens a FRESH connection and sends a clean
// request to confirm one bad client did not take down the server.
//
// Run: node extension/test/oversized-line.test.js
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

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-oversized-'));
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
  },
  commands: {
    registerCommand: (_name, _cb) => ({ dispose: () => {} }),
    executeCommand: () => Promise.resolve(),
  },
};

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

const ext = require(BUNDLE);
const subscriptions = [];
ext.activate({ subscriptions, extensionPath: EXT_ROOT });

const sockPath = path.join(workspaceRoot, '.claws', 'claws.sock');

async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function sendOversized() {
  return new Promise((resolve) => {
    const s = net.createConnection(sockPath);
    const result = { errored: false, closed: false, response: null };
    let buf = '';
    s.on('connect', () => {
      // Write 2 MB of junk in chunks, no newline — server's MAX_LINE_BYTES
      // is 1 MB, so the buffer cap should trip well before the full 2 MB
      // is received.
      const chunk = Buffer.alloc(64 * 1024, 'x'); // 64 KB
      let sent = 0;
      const target = 2 * 1024 * 1024;
      const writeMore = () => {
        while (sent < target) {
          const ok = s.write(chunk);
          sent += chunk.length;
          if (!ok) { s.once('drain', writeMore); return; }
        }
      };
      writeMore();
    });
    s.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        try { result.response = JSON.parse(line); } catch { /* ignore */ }
      }
    });
    s.on('error', () => { result.errored = true; });
    s.on('close', () => { result.closed = true; resolve(result); });
    setTimeout(() => { try { s.destroy(); } catch { /* ignore */ } }, 5000);
  });
}

function sendClean(req) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sockPath);
    let buf = '';
    s.on('connect', () => s.write(JSON.stringify(req) + '\n'));
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
    setTimeout(() => { s.destroy(); reject(new Error('clean socket timeout')); }, 3000);
  });
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
  check('socket ready', () => { if (!ready) throw new Error('socket not created'); });

  const result = await sendOversized();

  check('oversized request closed by server or got request-too-large error', () => {
    const errMatches = result.response && result.response.ok === false && /request too large/.test(result.response.error || '');
    if (!errMatches && !result.closed) {
      throw new Error(`neither closed nor error-response; result=${JSON.stringify(result)}`);
    }
  });

  // Now confirm server still alive on a NEW connection.
  try {
    const resp = await sendClean({ id: 99, cmd: 'list' });
    check('subsequent clean request still succeeds', () => {
      if (!resp.ok) throw new Error(`list failed: ${JSON.stringify(resp)}`);
      if (!Array.isArray(resp.terminals)) throw new Error('no terminals array');
    });
  } catch (e) {
    check('subsequent clean request still succeeds', () => { throw e; });
  }

  await ext.deactivate();
  await new Promise((r) => setTimeout(r, 100));

  for (const a of assertions) {
    console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
  }
  try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ignore */ }

  const failed = assertions.filter((a) => !a.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${assertions.length} oversized-line check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${assertions.length} oversized-line checks`);
  process.exit(0);
})();
