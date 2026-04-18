// Claws — Terminal Control Bridge for VS Code.
//
// Protocol: newline-delimited JSON over ${workspace}/.claws/claws.sock
// Every request: { id, cmd, ...args }
// Every response: { id, ok, ...fields } or { id, ok:false, error }
//
// Commands:
//   list                               -> { terminals: [{id,name,pid,hasShellIntegration,active,logPath}] }
//   create {name?, cwd?, show?, wrapped?} -> { id, logPath? }
//   show {id, preserveFocus?}          -> {}
//   send {id, text, newline?}          -> {}
//   exec {id, command, timeoutMs?}     -> { commandLine, output, exitCode }
//   read {id?, since?, limit?}         -> { events: [...] }
//   poll {since?}                      -> { events: [...], cursor }
//   readLog {id, offset?, limit?, strip?} -> { bytes, truncated, logPath }
//   close {id}                         -> {}
//
// Events are {seq, terminalId, terminalName, commandLine, output, exitCode, startedAt, endedAt}.

const vscode = require('vscode');
const net = require('net');
const fs = require('fs');
const path = require('path');

// Defaults — overridden by contributes.configuration in package.json.
const DEFAULT_SOCKET_REL = '.claws/claws.sock';
const DEFAULT_LOG_DIR_REL = '.claws/terminals';
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_HISTORY = 500;
const MAX_READLOG_BYTES = 512 * 1024;

// Strip ANSI / control sequences for clean text from a pty log.
const ANSI_PATTERN = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-ntqry=><]/g;
const CTRL_PATTERN = /[\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f]/g;

function getConfig(key, fallback) {
  return vscode.workspace.getConfiguration('claws').get(key, fallback);
}

let server = null;
let socketPath = null;
const outputChannel = vscode.window.createOutputChannel('Claws');

const terminalIds = new WeakMap();
let nextTerminalId = 1;

const terminalLogPaths = new Map();

const pendingWrappedProfiles = [];

const runningExec = new WeakMap();

const history = [];
let nextSeq = 1;

const execWaiters = new WeakMap();

function idFor(terminal) {
  let id = terminalIds.get(terminal);
  if (id == null) {
    id = String(nextTerminalId++);
    terminalIds.set(terminal, id);
  }
  return id;
}

function terminalById(id) {
  for (const t of vscode.window.terminals) {
    if (idFor(t) === String(id)) return t;
  }
  return null;
}

async function describeTerminal(t) {
  let pid = null;
  try { pid = await t.processId; } catch {}
  const id = idFor(t);
  return {
    id,
    name: t.name,
    pid,
    hasShellIntegration: !!t.shellIntegration,
    active: vscode.window.activeTerminal === t,
    logPath: terminalLogPaths.get(id) || null,
  };
}

function maxOutputBytes() {
  return getConfig('maxOutputBytes', DEFAULT_MAX_OUTPUT_BYTES);
}

function maxHistory() {
  return getConfig('maxHistory', DEFAULT_MAX_HISTORY);
}

function pushEvent(terminal, commandLine, output, exitCode, startedAt, endedAt) {
  const cap = maxOutputBytes();
  const ev = {
    seq: nextSeq++,
    terminalId: idFor(terminal),
    terminalName: terminal.name,
    commandLine,
    output: output.length > cap
      ? output.slice(0, cap) + `\n[...truncated ${output.length - cap} bytes]`
      : output,
    exitCode: exitCode ?? null,
    startedAt,
    endedAt,
  };
  history.push(ev);
  const cap2 = maxHistory();
  while (history.length > cap2) history.shift();
  outputChannel.appendLine(
    `[seq ${ev.seq}] ${ev.terminalName}#${ev.terminalId} exit=${ev.exitCode} ` +
    `cmd=${JSON.stringify((commandLine || '').slice(0, 80))}`
  );

  const waiters = execWaiters.get(terminal);
  if (waiters && waiters.length) {
    const w = waiters.shift();
    w(ev);
  }
}

function attachShellIntegrationListeners(context) {
  if (typeof vscode.window.onDidStartTerminalShellExecution === 'function') {
    context.subscriptions.push(
      vscode.window.onDidStartTerminalShellExecution(async (e) => {
        const terminal = e.terminal;
        const state = {
          commandLine: (e.execution.commandLine && e.execution.commandLine.value) || '',
          output: '',
          startedAt: Date.now(),
        };
        runningExec.set(terminal, state);
        try {
          const stream = e.execution.read();
          for await (const chunk of stream) {
            state.output += chunk;
            const cap = maxOutputBytes();
            if (state.output.length > cap * 2) {
              state.output = state.output.slice(-cap * 2);
            }
          }
        } catch (err) {
          outputChannel.appendLine(`[read error] ${err}`);
        }
      }),
    );
  }

  if (typeof vscode.window.onDidEndTerminalShellExecution === 'function') {
    context.subscriptions.push(
      vscode.window.onDidEndTerminalShellExecution((e) => {
        const terminal = e.terminal;
        const state = runningExec.get(terminal);
        runningExec.delete(terminal);
        const commandLine = state ? state.commandLine
          : ((e.execution.commandLine && e.execution.commandLine.value) || '');
        const output = state ? state.output : '';
        pushEvent(terminal, commandLine, output, e.exitCode, state?.startedAt ?? Date.now(), Date.now());
      }),
    );
  }
}

// Resolve the terminal-wrapper.sh script path.
// Priority: workspace-local scripts/terminal-wrapper.sh > extension-bundled.
function resolveWrapperScript(wsRoot, extensionPath) {
  const local = path.join(wsRoot, 'scripts', 'terminal-wrapper.sh');
  if (fs.existsSync(local)) return local;
  const bundled = path.join(extensionPath, '..', 'scripts', 'terminal-wrapper.sh');
  if (fs.existsSync(bundled)) return bundled;
  // Fallback: look in extension src directory
  const srcBundled = path.join(extensionPath, 'scripts', 'terminal-wrapper.sh');
  if (fs.existsSync(srcBundled)) return srcBundled;
  return null;
}

async function handle(req, extensionPath) {
  const { cmd } = req || {};
  if (cmd === 'list') {
    const out = [];
    for (const t of vscode.window.terminals) {
      out.push(await describeTerminal(t));
    }
    return { ok: true, terminals: out };
  }

  if (cmd === 'create') {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const wantWrapped = req.wrapped === true && !!wsRoot;

    // Wrapped terminals depend on script(1), a POSIX bash utility. On Windows
    // there is no equivalent; silently opening an unwrapped shell would make
    // every later `read_log` fail opaquely. Refuse explicitly until v0.4
    // ships native Pseudoterminal + ConPTY support.
    if (wantWrapped && process.platform === 'win32') {
      return {
        ok: false,
        error:
          'wrapped=true is not supported on Windows yet — script(1) is POSIX-only. ' +
          'Native Pseudoterminal/ConPTY support ships in v0.4. ' +
          'Workaround: use wrapped=false; output capture works via claws_exec on any platform.',
      };
    }

    const reservedId = String(nextTerminalId++);
    let logPath = null;
    const options = {
      name: req.name || 'claws',
      cwd: req.cwd,
      shellPath: req.shellPath,
    };

    if (wantWrapped) {
      const logDir = getConfig('logDirectory', DEFAULT_LOG_DIR_REL);
      logPath = path.join(wsRoot, logDir, `claws-${reservedId}.log`);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      const wrapperPath = resolveWrapperScript(wsRoot, extensionPath);
      if (!wrapperPath) {
        return { ok: false, error: 'terminal-wrapper.sh not found. Place it in workspace scripts/ or extension scripts/' };
      }
      options.shellPath = wrapperPath;
      options.env = {
        ...(req.env || {}),
        CLAWS_TERM_LOG: logPath,
      };
    }

    const t = vscode.window.createTerminal(options);
    terminalIds.set(t, reservedId);
    if (logPath) terminalLogPaths.set(reservedId, logPath);
    if (req.show !== false) t.show(req.preserveFocus !== false);
    return { ok: true, id: reservedId, logPath };
  }

  if (cmd === 'show') {
    const t = terminalById(req.id);
    if (!t) return { ok: false, error: `unknown terminal id ${req.id}` };
    t.show(req.preserveFocus !== false);
    return { ok: true };
  }

  if (cmd === 'send') {
    const t = terminalById(req.id);
    if (!t) return { ok: false, error: `unknown terminal id ${req.id}` };
    if (req.show !== false) t.show(true);
    t.sendText(req.text ?? '', req.newline !== false);
    return { ok: true };
  }

  if (cmd === 'exec') {
    const t = terminalById(req.id);
    if (!t) return { ok: false, error: `unknown terminal id ${req.id}` };
    if (req.show !== false) t.show(true);
    if (!t.shellIntegration) {
      t.sendText(req.command, true);
      return {
        ok: true,
        degraded: true,
        note: 'no shell integration active; output not captured. Re-run after shell integration activates.',
      };
    }
    const timeoutMs = req.timeoutMs || 180000;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = execWaiters.get(t) || [];
        const idx = list.indexOf(resolver);
        if (idx >= 0) list.splice(idx, 1);
        reject(new Error(`exec timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const resolver = (ev) => { clearTimeout(timer); resolve(ev); };
      const list = execWaiters.get(t) || [];
      list.push(resolver);
      execWaiters.set(t, list);
      try {
        t.shellIntegration.executeCommand(req.command);
      } catch (err) {
        clearTimeout(timer);
        const lst = execWaiters.get(t) || [];
        const idx = lst.indexOf(resolver);
        if (idx >= 0) lst.splice(idx, 1);
        reject(err);
      }
    });
    return { ok: true, event: result };
  }

  if (cmd === 'read') {
    const sinceSeq = req.since ?? 0;
    const limit = req.limit ?? 50;
    const filtered = history.filter((ev) => {
      if (ev.seq <= sinceSeq) return false;
      if (req.id != null && ev.terminalId !== String(req.id)) return false;
      return true;
    });
    const slice = filtered.slice(-limit);
    return {
      ok: true,
      events: slice,
      cursor: slice.length ? slice[slice.length - 1].seq : sinceSeq,
    };
  }

  if (cmd === 'poll') {
    const sinceSeq = req.since ?? 0;
    const events = history.filter((ev) => ev.seq > sinceSeq);
    return {
      ok: true,
      events,
      cursor: events.length ? events[events.length - 1].seq : sinceSeq,
    };
  }

  if (cmd === 'close') {
    const t = terminalById(req.id);
    if (!t) return { ok: false, error: `unknown terminal id ${req.id}` };
    t.dispose();
    terminalLogPaths.delete(String(req.id));
    return { ok: true };
  }

  if (cmd === 'readLog') {
    const id = String(req.id);
    const logPath = terminalLogPaths.get(id);
    if (!logPath) return { ok: false, error: `terminal ${id} is not wrapped (no log path)` };
    if (!fs.existsSync(logPath)) return { ok: true, bytes: '', truncated: false, logPath };
    try {
      const stat = fs.statSync(logPath);
      const totalSize = stat.size;
      const limit = Math.min(req.limit || MAX_READLOG_BYTES, MAX_READLOG_BYTES);
      let offset = req.offset;
      if (offset == null) offset = Math.max(0, totalSize - limit);
      const fd = fs.openSync(logPath, 'r');
      try {
        const buf = Buffer.alloc(Math.min(limit, totalSize - offset));
        fs.readSync(fd, buf, 0, buf.length, offset);
        let text = buf.toString('utf8');
        if (req.strip !== false) {
          text = text.replace(ANSI_PATTERN, '').replace(CTRL_PATTERN, '');
        }
        return {
          ok: true,
          bytes: text,
          offset,
          nextOffset: offset + buf.length,
          totalSize,
          truncated: totalSize > offset + buf.length,
          logPath,
        };
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      return { ok: false, error: `read failed: ${err.message || err}` };
    }
  }

  return { ok: false, error: `unknown cmd: ${cmd}` };
}

// Probe an existing socket file. Returns true if something responds (i.e.
// another VS Code window owns it); false if the socket is stale/refused.
function probeSocket(sockPath, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.createConnection(sockPath);
    let settled = false;
    const finish = (alive) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolve(alive);
    };
    sock.on('connect', () => {
      sock.write(JSON.stringify({ id: 0, cmd: 'list' }) + '\n');
    });
    sock.on('data', () => finish(true));
    sock.on('error', () => finish(false));
    setTimeout(() => finish(false), timeoutMs);
  });
}

async function startServer(context) {
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wsRoot) {
    outputChannel.appendLine('[claws] no workspace folder; bridge disabled');
    return;
  }
  const socketRel = getConfig('socketPath', DEFAULT_SOCKET_REL);
  // Use a local until we've actually claimed ownership. Assigning the
  // module-level `socketPath` too early would cause our dispose() / deactivate()
  // to unlink another window's socket if we later refuse to start.
  const candidatePath = path.join(wsRoot, socketRel);
  const clawsDir = path.dirname(candidatePath);
  fs.mkdirSync(clawsDir, { recursive: true });

  // Privacy: pty logs and the socket live here. They contain typed passwords,
  // tokens in error messages, and full command history. Auto-write a
  // .gitignore so a fresh `git add .` never leaks them. Idempotent.
  const gitignorePath = path.join(clawsDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    try {
      fs.writeFileSync(gitignorePath, '*\n!.gitignore\n');
      outputChannel.appendLine(`[claws] wrote ${gitignorePath} (privacy: prevents committing pty logs)`);
    } catch (err) {
      outputChannel.appendLine(`[claws] could not write .gitignore: ${err.message}`);
    }
  }

  // Workspace collision detection: if a socket already exists at this path,
  // probe it before unlinking. If another VS Code window is alive on this
  // workspace, do NOT clobber its socket — refuse to start, and crucially do
  // NOT set the module-level `socketPath` (otherwise our cleanup would later
  // unlink the other window's socket). Only unlink if genuinely stale.
  if (fs.existsSync(candidatePath)) {
    const probeOk = await probeSocket(candidatePath, 500);
    if (probeOk) {
      const msg = `Another VS Code window already owns this workspace's Claws socket (${candidatePath}). ` +
        `Close the other window, or open a different workspace, then reload this one.`;
      outputChannel.appendLine(`[claws] REFUSE: ${msg}`);
      vscode.window.showErrorMessage(`Claws: ${msg}`);
      return;
    }
    outputChannel.appendLine(`[claws] removing stale socket at ${candidatePath}`);
    try { fs.unlinkSync(candidatePath); } catch {}
  }

  // Take ownership now that we're past the collision check.
  socketPath = candidatePath;

  const extPath = context.extensionPath;

  server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (data) => {
      buf += data.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch (err) {
          socket.write(JSON.stringify({ ok: false, error: 'bad json' }) + '\n');
          continue;
        }
        handle(req, extPath).then((resp) => {
          socket.write(JSON.stringify({ id: req.id, ...resp }) + '\n');
        }).catch((err) => {
          socket.write(JSON.stringify({ id: req.id, ok: false, error: String(err && err.message || err) }) + '\n');
        });
      }
    });
    socket.on('error', (err) => {
      outputChannel.appendLine(`[socket error] ${err}`);
    });
  });

  server.listen(socketPath, () => {
    try { fs.chmodSync(socketPath, 0o600); } catch {}
    outputChannel.appendLine(`[claws] listening on ${socketPath}`);
  });
  server.on('error', (err) => {
    outputChannel.appendLine(`[server error] ${err}`);
  });
}

function activate(context) {
  outputChannel.appendLine('[claws] activating');

  attachShellIntegrationListeners(context);
  // startServer is async (probes any pre-existing socket); fire-and-log.
  startServer(context).catch((err) => {
    outputChannel.appendLine(`[claws] startServer failed: ${err && err.message || err}`);
  });

  for (const t of vscode.window.terminals) idFor(t);

  context.subscriptions.push(
    vscode.window.onDidOpenTerminal((t) => {
      const match = /^Claws Wrapped (\d+)$/.exec(t.name || '');
      if (match) {
        const reservedId = match[1];
        const idx = pendingWrappedProfiles.findIndex((p) => p.reservedId === reservedId);
        if (idx >= 0) {
          const pending = pendingWrappedProfiles[idx];
          pendingWrappedProfiles.splice(idx, 1);
          terminalIds.set(t, reservedId);
          terminalLogPaths.set(reservedId, pending.logPath);
          outputChannel.appendLine(
            `[profile] adopted ${t.name} -> id=${reservedId} log=${pending.logPath}`,
          );
          return;
        }
      }
      idFor(t);
    }),
  );

  // Wrapped terminal profile is only registered on POSIX. On Windows the
  // dropdown entry would silently open a non-wrapped shell — see the same
  // refusal in the `create` command handler. Hide it entirely instead.
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (wsRoot && process.platform !== 'win32') {
    context.subscriptions.push(
      vscode.window.registerTerminalProfileProvider('claws.wrappedTerminal', {
        provideTerminalProfile() {
          const reservedId = String(nextTerminalId++);
          const logDir = getConfig('logDirectory', DEFAULT_LOG_DIR_REL);
          const logPath = path.join(wsRoot, logDir, `claws-${reservedId}.log`);
          try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch {}
          pendingWrappedProfiles.push({ reservedId, logPath });
          outputChannel.appendLine(
            `[profile] provisioning wrapped terminal id=${reservedId} log=${logPath}`,
          );
          const wrapperPath = resolveWrapperScript(wsRoot, context.extensionPath);
          if (!wrapperPath) {
            outputChannel.appendLine('[profile] WARNING: terminal-wrapper.sh not found');
          }
          return new vscode.TerminalProfile({
            name: `Claws Wrapped ${reservedId}`,
            shellPath: wrapperPath || process.env.SHELL || '/bin/zsh',
            cwd: wsRoot,
            env: { CLAWS_TERM_LOG: logPath },
          });
        },
      }),
    );
  } else if (wsRoot && process.platform === 'win32') {
    outputChannel.appendLine(
      '[claws] Windows detected — wrapped terminal profile disabled. ' +
      'Use unwrapped terminals; native Pseudoterminal/ConPTY ships in v0.4.',
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('claws.status', () => {
      outputChannel.show(true);
      outputChannel.appendLine(
        `status: socket=${socketPath} terminals=${vscode.window.terminals.length} history=${history.length} seq=${nextSeq}`,
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claws.listTerminals', async () => {
      const items = [];
      for (const t of vscode.window.terminals) {
        const desc = await describeTerminal(t);
        const wrap = desc.logPath ? 'wrapped' : 'unwrapped';
        items.push(`${desc.id}  ${desc.name}  pid=${desc.pid}  [${wrap}]`);
      }
      outputChannel.show(true);
      outputChannel.appendLine('--- terminals ---');
      items.forEach((i) => outputChannel.appendLine(i));
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      try { server && server.close(); } catch {}
      try { socketPath && fs.unlinkSync(socketPath); } catch {}
    },
  });
}

function deactivate() {
  try { server && server.close(); } catch {}
  try { socketPath && fs.unlinkSync(socketPath); } catch {}
}

module.exports = { activate, deactivate };
