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
    description: 'Spawn a complete VISIBLE worker terminal. Creates a wrapped terminal, launches interactive Claude Code with --dangerously-skip-permissions (full tool access), waits for boot, then sends the mission prompt. The worker runs visibly in VS Code\'s terminal panel. NEVER headless.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Worker name (appears as terminal tab name)' },
        mission: { type: 'string', description: 'Mission prompt to send to Claude Code. Single line. Include MISSION_COMPLETE marker.' },
        launch_claude: { type: 'boolean', description: 'Auto-launch claude --dangerously-skip-permissions (default true)' },
        command: { type: 'string', description: 'Alternative: raw shell command instead of Claude mission. Set launch_claude=false.' },
      },
      required: ['name'],
    },
  },
];

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
    const launchClaude = args.launch_claude !== false;
    const mission = args.mission || args.command || '';

    const createResp = await clawsRpc(sock, {
      cmd: 'create', name: args.name, wrapped: true, show: true,
    });
    if (!createResp.ok) return [{ type: 'text', text: `ERROR creating terminal: ${createResp.error}` }];
    const termId = createResp.id;
    const logPath = createResp.logPath || '';

    await sleep(1500);

    if (launchClaude) {
      await clawsRpc(sock, { cmd: 'send', id: termId, text: 'claude --dangerously-skip-permissions', newline: true });
      await sleep(5000);
      if (mission) {
        await clawsRpc(sock, { cmd: 'send', id: termId, text: mission, newline: true });
        await sleep(300);
        await clawsRpc(sock, { cmd: 'send', id: termId, text: '\r', newline: false });
      }
      return [{ type: 'text', text: [
        `worker '${args.name}' spawned with Claude Code (full permissions)`,
        `  terminal: ${termId}`,
        `  log: ${logPath}`,
        `  claude: interactive, --dangerously-skip-permissions`,
        mission ? `  mission sent: ${mission.slice(0, 100)}...` : '  no mission sent — waiting for prompt',
        '', `use claws_read_log id=${termId} to monitor`,
        `use claws_send id=${termId} to send follow-up prompts`,
        `use claws_close id=${termId} when done`,
      ].join('\n') }];
    } else {
      if (mission) {
        await clawsRpc(sock, { cmd: 'send', id: termId, text: mission, newline: true });
      }
      return [{ type: 'text', text: [
        `worker '${args.name}' spawned (shell mode)`,
        `  terminal: ${termId}`,
        `  log: ${logPath}`,
        mission ? `  command sent: ${mission.slice(0, 100)}` : '  idle shell',
        '', `use claws_read_log id=${termId} to monitor`,
        `use claws_close id=${termId} when done`,
      ].join('\n') }];
    }
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
        serverInfo: { name: 'claws', version: '0.3.0' },
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
