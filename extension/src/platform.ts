// extension/src/platform.ts
// Platform type alias and process helper factory for tri-platform discipline (v0.8+).
// win32 branches throw "not implemented" — that's P2 work.

import { spawnSync } from 'child_process';

export type NodePlatform = 'win32' | 'darwin' | 'linux';

export const currentPlatform: NodePlatform = process.platform as NodePlatform;

export const isWindows = currentPlatform === 'win32';
export const isMac     = currentPlatform === 'darwin';
export const isLinux   = currentPlatform === 'linux';

export interface ProcessHelpers {
  /**
   * Return the foreground process running under shellPid.
   * Uses pgrep + ps on darwin/linux. Throws on win32 (P2).
   */
  getForegroundProcess(shellPid: number): { pid: number | null; basename: string | null };
}

/**
 * Return platform-appropriate process helpers.
 * On win32, returns the shell PID and null basename (ConPTY does not expose
 * the foreground process without Win32 API calls — v0.8 stub, improved in v0.8.1).
 */
export function getProcessHelpers(): ProcessHelpers {
  if (currentPlatform === 'win32') {
    return {
      getForegroundProcess(shellPid: number): { pid: number | null; basename: string | null } {
        // Win32 stub: ConPTY process tree requires NtQueryInformationProcess or
        // toolhelp32 — neither is available in pure Node. Return the shell PID
        // so the safety gate can still warn (basename=null → 'unknown' content type).
        return { pid: shellPid, basename: null };
      },
    };
  }

  return {
    getForegroundProcess(shellPid: number): { pid: number | null; basename: string | null } {
      try {
        const pgrepResult = spawnSync('pgrep', ['-P', String(shellPid)], { encoding: 'utf8', timeout: 500 });
        const childOutput = (pgrepResult.stdout ?? '').trim();
        let targetPid: number = shellPid;
        if (childOutput) {
          const childPids = childOutput.split('\n').filter(Boolean);
          const candidatePid = parseInt(childPids[childPids.length - 1] ?? '', 10);
          if (!isNaN(candidatePid)) targetPid = candidatePid;
        }
        const psResult = spawnSync('ps', ['-p', String(targetPid), '-o', 'comm='], { encoding: 'utf8', timeout: 500 });
        let basename = (psResult.stdout ?? '').trim() || null;
        if (!basename && targetPid !== shellPid) {
          const fallback = spawnSync('ps', ['-p', String(shellPid), '-o', 'comm='], { encoding: 'utf8', timeout: 500 });
          basename = (fallback.stdout ?? '').trim() || null;
          targetPid = shellPid;
        }
        return { pid: targetPid, basename };
      } catch {
        return { pid: shellPid, basename: null };
      }
    },
  };
}
