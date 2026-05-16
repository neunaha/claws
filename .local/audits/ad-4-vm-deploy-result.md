# AD-4 VM Deploy + Win32 Paste-Gate Test Result

**Date:** 2026-05-16
**Wave:** AD-4 (prep) — deploy AD-1+AD-2 to Windows VM and run static test
**Branch:** v0.8-alpha

---

## VM Identification

- **IP:** 20.64.202.20 (Azure Windows dogfood VM)
- **Git repo on VM:** `C:\Users\claws\build-prebuilt` (remote: https://github.com/neunaha/claws.git)
- **Note:** Other directories exist (`C:\claws-p7\claws-0.8-alpha`, `C:\Users\claws\claws-src\Claws`) but are extracted tarballs without `.git`. The canonical git checkout is `build-prebuilt`.

---

## Node + Git Versions on VM

- **Node:** v24.15.0
- **Git:** 2.54.0.windows.1
- **Default SSH shell:** cmd.exe (pwsh/powershell not on PATH; `node` and `git` available directly)

---

## Commit State on VM (after pull)

```
94c1292 test(v0.8): paste-gate regression suite (AD-2)
034c3ea fix(v0.8): gate mission paste on confirmed claude pty-claim (AD-1)
00b4517 fix(v0.8): spawn-helper must be executable — bundle-native chmod + runtime check (W8ac-1.1)
62ecb3c feat(v0.8): event-driven boot via correlation_id (W8ac-2)
77409d6 chore(v0.8): bake tri-platform convention into CLAUDE.md + drop orphan W8aa test
```

Both AD-1 and AD-2 commits confirmed present.

---

## Installer Run

Command: `node lib/install.js --no-vsix` (run from repo root)
- `--no-vsix` flag is accepted (silent success, no "unknown flag" error)
- Exit code: 0
- Output: silent (installer produces no stdout/stderr on this path)

---

## paste-gate.test.js (Step 5) — PASS

```
  ✓ helper: _gatePasteOnClaudeClaim function defined
  ✓ helper: _gatePasteOnClaudeClaim takes (sock, termId, corrId, opts)
  ✓ helper: _gatePasteOnClaudeClaim body references _waitForWorkerReady
  ✓ anti-pattern absent: no "best-effort: assume booted, proceed" comment
  ✓ slow-path: runBlockingWorker calls _gatePasteOnClaudeClaim with _bCorrId exactly once
  ✓ fast-path: claws_worker calls _gatePasteOnClaudeClaim with _fpCorrId exactly once
  ✓ dispatch-path: claws_dispatch_subworker calls _gatePasteOnClaudeClaim with _dswSock/_dswCorrId exactly once
  ✓ boot_failed: system.worker.boot_failed topic present in source
  ✓ boot_failed: payload contains cause field
  ✓ boot_failed: payload contains pty_tail field
  ✓ boot_failed: payload contains timeout_ms field
  ✓ boot_failed: payload contains correlation_id field
  ✓ tri-platform: claudeMarkers regex includes "bypass permissions"
  ✓ tri-platform: claudeMarkers regex includes "Claude Code v"
  ✓ tri-platform: shellErrorMarkers regex includes "command not found"
  ✓ tri-platform: shellErrorMarkers regex includes "is not recognized as" (win32)
  ✓ tri-platform: shellErrorMarkers regex includes "bad pattern:" (zsh)
  ✓ defaults: boot_wait_ms is 8000 in DEFAULTS

PASS: 18/18 checks
Exit code: 0
```

**Result: GREEN — all 18 checks pass on win32.**

---

## claws-v2-correlation-events.test.js (Step 6)

```
  ✓ TC1a: claws-pty.ts injects CLAWS_TERMINAL_CORR_ID into pty env when correlationId set
  ✓ TC1b: protocol.ts CreateRequest has correlation_id field
  ✓ TC1c: server.ts create handler extracts correlation_id and passes as correlationId
  ✓ TC4a: vscode-backend.ts has onFirstOutput callback wiring for terminal:ready
  ✓ TC4b: claws-pty.ts firstOutputFired guard ensures onFirstOutputHook fires exactly once
  ✓ TC4c: server.ts listens for terminal:ready and emits system.terminal.ready bus event
  ✓ TC-peer: PeerConnection interface has correlationId field
  ✗ socket ready — no socket after 3s

PASS: 7/8 checks
Exit code: 0
```

**Result: 7/8 static checks pass. The single miss (`socket ready — no socket after 3s`) is expected — no VS Code instance with the Claws extension running on the VM. Runtime checks require a live extension process. Exit code is still 0.**

---

## Blockers for End-to-End Runtime Smoke

The following steps require a live Claws extension (VS Code with Claws installed + running):

1. **User must RDP into the VM** to launch VS Code, open the `build-prebuilt` folder, and ensure the Claws extension is active (socket at `.claws/claws.sock`).
2. Then `/claws-do` can be exercised to validate the AD-1 paste-gate path at runtime (confirm mission lands in Claude, not zsh).
3. Full runtime smoke of AD-1+AD-2 is blocked on user-initiated VS Code session on the VM — cannot be driven remotely via SSH.

---

## Summary

| Check | Result |
|---|---|
| SSH reachable | ✓ |
| node + git on PATH | ✓ (v24.15.0 / 2.54.0.windows.1) |
| AD-1 + AD-2 commits on VM | ✓ (94c1292, 034c3ea) |
| installer `--no-vsix` accepted | ✓ (exit 0) |
| paste-gate.test.js (win32) | ✓ 18/18 PASS |
| claws-v2-correlation-events.test.js (win32) | ✓ 7/8 PASS (1 runtime-only miss expected) |
| Runtime E2E smoke | BLOCKED — needs user RDP + VS Code session |
