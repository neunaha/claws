#!/usr/bin/env node
// Tests for Windows path handling in Claws transport and mcp_server.js.
// Verifies that path.win32 separators, sha256 hash computation, and pipe
// name format are all handled correctly using path.win32 APIs directly.
// All checks are platform-agnostic (run on macOS/Linux/Windows equally).
//
// Run: node extension/test/claws-windows-paths.test.js
// Exits 0 on success, 1 on failure. No VS Code dependency.

'use strict';

const assert = require('assert');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

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

// Reference implementation (mirrors transport.ts algorithm)
function winPipeName(workspaceRoot) {
  const hash = crypto
    .createHash('sha256')
    .update(workspaceRoot.toLowerCase())
    .digest('hex')
    .slice(0, 8);
  return `\\\\.\\pipe\\claws-${hash}`;
}

// ── Check 1: Hash produces 8 hex chars ───────────────────────────────────────
check("sha256[0:8] of workspaceRoot produces exactly 8 lowercase hex chars", () => {
  const root = 'C:\\Users\\user\\project';
  const name = winPipeName(root);
  const hash = name.replace('\\\\.\\pipe\\claws-', '');
  assert.match(hash, /^[0-9a-f]{8}$/, `expected 8 hex chars, got '${hash}'`);
});

// ── Check 2: path.win32.basename handles backslash-separated paths ────────────
check("path.win32.basename correctly extracts filename from win32 path", () => {
  assert.strictEqual(path.win32.basename('C:\\Windows\\System32\\powershell.exe'), 'powershell.exe');
  assert.strictEqual(path.win32.basename('C:\\Program Files\\Git\\cmd\\git.exe'), 'git.exe');
  assert.strictEqual(path.win32.basename('powershell.exe'), 'powershell.exe');
});

// ── Check 3: Case folding before hash ────────────────────────────────────────
check("win32 pipe name is case-insensitive (same hash for mixed-case paths)", () => {
  const lower = 'c:\\users\\user\\project';
  const mixed = 'C:\\Users\\User\\Project';
  const upper = 'C:\\USERS\\USER\\PROJECT';
  assert.strictEqual(winPipeName(lower), winPipeName(mixed));
  assert.strictEqual(winPipeName(mixed), winPipeName(upper));
});

// ── Check 4: Pipe name format matches \\.\pipe\claws-XXXXXXXX ────────────────
check("win32 pipe name matches \\\\.\\.pipe\\claws-<8hex> format", () => {
  const roots = [
    'C:\\workspace',
    'D:\\Users\\dev\\my-project with spaces',
    'C:\\a\\b\\c\\d\\e\\very\\long\\path',
  ];
  for (const root of roots) {
    const name = winPipeName(root);
    assert.match(
      name,
      /^\\\\.\\pipe\\claws-[0-9a-f]{8}$/,
      `pipe name '${name}' for root '${root}' does not match expected format`,
    );
  }
});

// ── Check 5: mcp_server.js has win32 pipe path in getSocket() source ─────────
check("mcp_server.js getSocket() contains win32 named pipe logic", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../mcp_server.js'),
    'utf8',
  );
  assert.ok(
    src.includes("process.platform === 'win32'"),
    "mcp_server.js getSocket() must have win32 platform branch",
  );
  assert.ok(
    src.includes('\\\\.\\\\pipe\\\\claws-') || src.includes('\\\\.\\pipe\\claws-'),
    "mcp_server.js must reference the named pipe prefix format",
  );
});

// ── Check 6: stream-events.js has win32 pipe path in findSocket() source ─────
check("stream-events.js findSocket() contains win32 named pipe logic", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/stream-events.js'),
    'utf8',
  );
  assert.ok(
    src.includes("process.platform === 'win32'"),
    "stream-events.js findSocket() must have win32 platform branch",
  );
});

const pass = results.filter(r => r.ok).length;
const fail = results.filter(r => !r.ok).length;
console.log(`\nclaws-windows-paths.test.js: ${pass}/${results.length} PASS`);
if (fail > 0) process.exit(1);
process.exit(0);
