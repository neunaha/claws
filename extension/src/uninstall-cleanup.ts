// Uninstall-cleanup command implementation.
//
// Inventories Claws-installed files across the currently-open workspace
// folders and, on explicit per-folder confirmation, removes only what was
// actually installed. Never touches files Claws didn't put there (edits to
// JSON / markdown surgically strip only the `claws` entries).

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface CleanupAction {
  action: 'rmdir' | 'rm' | 'edit-json' | 'edit-markdown';
  path: string;
  /** Extra context for edit-* actions. */
  note?: string;
}

export interface CleanupResult {
  removed: number;
  failed: number;
}

/**
 * Register the `claws.uninstallCleanup` command. The command:
 *   1. Shows a modal warning
 *   2. For each currently-open workspace folder, plans + confirms + executes
 *   3. Prints a summary to the Output channel
 *   4. Guides the user to uninstall the extension itself manually
 */
export function registerUninstallCleanupCommand(
  context: vscode.ExtensionContext,
  logger: (msg: string) => void,
  showOutput: () => void,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('claws.uninstallCleanup', async () => {
      const confirm = await vscode.window.showInformationMessage(
        'Claws: Uninstall Cleanup — this will remove Claws-installed files from your currently-open workspace folders. The VS Code extension itself must be uninstalled manually afterwards. Continue?',
        { modal: true },
        'Continue',
        'Cancel',
      );
      if (confirm !== 'Continue') return;

      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) {
        vscode.window.showWarningMessage('Claws: no workspace folders open. Nothing to clean.');
        return;
      }

      showOutput();
      logger('');
      logger('── Claws: Uninstall Cleanup ──');

      const summary: string[] = [];
      for (const folder of folders) {
        const root = folder.uri.fsPath;
        const plan = planCleanup(root);
        if (plan.length === 0) {
          logger(`[cleanup] ${root}: nothing to remove`);
          continue;
        }
        const detail = plan.map((p) => `  ${p.action}: ${p.path}`).join('\n');
        logger(`[cleanup] ${root}: planned removals:\n${detail}`);
        const proceed = await vscode.window.showWarningMessage(
          `Claws: clean up files in ${path.basename(root)}?\n\n${plan.map((p) => `${p.action}: ${path.relative(root, p.path)}`).join('\n')}`,
          { modal: true },
          'Remove',
          'Skip',
        );
        if (proceed !== 'Remove') {
          logger(`[cleanup] ${root}: SKIPPED by user`);
          continue;
        }
        const results = executeCleanup(plan, logger);
        summary.push(`${root}: ${results.removed} removed, ${results.failed} failed`);
      }

      logger('');
      logger('── cleanup summary ──');
      if (summary.length === 0) {
        logger('no folders were cleaned');
      } else {
        for (const s of summary) logger(`  ${s}`);
      }
      logger('');
      logger('Next step: uninstall the "Claws" extension from the VS Code Extensions panel.');
      vscode.window.showInformationMessage(
        'Claws cleanup complete. Uninstall the VS Code extension manually from the Extensions panel to finish.',
      );
    }),
  );
}

/**
 * Build a plan of cleanup actions for a single workspace folder. Returns an
 * empty array if nothing Claws-installed is detected — the command uses this
 * to skip folder confirmation prompts for folders with nothing to remove.
 */
export function planCleanup(root: string): CleanupAction[] {
  const plan: CleanupAction[] = [];
  const push = (a: CleanupAction) => plan.push(a);

  const mcpJson = path.join(root, '.mcp.json');
  if (fs.existsSync(mcpJson)) {
    // Only target when it actually has a claws entry.
    try {
      const raw = fs.readFileSync(mcpJson, 'utf8');
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      if (parsed.mcpServers && 'claws' in parsed.mcpServers) {
        push({ action: 'edit-json', path: mcpJson, note: 'drop mcpServers.claws' });
      }
    } catch { /* malformed — skip */ }
  }

  const clawsBin = path.join(root, '.claws-bin');
  if (fs.existsSync(clawsBin)) push({ action: 'rmdir', path: clawsBin });

  const cmdsDir = path.join(root, '.claude', 'commands');
  if (fs.existsSync(cmdsDir)) {
    for (const entry of fs.readdirSync(cmdsDir)) {
      if (entry.startsWith('claws-') && entry.endsWith('.md')) {
        push({ action: 'rm', path: path.join(cmdsDir, entry) });
      }
    }
  }

  const rulesFile = path.join(root, '.claude', 'rules', 'claws-default-behavior.md');
  if (fs.existsSync(rulesFile)) push({ action: 'rm', path: rulesFile });

  for (const skill of ['claws-orchestration-engine', 'claws-prompt-templates']) {
    const p = path.join(root, '.claude', 'skills', skill);
    if (fs.existsSync(p)) push({ action: 'rmdir', path: p });
  }

  const extensionsJson = path.join(root, '.vscode', 'extensions.json');
  if (fs.existsSync(extensionsJson)) {
    try {
      const raw = fs.readFileSync(extensionsJson, 'utf8');
      const parsed = JSON.parse(raw) as { recommendations?: unknown };
      const recs = Array.isArray(parsed.recommendations) ? parsed.recommendations as string[] : [];
      if (recs.includes('neunaha.claws')) {
        push({ action: 'edit-json', path: extensionsJson, note: 'drop recommendations[neunaha.claws]' });
      }
    } catch { /* malformed — skip */ }
  }

  const claudeMd = path.join(root, 'CLAUDE.md');
  if (fs.existsSync(claudeMd)) {
    try {
      const raw = fs.readFileSync(claudeMd, 'utf8');
      if (raw.includes('<!-- CLAWS:BEGIN -->') && raw.includes('<!-- CLAWS:END -->')) {
        push({ action: 'edit-markdown', path: claudeMd, note: 'strip CLAWS fenced block' });
      }
    } catch { /* ignore */ }
  }

  return plan;
}

/**
 * Execute a cleanup plan. Each action runs in a try/catch so one failure
 * does not abort the rest. Logs each operation's outcome and returns a
 * tally for the summary line.
 */
export function executeCleanup(
  plan: CleanupAction[],
  logger: (msg: string) => void,
): CleanupResult {
  let removed = 0;
  let failed = 0;
  for (const action of plan) {
    try {
      if (action.action === 'rm') {
        fs.unlinkSync(action.path);
        logger(`[cleanup]   ✓ rm ${action.path}`);
      } else if (action.action === 'rmdir') {
        fs.rmSync(action.path, { recursive: true, force: true });
        logger(`[cleanup]   ✓ rmdir ${action.path}`);
      } else if (action.action === 'edit-json') {
        const raw = fs.readFileSync(action.path, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (path.basename(action.path) === '.mcp.json') {
          const servers = parsed.mcpServers as Record<string, unknown> | undefined;
          if (servers) delete servers.claws;
        } else if (path.basename(action.path) === 'extensions.json') {
          const recs = parsed.recommendations as string[] | undefined;
          if (Array.isArray(recs)) {
            parsed.recommendations = recs.filter((r) => r !== 'neunaha.claws');
          }
        }
        fs.writeFileSync(action.path, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
        logger(`[cleanup]   ✓ edit-json ${action.path} (${action.note})`);
      } else if (action.action === 'edit-markdown') {
        const raw = fs.readFileSync(action.path, 'utf8');
        const stripped = raw.replace(
          /<!-- CLAWS:BEGIN -->[\s\S]*?<!-- CLAWS:END -->\n?/g,
          '',
        );
        fs.writeFileSync(action.path, stripped, 'utf8');
        logger(`[cleanup]   ✓ edit-markdown ${action.path} (${action.note})`);
      }
      removed += 1;
    } catch (err) {
      logger(`[cleanup]   ✗ ${action.action} ${action.path} — ${(err as Error).message}`);
      failed += 1;
    }
  }
  return { removed, failed };
}
