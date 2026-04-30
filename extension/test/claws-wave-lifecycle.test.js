#!/usr/bin/env node
// claws/2 WaveRegistry lifecycle test. Activates the extension against a mocked vscode,
// connects peers, and asserts wave.create / wave.status / wave.complete behaviour
// plus MCP tool existence.
//
// RED phase: MCP tools (claws_wave_*) are unimplemented — those checks fail.
//            wave.* server commands are now implemented — those checks pass.
// GREEN phase: LEAD adds claws_wave_create/status/complete to mcp_server.js — all pass.
//
// Run: node extension/test/claws-wave-lifecycle.test.js
// Exits 0 on success, 1 on failure.

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { execSync } = require('child_process');

const EXT_ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(EXT_ROOT, 'dist', 'extension.js');
const REPO_ROOT = path.resolve(EXT_ROOT, '..');
const MCP_SERVER = path.join(REPO_ROOT, 'mcp_server.js');

if (!fs.existsSync(BUNDLE)) {
  console.error('FAIL: dist/extension.js not found. Run `npm run build` first.');
  process.exit(1);
}

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-wave-'));
const logs = [];

// ─── Mock vscode ──────────────────────────────────────────────────────────────
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

function connect() {
  const s = net.createConnection(sockPath);
  const responses = new Map();
  const pushes = [];
  let buf = '';
  s.on('data', (d) => {
    buf += d.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const f = JSON.parse(line);
        if (f.rid != null) responses.set(f.rid, f);
        else pushes.push(f);
      } catch { /* ignore */ }
    }
  });
  return { socket: s, responses, pushes };
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

async function hello(peer, id, role, name) {
  peer.socket.write(JSON.stringify({
    id, cmd: 'hello', protocol: 'claws/2', role, peerName: name,
  }) + '\n');
  await waitFor(() => peer.responses.has(id), 2000);
  const r = peer.responses.get(id);
  if (!r || !r.ok) throw new Error(`hello failed for ${name}: ${JSON.stringify(r)}`);
  return r.peerId;
}

(async () => {
  const ready = await waitFor(() => fs.existsSync(sockPath), 3000);
  check('socket ready', () => { if (!ready) throw new Error('no socket'); });

  // Establish: orchestrator (lead), worker (sub1), observer (sub2)
  const lead = connect();
  await new Promise((resolve) => lead.socket.on('connect', resolve));
  const leadId = await hello(lead, 1, 'orchestrator', 'wave-lead');

  const sub1 = connect();
  await new Promise((resolve) => sub1.socket.on('connect', resolve));
  const sub1Id = await hello(sub1, 2, 'worker', 'wave-sub1');

  const sub2 = connect();
  await new Promise((resolve) => sub2.socket.on('connect', resolve));
  await hello(sub2, 3, 'worker', 'wave-sub2');

  // ── 1. wave.create missing waveId → ok:false ─────────────────────────────
  lead.socket.write(JSON.stringify({
    id: 100, cmd: 'wave.create', manifest: ['tester'], layers: ['L1'],
  }) + '\n');
  await waitFor(() => lead.responses.has(100), 2000);
  check('wave.create missing waveId rejected', () => {
    const r = lead.responses.get(100);
    if (!r) throw new Error('no response');
    if (r.ok) throw new Error('expected ok:false — waveId is required');
    if (!/missing-waveId/.test(String(r.error || ''))) throw new Error(`wrong error: ${r.error}`);
  });

  // ── 2. wave.create missing manifest → ok:false ──────────────────────────
  lead.socket.write(JSON.stringify({
    id: 101, cmd: 'wave.create', waveId: 'wave-test-001', layers: ['L1'],
  }) + '\n');
  await waitFor(() => lead.responses.has(101), 2000);
  check('wave.create missing manifest rejected', () => {
    const r = lead.responses.get(101);
    if (!r) throw new Error('no response');
    if (r.ok) throw new Error('expected ok:false — manifest is required');
    if (!/missing-manifest/.test(String(r.error || ''))) throw new Error(`wrong error: ${r.error}`);
  });

  // ── 3. wave.create with valid params → ok:true, waveId matches ──────────
  lead.socket.write(JSON.stringify({
    id: 200, cmd: 'wave.create',
    waveId: 'wave-test-001',
    layers: ['L1-schemas', 'L2-handlers'],
    manifest: ['tester', 'reviewer'],
  }) + '\n');
  await waitFor(() => lead.responses.has(200), 2000);
  const createResp = lead.responses.get(200);
  check('wave.create valid returns ok:true with waveId and createdAt', () => {
    if (!createResp || !createResp.ok) throw new Error(`wave.create failed: ${JSON.stringify(createResp)}`);
    if (createResp.waveId !== 'wave-test-001') throw new Error(`waveId mismatch: ${createResp.waveId}`);
    if (typeof createResp.createdAt !== 'number') throw new Error('createdAt must be a number');
  });
  const waveId = 'wave-test-001';

  // ── 4. wave.create idempotent — same waveId returns same record ──────────
  lead.socket.write(JSON.stringify({
    id: 201, cmd: 'wave.create',
    waveId,
    layers: ['different-layers'],
    manifest: ['tester'],
  }) + '\n');
  await waitFor(() => lead.responses.has(201), 2000);
  check('wave.create idempotent — second call with same waveId returns same record', () => {
    const r = lead.responses.get(201);
    if (!r || !r.ok) throw new Error(`wave.create idempotent failed: ${JSON.stringify(r)}`);
    if (r.createdAt !== createResp.createdAt) throw new Error('createdAt changed on idempotent call — wave was overwritten');
  });

  // ── 5. wave.status returns correct flat shape ────────────────────────────
  lead.socket.write(JSON.stringify({ id: 300, cmd: 'wave.status', waveId }) + '\n');
  await waitFor(() => lead.responses.has(300), 2000);
  const statusResp = lead.responses.get(300);
  check('wave.status returns flat shape: waveId, layers, leadPeerId, subWorkers, complete=false', () => {
    if (!statusResp || !statusResp.ok) throw new Error(`wave.status failed: ${JSON.stringify(statusResp)}`);
    if (statusResp.waveId !== waveId) throw new Error(`waveId mismatch: ${statusResp.waveId}`);
    if (!Array.isArray(statusResp.layers)) throw new Error('layers must be an array');
    if (statusResp.leadPeerId !== leadId) throw new Error(`leadPeerId wrong: ${statusResp.leadPeerId}`);
    if (!Array.isArray(statusResp.subWorkers)) throw new Error('subWorkers must be an array');
    if (statusResp.complete !== false) throw new Error(`expected complete=false, got ${statusResp.complete}`);
    if (typeof statusResp.createdAt !== 'number') throw new Error('createdAt must be a number');
  });

  // ── 6. wave.status subWorkers matches manifest roles ─────────────────────
  check('wave.status subWorkers match manifest roles [tester, reviewer]', () => {
    if (!statusResp || !statusResp.ok) throw new Error(`wave.status failed: ${JSON.stringify(statusResp)}`);
    const roles = statusResp.subWorkers.map((sw) => sw.role).sort();
    if (JSON.stringify(roles) !== JSON.stringify(['reviewer', 'tester'])) {
      throw new Error(`subWorker roles mismatch: ${JSON.stringify(roles)}`);
    }
    for (const sw of statusResp.subWorkers) {
      if (typeof sw.lastHeartbeatMs !== 'number') throw new Error(`${sw.role}: lastHeartbeatMs missing`);
      if (sw.complete !== false) throw new Error(`${sw.role}: expected complete=false`);
    }
  });

  // ── 7. wave.status with unknown waveId → ok:false ────────────────────────
  lead.socket.write(JSON.stringify({ id: 400, cmd: 'wave.status', waveId: 'wave-nonexistent' }) + '\n');
  await waitFor(() => lead.responses.has(400), 2000);
  check('wave.status with unknown waveId rejected (not-found)', () => {
    const r = lead.responses.get(400);
    if (!r) throw new Error('no response');
    if (r.ok) throw new Error('expected ok:false for unknown waveId');
    if (!/not-found/.test(String(r.error || ''))) throw new Error(`wrong error: ${r.error}`);
  });

  // ── 8. wave.complete from non-creator peer → ok:false (not-lead) ─────────
  sub1.socket.write(JSON.stringify({
    id: 500, cmd: 'wave.complete', waveId, summary: 'sub1 should not be able to complete this',
  }) + '\n');
  await waitFor(() => sub1.responses.has(500), 2000);
  check('wave.complete from non-creator peer rejected (not-lead)', () => {
    const r = sub1.responses.get(500);
    if (!r) throw new Error('no response');
    if (r.ok) throw new Error('expected ok:false — only LEAD may complete a wave');
    if (!/not-lead/.test(String(r.error || ''))) throw new Error(`wrong error: ${r.error}`);
  });

  // ── 9. wave.complete from creator → ok:true + completedAt ────────────────
  lead.socket.write(JSON.stringify({
    id: 600, cmd: 'wave.complete', waveId,
    summary: 'wave-test-001 complete — all checks passed',
    commits: ['abc123'],
    regressionClean: true,
  }) + '\n');
  await waitFor(() => lead.responses.has(600), 2000);
  check('wave.complete from LEAD creator returns ok:true with completedAt', () => {
    const r = lead.responses.get(600);
    if (!r || !r.ok) throw new Error(`wave.complete failed: ${JSON.stringify(r)}`);
    if (r.waveId !== waveId) throw new Error(`waveId mismatch: ${r.waveId}`);
    if (typeof r.completedAt !== 'number') throw new Error('completedAt must be a number');
  });

  // ── 10. wave.status after complete shows complete=true ────────────────────
  lead.socket.write(JSON.stringify({ id: 601, cmd: 'wave.status', waveId }) + '\n');
  await waitFor(() => lead.responses.has(601), 2000);
  check('wave.status after complete shows complete=true and completedAt set', () => {
    const r = lead.responses.get(601);
    if (!r || !r.ok) throw new Error(`wave.status post-complete failed: ${JSON.stringify(r)}`);
    if (r.complete !== true) throw new Error(`expected complete=true, got ${r.complete}`);
    if (typeof r.completedAt !== 'number') throw new Error('completedAt missing after complete');
    if (r.summary !== 'wave-test-001 complete — all checks passed') throw new Error('summary missing or wrong');
    if (r.regressionClean !== true) throw new Error('regressionClean not set');
  });

  // ── 11. wave.complete already-complete → ok:false (idempotent guard) ──────
  lead.socket.write(JSON.stringify({
    id: 700, cmd: 'wave.complete', waveId, summary: 'duplicate',
  }) + '\n');
  await waitFor(() => lead.responses.has(700), 2000);
  check('wave.complete on already-complete wave returns ok:false (already-complete)', () => {
    const r = lead.responses.get(700);
    if (!r) throw new Error('no response');
    if (r.ok) throw new Error('expected ok:false — wave already complete');
    if (!/already-complete/.test(String(r.error || ''))) throw new Error(`wrong error: ${r.error}`);
  });

  lead.socket.destroy();
  sub1.socket.destroy();
  sub2.socket.destroy();

  // ── 12–14. MCP tool smoke tests — RED until LEAD adds claws_wave_* ────────
  // These assert the three wave tools exist in the MCP server's tools/list.
  // They will be RED until mcp_server.js is updated with wave tool definitions.
  function getMcpTools() {
    const input = [
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
    ].join('\n') + '\n';
    const out = execSync(`printf '%s' '${input.replace(/'/g, "'\\''")}' | node "${MCP_SERVER}"`, {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, CLAWS_SOCKET: '/tmp/claws-wave-test-nonexistent.sock' },
    });
    const lines = out.trim().split('\n').filter((l) => l.startsWith('{'));
    const toolsResp = lines.find((l) => { try { return JSON.parse(l).id === 2; } catch { return false; } });
    if (!toolsResp) throw new Error('no tools/list response from mcp_server');
    return JSON.parse(toolsResp).result.tools;
  }

  check('claws_wave_create MCP tool exists in tools/list', () => {
    const tools = getMcpTools();
    if (!Array.isArray(tools)) throw new Error('tools is not an array');
    if (!tools.find((t) => t.name === 'claws_wave_create')) throw new Error('claws_wave_create not found in MCP tools');
  });

  check('claws_wave_status MCP tool exists in tools/list', () => {
    const tools = getMcpTools();
    if (!tools.find((t) => t.name === 'claws_wave_status')) throw new Error('claws_wave_status not found in MCP tools');
  });

  check('claws_wave_complete MCP tool exists in tools/list', () => {
    const tools = getMcpTools();
    if (!tools.find((t) => t.name === 'claws_wave_complete')) throw new Error('claws_wave_complete not found in MCP tools');
  });

  await ext.deactivate();
  await new Promise((r) => setTimeout(r, 100));

  for (const a of assertions) {
    console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
  }
  try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = assertions.filter((a) => !a.ok);
  if (failed.length > 0) { console.error(`\nFAIL: ${failed.length}/${assertions.length} check(s) failed.`); process.exit(1); }
  console.log(`\nPASS: ${assertions.length} checks`);
  process.exit(0);
})();
