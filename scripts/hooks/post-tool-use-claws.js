#!/usr/bin/env node
try { require('fs').appendFileSync('/tmp/claws-hook-trace.log', `${new Date().toISOString()} hook-fired pid=${process.pid} cwd=${process.cwd()} argv=${JSON.stringify(process.argv)}\n`); } catch {}
// Claws PostToolUse hook — fail-closes the spawn → monitor race window.
//
// Fires after every MCP tool call. Only acts on spawn-class tools
// (claws_create/worker/fleet/dispatch_subworker) where the call succeeded
// and returned a terminal_id. Waits up to ~4s for lifecycle.monitors to
// register the terminal (4s nominal so cleanup has ~1s before the 5s self-kill).
// If missing, publishes wave.violation event + auto-closes the orphaned terminal.
//
// SAFETY CONTRACT (P5): never crash, never block, never exit non-zero.
// Errors silently swallowed unless CLAWS_DEBUG=1.
'use strict';

// M-24: gate error handlers on CLAWS_DEBUG — when CLAWS_DEBUG=1, errors
// propagate visibly for debugging instead of being silently swallowed.
if (!process.env.CLAWS_DEBUG) {
  process.on('uncaughtException', () => { try { process.exit(0); } catch {} });
  process.on('unhandledRejection', () => { try { process.exit(0); } catch {} });
}


// M-13: 5-second self-kill safety timer — hook can never hang the parent process.
setTimeout(() => { process.exit(0); }, 5000).unref();

const SPAWN_CLASS = new Set([
  'mcp__claws__claws_create',
  'mcp__claws__claws_worker',
  'mcp__claws__claws_fleet',
  'mcp__claws__claws_dispatch_subworker',
]);

// Monitor wait window: 4000 ms (< 5 s self-kill) leaves ~1 s for violation
// cleanup (publish + close) before the self-kill fires.
const MONITOR_WAIT_MS = 4000;
const MONITOR_POLL_MS = 500;

let input = '';
// M-13: single try block for both 'data' and 'end' — fail together or not at all.
try {
  process.stdin.on('data', d => { input += d; });
  process.stdin.on('end', () => {
    run(input).catch(() => { try { process.exit(0); } catch {} });
  });
} catch {
  process.exit(0);
}

// Append a structured diagnostic line to /tmp/claws-hook-diag.log (never throws).
function writeDiag(event, detail) {
  try {
    const line = `${new Date().toISOString()} hook-diag ${event} ${JSON.stringify(detail)}\n`;
    require('fs').appendFileSync('/tmp/claws-hook-diag.log', line);
  } catch {}
}

// BUG6-L1 (v0714, .local/plans/v0714/investigations/bug6-hook-nested-context.md):
// Forward-compat normalizer. Handles all observed Claude Code tool_response shapes and
// returns null for unknown/unparseable input so callers can log a diagnostic instead of
// silently proceeding with a broken value.
//
// Shapes handled:
//  1. Bare array:     [{type:'text', text:'<JSON>'}]          ← current Claude Code
//  2. Wrapped object: {content:[{type:'text', text:'<JSON>'}]} ← older Claude Code
//  3. Plain object:   {ok:true, terminal_id:..., ...}          ← already-unwrapped / tests
//  4. null / undefined / primitive → null
//  5. Unknown shape → null + diagnostic
function unwrapMcpResponse(resp) {
  if (resp == null || typeof resp !== 'object') {
    writeDiag('unwrap-null-or-primitive', { type: typeof resp });
    return null;
  }

  // Shape 3 — plain object already unwrapped
  if (resp.ok !== undefined) return resp;

  // Shape 1 — bare array of content blocks (current Claude Code)
  if (Array.isArray(resp) && resp[0] && typeof resp[0].text === 'string') {
    try { return JSON.parse(resp[0].text); }
    catch (e) { writeDiag('unwrap-bare-array-parse-fail', { error: e.message, preview: resp[0].text.slice(0, 200) }); return null; }
  }

  // Shape 2 — wrapped object with content array (older Claude Code)
  if (Array.isArray(resp.content) && resp.content[0] && typeof resp.content[0].text === 'string') {
    try { return JSON.parse(resp.content[0].text); }
    catch (e) { writeDiag('unwrap-wrapped-parse-fail', { error: e.message, preview: resp.content[0].text.slice(0, 200) }); return null; }
  }

  // Unknown shape — emit diagnostic so future format changes are observable
  writeDiag('unwrap-unknown-shape', { keys: Object.keys(resp), isArray: Array.isArray(resp), preview: JSON.stringify(resp).slice(0, 300) });
  return null;
}

async function run(raw) {
  try { require('fs').appendFileSync(`/tmp/claws-hook-stdin-${process.pid}.json`, raw); } catch {}
  try {
    const fs   = require('fs');
    const path = require('path');

    let data = {};
    try { data = JSON.parse(raw); } catch { process.exit(0); return; }

    const toolName = data.tool_name || '';
    if (!SPAWN_CLASS.has(toolName)) { process.exit(0); return; }

    const resp = unwrapMcpResponse(data.tool_response);
    if (!resp) { writeDiag('unwrap-failed', { tool: toolName }); process.exit(0); return; }
    if (!resp.ok) { process.exit(0); return; }

    const terminalIds = extractTerminalIds(resp);
    if (terminalIds.length === 0) { process.exit(0); return; }

    const cwd = data.cwd || process.cwd();
    const socketPath = findSocket(cwd);
    if (!socketPath) { process.exit(0); return; }

    // Layer 1: spawn per-worker pgrep watchers (fire-and-forget, <1ms).
    // Complements the lifecycle.snapshot check below — verifies an OS-level
    // stream-events.js process is actually alive watching the corrId, not just
    // that lifecycle.monitors[] was pre-populated by mcp_server at spawn time.
    spawnWatchers(extractWorkerEntries(resp), socketPath);

    for (const tid of terminalIds) {
      await checkOne(socketPath, tid, toolName);
    }
    process.exit(0);
  } catch {
    process.exit(0);
  }
}

// Returns [{terminalId, corrId}] for spawning per-worker pgrep watchers.
function extractWorkerEntries(resp) {
  if (Array.isArray(resp.workers)) {
    return resp.workers
      .filter(w => w && (w.terminal_id != null || w.id != null))
      .map(w => ({
        terminalId: w.terminal_id != null ? w.terminal_id : w.id,
        corrId:     w.correlation_id || null,
      }));
  }
  const tid = resp.terminal_id != null   ? resp.terminal_id
    : Array.isArray(resp.terminal_ids) && resp.terminal_ids[0] != null ? resp.terminal_ids[0]
    : resp.id != null ? resp.id
    : null;
  return [{ terminalId: tid, corrId: resp.correlation_id || null }];
}

function spawnWatchers(entries, socketPath) {
  const { spawn } = require('child_process');
  const path      = require('path');
  const fs        = require('fs');
  const watcherPath = path.join(__dirname, '..', 'monitor-arm-watch.js');
  // Derive the project root from the socket path so the watcher's cwd is
  // deterministic regardless of where the hook process was launched from.
  const projectRoot = socketPath
    ? path.dirname(path.dirname(socketPath))
    : undefined;
  for (const { terminalId, corrId } of entries) {
    if (!corrId || terminalId == null) continue;
    try {
      const debugLog = `/tmp/claws-monitor-arm-watch-${corrId}.log`;
      const fd = fs.openSync(debugLog, 'a');
      spawn(process.execPath, [
        watcherPath,
        '--corr-id',  corrId,
        '--term-id',  String(terminalId),
        '--grace-ms', '10000',
        '--socket',   socketPath,
      ], {
        detached: true,
        stdio:    ['ignore', fd, fd],
        cwd:      projectRoot,
      }).unref();
      try { fs.closeSync(fd); } catch {}
    } catch { /* fire-and-forget — never throw */ }
  }
}

function extractTerminalIds(resp) {
  if (Array.isArray(resp.terminal_ids)) {
    return resp.terminal_ids.filter(id => id != null);
  }
  if (resp.terminal_id != null) return [resp.terminal_id];
  // claws_create returns { id, logPath? } — use id as fallback
  if (resp.id != null) return [resp.id];
  // claws_fleet: { workers: [{terminal_id, ...}] }
  if (Array.isArray(resp.workers)) {
    return resp.workers
      .filter(w => w && (w.terminal_id != null || w.id != null))
      .map(w => (w.terminal_id != null ? w.terminal_id : w.id));
  }
  return [];
}

async function checkOne(socketPath, terminalId, toolName) {
  const registered = await waitForMonitor(socketPath, terminalId, MONITOR_WAIT_MS, MONITOR_POLL_MS);
  if (registered) return;

  try {
    process.stderr.write(
      `[claws] PostToolUse: monitor not registered for terminal ${terminalId} within 5s.` +
      ` Auto-cancelling spawn (use Monitor + scripts/stream-events.js | grep pattern next time).\n`
    );
  } catch {}

  try {
    await sendCmd(socketPath, {
      cmd: 'publish',
      topic: 'wave.violation',
      payload: { kind: 'monitor-missing', terminal_id: terminalId, tool_name: toolName, ts: new Date().toISOString() },
    });
  } catch {}

  try {
    await sendCmd(socketPath, { cmd: 'close', id: terminalId });
  } catch {}
}

async function waitForMonitor(socketPath, terminalId, maxWaitMs, intervalMs) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const snap = await sendCmd(socketPath, { cmd: 'lifecycle.snapshot' });
      if (monitorPresent(snap, terminalId)) return true;
    } catch { /* socket error — retry */ }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  return false;
}

function monitorPresent(snap, terminalId) {
  if (!snap || !snap.ok) return false;
  const state = snap.state || snap;
  const monitors = state.monitors;
  if (!monitors) return false;
  if (Array.isArray(monitors)) {
    return monitors.some(m => m && String(m.terminal_id) === String(terminalId));
  }
  return Object.prototype.hasOwnProperty.call(monitors, String(terminalId));
}

function sendCmd(socketPath, obj) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const id  = Math.random().toString(36).slice(2);
    const msg = JSON.stringify({ id, ...obj }) + '\n';
    let buf  = '';
    let done = false;
    const sock = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      if (!done) { done = true; try { sock.destroy(); } catch {} reject(new Error('timeout')); }
    }, 2000);
    sock.on('connect', () => {
      try { sock.write(msg); } catch (e) {
        if (!done) { done = true; clearTimeout(timer); reject(e); }
      }
    });
    sock.on('data', chunk => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl !== -1 && !done) {
        done = true;
        clearTimeout(timer);
        try { sock.destroy(); } catch {}
        try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
      }
    });
    sock.on('error', e => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    sock.on('close', () => { if (!done) { done = true; clearTimeout(timer); reject(new Error('closed')); } });
  });
}

function findSocket(startDir) {
  const path = require('path');
  const fs   = require('fs');
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, '.claws', 'claws.sock');
    try { if (fs.existsSync(candidate)) return candidate; } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
