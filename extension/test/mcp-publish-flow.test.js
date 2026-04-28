#!/usr/bin/env node
// Integration test: mcp_server.js persistent-socket hello → publish flow.
//
// Boots a Claws server in-process, spawns mcp_server.js as a child process,
// exercises the stateful hello → publish path via the MCP JSON-RPC protocol,
// and asserts that:
//   1. claws_hello returns a peerId on the persistent socket
//   2. claws_publish returns ok:true (deliveredTo) without "call hello first"
//   3. The event record lands in the on-disk event log
//
// This test specifically guards against the per-call socket churn bug (issue 09)
// where each MCP tool call opened a fresh socket, destroying the peer state set
// by hello so that the immediately following publish returned an error.
//
// Run: node extension/test/mcp-publish-flow.test.js
// Exits 0 on success, 1 on failure.

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const EXT_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(EXT_ROOT, '..');
const MCP_SERVER = path.join(REPO_ROOT, 'mcp_server.js');
const BUNDLE = path.join(EXT_ROOT, 'dist', 'extension.js');

if (!fs.existsSync(BUNDLE)) {
  console.error('FAIL: dist/extension.js not found. Run `npm run build` first.');
  process.exit(1);
}

if (!fs.existsSync(MCP_SERVER)) {
  console.error(`FAIL: mcp_server.js not found at ${MCP_SERVER}`);
  process.exit(1);
}

// ─── Mock vscode ─────────────────────────────────────────────────────────────

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-mcp-pub-'));
const logs = [];

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

// ─── MCP child session ────────────────────────────────────────────────────────

class McpSession {
  constructor(child) {
    this.child = child;
    this.pending = new Map(); // msgId → { resolve, reject }
    this.buf = '';
    this.nextId = 1;

    child.stdout.on('data', (d) => {
      this.buf += d.toString('utf8');
      let nl;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && this.pending.has(msg.id)) {
            const { resolve } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            resolve(msg);
          }
        } catch { /* ignore malformed frames */ }
      }
    });
  }

  send(method, params, timeoutMs = 10000) {
    const id = this.nextId++;
    const frame = { jsonrpc: '2.0', id, method };
    if (params !== undefined) frame.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP timeout for ${method} id=${id}`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
        reject,
      });
      this.child.stdin.write(JSON.stringify(frame) + '\n');
    });
  }

  callTool(name, args, timeoutMs) {
    return this.send('tools/call', { name, arguments: args || {} }, timeoutMs);
  }

  close() {
    try { this.child.stdin.end(); } catch { /* ignore */ }
    setTimeout(() => { try { this.child.kill(); } catch { /* ignore */ } }, 200);
  }
}

// ─── Test body ────────────────────────────────────────────────────────────────

(async () => {
  const ready = await waitFor(() => fs.existsSync(sockPath), 3000);
  check('socket ready', () => { if (!ready) throw new Error('server socket never appeared'); });
  if (!ready) {
    console.error('FAIL: Claws server socket never appeared');
    process.exit(1);
  }

  // Spawn mcp_server.js with CLAWS_SOCKET pointing at our in-process server.
  const child = spawn(process.execPath, [MCP_SERVER], {
    env: { ...process.env, CLAWS_SOCKET: sockPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {}); // suppress child stderr in test output

  const mcp = new McpSession(child);

  // 1. MCP initialize handshake
  const initResp = await mcp.send('initialize', {
    protocolVersion: '2024-11-05',
    clientInfo: { name: 'mcp-publish-flow-test', version: '0.0.1' },
    capabilities: {},
  });
  check('initialize handshake succeeds', () => {
    if (!initResp.result) throw new Error(`no result: ${JSON.stringify(initResp)}`);
    if (initResp.result.serverInfo.name !== 'claws') {
      throw new Error(`wrong serverInfo.name: ${initResp.result.serverInfo.name}`);
    }
  });

  // 2. claws_hello — registers identity on the persistent socket
  const helloResp = await mcp.callTool('claws_hello', { role: 'worker', peerName: 'mcp-pub-test-peer' });
  let peerId = null;
  check('claws_hello returns peerId via MCP', () => {
    if (!helloResp.result) throw new Error(`no result: ${JSON.stringify(helloResp)}`);
    if (helloResp.result.isError) {
      throw new Error(`hello returned error: ${helloResp.result.content[0].text}`);
    }
    const data = JSON.parse(helloResp.result.content[0].text);
    if (!data.peerId || !data.peerId.startsWith('p_')) {
      throw new Error(`unexpected peerId: ${JSON.stringify(data)}`);
    }
    peerId = data.peerId;
  });

  // 3. claws_publish — must succeed on the SAME persistent socket (not a new one)
  //    Without the fix, the server returns "call hello first" because publish opens
  //    a fresh socket that has no registered peer.
  const pubResp = await mcp.callTool('claws_publish', {
    topic: 'worker.mcp.test.publish',
    payload: { peerId, msg: 'persistent socket publish' },
  });
  check('claws_publish succeeds on persistent socket (not "call hello first")', () => {
    if (!pubResp.result) throw new Error(`no result: ${JSON.stringify(pubResp)}`);
    if (pubResp.result.isError) {
      const text = pubResp.result.content[0].text;
      throw new Error(`publish returned error: ${text}`);
    }
    const data = JSON.parse(pubResp.result.content[0].text);
    if (typeof data.deliveredTo !== 'number') {
      throw new Error(`deliveredTo missing: ${JSON.stringify(data)}`);
    }
  });

  // 4. Disk record — event log must contain the published event
  // The event log writes synchronously on each append; a short wait ensures
  // the async append queue has flushed.
  await new Promise((r) => setTimeout(r, 300));
  const eventDir = path.join(workspaceRoot, '.claws', 'events', 'default');
  check('event log record landed on disk for worker.mcp.test.publish', () => {
    if (!fs.existsSync(eventDir)) throw new Error(`event dir missing: ${eventDir}`);
    const files = fs.readdirSync(eventDir).filter((f) => f.endsWith('.jsonl'));
    if (!files.length) throw new Error('no JSONL segment files in event log directory');
    let found = false;
    for (const file of files) {
      const raw = fs.readFileSync(path.join(eventDir, file), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (rec.topic === 'worker.mcp.test.publish') { found = true; break; }
        } catch { /* ignore */ }
      }
      if (found) break;
    }
    if (!found) throw new Error('publish event not found in event log (topic: worker.mcp.test.publish)');
  });

  mcp.close();
  await ext.deactivate();
  await new Promise((r) => setTimeout(r, 200));

  for (const a of assertions) {
    console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
  }
  try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = assertions.filter((a) => !a.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${assertions.length} mcp-publish-flow check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${assertions.length} mcp-publish-flow checks`);
  process.exit(0);
})();
