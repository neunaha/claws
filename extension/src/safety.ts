import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

const SHELL_NAMES = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh']);
const KNOWN_TUIS = new Set([
  'claude', 'vim', 'nvim', 'emacs', 'less', 'more', 'top', 'htop',
  'nano', 'micro', 'tig', 'lazygit', 'k9s', 'btop', 'ranger',
]);

export interface ForegroundInfo {
  processName: string | null;
  isShell: boolean;
  isKnownTui: boolean;
}

export async function foregroundProcess(pid: number | null): Promise<ForegroundInfo> {
  if (!pid) return { processName: null, isShell: false, isKnownTui: false };
  try {
    const { stdout } = await execFileP('ps', ['-o', 'comm=', '-g', String(pid)], { timeout: 500 });
    const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    const foreground = lines[lines.length - 1] || null;
    if (!foreground) return { processName: null, isShell: false, isKnownTui: false };
    const base = foreground.split('/').pop() || foreground;
    return {
      processName: base,
      isShell: SHELL_NAMES.has(base),
      isKnownTui: KNOWN_TUIS.has(base),
    };
  } catch {
    return { processName: null, isShell: false, isKnownTui: false };
  }
}
