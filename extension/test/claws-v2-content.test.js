#!/usr/bin/env node
// L5/L6 content detection + command event taxonomy — integration tests.
// Verifies vehicle.<id>.content push frames on foreground-process change,
// and command.<id>.start / command.<id>.end events on exec.
//
// Run: node extension/test/claws-v2-content.test.js
// Exits 0 on success, 1 on failure.

const assert = require('assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawnSync } = require('child_process');

const EXT_ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(EXT_ROOT, 'dist', 'extension.js');

if (!fs.existsSync(BUNDLE)) {
  console.error('FAIL: dist/extension.js not found. Run `npm run build` first.');
  process.exit(1);
}

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-content-'));
const logs = [];

// ─── vscode mock ─────────────────────────────────────────────────────────────

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
const createdTerminals = [];

const vscode = {
  EventEmitter, TerminalProfile, MarkdownString, ThemeColor,
  StatusBarAlignment: { Left: 1, Right: 2 },
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file', path: p }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
    getConfiguration: (_s) => ({ get: (_k, fb) => fb }),
    onDidChangeConfiguration: (_cb) => ({ dispose: () => {} }),
  },
  window: {
    terminals: [],
    activeTerminal: undefined,
    createOutputChannel: () => ({ appendLine: (m) => logs.push(m), show: () => {}, dispose: () => {} }),
    createStatusBarItem: () => ({
      text: '', tooltip: '', color: undefined, command: '', name: '',
      show: () => {}, hide: () => {}, dispose: () => {},
    }),
    createTerminal: (opts) => {
      const t = {
        name: (opts && opts.name) || 'mock',
        processId: Promise.resolve(12345),
        shellIntegration: undefined,
        show: () => {},
        sendText: () => {},
        dispose: () => { onClose.fire(t); },
      };
      createdTerminals.push(t);
      vscode.window.terminals.push(t);
      if (opts && opts.pty && typeof opts.pty.open === 'function') {
        setTimeout(() => opts.pty.open({ columns: 80, rows: 24 }), 20);
      }
      return t;
    },
    onDidOpenTerminal: onOpen.event,
    onDidCloseTerminal: onClose.event,
    registerTerminalProfileProvider: () => ({ dispose: () => {} }),
    activeColorTheme: { kind: 2 },
  },
  commands: { registerCommand: () => ({ dispose: () => {} }) },
  extensions: { getExtension: () => undefined },
};

Module._resolveFilename = ((orig) => (req, parent, isMain, opts) => {
  if (req === 'vscode') return '__vscode__';
  return orig(req, parent, isMain, opts);
})(Module._resolveFilename);
Module._cache['__vscode__'] = { id: '__vscode__', filename: '__vscode__', loaded: true, exports: vscode };

const ext = require(BUNDLE);
ext.activate({ subscriptions: [], extensionPath: EXT_ROOT, extension: { packageJSON: { version: '0.7.5' } } });

const sockPath = path.join(workspaceRoot, '.claws', 'claws.sock');

// ─── helpers ─────────────────────────────────────────────────────────────────

async function waitFor(fn, timeoutMs = 5000) {
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
        try { resolve(JSON.parse(buf.slice(0, idx))); } catch (e) { reject(e); }
        s.destroy();
      }
    });
    s.on('error', reject);
    s.on('connect', () => s.write(JSON.stringify({ id: 1, ...payload }) + '\n'));
  });
}

function openSubscription(topic) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const s = net.createConnection(sockPath);
    let buf = '';
    let resolved = false;
    s.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (!resolved && msg.ok === true && msg.subscriptionId) {
          resolved = true;
          resolve({ frames, socket: s, subscriptionId: msg.subscriptionId });
        } else if (msg.push === 'message') {
          frames.push(msg);
        }
      }
    });
    s.on('error', reject);
    s.on('connect', () => {
      s.write(JSON.stringify({ id: 1, cmd: 'hello', protocol: 'claws/2', role: 'observer', peerName: 'content-test-observer' }) + '\n');
      setTimeout(() => {
        s.write(JSON.stringify({ id: 2, cmd: 'subscribe', protocol: 'claws/2', topic }) + '\n');
      }, 50);
    });
    setTimeout(() => { if (!resolved) reject(new Error('subscription timeout')); }, 3000);
  });
}

// Check if python3 is available on this system
function hasPython3() {
  try {
    const r = spawnSync('which', ['python3'], { encoding: 'utf8', timeout: 1000 });
    return r.status === 0 && r.stdout.trim().length > 0;
  } catch { return false; }
}

// Check if vim is available on this system
function hasVim() {
  try {
    const r = spawnSync('which', ['vim'], { encoding: 'utf8', timeout: 1000 });
    return r.status === 0 && r.stdout.trim().length > 0;
  } catch { return false; }
}

// ─── test runner ─────────────────────────────────────────────────────────────

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message || String(e) });
    console.log(`  FAIL  ${name}: ${e.message || e}`);
  }
}

function skipCheck(name, reason) {
  results.push({ name, ok: true, skipped: true });
  console.log(`  SKIP  ${name} (${reason})`);
}

// ─── tests ───────────────────────────────────────────────────────────────────

(async () => {
  const ready = await waitFor(() => fs.existsSync(sockPath), 4000);
  await check('socket is ready', () => {
    if (!ready) throw new Error('socket never appeared');
  });
  if (!ready) { console.error('FAIL: no socket'); process.exit(1); }

  await check('lifecycle.plan succeeds', async () => {
    const r = await rpc({ cmd: 'lifecycle.plan', plan: 'L5/L6 content detection test' });
    assert.strictEqual(r.ok, true, `expected ok:true got: ${JSON.stringify(r)}`);
  });

  // ── vehicle.*.content subscription ────────────────────────────────────────

  let contentSub;
  await check('subscribe to vehicle.**.content returns subscriptionId', async () => {
    contentSub = await openSubscription('vehicle.**.content');
    assert.ok(contentSub.subscriptionId, 'expected subscriptionId');
    assert.match(contentSub.subscriptionId, /^s_/, 'subscriptionId should start with s_');
  });

  if (!contentSub) { console.error('FAIL: content subscription failed'); process.exit(1); }

  // ── command.** subscription ───────────────────────────────────────────────

  let cmdSub;
  await check('subscribe to command.** returns subscriptionId', async () => {
    cmdSub = await openSubscription('command.**');
    assert.ok(cmdSub.subscriptionId, 'expected subscriptionId');
  });

  if (!cmdSub) { console.error('FAIL: command subscription failed'); process.exit(1); }

  // ── create wrapped terminal ───────────────────────────────────────────────

  let terminalId;
  await check('create wrapped=true returns ok:true with id', async () => {
    const r = await rpc({ cmd: 'create', wrapped: true, name: 'content-detection-test' });
    assert.strictEqual(r.ok, true, `create failed: ${JSON.stringify(r)}`);
    assert.ok(r.id, 'expected id in create response');
    terminalId = String(r.id);
  });

  if (!terminalId) { console.error('FAIL: no terminal id'); process.exit(1); }

  // ── vehicle.N.content — initial shell detection ───────────────────────────

  await check('vehicle.N.content push frame emitted on initial detection', async () => {
    // Content detection polls every 2s; wait up to 6s for the first event.
    const ok = await waitFor(
      () => contentSub.frames.some(f => f.topic === `vehicle.${terminalId}.content`),
      6000
    );
    if (!ok) {
      throw new Error(
        `No vehicle.${terminalId}.content frame received within 6s. ` +
        `Frames: ${JSON.stringify(contentSub.frames.map(f => f.topic))}`
      );
    }
  });

  await check('vehicle.N.content payload has contentType field', async () => {
    const frame = contentSub.frames.find(f => f.topic === `vehicle.${terminalId}.content`);
    assert.ok(frame, 'no content frame found');
    assert.ok(typeof frame.payload.contentType === 'string', `contentType must be a string, got: ${JSON.stringify(frame.payload)}`);
  });

  await check('vehicle.N.content payload has terminalId field', async () => {
    const frame = contentSub.frames.find(f => f.topic === `vehicle.${terminalId}.content`);
    assert.ok(frame, 'no content frame found');
    assert.strictEqual(String(frame.payload.terminalId), terminalId);
  });

  await check('vehicle.N.content payload has detectedAt ISO timestamp', async () => {
    const frame = contentSub.frames.find(f => f.topic === `vehicle.${terminalId}.content`);
    assert.ok(frame, 'no content frame found');
    assert.ok(frame.payload.detectedAt, 'expected detectedAt field');
    assert.doesNotThrow(() => new Date(frame.payload.detectedAt), 'detectedAt must be parseable as date');
  });

  await check('vehicle.N.content payload has foregroundPid field (number or null)', async () => {
    const frame = contentSub.frames.find(f => f.topic === `vehicle.${terminalId}.content`);
    assert.ok(frame, 'no content frame found');
    assert.ok(
      frame.payload.foregroundPid === null || typeof frame.payload.foregroundPid === 'number',
      `foregroundPid must be null or number, got: ${typeof frame.payload.foregroundPid}`
    );
  });

  await check('vehicle.N.content initial contentType is "shell" for bash/zsh terminal', async () => {
    const frame = contentSub.frames.find(f => f.topic === `vehicle.${terminalId}.content`);
    assert.ok(frame, 'no content frame found');
    assert.strictEqual(
      frame.payload.contentType, 'shell',
      `expected contentType="shell" for initial shell spawn, got: "${frame.payload.contentType}"`
    );
  });

  await check('push frame has push="message" and correct topic structure', async () => {
    const frame = contentSub.frames.find(f => f.topic === `vehicle.${terminalId}.content`);
    assert.ok(frame, 'no content frame found');
    assert.strictEqual(frame.push, 'message');
    assert.match(frame.topic, /^vehicle\.\d+\.content$/);
  });

  // ── command events on exec ────────────────────────────────────────────────

  const testCommand = 'echo hello-from-claws-content-test';
  let execResp;
  await check('exec command returns ok:true', async () => {
    execResp = await rpc({ cmd: 'exec', id: terminalId, command: testCommand });
    assert.strictEqual(execResp.ok, true, `exec failed: ${JSON.stringify(execResp)}`);
  });

  await check('command.N.start push frame emitted on exec', async () => {
    const ok = await waitFor(
      () => cmdSub.frames.some(f =>
        f.topic === `command.${terminalId}.start` || f.topic.startsWith(`command.${terminalId}.`)
      ),
      2000
    );
    if (!ok) {
      throw new Error(
        `No command.${terminalId}.start frame received. ` +
        `Command frames: ${JSON.stringify(cmdSub.frames.map(f => f.topic))}`
      );
    }
  });

  await check('command.N.start payload has command field', async () => {
    const frame = cmdSub.frames.find(f => f.topic === `command.${terminalId}.start`);
    assert.ok(frame, `command.${terminalId}.start frame not found`);
    assert.strictEqual(frame.payload.command, testCommand);
  });

  await check('command.N.start payload has terminalId and startedAt', async () => {
    const frame = cmdSub.frames.find(f => f.topic === `command.${terminalId}.start`);
    assert.ok(frame, `command.${terminalId}.start frame not found`);
    assert.strictEqual(String(frame.payload.terminalId), terminalId);
    assert.ok(frame.payload.startedAt, 'expected startedAt field');
    assert.doesNotThrow(() => new Date(frame.payload.startedAt), 'startedAt must be parseable');
  });

  await check('command.N.end push frame emitted after exec completes', async () => {
    const ok = await waitFor(
      () => cmdSub.frames.some(f => f.topic === `command.${terminalId}.end`),
      2000
    );
    if (!ok) {
      throw new Error(
        `No command.${terminalId}.end frame received. ` +
        `Command frames: ${JSON.stringify(cmdSub.frames.map(f => f.topic))}`
      );
    }
  });

  await check('command.N.end payload has command and exitCode fields', async () => {
    const frame = cmdSub.frames.find(f => f.topic === `command.${terminalId}.end`);
    assert.ok(frame, `command.${terminalId}.end frame not found`);
    assert.strictEqual(frame.payload.command, testCommand);
    assert.ok(
      frame.payload.exitCode === null || typeof frame.payload.exitCode === 'number',
      `exitCode must be null or number, got: ${typeof frame.payload.exitCode}`
    );
  });

  await check('command.N.end payload has endedAt ISO timestamp', async () => {
    const frame = cmdSub.frames.find(f => f.topic === `command.${terminalId}.end`);
    assert.ok(frame, `command.${terminalId}.end frame not found`);
    assert.ok(frame.payload.endedAt, 'expected endedAt field');
    assert.doesNotThrow(() => new Date(frame.payload.endedAt), 'endedAt must be parseable');
  });

  // ── conditional content-type tests (require real binaries) ────────────────

  if (hasPython3()) {
    // Send python3 to the terminal; wait for content change event
    const framesBeforePython = contentSub.frames.length;
    await check('send python3 to terminal via send command', async () => {
      const r = await rpc({ cmd: 'send', id: terminalId, text: 'python3 -c "import time; time.sleep(15)"', newline: true });
      assert.strictEqual(r.ok, true, `send failed: ${JSON.stringify(r)}`);
    });

    await check('vehicle.N.content changes to "python" when python3 is launched', async () => {
      // Wait for a new content frame after python3 was sent (up to 5s — 2× detection interval)
      const ok = await waitFor(
        () => contentSub.frames.slice(framesBeforePython).some(f =>
          f.topic === `vehicle.${terminalId}.content` && f.payload.contentType === 'python'
        ),
        5000
      );
      if (!ok) {
        const newFrames = contentSub.frames.slice(framesBeforePython);
        throw new Error(
          `Expected contentType="python" after python3 launch. ` +
          `New content frames: ${JSON.stringify(newFrames.map(f => ({ topic: f.topic, ct: f.payload?.contentType })))}`
        );
      }
    });
  } else {
    skipCheck('vehicle.N.content changes to "python" when python3 is launched', 'python3 not available');
    skipCheck('send python3 to terminal via send command', 'python3 not available');
  }

  if (hasVim()) {
    // Note: vim opens a TUI — send q after to close it
    const framesBeforeVim = contentSub.frames.length;
    await check('send vim to terminal via send command', async () => {
      const r = await rpc({ cmd: 'send', id: terminalId, text: 'vim /dev/null', newline: true });
      assert.strictEqual(r.ok, true, `send failed: ${JSON.stringify(r)}`);
    });

    await check('vehicle.N.content changes to "vim" when vim is launched', async () => {
      const ok = await waitFor(
        () => contentSub.frames.slice(framesBeforeVim).some(f =>
          f.topic === `vehicle.${terminalId}.content` && f.payload.contentType === 'vim'
        ),
        5000
      );
      if (!ok) {
        const newFrames = contentSub.frames.slice(framesBeforeVim);
        throw new Error(
          `Expected contentType="vim" after vim launch. ` +
          `New content frames: ${JSON.stringify(newFrames.map(f => ({ topic: f.topic, ct: f.payload?.contentType })))}`
        );
      }
    });
  } else {
    skipCheck('send vim to terminal via send command', 'vim not available');
    skipCheck('vehicle.N.content changes to "vim" when vim is launched', 'vim not available');
  }

  // ── cleanup ───────────────────────────────────────────────────────────────

  try { contentSub.socket.destroy(); } catch {}
  try { cmdSub.socket.destroy(); } catch {}

  // ── results ──────────────────────────────────────────────────────────────

  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  const skipped = results.filter(r => r.skipped).length;
  console.log('');
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped (${results.length} total)`);
  if (failed > 0) {
    console.log('\nFailed assertions:');
    for (const r of results.filter(r => !r.ok)) {
      console.log(`  - ${r.name}: ${r.err}`);
    }
    process.exit(1);
  }
  process.exit(0);
})();
