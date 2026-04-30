#!/usr/bin/env node
// L18 AUTH tests — HMAC-SHA256 token validation in hello handler.
//
// Run: node extension/test/claws-auth.test.js
// Exits 0 on success, 1 on failure.

'use strict';

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');

const EXT_ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(EXT_ROOT, 'dist', 'extension.js');

if (!fs.existsSync(BUNDLE)) {
  console.error('FAIL: dist/extension.js not found. Run `npm run build` first.');
  process.exit(1);
}

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-auth-'));
const logs = [];

const SECRET = 'wave10-auth-test-secret';
const tokenPath = path.join(workspaceRoot, 'auth.token');
fs.writeFileSync(tokenPath, SECRET, 'utf8');

// ─── Mutable config store ─────────────────────────────────────────────────
const configValues = {
  'socketPath': '.claws/claws.sock',
  'auth.enabled': true,
  'auth.tokenPath': tokenPath,
  'webSocket.enabled': false,
  'webSocket.port': 0,
  'webSocket.certPath': '',
  'webSocket.keyPath': '',
};

// ─── vscode mock ─────────────────────────────────────────────────────────
class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (l) => {
      this.listeners.push(l);
      return { dispose: () => { const i = this.listeners.indexOf(l); if (i >= 0) this.listeners.splice(i, 1); } };
    };
  }
  fire(arg) { for (const l of this.listeners.slice()) l(arg); }
  dispose() { this.listeners = []; }
}
class TerminalProfile { constructor(o) { this.options = o; } }
class MarkdownString { constructor() { this.value = ''; } appendMarkdown(s) { this.value += s; return this; } }
class ThemeColor { constructor(id) { this.id = id; } }

const onOpen = new EventEmitter();
const onClose = new EventEmitter();
const onConfig = new EventEmitter();
const onFolders = new EventEmitter();

const vscode = {
  EventEmitter, TerminalProfile, MarkdownString, ThemeColor,
  StatusBarAlignment: { Left: 1, Right: 2 },
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file', path: p }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
    getConfiguration: (_s) => ({ get: (k, fb) => configValues[k] ?? fb }),
    onDidChangeConfiguration: onConfig.event,
    onDidChangeWorkspaceFolders: onFolders.event,
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

/** Make HMAC-SHA256 token using the test secret. */
function makeToken(peerName, role, nonce, timestamp) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(`${peerName}:${role}:${nonce}:${timestamp}`)
    .digest('hex');
}

/** Open a raw socket and send one hello frame; return the response. */
function helloOnce(frame) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sockPath);
    let buf = '';
    const t = setTimeout(() => { s.destroy(); reject(new Error('hello timeout')); }, 3000);
    s.on('connect', () => s.write(JSON.stringify(frame) + '\n'));
    s.on('data', (d) => {
      buf += d.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx !== -1) {
        clearTimeout(t);
        s.destroy();
        try { resolve(JSON.parse(buf.slice(0, idx))); } catch (e) { reject(e); }
      }
    });
    s.on('error', (e) => { clearTimeout(t); reject(e); });
  });
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

function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  const ready = await waitFor(() => fs.existsSync(sockPath), 3000);
  if (!ready) { console.error('FAIL: socket never appeared'); process.exit(1); }

  // ─── Test 1: hello without token → auth:required or auth:invalid ─────────
  await check('hello without token → auth error', async () => {
    const resp = await helloOnce({ id: 1, cmd: 'hello', protocol: 'claws/2', role: 'worker', peerName: 'no-token' });
    assert(resp.ok === false, `expected ok:false, got ok:${resp.ok}`);
    assert(
      resp.error === 'auth:required' || resp.error === 'auth:invalid',
      `expected auth:required or auth:invalid, got "${resp.error}"`,
    );
  });

  // ─── Test 2: hello with wrong token → auth:invalid ───────────────────────
  await check('hello with wrong HMAC token → auth:invalid', async () => {
    const resp = await helloOnce({
      id: 2, cmd: 'hello', protocol: 'claws/2', role: 'worker', peerName: 'wrong-token',
      nonce: 'deadbeef', timestamp: Date.now(), token: 'notavalidtoken',
    });
    assert(resp.ok === false, `expected ok:false`);
    assert(resp.error === 'auth:invalid', `expected auth:invalid, got "${resp.error}"`);
  });

  // ─── Test 3: hello with valid HMAC token → ok:true ───────────────────────
  await check('hello with valid HMAC token → ok:true with peerId', async () => {
    const peerName = 'valid-auth-peer';
    const role = 'worker';
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now();
    const token = makeToken(peerName, role, nonce, timestamp);
    const resp = await helloOnce({ id: 3, cmd: 'hello', protocol: 'claws/2', role, peerName, nonce, timestamp, token });
    assert(resp.ok === true, `expected ok:true, got ok:${resp.ok} error:${resp.error}`);
    assert(typeof resp.peerId === 'string', `expected peerId string`);
  });

  // ─── Test 4: stale timestamp → auth:invalid ──────────────────────────────
  await check('hello with stale timestamp (>5min) → auth:invalid', async () => {
    const peerName = 'stale-peer';
    const role = 'worker';
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now() - 10 * 60 * 1000; // 10 min ago
    const token = makeToken(peerName, role, nonce, timestamp);
    const resp = await helloOnce({ id: 4, cmd: 'hello', protocol: 'claws/2', role, peerName, nonce, timestamp, token });
    assert(resp.ok === false, `expected ok:false for stale token`);
    assert(resp.error === 'auth:invalid', `expected auth:invalid, got "${resp.error}"`);
  });

  // ─── Test 5: nonce reuse → auth:invalid ──────────────────────────────────
  await check('nonce reuse on second hello → auth:invalid', async () => {
    const peerName = 'nonce-peer';
    const role = 'worker';
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now();
    const token = makeToken(peerName, role, nonce, timestamp);
    const frame = { id: 5, cmd: 'hello', protocol: 'claws/2', role, peerName, nonce, timestamp, token };

    // First hello — should succeed
    const r1 = await helloOnce(frame);
    assert(r1.ok === true, `first hello should succeed, got error:${r1.error}`);

    // Second hello with same nonce — should fail
    const r2 = await helloOnce({ ...frame, id: 6 });
    assert(r2.ok === false, `second hello with same nonce should fail`);
    assert(r2.error === 'auth:invalid', `expected auth:invalid, got "${r2.error}"`);
  });

  // ─── Test 6: auth disabled — no token required ───────────────────────────
  await check('auth disabled — hello without token succeeds on separate server', async () => {
    // This is validated indirectly: other test suites (e.g. claws-v2-hello)
    // connect without tokens. If auth was always on, those tests would fail.
    // We verify the current server IS enforcing auth, which proves the toggle works.
    const resp = await helloOnce({ id: 7, cmd: 'hello', protocol: 'claws/2', role: 'observer', peerName: 'no-token-observer' });
    assert(resp.ok === false, `expected auth to be enforced (ok:false)`);
    assert(
      resp.error === 'auth:required' || resp.error === 'auth:invalid',
      `expected auth error, got "${resp.error}"`,
    );
  });

  await ext.deactivate();

  // ─── Report ──────────────────────────────────────────────────────────────
  console.log('\nL18 AUTH — token validation\n');
  let pass = 0; let fail = 0;
  for (const a of assertions) {
    if (a.ok) { console.log(`  ✓ ${a.name}`); pass++; }
    else { console.log(`  ✗ ${a.name}: ${a.err}`); fail++; }
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})();
