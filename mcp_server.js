#!/usr/bin/env node
/**
 * Claws MCP Server — expose terminal control as native Claude Code tools.
 * Zero dependencies. Node.js stdlib only.
 *
 * Powered by Claude Opus.
 *
 * Install Claws (auto-registers this MCP server globally):
 *     bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)
 *
 * Or register manually (use FULL absolute path):
 *     "mcpServers": {
 *         "claws": {
 *             "command": "node",
 *             "args": ["/home/YOUR_USER/.claws-src/mcp_server.js"]
 *         }
 *     }
 *
 * Tools: claws_list, claws_create, claws_send, claws_exec,
 *        claws_read_log, claws_poll, claws_close, claws_worker,
 *        claws_hello, claws_subscribe, claws_publish, claws_broadcast,
 *        claws_ping, claws_peers
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');

// ─── MCP protocol (stdio, newline-delimited JSON) ──────────────────────────
// MCP spec: each JSON-RPC message is a single line on stdin/stdout, terminated
// by '\n'. (NOT LSP-style Content-Length framing — that was the prior bug.)

let inputBuf = '';

function readMessage() {
  return new Promise((resolve) => {
    const tryParse = () => {
      const nl = inputBuf.indexOf('\n');
      if (nl === -1) return false;
      const line = inputBuf.slice(0, nl).replace(/\r$/, '');
      inputBuf = inputBuf.slice(nl + 1);
      if (line.trim() === '') return tryParse();
      try {
        resolve(JSON.parse(line));
        return true;
      } catch {
        return tryParse();
      }
    };
    if (tryParse()) return;
    const onData = (chunk) => {
      inputBuf += chunk.toString('utf8');
      if (tryParse()) process.stdin.removeListener('data', onData);
    };
    process.stdin.on('data', onData);
  });
}

function writeMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function respond(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

function log(msg) {
  process.stderr.write('[claws-mcp] ' + msg + '\n');
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ─── Claws socket client ───────────────────────────────────────────────────

let counter = 0;

function clawsRpc(sockPath, req, timeout = 30000) {
  return new Promise((resolve) => {
    counter++;
    req = { id: counter, ...req };
    const sock = net.createConnection(sockPath);
    sock.setTimeout(timeout);
    let buf = '';
    sock.on('connect', () => {
      sock.write(JSON.stringify(req) + '\n');
    });
    sock.on('data', (data) => {
      buf += data.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        try { resolve(JSON.parse(buf.slice(0, nl))); }
        catch { resolve({ ok: false, error: 'bad json from extension' }); }
        sock.destroy();
      }
    });
    sock.on('error', (err) => {
      log('socket error [' + req.cmd + ']: ' + err.message);
      resolve({ ok: false, error: `socket error: ${err.message}` });
    });
    sock.on('timeout', () => {
      log('socket timeout [' + req.cmd + '] after ' + timeout + 'ms');
      resolve({ ok: false, error: 'socket timeout' });
      sock.destroy();
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fileExec(sockPath, termId, command, timeoutMs = 180000) {
  const execId = randomUUID().slice(0, 10);
  const base = path.join(os.tmpdir(), 'claws-exec');
  fs.mkdirSync(base, { recursive: true });
  const outPath = path.join(base, `${execId}.out`);
  const donePath = path.join(base, `${execId}.done`);
  const wrapper = `{ ${command}; } > ${outPath} 2>&1; echo $? > ${donePath}`;
  await clawsRpc(sockPath, { cmd: 'send', id: termId, text: wrapper, newline: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(donePath)) break;
    await sleep(150);
  }
  if (!fs.existsSync(donePath)) {
    const partial = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
    return { ok: false, error: `timeout after ${timeoutMs}ms`, partial };
  }
  const exitRaw = fs.readFileSync(donePath, 'utf8').trim();
  const exitCode = /^\d+$/.test(exitRaw) ? parseInt(exitRaw, 10) : null;
  const output = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
  try { fs.unlinkSync(outPath); } catch {}
  try { fs.unlinkSync(donePath); } catch {}
  return { ok: true, terminal_id: termId, command, output, exit_code: exitCode };
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'claws_list',
    description: 'List all open VS Code terminals with their ID, name, PID, shell integration status, active state, and pty log path (null if not wrapped). Use this to discover what\'s running before sending commands.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'claws_create',
    description: 'Create a new VS Code terminal. Set wrapped=true to enable full pty logging — this lets you read everything that happens in the terminal including TUI sessions (Claude Code, vim, htop, REPLs). The terminal appears visibly in VS Code\'s panel.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Terminal display name' },
        cwd: { type: 'string', description: 'Working directory (absolute path)' },
        wrapped: { type: 'boolean', description: 'Enable script(1) pty logging for full read-back. Defaults to true — all worker terminals should be wrapped for observability. Set false only for interactive UI terminals where logging is undesired.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'claws_send',
    description: 'Send text into a terminal. The text arrives at whatever input is active — shell prompt, TUI input field, REPL prompt. Multi-line text is auto-wrapped in bracketed paste mode. Set newline=false to send raw keystrokes without Enter.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Terminal ID from claws_list or claws_create' },
        text: { type: 'string', description: 'Text to send' },
        newline: { type: 'boolean', description: 'Append Enter after text (default true)' },
      },
      required: ['id', 'text'],
    },
  },
  {
    name: 'claws_exec',
    description: 'Execute a shell command in a terminal and capture the output (stdout + stderr + exit code). Uses file-based capture — works in any terminal type. Waits for the command to finish.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Terminal ID' },
        command: { type: 'string', description: 'Shell command to execute' },
        timeout_ms: { type: 'integer', description: 'Max wait time in ms (default 180000)' },
      },
      required: ['id', 'command'],
    },
  },
  {
    name: 'claws_read_log',
    description: 'Read a wrapped terminal\'s pty log with ANSI escapes stripped. Returns clean, readable text of everything that happened — including TUI sessions, build output, AI coding assistant transcripts. Only works for terminals created with wrapped=true.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Terminal ID (must be wrapped)' },
        lines: { type: 'integer', description: 'Number of lines to return from the tail (default 50)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'claws_poll',
    description: 'Stream shell-integration command-completion events across all terminals. Pass since=cursor to get only new events. Note: unreliable in wrapped terminals — use claws_read_log instead.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'integer', description: 'Sequence cursor — return only events after this (default 0)' },
      },
    },
  },
  {
    name: 'claws_close',
    description: 'Close and dispose a terminal. Always close terminals you created when the work is done.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Terminal ID to close' },
      },
      required: ['id'],
    },
  },
  {
    name: 'claws_worker',
    description: 'Run a complete worker lifecycle in one blocking call: creates a wrapped terminal, optionally launches Claude Code with --dangerously-skip-permissions, sends the mission prompt, polls the capture buffer for a completion marker (default MISSION_COMPLETE) or error markers, harvests the final output, and auto-closes. Returns a structured result. Set detach=true for the legacy fire-and-forget behavior.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Worker name (terminal tab)' },
        mission: { type: 'string', description: 'Mission prompt sent to Claude Code. Include your completion marker (default MISSION_COMPLETE) so the blocker knows when to stop.' },
        command: { type: 'string', description: 'Alternative to mission: raw shell command sent to a wrapped terminal. Implies launch_claude=false.' },
        launch_claude: { type: 'boolean', description: 'Launch claude --dangerously-skip-permissions before sending mission (default: true if mission present, false if command present)' },
        detach: { type: 'boolean', description: 'Return immediately after spawning (legacy behavior, default false).' },
        timeout_ms: { type: 'integer', description: 'Max wait for completion in ms (default 1800000 = 30 min).' },
        boot_wait_ms: { type: 'integer', description: 'Max wait for Claude Code boot before sending mission (default 8000).' },
        boot_marker: { type: 'string', description: 'Substring that indicates Claude booted (default "Claude Code").' },
        complete_marker: { type: 'string', description: 'Substring that signals success (default "MISSION_COMPLETE").' },
        error_markers: { type: 'array', items: { type: 'string' }, description: 'Substrings that signal failure (default ["MISSION_FAILED"]).' },
        poll_interval_ms: { type: 'integer', description: 'How often to check the capture buffer (default 1500).' },
        harvest_lines: { type: 'integer', description: 'Tail N lines of output to return on completion (default 200).' },
        close_on_complete: { type: 'boolean', description: 'Auto-close the terminal after completion (default true).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'claws_hello',
    description: 'Register this Claude session with the Claws server as an orchestrator or worker peer. Must be called before subscribe, publish, or task commands. Returns a peerId for this session.',
    inputSchema: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          enum: ['orchestrator', 'worker', 'observer'],
          description: 'Peer role. Orchestrator may assign/cancel/broadcast; worker may publish status and claim tasks; observer is read-only.',
        },
        peerName: { type: 'string', description: "Human label for this peer (e.g. 'sdlc-lead', 'test-worker-1')." },
        terminalId: { type: 'string', description: 'Optional: associate this peer with a specific terminal id so the server can correlate logs and do inject fan-out.' },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of capability strings the peer advertises (server intersects with its own).',
        },
      },
      required: ['role', 'peerName'],
    },
  },
  {
    name: 'claws_subscribe',
    description: "Subscribe to a topic pattern on the Claws message bus. Patterns support wildcards: '*' matches one segment, '**' matches many. Examples: 'task.status', 'worker.*', 'task.**'. Returns a subscriptionId.",
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic pattern to subscribe to (dot-namespaced, supports * and ** wildcards).' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'claws_publish',
    description: 'Publish a payload to a topic on the Claws message bus. All peers subscribed to a matching pattern will receive a push frame.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic to publish on.' },
        payload: { type: 'object', description: 'The message payload (arbitrary JSON object).' },
        echo: { type: 'boolean', description: 'If true, sender also receives the message (default false).' },
      },
      required: ['topic', 'payload'],
    },
  },
  {
    name: 'claws_broadcast',
    description: "Orchestrator-only: send a text message to all workers (or all peers). Optionally inject the text directly into each worker's terminal via bracketed paste. Useful as a kill-switch or coordination signal.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text payload to broadcast.' },
        targetRole: {
          type: 'string',
          enum: ['worker', 'orchestrator', 'observer', 'all'],
          description: "Which role(s) to target (default 'worker').",
        },
        inject: { type: 'boolean', description: "If true, text is also sent into each peer's associated terminal via bracketed paste (default false)." },
      },
      required: ['text'],
    },
  },
  {
    name: 'claws_ping',
    description: "Check that the Claws server is reachable. Returns the server's current timestamp. Useful as a heartbeat.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'claws_peers',
    description: 'List all currently registered peers on the Claws server (claws/2 connections that have called hello). Returns role, peerName, terminalId, and lastSeen for each peer.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'claws_lifecycle_plan',
    description: 'Log the PLAN phase — required before any claws_create call. The server-side lifecycle gate blocks terminal creation until this succeeds. Provide a 1–3 sentence summary of what you are about to do. Idempotent: safe to call twice.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: '1–3 sentence mission summary. What you are doing, why, and what success looks like.' },
      },
      required: ['plan'],
    },
  },
  {
    name: 'claws_lifecycle_advance',
    description: 'Advance the server-side lifecycle state machine to the next phase. Legal transitions per event-protocol.md §4: PLAN→SPAWN, SPAWN→DEPLOY|RECOVER|FAILED, DEPLOY→OBSERVE|RECOVER|FAILED, OBSERVE→HARVEST|RECOVER|FAILED, RECOVER→DEPLOY|OBSERVE|FAILED, HARVEST→CLEANUP|FAILED, CLEANUP→REFLECT|FAILED. Idempotent: advancing to the current phase is a no-op.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          enum: ['SPAWN', 'DEPLOY', 'OBSERVE', 'RECOVER', 'HARVEST', 'CLEANUP', 'REFLECT', 'FAILED'],
          description: 'Target phase.',
        },
        reason: { type: 'string', description: 'Optional human-readable transition reason (logged in state).' },
      },
      required: ['to'],
    },
  },
  {
    name: 'claws_lifecycle_snapshot',
    description: 'Read the current server-side lifecycle state without changing it. Returns null when no PLAN has been logged yet. Use this to check what phase you are in before sending lifecycle commands.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'claws_lifecycle_reflect',
    description: 'Terminal lifecycle transition: advance to REFLECT and persist your retrospective text. Call this after CLEANUP when all workers are closed and you have assessed the session. The REFLECT phase is terminal — no further transitions are allowed.',
    inputSchema: {
      type: 'object',
      properties: {
        reflect: { type: 'string', description: 'Retrospective text: what succeeded, what failed, what to improve next time.' },
      },
      required: ['reflect'],
    },
  },
];

// ─── Blocking worker lifecycle ─────────────────────────────────────────────

function findMarkerLine(text, marker) {
  const idx = text.indexOf(marker);
  if (idx === -1) return null;
  const lineStart = text.lastIndexOf('\n', idx) + 1;
  const lineEnd = text.indexOf('\n', idx);
  return text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
}

async function runBlockingWorker(sock, args) {
  const DEFAULTS = {
    timeout_ms: 30 * 60 * 1000,
    boot_wait_ms: 8000,
    boot_marker: 'Claude Code',
    complete_marker: 'MISSION_COMPLETE',
    error_markers: ['MISSION_FAILED'],
    poll_interval_ms: 1500,
    harvest_lines: 200,
    close_on_complete: true,
  };
  const opt = { ...DEFAULTS, ...args };
  const hasMission = typeof args.mission === 'string' && args.mission.length > 0;
  const hasCommand = typeof args.command === 'string' && args.command.length > 0;
  const launchClaude = args.launch_claude !== undefined
    ? !!args.launch_claude
    : hasMission;

  // 1. Create wrapped terminal
  const cr = await clawsRpc(sock, {
    cmd: 'create', name: args.name || 'claws-worker', wrapped: true, show: true,
  });
  if (!cr.ok) return { status: 'error', error: `create failed: ${cr.error}` };
  const termId = cr.id;
  const startedAt = Date.now();

  // 2. Give shell a moment to emit prompt
  await sleep(400);

  // 3. Optional claude boot + detection
  let booted = !launchClaude;
  if (launchClaude) {
    await clawsRpc(sock, {
      cmd: 'send', id: termId,
      text: 'claude --dangerously-skip-permissions', newline: true,
    });
    const bootDeadline = Date.now() + opt.boot_wait_ms;
    while (Date.now() < bootDeadline) {
      const snap = await clawsRpc(sock, {
        cmd: 'readLog', id: termId, strip: true, limit: 32 * 1024,
      });
      if (snap.ok && typeof snap.bytes === 'string' && snap.bytes.includes(opt.boot_marker)) {
        booted = true;
        break;
      }
      await sleep(400);
    }
    // proceed even if marker missed — best-effort
    await sleep(500);
  }

  // 4. Send payload
  const payload = hasMission ? args.mission : hasCommand ? args.command : '';
  if (payload) {
    await clawsRpc(sock, {
      cmd: 'send', id: termId, text: payload, newline: true,
    });
    if (launchClaude) {
      // Claude Code TUI sometimes needs an extra Enter to submit
      await sleep(300);
      await clawsRpc(sock, {
        cmd: 'send', id: termId, text: '\r', newline: false,
      });
    }
  }

  // 5. Detach shortcut
  if (args.detach === true) {
    return {
      status: 'spawned',
      terminal_id: termId,
      booted,
      duration_ms: Date.now() - startedAt,
    };
  }

  // 6. Poll for completion / errors / timeout
  const timeoutDeadline = startedAt + opt.timeout_ms;
  let status = 'timeout';
  let markerLine = null;
  while (Date.now() < timeoutDeadline) {
    const snap = await clawsRpc(sock, {
      cmd: 'readLog', id: termId, strip: true, limit: 64 * 1024,
    });
    const text = snap.ok && typeof snap.bytes === 'string' ? snap.bytes : '';

    if (text.includes(opt.complete_marker)) {
      status = 'completed';
      markerLine = findMarkerLine(text, opt.complete_marker);
      break;
    }
    let failed = false;
    for (const em of opt.error_markers) {
      if (em && text.includes(em)) {
        status = 'failed';
        markerLine = findMarkerLine(text, em);
        failed = true;
        break;
      }
    }
    if (failed) break;

    await sleep(opt.poll_interval_ms);
  }

  // 7. Harvest final output
  const final = await clawsRpc(sock, {
    cmd: 'readLog', id: termId, strip: true, limit: 256 * 1024,
  });
  const allLines = (final.ok && typeof final.bytes === 'string' ? final.bytes : '').split('\n');
  const harvest = allLines.slice(-opt.harvest_lines).join('\n');

  // 8. Auto-close
  let cleanedUp = false;
  if (opt.close_on_complete) {
    const cl = await clawsRpc(sock, { cmd: 'close', id: termId });
    cleanedUp = !!cl.ok;
  }

  return {
    status,
    terminal_id: termId,
    booted,
    duration_ms: Date.now() - startedAt,
    marker_line: markerLine,
    cleaned_up: cleanedUp,
    harvest,
  };
}

// ─── Tool handlers ─────────────────────────────────────────────────────────

function getSocket() {
  // Absolute override wins immediately.
  const envSock = process.env.CLAWS_SOCKET;
  if (envSock && path.isAbsolute(envSock)) return envSock;

  // Walk up from CWD to find .claws/claws.sock — works when Claude Code chdir'd
  // to the workspace root before spawning the MCP server.
  for (let dir = process.cwd();;) {
    const candidate = path.join(dir, '.claws', 'claws.sock');
    try { if (fs.statSync(candidate).isSocket()) return candidate; } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Walk up from __dirname — self-locating regardless of CWD.
  // Project install: .claws-bin/mcp_server.js -> parent = project root -> .claws/claws.sock
  // Global install: ~/.claws-src/mcp_server.js -> walks up, finds nothing, falls through.
  for (let dir = __dirname;;) {
    const candidate = path.join(dir, '.claws', 'claws.sock');
    try { if (fs.statSync(candidate).isSocket()) return candidate; } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Fall back to env var (may be relative) or the conventional default.
  return envSock || '.claws/claws.sock';
}

async function handleTool(name, args) {
  const sock = getSocket();

  if (name === 'claws_list') {
    const resp = await clawsRpc(sock, { cmd: 'list' });
    if (!resp.ok) return toolError(`ERROR: ${resp.error}`);
    const terms = resp.terminals || [];
    if (!terms.length) return { content: [{ type: 'text', text: '[no terminals open]' }] };
    const lines = terms.map(t => {
      const wrap = t.logPath ? 'WRAPPED' : 'unwrapped';
      const marker = t.active ? '*' : ' ';
      return `${marker} ${t.id}  ${(t.name || '').padEnd(25)} pid=${t.pid}  [${wrap}]`;
    });
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  if (name === 'claws_create') {
    const resp = await clawsRpc(sock, {
      cmd: 'create', name: args.name || 'claws',
      cwd: args.cwd, wrapped: args.wrapped !== false, show: true,
    });
    if (!resp.ok) return toolError(`ERROR: ${resp.error}`);
    let text = `created terminal id=${resp.id}`;
    if (resp.logPath) text += ` wrapped logPath=${resp.logPath}`;
    return { content: [{ type: 'text', text }] };
  }

  if (name === 'claws_send') {
    // Auto-enable bracketed paste for multi-line text. Matches the documented
    // tool behavior and ensures the trailing CR registers as Enter in TUIs
    // like Claude Code (the extension splits the CR into a separate write
    // when bracketed paste is used; see claws-pty.ts:writeInjected).
    const text = args.text ?? '';
    const isMultiLine = text.includes('\n') || text.includes('\r');
    const resp = await clawsRpc(sock, {
      cmd: 'send', id: args.id, text,
      newline: args.newline !== false,
      paste: isMultiLine,
    });
    if (!resp.ok) return toolError(`ERROR: ${resp.error}`);
    return { content: [{ type: 'text', text: 'sent' }] };
  }

  if (name === 'claws_exec') {
    const timeoutMs = args.timeout_ms || 180000;
    const result = await fileExec(sock, args.id, args.command, timeoutMs);
    if (!result.ok) {
      let text = `ERROR: ${result.error}`;
      if (result.partial) text += `\n[partial output]\n${result.partial}`;
      return toolError(text);
    }
    return { content: [{ type: 'text', text: `exit ${result.exit_code}\n${result.output}` }] };
  }

  if (name === 'claws_read_log') {
    const resp = await clawsRpc(sock, { cmd: 'readLog', id: args.id, strip: true });
    if (!resp.ok) return toolError(`ERROR: ${resp.error}`);
    const allLines = (resp.bytes || '').split('\n');
    const n = args.lines || 50;
    const tail = allLines.length > n ? allLines.slice(-n) : allLines;
    const header = `[term ${args.id} · ${resp.totalSize || 0} bytes · showing last ${tail.length} of ${allLines.length} lines]`;
    return { content: [{ type: 'text', text: header + '\n' + tail.join('\n') }] };
  }

  if (name === 'claws_poll') {
    const resp = await clawsRpc(sock, { cmd: 'poll', since: args.since || 0 });
    if (!resp.ok) return toolError(`ERROR: ${resp.error}`);
    const events = resp.events || [];
    if (!events.length) return { content: [{ type: 'text', text: `[no events · cursor ${resp.cursor || 0}]` }] };
    const lines = events.map(e => {
      let line = `[seq ${e.seq} · ${e.terminalName} · exit ${e.exitCode}] $ ${e.commandLine || ''}`;
      if (e.output) {
        const out = e.output.length > 500 ? e.output.slice(0, 500) + '...' : e.output;
        line += '\n' + out;
      }
      return line;
    });
    return { content: [{ type: 'text', text: lines.join('\n') + `\n[cursor ${resp.cursor}]` }] };
  }

  if (name === 'claws_close') {
    const resp = await clawsRpc(sock, { cmd: 'close', id: args.id });
    if (!resp.ok) return toolError(`ERROR: ${resp.error}`);
    return { content: [{ type: 'text', text: `closed terminal ${args.id}` }] };
  }

  /**
   * claws_hello — register this Claude session with the Claws server.
   * Calls the claws/2 `hello` command. Must be invoked before any
   * subscribe/publish/task/broadcast call so the server can allocate a
   * stable peerId for this connection.
   * Role requirements: none (any role may hello).
   * Returns: peerId, serverCapabilities, orchestratorPresent.
   */
  if (name === 'claws_hello') {
    const resp = await clawsRpc(sock, {
      cmd: 'hello',
      protocol: 'claws/2',
      role: args.role,
      peerName: args.peerName,
      terminalId: args.terminalId,
      capabilities: Array.isArray(args.capabilities) ? args.capabilities : undefined,
    });
    if (!resp.ok) return toolError(`ERROR: ${resp.error || 'hello failed'}`);
    log(`registered as peer ${resp.peerId} role=${args.role}`);
    const out = {
      peerId: resp.peerId,
      serverCapabilities: resp.serverCapabilities || [],
      orchestratorPresent: !!resp.orchestratorPresent,
    };
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  }

  /**
   * claws_subscribe — subscribe this client to a topic pattern on the bus.
   * Calls the claws/2 `subscribe` command. Server-pushed frames for matching
   * topics will be delivered on this socket thereafter.
   * Role requirements: none (orchestrator, worker, and observer may all subscribe).
   * Returns: subscriptionId (opaque string used with unsubscribe).
   */
  if (name === 'claws_subscribe') {
    const resp = await clawsRpc(sock, { cmd: 'subscribe', topic: args.topic });
    if (!resp.ok) return toolError(`ERROR: ${resp.error || 'subscribe failed'}`);
    return { content: [{ type: 'text', text: JSON.stringify({ subscriptionId: resp.subscriptionId }, null, 2) }] };
  }

  /**
   * claws_publish — publish a payload to a topic on the Claws message bus.
   * Calls the claws/2 `publish` command. Delivered to every peer whose
   * subscription pattern matches the topic; the sender receives the message
   * too only when `echo: true`.
   * Role requirements: none (any peer may publish).
   * Returns: deliveredTo (number of subscribers who received the frame).
   */
  if (name === 'claws_publish') {
    const resp = await clawsRpc(sock, {
      cmd: 'publish',
      topic: args.topic,
      payload: args.payload || {},
      echo: !!args.echo,
    });
    if (!resp.ok) return toolError(`ERROR: ${resp.error || 'publish failed'}`);
    return { content: [{ type: 'text', text: JSON.stringify({ deliveredTo: resp.deliveredTo || 0 }, null, 2) }] };
  }

  /**
   * claws_broadcast — orchestrator-only fan-out to all workers (or all peers).
   * Calls the claws/2 `broadcast` command. With `inject: true` the server also
   * sends the text into each target peer's associated terminal via bracketed
   * paste — this is the kill-switch path for workers that are deep in a tool
   * call and not reading their socket.
   * Role requirements: caller must have handshaked with role='orchestrator'.
   * Returns: deliveredTo (number of peers the broadcast reached).
   */
  if (name === 'claws_broadcast') {
    const resp = await clawsRpc(sock, {
      cmd: 'broadcast',
      text: args.text,
      targetRole: args.targetRole || 'worker',
      inject: !!args.inject,
    });
    if (!resp.ok) return toolError(`ERROR: ${resp.error || 'broadcast failed'}`);
    return { content: [{ type: 'text', text: JSON.stringify({ deliveredTo: resp.deliveredTo || 0 }, null, 2) }] };
  }

  /**
   * claws_ping — liveness check.
   * Calls the claws/2 `ping` command. Also acts as an implicit heartbeat —
   * the server refreshes the caller's `lastSeen` so it is not reaped as
   * offline.
   * Role requirements: none.
   * Returns: serverTime (ms since epoch as reported by the server).
   */
  if (name === 'claws_ping') {
    const resp = await clawsRpc(sock, { cmd: 'ping' });
    if (!resp.ok) return toolError(`ERROR: ${resp.error || 'ping failed'}`);
    return { content: [{ type: 'text', text: JSON.stringify({ serverTime: resp.serverTime }, null, 2) }] };
  }

  /**
   * claws_peers — list all registered claws/2 peers.
   * There is no dedicated `peers` command on the server yet, so this tool
   * calls `introspect` and surfaces whatever peer info is included in the
   * snapshot (claws/2 Phase A exposes a peers map on the connection server).
   * Role requirements: none.
   * Returns: an array of peer records with { peerId, role, peerName, terminalId, lastSeen }.
   *
   * TODO: server-side 'peers' command needed in claws/2 Phase C — until then
   * we synthesise the list from `introspect` output. If the server already
   * has a `peers` command available we fall back to that first.
   */
  if (name === 'claws_peers') {
    // Prefer a direct `peers` command if the server implements it;
    // fall back to `introspect` otherwise.
    let resp = await clawsRpc(sock, { cmd: 'peers' });
    if (!resp.ok) {
      resp = await clawsRpc(sock, { cmd: 'introspect' });
    }
    if (!resp.ok) return toolError(`ERROR: ${resp.error || 'peers lookup failed'}`);
    const peers = resp.peers || (resp.snapshot && resp.snapshot.peers) || [];
    return { content: [{ type: 'text', text: JSON.stringify({ peers }, null, 2) }] };
  }

  if (name === 'claws_worker') {
    const result = await runBlockingWorker(sock, args);

    if (result.status === 'error') {
      return toolError(`ERROR: ${result.error}`);
    }

    const header = [
      `worker '${args.name}' ${result.status.toUpperCase()}`,
      `  terminal:   ${result.terminal_id}`,
      `  duration:   ${(result.duration_ms / 1000).toFixed(1)}s`,
      `  booted:     ${result.booted}`,
      `  cleaned_up: ${result.cleaned_up}`,
    ];
    if (result.marker_line) header.push(`  marker:     ${result.marker_line}`);

    if (result.status === 'spawned') {
      header.push('', `detached mode — use claws_read_log id=${result.terminal_id} and claws_close when done`);
      return { content: [{ type: 'text', text: header.join('\n') }] };
    }

    const body = result.harvest || '';
    return { content: [{ type: 'text', text: header.join('\n') + '\n\n── harvest (last lines) ──\n' + body }] };
  }

  if (name === 'claws_lifecycle_plan') {
    const resp = await clawsRpc(sock, { cmd: 'lifecycle.plan', plan: args.plan });
    if (!resp.ok) return toolError(`ERROR: ${resp.error}\n${resp.message || ''}`);
    const out = { state: resp.state, idempotent: !!resp.idempotent };
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  }

  if (name === 'claws_lifecycle_advance') {
    const resp = await clawsRpc(sock, { cmd: 'lifecycle.advance', to: args.to, reason: args.reason });
    if (!resp.ok) return toolError(`ERROR: ${resp.error}\n${resp.message || ''}`);
    return { content: [{ type: 'text', text: JSON.stringify({ state: resp.state }, null, 2) }] };
  }

  if (name === 'claws_lifecycle_snapshot') {
    const resp = await clawsRpc(sock, { cmd: 'lifecycle.snapshot' });
    if (!resp.ok) return toolError(`ERROR: ${resp.error}`);
    const text = resp.state
      ? JSON.stringify(resp.state, null, 2)
      : '[no lifecycle state — call claws_lifecycle_plan first]';
    return { content: [{ type: 'text', text }] };
  }

  if (name === 'claws_lifecycle_reflect') {
    const resp = await clawsRpc(sock, { cmd: 'lifecycle.reflect', reflect: args.reflect });
    if (!resp.ok) return toolError(`ERROR: ${resp.error}\n${resp.message || ''}`);
    return { content: [{ type: 'text', text: JSON.stringify({ state: resp.state }, null, 2) }] };
  }

  return toolError(`unknown tool: ${name}`);
}

// ─── MCP server main loop ──────────────────────────────────────────────────

async function main() {
  process.stdin.resume();
  log('MCP server started, socket: ' + getSocket());

  while (true) {
    const msg = await readMessage();
    if (!msg) break;

    const { method, id, params = {} } = msg;

    if (method === 'initialize') {
      log('client connected: ' + ((params && params.clientInfo && params.clientInfo.name) || 'unknown'));
      respond(id, {
        protocolVersion: '2024-11-05',
        // Version must match extension/package.json — bump both together on release.
        serverInfo: { name: 'claws', version: '0.6.1' },
        capabilities: { tools: {} },
      });
    } else if (method === 'notifications/initialized') {
      // no response needed
    } else if (method === 'tools/list') {
      respond(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      try {
        const result = await handleTool(params.name || '', params.arguments || {});
        respond(id, result);
      } catch (e) {
        respond(id, { content: [{ type: 'text', text: `ERROR: ${e.message || e}` }], isError: true });
      }
    } else if (method === 'ping') {
      respond(id, {});
    } else if (id != null) {
      respondError(id, -32601, `unknown method: ${method}`);
    }
  }
}

main().catch(console.error);
