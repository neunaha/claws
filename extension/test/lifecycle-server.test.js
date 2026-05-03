#!/usr/bin/env node
// Integration tests for the server-side lifecycle gate.
// Tests against a running ClawsServer on a Unix socket.
// Run: node extension/test/lifecycle-server.test.js
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

// ─── vscode mock ────────────────────────────────────────────────────────────

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-lc-server-'));
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

class TerminalProfile { constructor(options) { this.options = options; } }
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

// ─── helpers ────────────────────────────────────────────────────────────────

async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
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
        const line = buf.slice(0, idx);
        try { resolve(JSON.parse(line)); } catch (e) { reject(e); }
        s.destroy();
      }
    });
    s.on('error', reject);
    s.on('connect', () => {
      s.write(JSON.stringify({ id: 1, ...payload }) + '\n');
    });
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

// ─── tests (run sequentially) ───────────────────────────────────────────────

(async () => {
  const ready = await waitFor(() => fs.existsSync(sockPath), 3000);
  check('socket ready', () => { if (!ready) throw new Error('no socket'); });
  if (!ready) {
    console.error('FAIL: socket never appeared');
    process.exit(1);
  }

  // 1. create with no state file → rejected with lifecycle:plan-required
  await check('create with no state file → rejected with lifecycle:plan-required', async () => {
    const resp = await rpc({ cmd: 'create', name: 'gate-test', wrapped: true });
    assert.strictEqual(resp.ok, false, `expected ok:false, got: ${JSON.stringify(resp)}`);
    assert.strictEqual(resp.error, 'lifecycle:plan-required');
    assert(resp.message, 'expected message field');
  });

  // 5. Bash raw-socket bypass attempt → same rejection at server level (no MCP layer)
  // Run BEFORE plan is logged so the gate fires.
  await check('raw-socket bypass (before plan) → lifecycle:plan-required from server', async () => {
    const resp = await new Promise((resolve, reject) => {
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
      s.on('connect', () => {
        // Raw net.Socket — no MCP wrapper. Same server-side gate applies.
        s.write(JSON.stringify({ id: 1, cmd: 'create', name: 'bypass', wrapped: true }) + '\n');
      });
    });
    assert.strictEqual(resp.ok, false, `bypass should be rejected: ${JSON.stringify(resp)}`);
    assert.strictEqual(resp.error, 'lifecycle:plan-required', `expected lifecycle:plan-required, got: ${resp.error}`);
  });

  // 2. lifecycle.plan → state file created, phase=PLAN
  await check('lifecycle.plan → state file created, phase=PLAN', async () => {
    const resp = await rpc({ cmd: 'lifecycle.plan', plan: 'test mission', workerMode: 'single', expectedWorkers: 1 });
    assert.strictEqual(resp.ok, true, `expected ok:true, got: ${JSON.stringify(resp)}`);
    assert(resp.state, 'expected state field');
    assert.strictEqual(resp.state.phase, 'PLAN');
    assert.strictEqual(resp.state.plan, 'test mission');
    assert.deepStrictEqual(resp.state.phases_completed, ['PLAN']);
    const sf = path.join(workspaceRoot, '.claws', 'lifecycle-state.json');
    assert(fs.existsSync(sf), 'state file should exist on disk');
    const onDisk = JSON.parse(fs.readFileSync(sf, 'utf8'));
    assert.strictEqual(onDisk.phase, 'PLAN');
    assert.strictEqual(onDisk.plan, 'test mission');
  });

  // 3. create after plan → succeeds
  await check('create after plan → succeeds', async () => {
    const resp = await rpc({ cmd: 'create', name: 'after-plan', wrapped: true });
    assert.strictEqual(resp.ok, true, `expected ok:true after plan, got: ${JSON.stringify(resp)}`);
    assert(resp.id !== undefined, 'expected id');
    assert.strictEqual(resp.wrapped, true);
  });

  // 4. lifecycle.advance → state file updated, phase advances; idempotent
  await check('lifecycle.advance → state advances; idempotent call does not re-write file', async () => {
    const r1 = await rpc({ cmd: 'lifecycle.advance', to: 'SPAWN' });
    assert.strictEqual(r1.ok, true, `expected ok:true, got: ${JSON.stringify(r1)}`);
    assert.strictEqual(r1.state.phase, 'SPAWN');
    const sf = path.join(workspaceRoot, '.claws', 'lifecycle-state.json');
    const d1 = JSON.parse(fs.readFileSync(sf, 'utf8'));
    assert.strictEqual(d1.phase, 'SPAWN');
    // Get mtime before idempotent call
    const mtime1 = fs.statSync(sf).mtimeMs;
    // Wait 10ms to ensure mtime would differ if file were written
    await new Promise((r) => setTimeout(r, 10));
    // Idempotent: advance to SPAWN again
    const r2 = await rpc({ cmd: 'lifecycle.advance', to: 'SPAWN' });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.state.phase, 'SPAWN');
    const mtime2 = fs.statSync(sf).mtimeMs;
    assert.strictEqual(mtime1, mtime2, 'idempotent advance should not re-write file');
    assert.strictEqual(r2.idempotent, true, 'idempotent advance should have idempotent:true');
  });

  // M1: lifecycle.advance illegal transition → stable error code + separate message field
  await check('lifecycle.advance illegal transition → stable error code + message field', async () => {
    // State is at SPAWN; REFLECT is not legal from SPAWN (allowed: DEPLOY, RECOVER, FAILED)
    const r = await rpc({ cmd: 'lifecycle.advance', to: 'REFLECT' });
    assert.strictEqual(r.ok, false, `expected ok:false, got: ${JSON.stringify(r)}`);
    assert.strictEqual(r.error, 'lifecycle:invalid-transition', `expected stable error code, got: ${r.error}`);
    assert.strictEqual(typeof r.message, 'string', 'expected message field to be a string');
    assert(r.message.length > 0, 'expected non-empty message');
  });

  // 6. lifecycle.plan twice → second returns ok with original plan, idempotent:true
  await check('lifecycle.plan twice → second call idempotent, original plan preserved', async () => {
    const r2 = await rpc({ cmd: 'lifecycle.plan', plan: 'different plan text', workerMode: 'single', expectedWorkers: 1 });
    assert.strictEqual(r2.ok, true, `expected ok:true, got: ${JSON.stringify(r2)}`);
    assert.strictEqual(r2.idempotent, true, `expected idempotent:true`);
    assert.strictEqual(r2.state.plan, 'test mission', `plan should remain 'test mission', got: ${r2.state.plan}`);
    const sf = path.join(workspaceRoot, '.claws', 'lifecycle-state.json');
    const onDisk = JSON.parse(fs.readFileSync(sf, 'utf8'));
    assert.strictEqual(onDisk.plan, 'test mission');
  });

  await ext.deactivate();
  await new Promise((r) => setTimeout(r, 100));

  for (const a of assertions) {
    console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
  }
  try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ignore */ }

  const failed = assertions.filter((a) => !a.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${assertions.length} lifecycle-server check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${assertions.length} lifecycle-server checks`);
  process.exit(0);
})();
