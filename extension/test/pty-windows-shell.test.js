#!/usr/bin/env node
// Tests for win32-specific shell behavior in claws-pty.ts.
// All checks verify source-level patterns (no VS Code host or real pty needed).
// Cases align with v0.8 blueprint Mission A §8.2.
// Run: node extension/test/pty-windows-shell.test.js
// Exits 0 on success, 1 on failure. Platform-agnostic.

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const src = fs.readFileSync(
  path.resolve(__dirname, '../src/backends/vscode/claws-pty.ts'),
  'utf8',
);

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message || String(e) });
    console.log(`  FAIL  ${name}: ${e.message || e}`);
  }
}

// 1. defaultShell() returns COMSPEC or powershell.exe on win32
check("defaultShell() returns COMSPEC or powershell.exe on win32", () => {
  // Verify the win32 branch exists in defaultShell()
  const fnRe = /export function defaultShell\(\)[\s\S]{0,500}?win32[\s\S]{0,200}?COMSPEC/;
  assert.ok(
    fnRe.test(src),
    'defaultShell() missing win32 branch that checks COMSPEC — claws-pty.ts needs the win32 guard',
  );
  // Also check the powershell.exe fallback
  assert.ok(
    src.includes('powershell.exe'),
    "defaultShell() missing 'powershell.exe' fallback for win32",
  );
});

// 2. defaultShellArgs() returns [] on win32
check("defaultShellArgs() returns [] on win32", () => {
  // Verify the win32 early-return in defaultShellArgs()
  const fnRe = /export function defaultShellArgs[\s\S]{0,300}?win32[\s\S]{0,100}?return \[\]/;
  assert.ok(
    fnRe.test(src),
    "defaultShellArgs() missing win32 branch returning [] — pgrep-less shells don't need login flags",
  );
});

// 3. getForegroundProcess() returns non-null pid on win32 without calling pgrep
check("getForegroundProcess() returns non-null pid on win32 without calling pgrep", () => {
  // Verify the win32 guard appears BEFORE the pgrep call
  const fnRe = /getForegroundProcess\(\)[\s\S]{0,800}/;
  const match = fnRe.exec(src);
  assert.ok(match, 'getForegroundProcess() method not found in claws-pty.ts');
  const body = match[0];
  const win32Idx = body.indexOf("platform === 'win32'");
  const pgrepIdx = body.indexOf("pgrep");
  assert.ok(
    win32Idx >= 0,
    "getForegroundProcess() missing win32 guard — pgrep will crash on Windows",
  );
  assert.ok(
    win32Idx < pgrepIdx,
    `win32 guard (offset ${win32Idx}) must appear before pgrep call (offset ${pgrepIdx})`,
  );
  // Also verify it returns the pid (not throws)
  assert.ok(
    body.slice(0, pgrepIdx).includes('return {'),
    "win32 branch of getForegroundProcess() must return { pid, basename } before reaching pgrep",
  );
});

// 4. sanitizeEnv drops VSCODE_* on win32 (same as Unix)
check("sanitizeEnv drops VSCODE_/ELECTRON_/npm_ prefixes (platform-agnostic impl)", () => {
  // sanitizeEnv should not have a platform branch — it's pure env key filtering
  const fnRe = /function sanitizeEnv[\s\S]{0,600}/;
  const match = fnRe.exec(src);
  assert.ok(match, 'sanitizeEnv() not found in claws-pty.ts');
  const body = match[0];
  // Verify it strips the expected prefixes
  assert.ok(body.includes('VSCODE_'), "sanitizeEnv must filter VSCODE_ vars");
  assert.ok(body.includes('ELECTRON_'), "sanitizeEnv must filter ELECTRON_ vars");
  // Verify no win32-only branch (should behave identically on all platforms)
  const platformBranchCount = (body.match(/process\.platform/g) || []).length;
  assert.strictEqual(
    platformBranchCount,
    0,
    "sanitizeEnv should not have platform branches — env filtering is platform-agnostic",
  );
});

// 5. ClawsPty.open() shell resolution calls defaultShell() on win32 path
check("ClawsPty.open() uses defaultShell() for shell resolution (win32-compatible)", () => {
  // Verify open() calls defaultShell() rather than hardcoding a Unix path
  const openRe = /open\(initialDimensions[\s\S]{0,600}/;
  const match = openRe.exec(src);
  assert.ok(match, 'ClawsPty.open() not found in claws-pty.ts');
  const body = match[0];
  assert.ok(
    body.includes('defaultShell()'),
    "open() must call defaultShell() for cross-platform shell resolution",
  );
  // Verify it does NOT hardcode /bin/zsh or /bin/bash (would fail on Windows)
  assert.ok(
    !body.includes("'/bin/zsh'") && !body.includes("'/bin/bash'"),
    "open() must not hardcode Unix shell paths — use defaultShell()",
  );
});

const pass = results.filter(r => r.ok).length;
const fail = results.filter(r => !r.ok).length;
console.log(`\npty-windows-shell.test.js: ${pass}/${results.length} PASS`);
if (fail > 0) process.exit(1);
process.exit(0);
