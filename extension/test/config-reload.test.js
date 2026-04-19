#!/usr/bin/env node
// Config hot-reload test — activates the extension against a mocked vscode,
// fires an onDidChangeConfiguration event for claws.maxCaptureBytes with a
// new value, and asserts the extension reacted (log line + no throw).
//
// Run: node extension/test/config-reload.test.js
// Exits 0 on success, 1 on failure.

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

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-config-'));
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

// Mutable config store the mock reads from. Test updates it before firing
// onDidChangeConfiguration so cfg() reads the new value.
const configValues = {
  'maxCaptureBytes': 1024 * 1024,
  'socketPath': '.claws/claws.sock',
  'maxOutputBytes': 262144,
  'maxHistory': 500,
};

const onOpen = new EventEmitter();
const onClose = new EventEmitter();
const onConfig = new EventEmitter();
const onFolders = new EventEmitter();

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
      get: (key, fallback) => configValues[key] ?? fallback,
    }),
    onDidChangeConfiguration: onConfig.event,
    onDidChangeWorkspaceFolders: onFolders.event,
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
    showErrorMessage: () => ({ then: () => {} }),
    showInformationMessage: () => ({ then: () => {} }),
    showWarningMessage: () => ({ then: () => {} }),
    showQuickPick: () => Promise.resolve(undefined),
  },
  commands: {
    registerCommand: (_name, _cb) => ({ dispose: () => {} }),
    executeCommand: () => {},
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

const assertions = [];
function check(name, fn) {
  try { fn(); assertions.push({ name, ok: true }); }
  catch (e) { assertions.push({ name, ok: false, err: e.message || String(e) }); }
}

check('extension activated (log signature present)', () => {
  const hasSig = logs.some((l) => l.includes('(typescript)') || l.includes('activation complete'));
  if (!hasSig) throw new Error(`logs: ${JSON.stringify(logs)}`);
});

check('config listener was registered', () => {
  if (onConfig.listeners.length === 0) throw new Error('no config listeners registered');
});

// Fire onDidChangeConfiguration for maxCaptureBytes with a new value.
const logsBefore = logs.length;
configValues['maxCaptureBytes'] = 2 * 1024 * 1024;
onConfig.fire({
  affectsConfiguration: (key) => key === 'claws.maxCaptureBytes',
});

check('maxCaptureBytes change produced a log line', () => {
  const updated = logs.slice(logsBefore).some((l) => /maxCaptureBytes updated: 2097152/.test(l));
  if (!updated) throw new Error(`no update log; new logs: ${JSON.stringify(logs.slice(logsBefore))}`);
});

// Fire onDidChangeConfiguration for socketPath — should produce info message call.
const logsBefore2 = logs.length;
configValues['socketPath'] = '.claws/custom.sock';
onConfig.fire({
  affectsConfiguration: (key) => key === 'claws.socketPath',
});

check('socketPath change produced reload-prompt log line', () => {
  const updated = logs.slice(logsBefore2).some((l) => /socketPath change detected/.test(l));
  if (!updated) throw new Error(`no socketPath log; new logs: ${JSON.stringify(logs.slice(logsBefore2))}`);
});

(async () => {
  await ext.deactivate();

for (const a of assertions) {
  console.log(`${a.ok ? '  ✓' : '  ✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
}
try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ignore */ }

const failed = assertions.filter((a) => !a.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${assertions.length} check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS: ${assertions.length} checks`);
process.exit(0);
})();
