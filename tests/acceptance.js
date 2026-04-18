#!/usr/bin/env node
// Claws VS Code extension — Layer 1 acceptance test.
// Pure Node.js stdlib. Zero dependencies.
//
// Runs 8 checks in order against the Claws Unix socket at .claws/claws.sock
// relative to the project root (parent of this tests/ directory).
//
// Exit code: 0 iff all 8 checks pass.

'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ----- config / paths --------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SOCKET_PATH = path.join(PROJECT_ROOT, '.claws', 'claws.sock');

const SOCKET_TIMEOUT_MS = 10_000;
const SHELL_BOOT_WAIT_MS = 2_000;
const POST_SEND_WAIT_MS = 2_000;
const LOG_SCAN_TAIL_LINES = 5_000;
const LOG_FRESH_WINDOW_MS = 5 * 60 * 1_000; // 5 minutes

// ANSI color helpers (ignored if not a TTY).
const USE_COLOR = process.stdout.isTTY;
const GREEN = USE_COLOR ? '\x1b[32m' : '';
const RED = USE_COLOR ? '\x1b[31m' : '';
const YELLOW = USE_COLOR ? '\x1b[33m' : '';
const BOLD = USE_COLOR ? '\x1b[1m' : '';
const RESET = USE_COLOR ? '\x1b[0m' : '';

// ----- state -----------------------------------------------------------------

const results = []; // { num, desc, ok, reason }
let createdTerminalId = null;

function recordPass(num, desc) {
  results.push({ num, desc, ok: true, reason: null });
  console.log(`[check ${num}/8] ${desc} ${GREEN}✓${RESET}`);
}

function recordFail(num, desc, reason) {
  results.push({ num, desc, ok: false, reason });
  console.log(`[check ${num}/8] ${desc} ${RED}✗${RESET} ${reason}`);
}

function recordWarn(num, desc, reason) {
  // Treated as a pass but with a warning note printed.
  results.push({ num, desc, ok: true, reason: null });
  console.log(`[check ${num}/8] ${desc} ${GREEN}✓${RESET} ${YELLOW}(${reason})${RESET}`);
}

// ----- socket client (one-shot per request) ---------------------------------

// Sends a single newline-delimited JSON request, reads the first full JSON
// response line, then closes the socket. Rejects on timeout or parse error.
function sendRequest(payload) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(SOCKET_PATH);
    let buffer = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { client.destroy(); } catch (_) { /* ignore */ }
      reject(new Error(`socket timeout after ${SOCKET_TIMEOUT_MS}ms`));
    }, SOCKET_TIMEOUT_MS);

    client.setEncoding('utf8');

    client.on('connect', () => {
      try {
        client.write(JSON.stringify(payload) + '\n');
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    client.on('data', (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.end(); } catch (_) { /* ignore */ }
      try {
        resolve(JSON.parse(line));
      } catch (err) {
        reject(new Error(`failed to parse response as JSON: ${err.message} — raw: ${line.slice(0, 200)}`));
      }
    });

    client.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    client.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('socket closed with no response'));
    });
  });
}

// ----- utilities -------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomMarker() {
  const rand = Math.random().toString(36).slice(2, 10).toUpperCase();
  return `CLAWS_ACCEPT_${rand}`;
}

// Resolve candidate VS Code log directories per platform. Returns an array
// of directories that actually exist.
function candidateLogDirs() {
  const home = os.homedir();
  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push(path.join(home, 'Library', 'Application Support', 'Code', 'logs'));
  } else if (process.platform === 'linux') {
    candidates.push(path.join(home, '.config', 'Code', 'logs'));
  } else if (process.platform === 'win32') {
    candidates.push(path.join(home, 'AppData', 'Roaming', 'Code', 'logs'));
  }
  // Fallback: check all three anyway in case user has a non-standard setup.
  const extras = [
    path.join(home, 'Library', 'Application Support', 'Code', 'logs'),
    path.join(home, '.config', 'Code', 'logs'),
    path.join(home, 'AppData', 'Roaming', 'Code', 'logs'),
  ];
  for (const p of extras) {
    if (!candidates.includes(p)) candidates.push(p);
  }
  return candidates.filter((p) => {
    try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
  });
}

// Walk a directory recursively and return all files whose basename is
// "1-Claws.log". Returns [{ path, mtimeMs }, ...].
function findClawsLogs(rootDir) {
  const hits = [];
  const stack = [rootDir];
  const MAX_ENTRIES = 20_000; // defensive cap
  let visited = 0;
  while (stack.length > 0) {
    if (visited++ > MAX_ENTRIES) break;
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && ent.name === '1-Claws.log') {
        try {
          const st = fs.statSync(full);
          hits.push({ path: full, mtimeMs: st.mtimeMs });
        } catch (_) { /* ignore */ }
      }
    }
  }
  return hits;
}

// Read the tail of a file (up to N lines). Returns the tail as a single
// string. Falls back to whole file if it's smaller than the buffer.
function readTail(filePath, maxLines) {
  const stat = fs.statSync(filePath);
  const size = stat.size;
  // Read at most ~1 MB from the end. That's usually enough for 5000 lines.
  const BUF_SIZE = Math.min(size, 1_048_576);
  const buf = Buffer.alloc(BUF_SIZE);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, BUF_SIZE, size - BUF_SIZE);
  } finally {
    fs.closeSync(fd);
  }
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(lines.length - maxLines).join('\n');
}

// ----- individual checks -----------------------------------------------------

// Check 1: socket exists and is a Unix socket.
function check1_socketExists() {
  const desc = `socket exists at ${path.relative(PROJECT_ROOT, SOCKET_PATH)}`;
  let stat;
  try {
    stat = fs.statSync(SOCKET_PATH);
  } catch (err) {
    recordFail(1, desc, `not found (${err.code || err.message}) — is VS Code open on ${PROJECT_ROOT} with Claws loaded?`);
    return false;
  }
  if (!stat.isSocket()) {
    recordFail(1, desc, `exists but is not a socket (mode=${stat.mode.toString(8)})`);
    return false;
  }
  recordPass(1, desc);
  return true;
}

// Check 2: socket responds to `list` with { ok:true, terminals:[...] }.
async function check2_listResponds() {
  const desc = 'socket responds to `list`';
  try {
    const resp = await sendRequest({ id: 1, cmd: 'list' });
    if (!resp || resp.ok !== true) {
      recordFail(2, desc, `response not ok — got: ${JSON.stringify(resp)}`);
      return false;
    }
    if (!Array.isArray(resp.terminals)) {
      recordFail(2, desc, `response missing terminals array — got: ${JSON.stringify(resp)}`);
      return false;
    }
    recordPass(2, desc);
    return true;
  } catch (err) {
    recordFail(2, desc, `request failed: ${err.message}`);
    return false;
  }
}

// Check 3: create wrapped terminal. Captures createdTerminalId.
async function check3_createWrapped() {
  const desc = 'create wrapped terminal';
  try {
    const resp = await sendRequest({
      id: 2,
      cmd: 'create',
      name: 'claws-acceptance',
      wrapped: true,
      show: false,
    });
    if (!resp || resp.ok !== true) {
      recordFail(3, desc, `response not ok — got: ${JSON.stringify(resp)}`);
      return false;
    }
    if (resp.id === undefined || resp.id === null) {
      recordFail(3, desc, `response missing id — got: ${JSON.stringify(resp)}`);
      return false;
    }
    if (resp.wrapped !== true) {
      recordFail(3, desc, `response wrapped !== true — got: ${JSON.stringify(resp)}`);
      return false;
    }
    createdTerminalId = resp.id;
    recordPass(3, desc);
    return true;
  } catch (err) {
    recordFail(3, desc, `request failed: ${err.message}`);
    return false;
  }
}

// Check 4: send a marker echo and verify it appears in readLog bytes.
// Returns an object { ok, bytes } so the next check (pipe-mode scan) can
// reuse the same log bytes without a second round trip.
async function check4_sendAndReadLog() {
  const desc = 'send marker + readLog round trip';
  if (createdTerminalId === null) {
    recordFail(4, desc, 'skipped — no terminal id from check 3');
    return { ok: false, bytes: '' };
  }
  const marker = randomMarker();
  try {
    // Let the shell boot inside the wrapped pty before we send anything.
    await sleep(SHELL_BOOT_WAIT_MS);

    // Note on the protocol: per-terminal commands use `id` as the terminal
    // identifier. That's the same key name the CLAUDE.md protocol summary
    // uses for request correlation, but the extension treats the top-level
    // `id` as the terminal id for commands like send/readLog/close.
    const sendResp = await sendRequest({
      cmd: 'send',
      id: createdTerminalId,
      text: `echo ${marker}`,
      newline: true,
    });
    if (!sendResp || sendResp.ok !== true) {
      recordFail(4, desc, `send failed — got: ${JSON.stringify(sendResp)}`);
      return { ok: false, bytes: '' };
    }

    await sleep(POST_SEND_WAIT_MS);

    const readResp = await sendRequest({
      cmd: 'readLog',
      id: createdTerminalId,
      strip: true,
    });
    if (!readResp || readResp.ok !== true) {
      recordFail(4, desc, `readLog failed — got: ${JSON.stringify(readResp)}`);
      return { ok: false, bytes: '' };
    }
    const bytes = typeof readResp.bytes === 'string' ? readResp.bytes : '';
    if (!bytes.includes(marker)) {
      recordFail(4, desc, `marker "${marker}" not found in readLog bytes (log size=${bytes.length})`);
      return { ok: false, bytes };
    }
    recordPass(4, desc);
    return { ok: true, bytes };
  } catch (err) {
    recordFail(4, desc, `request failed: ${err.message}`);
    return { ok: false, bytes: '' };
  }
}

// Check 5: readLog bytes should NOT contain the pipe-mode banner.
function check5_noPipeModeBanner(bytes) {
  const desc = 'no pipe-mode banner in readLog (node-pty is loading)';
  const banner = '[claws] running in pipe-mode';
  if (!bytes) {
    recordFail(5, desc, 'skipped — no readLog bytes from check 4');
    return false;
  }
  if (bytes.includes(banner)) {
    recordFail(
      5,
      desc,
      `pipe-mode banner present — node-pty is NOT loading inside the VS Code extension host; wrapped terminals are falling back to child_process pipe-mode`,
    );
    return false;
  }
  recordPass(5, desc);
  return true;
}

// Check 6: scan the most recently modified 1-Claws.log for pipe-mode.
// Treated as informational — missing log files don't fail the test.
function check6_scanVscodeLog() {
  const desc = 'VS Code extension log free of recent pipe-mode activity';
  const roots = candidateLogDirs();
  if (roots.length === 0) {
    recordWarn(6, desc, 'VS Code log directory not found — skipped');
    return true;
  }
  const allHits = [];
  for (const root of roots) {
    for (const hit of findClawsLogs(root)) allHits.push(hit);
  }
  if (allHits.length === 0) {
    recordWarn(6, desc, 'no 1-Claws.log files found under any VS Code log dir — skipped');
    return true;
  }
  allHits.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const newest = allHits[0];
  const now = Date.now();
  if (now - newest.mtimeMs > LOG_FRESH_WINDOW_MS) {
    // Log is stale — either VS Code isn't really running or it rotated.
    // We can't make a reliable claim about recent pipe-mode. Pass with warn.
    recordWarn(
      6,
      desc,
      `newest log is ${Math.round((now - newest.mtimeMs) / 1000)}s old — no recent activity to scan`,
    );
    return true;
  }
  let tail;
  try {
    tail = readTail(newest.path, LOG_SCAN_TAIL_LINES);
  } catch (err) {
    recordWarn(6, desc, `could not read ${newest.path}: ${err.message}`);
    return true;
  }
  if (tail.includes('pipe-mode')) {
    recordFail(
      6,
      desc,
      `"pipe-mode" found in recent log (${path.basename(path.dirname(newest.path))}/${path.basename(newest.path)}) — extension fell back to pipe-mode in the last ~5 minutes`,
    );
    return false;
  }
  recordPass(6, desc);
  return true;
}

// Check 7: close the terminal we created.
async function check7_closeTerminal() {
  const desc = 'cleanup — close test terminal';
  if (createdTerminalId === null) {
    recordWarn(7, desc, 'no terminal was created, nothing to close');
    return true;
  }
  try {
    const resp = await sendRequest({ cmd: 'close', id: createdTerminalId });
    if (!resp || resp.ok !== true) {
      recordFail(7, desc, `close failed — got: ${JSON.stringify(resp)}`);
      return false;
    }
    createdTerminalId = null;
    recordPass(7, desc);
    return true;
  } catch (err) {
    recordFail(7, desc, `request failed: ${err.message}`);
    return false;
  }
}

// Check 8: socket still answers `list` after close.
async function check8_socketStillLive() {
  const desc = 'post-test socket still live';
  try {
    const resp = await sendRequest({ cmd: 'list' });
    if (!resp || resp.ok !== true || !Array.isArray(resp.terminals)) {
      recordFail(8, desc, `response malformed — got: ${JSON.stringify(resp)}`);
      return false;
    }
    recordPass(8, desc);
    return true;
  } catch (err) {
    recordFail(8, desc, `request failed: ${err.message}`);
    return false;
  }
}

// ----- orchestration ---------------------------------------------------------

async function runAll() {
  console.log(`${BOLD}Claws Layer 1 acceptance test${RESET}`);
  console.log(`project root: ${PROJECT_ROOT}`);
  console.log(`socket:       ${SOCKET_PATH}`);
  console.log('');

  // Check 1 is a gate — if the socket doesn't exist, bail early with a
  // clear fail for checks 2-8 skipped.
  const ok1 = check1_socketExists();
  if (!ok1) {
    // Mark remaining checks as skipped-failures so the counter is honest.
    for (let n = 2; n <= 8; n++) {
      recordFail(n, `check ${n} skipped`, 'socket missing — cannot proceed');
    }
    return summarize();
  }

  await check2_listResponds();
  const createdOk = await check3_createWrapped();

  let readResult = { ok: false, bytes: '' };
  try {
    if (createdOk) {
      readResult = await check4_sendAndReadLog();
    } else {
      recordFail(4, 'send marker + readLog round trip', 'skipped — terminal not created');
    }

    if (createdOk) {
      check5_noPipeModeBanner(readResult.bytes);
    } else {
      recordFail(5, 'no pipe-mode banner in readLog (node-pty is loading)', 'skipped — terminal not created');
    }

    check6_scanVscodeLog();
  } finally {
    // Always attempt cleanup so we don't leak a terminal.
    await check7_closeTerminal();
  }

  await check8_socketStillLive();
  return summarize();
}

function summarize() {
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log('');
  if (passed === total && total === 8) {
    console.log(`${BOLD}${GREEN}ACCEPTANCE PASS (${passed}/${total})${RESET}`);
    return 0;
  }
  console.log(`${BOLD}${RED}ACCEPTANCE FAIL (${passed}/${total})${RESET}`);
  // List failed checks as a final recap.
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log('');
    console.log('failed checks:');
    for (const r of failed) {
      console.log(`  - [${r.num}] ${r.desc}: ${r.reason}`);
    }
  }
  return 1;
}

// ----- entry point -----------------------------------------------------------

runAll()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`${RED}fatal: ${err && err.stack ? err.stack : err}${RESET}`);
    process.exit(1);
  });
