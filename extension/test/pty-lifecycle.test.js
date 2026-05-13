#!/usr/bin/env node
// ClawsPty lifecycle test. Bundles src/claws-pty.ts (together with its
// capture-store dep) via esbuild into a test-only CJS module, mocks vscode's
// EventEmitter so the bundle can construct one, instantiates a ClawsPty
// with a real CaptureStore + logger, and drives open → handleInput → close.
//
// The pty is expected to either find node-pty (mode='pty') or fall back to
// pipe-mode (mode='pipe'); both are valid. What we assert is that:
//   - mode transitions from 'none' before open() to 'pty' or 'pipe' after
//   - handleInput delivers output into the captureStore within ~500ms
//   - close() stops the underlying process and returns without throwing
//   - after close the handler remains safe to call
//
// Run: node extension/test/pty-lifecycle.test.js
// Exits 0 on success, 1 on failure.

const Module = require('module');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const EXT_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(EXT_ROOT, 'src', 'backends', 'vscode', 'claws-pty.ts');
const OUT = path.join(EXT_ROOT, 'dist', 'claws-pty-test.js');

// ─── Mock vscode BEFORE requiring the compiled bundle ────────────────────
// The bundle marks 'vscode' as external (same as esbuild.mjs production build),
// so require('vscode') inside the bundle falls through to our mock.
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

const vscodeMock = { EventEmitter };

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'vscode') return 'vscode';
  return origResolve.call(this, request, parent, ...rest);
};
require.cache['vscode'] = {
  id: 'vscode',
  filename: 'vscode',
  loaded: true,
  exports: vscodeMock,
};

// ─── Bundle src/claws-pty.ts + capture-store.ts together ──────────────────
fs.mkdirSync(path.dirname(OUT), { recursive: true });
esbuild.buildSync({
  entryPoints: [SRC],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: OUT,
  // Same externals as the production bundle — vscode is mocked above,
  // node-pty is loaded lazily at runtime by claws-pty.ts so whether it
  // resolves or not is a test variable (pty vs pipe mode).
  external: ['vscode', 'node-pty'],
  logLevel: 'silent',
});

const ptyModule = require(OUT);
const { ClawsPty, sanitizeEnv, defaultShell, defaultShellArgs } = ptyModule;

// Capture-store is bundled inline so we build a small wrapper instance by
// compiling capture-store separately — same approach as capture-store-trim.
const CAP_OUT = path.join(EXT_ROOT, 'dist', 'capture-store-test.js');
if (!fs.existsSync(CAP_OUT)) {
  esbuild.buildSync({
    entryPoints: [path.join(EXT_ROOT, 'src', 'capture-store.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outfile: CAP_OUT,
    logLevel: 'silent',
  });
}
const { CaptureStore } = require(CAP_OUT);

// ─── Run lifecycle ────────────────────────────────────────────────────────
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

const logs = [];
const captureStore = new CaptureStore(64 * 1024);
const pty = new ClawsPty({
  terminalId: 'pty-test-1',
  captureStore,
  logger: (m) => logs.push(m),
});

check('mode is "none" before open()', () => {
  if (pty.mode !== 'none') throw new Error(`mode=${pty.mode}`);
});

check('hasOpened() is false before open()', () => {
  if (typeof pty.hasOpened !== 'function') throw new Error('hasOpened() missing');
  if (pty.hasOpened()) throw new Error('hasOpened() should be false before open()');
  if (typeof pty.ageMs !== 'function') throw new Error('ageMs() missing');
  if (pty.ageMs() < 0) throw new Error(`ageMs=${pty.ageMs()}`);
});

check('sanitizeEnv drops VSCODE_/ELECTRON_/npm_ prefixes but keeps PATH/HOME/TERM', () => {
  const base = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    USER: 'u',
    LANG: 'en_US.UTF-8',
    TERM: 'xterm',
    VSCODE_PID: '123',
    VSCODE_IPC_HOOK: '/tmp/ipc',
    ELECTRON_RUN_AS_NODE: '1',
    CHROME_DESKTOP: 'Code.desktop',
    npm_lifecycle_event: 'test',
    npm_package_name: 'claws',
    INIT_CWD: '/tmp',
    EDITOR: 'vim',
  };
  const out = sanitizeEnv(base);
  if (out.PATH !== '/usr/bin') throw new Error('PATH dropped');
  if (out.HOME !== '/home/u') throw new Error('HOME dropped');
  if (out.TERM !== 'xterm') throw new Error('TERM dropped');
  if (out.EDITOR !== 'vim') throw new Error('EDITOR dropped');
  if (out.USER !== 'u') throw new Error('USER dropped');
  if ('VSCODE_PID' in out) throw new Error('VSCODE_PID kept');
  if ('VSCODE_IPC_HOOK' in out) throw new Error('VSCODE_IPC_HOOK kept');
  if ('ELECTRON_RUN_AS_NODE' in out) throw new Error('ELECTRON_RUN_AS_NODE kept');
  if ('CHROME_DESKTOP' in out) throw new Error('CHROME_DESKTOP kept');
  if ('npm_lifecycle_event' in out) throw new Error('npm_lifecycle_event kept');
  if ('INIT_CWD' in out) throw new Error('INIT_CWD kept');
});

check('sanitizeEnv overrides take precedence', () => {
  const out = sanitizeEnv({ TERM: 'xterm', PATH: '/a' }, { TERM: 'xterm-256color' });
  if (out.TERM !== 'xterm-256color') throw new Error(`TERM=${out.TERM}`);
  if (out.PATH !== '/a') throw new Error(`PATH=${out.PATH}`);
});

check('defaultShell returns a truthy path', () => {
  const s = defaultShell();
  if (typeof s !== 'string' || s.length === 0) throw new Error(`defaultShell=${JSON.stringify(s)}`);
});

check('defaultShellArgs returns at least -i for zsh/bash/sh', () => {
  for (const shell of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    const args = defaultShellArgs(shell);
    if (!Array.isArray(args)) throw new Error(`not array: ${shell}`);
    if (!args.includes('-i')) throw new Error(`${shell}: no -i in ${JSON.stringify(args)}`);
  }
});

(async () => {
  let openThrew = null;
  try {
    pty.open(undefined);
  } catch (e) {
    openThrew = e;
  }

  check('open() does not throw even if node-pty missing', () => {
    if (openThrew) throw openThrew;
  });

  check('mode transitioned to pty or pipe after open()', () => {
    if (pty.mode !== 'pty' && pty.mode !== 'pipe') {
      throw new Error(`mode=${pty.mode}, logs=${JSON.stringify(logs)}`);
    }
  });

  check('hasOpened() is true after open()', () => {
    if (!pty.hasOpened()) throw new Error('hasOpened() still false after open()');
  });

  const modeAfterOpen = pty.mode;

  // Drive input. Output may or may not arrive depending on shell startup
  // speed, but "echo hi" should produce bytes within a reasonable window.
  try { pty.handleInput('echo hi\n'); } catch { /* ignore — some environments refuse input */ }

  // Poll captureStore for up to ~1.2s.
  const deadline = Date.now() + 1200;
  while (Date.now() < deadline) {
    const slice = captureStore.read('pty-test-1', undefined, 1024, false);
    if (slice.totalSize > 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  check('captureStore received some bytes after handleInput', () => {
    const slice = captureStore.read('pty-test-1', undefined, 4096, false);
    if (slice.totalSize === 0) {
      throw new Error(`no bytes captured; mode=${modeAfterOpen}, logs=${JSON.stringify(logs.slice(-5))}`);
    }
  });

  check('mode unchanged between open() and close()', () => {
    if (pty.mode !== modeAfterOpen) {
      throw new Error(`mode drifted: was ${modeAfterOpen}, now ${pty.mode}`);
    }
  });

  let closeThrew = null;
  try { pty.close(); } catch (e) { closeThrew = e; }
  check('close() does not throw', () => {
    if (closeThrew) throw closeThrew;
  });

  // Give the child process a moment to tear down.
  await new Promise((r) => setTimeout(r, 100));

  check('mode is "none" after close()', () => {
    if (pty.mode !== 'none') throw new Error(`mode=${pty.mode} after close`);
  });

  check('claws-pty.ts has win32 platform guard (no pgrep on Windows)', () => {
    const ptySrc = fs.readFileSync(
      path.join(EXT_ROOT, 'src', 'backends', 'vscode', 'claws-pty.ts'),
      'utf8',
    );
    if (!ptySrc.includes("process.platform === 'win32'")) {
      throw new Error("claws-pty.ts missing win32 guard — pgrep would crash on Windows");
    }
  });

  for (const a of assertions) {
    console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
  }

  const failed = assertions.filter((a) => !a.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${assertions.length} pty-lifecycle check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${assertions.length} pty-lifecycle checks`);
  process.exit(0);
})();
