#!/usr/bin/env node
// Tests for claws-sdk.js CLI + module API (§3.2.1).
// Run: node extension/test/sdk-cli.test.js
// Exits 0 on success, 1 on failure.

const assert  = require('assert');
const Module  = require('module');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const net     = require('net');
const { spawnSync } = require('child_process');

const EXT_ROOT  = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(EXT_ROOT, '..');
const SDK       = path.join(REPO_ROOT, 'claws-sdk.js');
const BUNDLE    = path.join(EXT_ROOT, 'dist', 'extension.js');

if (!fs.existsSync(BUNDLE)) {
  console.error('FAIL: dist/extension.js not found. Run `npm run build` first.');
  process.exit(1);
}

if (!fs.existsSync(SDK)) {
  console.error(`FAIL: claws-sdk.js not found at ${SDK}`);
  process.exit(1);
}

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-sdk-test-'));
const logs = [];

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => { const i = this.listeners.indexOf(listener); if (i >= 0) this.listeners.splice(i, 1); } };
    };
  }
  fire(arg) { for (const l of this.listeners.slice()) l(arg); }
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
    getConfiguration: () => ({ get: (_k, fb) => fb }),
  },
  window: {
    terminals: [],
    activeTerminal: undefined,
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
  commands: { registerCommand: () => ({ dispose: () => {} }), executeCommand: () => Promise.resolve() },
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

async function waitFor(fn, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
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

(async () => {
  // ── 1. Static CLI checks ────────────────────────────────────────────────────

  check('--help exits 0 and prints claws-sdk', () => {
    const r = spawnSync(process.execPath, [SDK, '--help'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `--help exited ${r.status}: ${r.stderr}`);
    assert.ok(r.stdout.includes('claws-sdk'), `--help missing "claws-sdk": ${r.stdout.slice(0, 200)}`);
  });

  check('--version prints semver string', () => {
    const r = spawnSync(process.execPath, [SDK, '--version'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `--version exited ${r.status}`);
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/, `unexpected version: "${r.stdout.trim()}"`);
  });

  check('publish without CLAWS_PEER_ID exits non-zero with clear error', () => {
    const env = { ...process.env };
    delete env.CLAWS_PEER_ID;
    const r = spawnSync(process.execPath, [SDK, 'publish', 'boot', '--mission', 'test'], {
      encoding: 'utf8',
      env: { ...env, CLAWS_SOCKET: '/tmp/claws-sdk-nonexistent.sock' },
    });
    assert.notStrictEqual(r.status, 0, 'should exit non-zero');
    assert.ok(r.stderr.includes('CLAWS_PEER_ID'), `stderr missing CLAWS_PEER_ID: ${r.stderr.slice(0, 200)}`);
  });

  check('ClawsSDK module exports expected symbols', () => {
    const mod = require(SDK);
    assert.ok(typeof mod.ClawsSDK === 'function', 'ClawsSDK class missing');
    assert.ok(typeof mod.buildEnvelope === 'function', 'buildEnvelope missing');
    assert.ok(typeof mod.findSocket === 'function', 'findSocket missing');
    assert.ok(typeof mod.VERSION === 'string', 'VERSION missing');
    const sdk = new mod.ClawsSDK({});
    assert.ok(typeof sdk.connect === 'function', 'connect method missing');
    assert.ok(typeof sdk.publishBoot === 'function', 'publishBoot method missing');
    assert.ok(typeof sdk.publishPhase === 'function', 'publishPhase method missing');
    assert.ok(typeof sdk.publishHeartbeat === 'function', 'publishHeartbeat method missing');
    assert.ok(typeof sdk.publishComplete === 'function', 'publishComplete method missing');
  });

  // ── 2. Integration: live server ─────────────────────────────────────────────

  const ready = await waitFor(() => fs.existsSync(sockPath), 3000);
  check('socket ready', () => { if (!ready) throw new Error('no socket'); });
  if (!ready) { console.error('FAIL: socket never appeared'); process.exit(1); }

  // Prime lifecycle so the server accepts connections
  await new Promise((resolve, reject) => {
    const s = net.createConnection(sockPath);
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.indexOf('\n') !== -1) { s.destroy(); resolve(); }
    });
    s.on('error', reject);
    s.on('connect', () => s.write(JSON.stringify({ id: 1, cmd: 'lifecycle.plan', plan: 'sdk test session' }) + '\n'));
  });

  await check('publishBoot via ClawsSDK module returns ok', async () => {
    const { ClawsSDK } = require(SDK);
    const sdk = new ClawsSDK({ socketPath: sockPath, peerName: 'sdk-test-worker' });
    await sdk.connect();
    await sdk.hello('worker');
    const r = await sdk.publishBoot({ missionSummary: 'integration test boot', role: 'worker', capabilities: ['test'] });
    sdk.close();
    assert.ok(r.ok, `publishBoot returned not-ok: ${JSON.stringify(r)}`);
  });

  await check('publishPhase via ClawsSDK module returns ok', async () => {
    const { ClawsSDK } = require(SDK);
    const sdk = new ClawsSDK({ socketPath: sockPath, peerName: 'sdk-test-worker-2' });
    await sdk.connect();
    await sdk.hello('worker');
    const r = await sdk.publishPhase({ phase: 'PLAN', prev: null, reason: 'sdk test' });
    sdk.close();
    assert.ok(r.ok, `publishPhase returned not-ok: ${JSON.stringify(r)}`);
  });

  await ext.deactivate();
  await new Promise((r) => setTimeout(r, 100));
  try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ignore */ }

  for (const a of assertions) {
    console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
  }
  const failed = assertions.filter((a) => !a.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${assertions.length} sdk-cli check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${assertions.length} sdk-cli checks`);
  process.exit(0);
})();
