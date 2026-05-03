// post-tool-use-monitor-gate.test.js — regression suite for Wave C PostToolUse hook.
//
// Covers post-tool-use-claws.js behaviors:
//   1. No socket → exits 0 silently
//   2. Non-spawn-class tool → exits 0 silently
//   3. No terminal_id in response → exits 0 silently
//   4. Monitor IS registered → exits 0 without violation
//   5. Monitor NOT registered → publishes violation + auto-closes terminal
//   6. Hung socket (no responses) → self-kills at 5 s
//
// Run: node extension/test/post-tool-use-monitor-gate.test.js
// Exits 0 on all pass.

'use strict';

const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const net          = require('net');
const { spawn }    = require('child_process');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'post-tool-use-claws.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail || '' });
}

// Run the hook as a child process with the given JSON input on stdin.
// Returns { exitCode, stdout, stderr } after the process exits (or after timeoutMs).
function runHook(inputObj, timeoutMs = 7000) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [HOOK], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { proc.kill('SIGKILL'); } catch {}
        resolve({ exitCode: null, stdout, stderr, timedOut: true });
      }
    }, timeoutMs);

    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: code, stdout, stderr, timedOut: false });
      }
    });

    proc.stdin.write(JSON.stringify(inputObj));
    proc.stdin.end();
  });
}

// Create a temp directory with .claws/ subdir and a mock Unix socket server.
// `handler` receives each parsed request object and returns a response object (or null to not respond).
// Returns { dir, socketPath, server, received, cleanup }.
function createMockSocket(handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-test-'));
  const clawsDir = path.join(dir, '.claws');
  fs.mkdirSync(clawsDir);
  const socketPath = path.join(clawsDir, 'claws.sock');

  const received = [];
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let req;
        try { req = JSON.parse(line); } catch { continue; }
        received.push(req);
        const resp = handler(req);
        if (resp != null) {
          try { sock.write(JSON.stringify(resp) + '\n'); } catch {}
        }
      }
    });
    sock.on('error', () => {});
  });

  server.listen(socketPath);

  function cleanup() {
    try { server.close(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  return { dir, socketPath, server, received, cleanup };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function main() {
  // ── Check 1: no socket → exits 0 silently ─────────────────────────────────
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-nosock-'));
    try {
      const r = await runHook({
        tool_name: 'mcp__claws__claws_create',
        tool_response: { ok: true, id: 5 },
        cwd: tmpDir,
      }, 3000);
      check('1 — no socket: exits 0', r.exitCode === 0 && !r.timedOut, `exit=${r.exitCode} timedOut=${r.timedOut}`);
      check('1 — no socket: no stderr', r.stderr === '', `stderr: ${r.stderr.slice(0, 100)}`);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  // ── Check 2: non-spawn-class tool → exits 0 silently ──────────────────────
  {
    const r = await runHook({
      tool_name: 'Bash',
      tool_response: { ok: true },
    }, 3000);
    check('2 — non-spawn-class: exits 0', r.exitCode === 0 && !r.timedOut, `exit=${r.exitCode} timedOut=${r.timedOut}`);
    check('2 — non-spawn-class: no stderr', r.stderr === '', `stderr: ${r.stderr.slice(0, 100)}`);
  }

  // ── Check 3: no terminal_id in response → exits 0 silently ────────────────
  {
    const r = await runHook({
      tool_name: 'mcp__claws__claws_worker',
      tool_response: { ok: true },
    }, 3000);
    check('3 — no terminal_id: exits 0', r.exitCode === 0 && !r.timedOut, `exit=${r.exitCode} timedOut=${r.timedOut}`);
    check('3 — no terminal_id: no stderr', r.stderr === '', `stderr: ${r.stderr.slice(0, 100)}`);
  }

  // ── Check 4: monitor IS registered → exits 0 without violation ────────────
  {
    const TERM_ID = 42;
    const mock = createMockSocket((req) => {
      if (req.cmd === 'lifecycle.snapshot') {
        return { id: req.id, ok: true, state: { monitors: { [String(TERM_ID)]: { terminal_id: TERM_ID } } } };
      }
      return { id: req.id, ok: true };
    });
    try {
      const r = await runHook({
        tool_name: 'mcp__claws__claws_create',
        tool_response: { ok: true, terminal_id: TERM_ID },
        cwd: mock.dir,
      }, 5000);
      check('4 — monitor registered: exits 0', r.exitCode === 0 && !r.timedOut, `exit=${r.exitCode} timedOut=${r.timedOut}`);
      check('4 — monitor registered: no violation in stderr', !r.stderr.includes('PostToolUse'), `stderr: ${r.stderr.slice(0, 200)}`);
      check('4 — monitor registered: lifecycle.snapshot was queried', mock.received.some(r => r.cmd === 'lifecycle.snapshot'), 'expected at least one lifecycle.snapshot request');
    } finally {
      mock.cleanup();
    }
  }

  // ── Check 5: monitor NOT registered → violation + auto-close ──────────────
  {
    const TERM_ID = 99;
    const mock = createMockSocket((req) => {
      if (req.cmd === 'lifecycle.snapshot') {
        return { id: req.id, ok: true, state: { monitors: {} } };
      }
      // respond to publish and close immediately
      return { id: req.id, ok: true };
    });
    try {
      const r = await runHook({
        tool_name: 'mcp__claws__claws_fleet',
        tool_response: { ok: true, workers: [{ terminal_id: TERM_ID }] },
        cwd: mock.dir,
      }, 7000);
      check('5 — monitor missing: exits 0', r.exitCode === 0 && !r.timedOut, `exit=${r.exitCode} timedOut=${r.timedOut}`);
      check('5 — monitor missing: stderr has violation message', r.stderr.includes('PostToolUse') && r.stderr.includes(String(TERM_ID)), `stderr: ${r.stderr.slice(0, 300)}`);
      const pubCmd = mock.received.find(r => r.cmd === 'publish' && r.topic === 'wave.violation');
      check('5 — monitor missing: wave.violation published', pubCmd != null && pubCmd.payload && pubCmd.payload.terminal_id === TERM_ID, `publish cmds: ${JSON.stringify(mock.received.filter(r => r.cmd === 'publish'))}`);
      const closeCmd = mock.received.find(r => r.cmd === 'close' && String(r.id) === String(TERM_ID));
      check('5 — monitor missing: terminal auto-closed', closeCmd != null, `close cmds: ${JSON.stringify(mock.received.filter(r => r.cmd === 'close'))}`);
    } finally {
      mock.cleanup();
    }
  }

  // ── Check 6: hung socket → self-kills at 5 s ──────────────────────────────
  {
    const TERM_ID = 7;
    // Server accepts connections but never responds
    const mock = createMockSocket((_req) => null);
    try {
      const start = Date.now();
      const r = await runHook({
        tool_name: 'mcp__claws__claws_dispatch_subworker',
        tool_response: { ok: true, terminal_id: TERM_ID },
        cwd: mock.dir,
      }, 8000);
      const elapsed = Date.now() - start;
      check('6 — hung socket: exits 0 (self-kill)', r.exitCode === 0 && !r.timedOut, `exit=${r.exitCode} timedOut=${r.timedOut} elapsed=${elapsed}ms`);
      check('6 — hung socket: exits within 7 s', elapsed < 7000, `elapsed ${elapsed}ms >= 7000ms`);
    } finally {
      mock.cleanup();
    }
  }

  // ─── Final report ──────────────────────────────────────────────────────────

  let pass = 0;
  let fail = 0;
  for (const c of checks) {
    if (c.ok) {
      console.log('  ✓ ' + c.name);
      pass++;
    } else {
      console.log('  ✗ ' + c.name + (c.detail ? ' — ' + c.detail : ''));
      fail++;
    }
  }
  console.log(`\nPASS: ${pass}  FAIL: ${fail}  (post-tool-use-monitor-gate)`);
  if (fail > 0) process.exit(1);
}

main().catch(e => {
  console.error('[test error]', e.message);
  process.exit(1);
});
