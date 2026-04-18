import * as vscode from 'vscode';
import { CaptureStore } from './capture-store';
import { TerminalManager } from './terminal-manager';
import { ClawsPty } from './claws-pty';
import { ClawsServer } from './server';
import { HistoryEvent } from './protocol';

interface PendingProfile {
  id: string;
  name: string;
  pty: ClawsPty;
}

const DEFAULT_SOCKET_REL = '.claws/claws.sock';
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_HISTORY = 500;
const DEFAULT_MAX_CAPTURE_BYTES = 1024 * 1024;

function cfg<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('claws').get<T>(key, fallback);
}

let server: ClawsServer | null = null;
let outputChannel: vscode.OutputChannel | null = null;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('Claws');
  const logger = (msg: string) => outputChannel!.appendLine(msg);
  logger('[claws] activating (typescript)');

  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wsRoot) {
    logger('[claws] no workspace folder; bridge disabled');
    return;
  }

  const captureStore = new CaptureStore(cfg('maxCaptureBytes', DEFAULT_MAX_CAPTURE_BYTES));
  const terminalManager = new TerminalManager(captureStore, logger);
  terminalManager.adoptExisting(vscode.window.terminals);

  const history: HistoryEvent[] = [];
  let nextSeq = 1;
  const runningExec = new WeakMap<vscode.Terminal, {
    commandLine: string;
    output: string;
    startedAt: number;
  }>();
  const execWaiters = new WeakMap<vscode.Terminal, Array<(ev: HistoryEvent) => void>>();

  const pushEvent = (
    terminal: vscode.Terminal,
    commandLine: string,
    output: string,
    exitCode: number | null,
    startedAt: number,
    endedAt: number,
  ): void => {
    const cap = cfg('maxOutputBytes', DEFAULT_MAX_OUTPUT_BYTES);
    const id = terminalManager.idFor(terminal);
    const ev: HistoryEvent = {
      seq: nextSeq++,
      terminalId: id,
      terminalName: terminal.name,
      commandLine,
      output: output.length > cap
        ? output.slice(0, cap) + `\n[...truncated ${output.length - cap} bytes]`
        : output,
      exitCode,
      startedAt,
      endedAt,
    };
    history.push(ev);
    const maxHist = cfg('maxHistory', DEFAULT_MAX_HISTORY);
    while (history.length > maxHist) history.shift();
    logger(
      `[seq ${ev.seq}] ${ev.terminalName}#${ev.terminalId} exit=${ev.exitCode} ` +
      `cmd=${JSON.stringify((commandLine || '').slice(0, 80))}`,
    );
    const waiters = execWaiters.get(terminal);
    if (waiters && waiters.length) {
      const w = waiters.shift()!;
      w(ev);
    }
  };

  if (typeof vscode.window.onDidStartTerminalShellExecution === 'function') {
    context.subscriptions.push(
      vscode.window.onDidStartTerminalShellExecution(async (e) => {
        const terminal = e.terminal;
        const state = {
          commandLine: e.execution.commandLine?.value || '',
          output: '',
          startedAt: Date.now(),
        };
        runningExec.set(terminal, state);
        try {
          const stream = e.execution.read();
          for await (const chunk of stream) {
            state.output += chunk;
            const cap = cfg('maxOutputBytes', DEFAULT_MAX_OUTPUT_BYTES);
            if (state.output.length > cap * 2) {
              state.output = state.output.slice(-cap * 2);
            }
          }
        } catch (err) {
          logger(`[read error] ${err}`);
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
        const commandLine = state ? state.commandLine : (e.execution.commandLine?.value || '');
        const output = state ? state.output : '';
        pushEvent(
          terminal,
          commandLine,
          output,
          e.exitCode ?? null,
          state?.startedAt ?? Date.now(),
          Date.now(),
        );
      }),
    );
  }

  const pendingProfiles: PendingProfile[] = [];

  context.subscriptions.push(
    vscode.window.onDidOpenTerminal((t) => {
      const idx = pendingProfiles.findIndex((p) => p.name === t.name);
      if (idx >= 0) {
        const pending = pendingProfiles[idx];
        pendingProfiles.splice(idx, 1);
        terminalManager.linkProfileTerminal(pending.id, t, pending.pty);
        logger(`[profile] adopted ${t.name} -> id=${pending.id}`);
        return;
      }
      terminalManager.idFor(t);
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((t) => {
      terminalManager.onTerminalClosed(t);
    }),
  );

  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider('claws.wrappedTerminal', {
      provideTerminalProfile(): vscode.TerminalProfile {
        const id = terminalManager.reserveNextId();
        const name = `Claws Wrapped ${id}`;
        const pty = new ClawsPty({
          terminalId: id,
          cwd: wsRoot,
          captureStore,
          logger,
        });
        pendingProfiles.push({ id, name, pty });
        logger(`[profile] provisioning wrapped terminal id=${id}`);
        return new vscode.TerminalProfile({ name, pty });
      },
    }),
  );

  server = new ClawsServer({
    workspaceRoot: wsRoot,
    socketRel: cfg('socketPath', DEFAULT_SOCKET_REL),
    captureStore,
    terminalManager,
    logger,
    history,
    execWaiters,
  });
  server.start();

  context.subscriptions.push(
    vscode.commands.registerCommand('claws.status', () => {
      outputChannel!.show(true);
      outputChannel!.appendLine(
        `status: socket=${server?.getSocketPath()} terminals=${vscode.window.terminals.length} ` +
        `history=${history.length} seq=${nextSeq}`,
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claws.listTerminals', async () => {
      const rows = await terminalManager.describeAll();
      outputChannel!.show(true);
      outputChannel!.appendLine('--- terminals ---');
      for (const d of rows) {
        const kind = d.wrapped ? 'wrapped(pty)' : d.logPath ? 'wrapped(log)' : 'unwrapped';
        outputChannel!.appendLine(`${d.id}  ${d.name}  pid=${d.pid}  [${kind}]`);
      }
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      server?.stop();
    },
  });
}

export function deactivate(): void {
  server?.stop();
  server = null;
}
