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
 *        claws_read_log, claws_poll, claws_close, claws_worker
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');

// ─── MCP protocol (stdio, Content-Length framing) ──────────────────────────

let inputBuf = '';

function readMessage() {
  return new Promise((resolve) => {
    const tryParse = () => {
      const headerEnd = inputBuf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return false;
      const headerBlock = inputBuf.slice(0, headerEnd);
      const match = headerBlock.match(/content-length:\s*(\d+)/i);
      if (!match) return false;
      const len = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (inputBuf.length < bodyStart + len) return false;
      const body = inputBuf.slice(bodyStart, bodyStart + len);
      inputBuf = inputBuf.slice(bodyStart + len);
      resolve(JSON.parse(body));
      return true;
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
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  process.stdout.write(header + body);
}

function respond(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
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
      resolve({ ok: false, error: `socket error: ${err.message}` });
    });
    sock.on('timeout', () => {
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
        wrapped: { type: 'boolean', description: 'Enable script(1) pty logging for full read-back. Always true for worker terminals.' },
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
  return process.env.CLAWS_SOCKET || '.claws/claws.sock';
}

async function handleTool(name, args) {
  const sock = getSocket();

  if (name === 'claws_list') {
    const resp = await clawsRpc(sock, { cmd: 'list' });
    if (!resp.ok) return [{ type: 'text', text: `ERROR: ${resp.error}` }];
    const terms = resp.terminals || [];
    if (!terms.length) return [{ type: 'text', text: '[no terminals open]' }];
    const lines = terms.map(t => {
      const wrap = t.logPath ? 'WRAPPED' : 'unwrapped';
      const marker = t.active ? '*' : ' ';
      return `${marker} ${t.id}  ${(t.name || '').padEnd(25)} pid=${t.pid}  [${wrap}]`;
    });
    return [{ type: 'text', text: lines.join('\n') }];
  }

  if (name === 'claws_create') {
    const resp = await clawsRpc(sock, {
      cmd: 'create', name: args.name || 'claws',
      cwd: args.cwd, wrapped: args.wrapped || false, show: true,
    });
    if (!resp.ok) return [{ type: 'text', text: `ERROR: ${resp.error}` }];
    let text = `created terminal id=${resp.id}`;
    if (resp.logPath) text += ` wrapped logPath=${resp.logPath}`;
    return [{ type: 'text', text }];
  }

  if (name === 'claws_send') {
    const resp = await clawsRpc(sock, {
      cmd: 'send', id: args.id, text: args.text,
      newline: args.newline !== false,
    });
    if (!resp.ok) return [{ type: 'text', text: `ERROR: ${resp.error}` }];
    return [{ type: 'text', text: 'sent' }];
  }

  if (name === 'claws_exec') {
    const timeoutMs = args.timeout_ms || 180000;
    const result = await fileExec(sock, args.id, args.command, timeoutMs);
    if (!result.ok) {
      let text = `ERROR: ${result.error}`;
      if (result.partial) text += `\n[partial output]\n${result.partial}`;
      return [{ type: 'text', text }];
    }
    return [{ type: 'text', text: `exit ${result.exit_code}\n${result.output}` }];
  }

  if (name === 'claws_read_log') {
    const resp = await clawsRpc(sock, { cmd: 'readLog', id: args.id, strip: true });
    if (!resp.ok) return [{ type: 'text', text: `ERROR: ${resp.error}` }];
    const allLines = (resp.bytes || '').split('\n');
    const n = args.lines || 50;
    const tail = allLines.length > n ? allLines.slice(-n) : allLines;
    const header = `[term ${args.id} · ${resp.totalSize || 0} bytes · showing last ${tail.length} of ${allLines.length} lines]`;
    return [{ type: 'text', text: header + '\n' + tail.join('\n') }];
  }

  if (name === 'claws_poll') {
    const resp = await clawsRpc(sock, { cmd: 'poll', since: args.since || 0 });
    if (!resp.ok) return [{ type: 'text', text: `ERROR: ${resp.error}` }];
    const events = resp.events || [];
    if (!events.length) return [{ type: 'text', text: `[no events · cursor ${resp.cursor || 0}]` }];
    const lines = events.map(e => {
      let line = `[seq ${e.seq} · ${e.terminalName} · exit ${e.exitCode}] $ ${e.commandLine || ''}`;
      if (e.output) {
        const out = e.output.length > 500 ? e.output.slice(0, 500) + '...' : e.output;
        line += '\n' + out;
      }
      return line;
    });
    return [{ type: 'text', text: lines.join('\n') + `\n[cursor ${resp.cursor}]` }];
  }

  if (name === 'claws_close') {
    const resp = await clawsRpc(sock, { cmd: 'close', id: args.id });
    if (!resp.ok) return [{ type: 'text', text: `ERROR: ${resp.error}` }];
    return [{ type: 'text', text: `closed terminal ${args.id}` }];
  }

  if (name === 'claws_worker') {
    const result = await runBlockingWorker(sock, args);

    if (result.status === 'error') {
      return [{ type: 'text', text: `ERROR: ${result.error}` }];
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
      return [{ type: 'text', text: header.join('\n') }];
    }

    const body = result.harvest || '';
    return [{ type: 'text', text: header.join('\n') + '\n\n── harvest (last lines) ──\n' + body }];
  }

  return [{ type: 'text', text: `unknown tool: ${name}` }];
}

// ─── MCP server main loop ──────────────────────────────────────────────────

async function main() {
  process.stdin.resume();

  while (true) {
    const msg = await readMessage();
    if (!msg) break;

    const { method, id, params = {} } = msg;

    if (method === 'initialize') {
      respond(id, {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'claws', version: '0.4.0' },
        capabilities: { tools: {} },
      });
    } else if (method === 'notifications/initialized') {
      // no response needed
    } else if (method === 'tools/list') {
      respond(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      try {
        const content = await handleTool(params.name || '', params.arguments || {});
        respond(id, { content });
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
