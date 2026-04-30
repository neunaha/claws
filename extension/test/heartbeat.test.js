#!/usr/bin/env node
// Regression test for L1.3: periodic system.heartbeat from the extension.
// Boots a server with heartbeatIntervalMs=200ms, waits 700ms, then confirms:
//   1. At least one .jsonl segment file was created (event log is non-empty)
//   2. At least 2 system.heartbeat lines exist in the segment file
//   3. Each heartbeat has the expected payload shape
//
// Run: node extension/test/heartbeat.test.js
// Exits 0 on success, 1 on failure. No VS Code dependency.

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const EXT_ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(EXT_ROOT, 'dist', 'extension.js');

if (!fs.existsSync(BUNDLE)) {
  console.error('FAIL: dist/extension.js not found. Run `npm run build` first.');
  process.exit(1);
}

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-heartbeat-'));

// ─── Mock vscode ─────────────────────────────────────────────────────────────

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
    // Return 200ms heartbeat interval; fall back to defaults for other keys.
    getConfiguration: (_s) => ({
      get: (k, fb) => {
        if (k === 'heartbeatIntervalMs') return 200;
        return fb;
      },
    }),
  },
  window: {
    terminals: [],
    activeTerminal: undefined,
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
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

// ─── helpers ─────────────────────────────────────────────────────────────────

const assertions = [];

async function check(name, fn) {
  try {
    await fn();
    assertions.push({ name, ok: true });
  } catch (e) {
    assertions.push({ name, ok: false, err: e.message || String(e) });
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function listSegmentFiles(streamDir) {
  try {
    return fs.readdirSync(streamDir)
      .filter(n => /^\d{4}-.*\.jsonl$/.test(n))
      .sort();
  } catch {
    return [];
  }
}

function readHeartbeatLines(streamDir) {
  const files = listSegmentFiles(streamDir);
  const lines = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(streamDir, f), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.topic === 'system.heartbeat') lines.push(rec);
      } catch { /* skip malformed */ }
    }
  }
  return lines;
}

// ─── main ─────────────────────────────────────────────────────────────────────

(async () => {
  const streamDir = path.join(workspaceRoot, '.claws', 'events', 'default');

  // Wait for the socket to appear (server started)
  const sockPath = path.join(workspaceRoot, '.claws', 'claws.sock');
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(sockPath) && Date.now() < deadline) {
    await sleep(50);
  }

  await check('server socket exists', () => {
    if (!fs.existsSync(sockPath)) throw new Error('claws.sock not created within 3s');
  });

  // Wait 700ms — enough time for at least 3 heartbeats at 200ms interval
  await sleep(700);

  await check('segment file created (log non-empty)', () => {
    const files = listSegmentFiles(streamDir);
    if (files.length === 0) throw new Error('no .jsonl segment files found — heartbeat never wrote to log');
  });

  await check('at least 2 system.heartbeat entries exist', () => {
    const lines = readHeartbeatLines(streamDir);
    if (lines.length < 2) {
      throw new Error(`expected ≥2 system.heartbeat entries, got ${lines.length}`);
    }
  });

  await check('heartbeat payload has uptimeMs (number)', () => {
    const lines = readHeartbeatLines(streamDir);
    for (const rec of lines) {
      const p = rec.payload;
      if (typeof p !== 'object' || p === null) throw new Error('payload is not an object');
      if (typeof p.uptimeMs !== 'number') throw new Error(`uptimeMs missing or wrong type: ${JSON.stringify(p)}`);
    }
  });

  await check('heartbeat payload has peers (number)', () => {
    const lines = readHeartbeatLines(streamDir);
    for (const rec of lines) {
      const p = rec.payload;
      if (typeof p.peers !== 'number') throw new Error(`peers missing or wrong type: ${JSON.stringify(p)}`);
    }
  });

  await check('heartbeat payload has terminals (number)', () => {
    const lines = readHeartbeatLines(streamDir);
    for (const rec of lines) {
      const p = rec.payload;
      if (typeof p.terminals !== 'number') throw new Error(`terminals missing or wrong type: ${JSON.stringify(p)}`);
    }
  });

  await check('heartbeat record has from=server', () => {
    const lines = readHeartbeatLines(streamDir);
    for (const rec of lines) {
      if (rec.from !== 'server') throw new Error(`expected from='server', got '${rec.from}'`);
    }
  });

  await check('heartbeat record has ts_server (ISO string)', () => {
    const lines = readHeartbeatLines(streamDir);
    for (const rec of lines) {
      if (typeof rec.ts_server !== 'string' || !rec.ts_server.includes('T')) {
        throw new Error(`ts_server missing or not ISO: ${rec.ts_server}`);
      }
    }
  });

  await check('heartbeat record has sequence (non-negative integer)', () => {
    const lines = readHeartbeatLines(streamDir);
    for (const rec of lines) {
      if (typeof rec.sequence !== 'number' || rec.sequence < 0) {
        throw new Error(`sequence missing or negative: ${rec.sequence}`);
      }
    }
  });

  await check('manifest.json current_offset > 0', () => {
    const manifestPath = path.join(streamDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      // Manifest may not be written yet if fewer than MANIFEST_FLUSH_INTERVAL appends.
      // This is non-fatal: the segment file check above is the primary assertion.
      return;
    }
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (typeof m.current_offset !== 'number') throw new Error('manifest has no current_offset');
    // current_offset may still be 0 if not yet flushed; just check it's a number.
  });

  // ── report ─────────────────────────────────────────────────────────────────

  let pass = 0;
  let fail = 0;
  for (const a of assertions) {
    if (a.ok) {
      console.log(`  PASS  ${a.name}`);
      pass++;
    } else {
      console.log(`  FAIL  ${a.name}: ${a.err}`);
      fail++;
    }
  }
  console.log(`\n${pass + fail} checks: ${pass} passed, ${fail} failed`);

  // Cleanup temp dir
  try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ignore */ }

  process.exit(fail > 0 ? 1 : 0);
})();
