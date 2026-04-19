// Claws status bar item. Right-aligned, priority 100, click → Health Check.
// Color shifts to warning / error based on server + node-pty state.

import * as vscode from 'vscode';
import * as path from 'path';
import { loadNodePtyStatus } from './claws-pty';
import { ClawsServer } from './server';

export interface StatusBarOptions {
  activated: boolean;
  version: string;
  getServers: () => Map<string, ClawsServer>;
  getTerminalCount: () => number;
}

export interface StatusBarHandle {
  item: vscode.StatusBarItem;
  timer: NodeJS.Timeout;
  update: () => void;
  dispose: () => void;
}

/**
 * Create the status bar item and start a 30-second refresh timer. Caller
 * owns the lifecycle — call `dispose()` on deactivate to clear the timer
 * and dispose the item.
 */
export function createStatusBar(
  context: vscode.ExtensionContext,
  opts: StatusBarOptions,
): StatusBarHandle {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.name = 'Claws';
  item.text = '$(terminal) Claws';
  item.command = 'claws.healthCheck';
  item.show();
  context.subscriptions.push(item);

  const update = (): void => renderStatusBar(item, opts);

  // Refresh every 30s so pid counts, node-pty status, socket liveness stay
  // current even without terminal-lifecycle events firing.
  const timer = setInterval(update, 30_000);
  if (typeof timer.unref === 'function') timer.unref();

  update();

  const dispose = (): void => {
    clearInterval(timer);
    try { item.dispose(); } catch { /* ignore */ }
  };

  return { item, timer, update, dispose };
}

function renderStatusBar(item: vscode.StatusBarItem, opts: StatusBarOptions): void {
  const servers = opts.getServers();
  const npty = loadNodePtyStatus();

  let state: 'ok' | 'warn' | 'err' = 'ok';
  let hint = '';

  if (!opts.activated) {
    state = 'err';
    hint = 'bridge disabled (no workspace open)';
  } else if (servers.size === 0) {
    state = 'err';
    hint = 'no socket servers running';
  } else if (npty.loaded === false && npty.error) {
    state = 'warn';
    hint = 'pipe-mode (node-pty not loaded)';
  }

  const termCount = opts.getTerminalCount();
  const iconPrefix = state === 'err' ? '$(error)' : state === 'warn' ? '$(warning)' : '$(terminal)';
  item.text = `${iconPrefix} Claws${termCount > 0 ? ` (${termCount})` : ''}`;
  item.color = state === 'err'
    ? new vscode.ThemeColor('statusBarItem.errorForeground')
    : state === 'warn'
      ? new vscode.ThemeColor('statusBarItem.warningForeground')
      : undefined;

  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown(`**Claws** · v${opts.version}\n\n`);
  if (hint) tooltip.appendMarkdown(`_${hint}_\n\n`);
  tooltip.appendMarkdown(`**Sockets** (${servers.size}):\n`);
  if (servers.size === 0) {
    tooltip.appendMarkdown(`· _none_\n`);
  } else {
    for (const [root, srv] of servers.entries()) {
      tooltip.appendMarkdown(`· \`${path.basename(root)}\` → \`${srv.getSocketPath() ?? '(pending)'}\`\n`);
    }
  }
  tooltip.appendMarkdown(`\n**Terminals**: ${termCount}\n\n`);
  tooltip.appendMarkdown(`**node-pty**: ${npty.loaded ? 'loaded' : npty.error ? 'not loaded (pipe-mode)' : 'not attempted yet'}\n\n`);
  tooltip.appendMarkdown(`_Click for Health Check_`);
  item.tooltip = tooltip;
}
