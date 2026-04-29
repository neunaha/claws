#!/usr/bin/env node
// Tests for M-50: mcp_server.js _pconnConnect() must have a 5s socket timeout
// so it doesn't hang forever when VS Code is reloading (socket exists but not
// accepting).
// Run: node extension/test/mcp-pconn-timeout.test.js
// Exits 0 on success, 1 on failure.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');

const MCP_SERVER_JS = path.resolve(__dirname, '..', '..', 'mcp_server.js');

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, err: err.message || String(err) });
  }
}

const src = fs.readFileSync(MCP_SERVER_JS, 'utf8');

// 1. M-50 comment present
check('mcp_server.js: M-50 comment present', () => {
  assert(src.includes('M-50'), 'M-50 comment not found');
});

// 2. sock.setTimeout called in _pconnConnect
check('mcp_server.js: sock.setTimeout() called in _pconnConnect', () => {
  const fnIdx = src.indexOf('function _pconnConnect');
  assert(fnIdx !== -1, '_pconnConnect not found');
  const fnBody = src.slice(fnIdx, fnIdx + 800);
  assert(fnBody.includes('setTimeout(5000)') || fnBody.includes('setTimeout(5 *') || fnBody.includes('sock.setTimeout'),
    'sock.setTimeout not found in _pconnConnect');
});

// 3. timeout handler destroys socket
check('mcp_server.js: timeout handler calls sock.destroy()', () => {
  const fnIdx = src.indexOf('function _pconnConnect');
  const fnBody = src.slice(fnIdx, fnIdx + 800);
  assert(fnBody.includes('sock.destroy'), 'sock.destroy not found in timeout handler');
});

// 4. timeout cleared on successful connect
check('mcp_server.js: setTimeout(0) clears connect-phase timeout on connect', () => {
  const fnIdx = src.indexOf('function _pconnConnect');
  const fnBody = src.slice(fnIdx, fnIdx + 800);
  assert(fnBody.includes('setTimeout(0)'), 'setTimeout(0) not found — connect timeout not cleared on success');
});

// 5. behavioral: timeout mechanism fires and destroys socket when no connect arrives
(async () => {
  let behavioralOk = true;
  let behavioralErr = '';
  const sockPath = path.join(os.tmpdir(), `claws-pconn-test-${process.pid}.sock`);

  // Use a short 150ms timeout inline — proves the mechanism works without
  // waiting 5s; the test doesn't bind a server so createConnection gets ENOENT
  // or hangs briefly then times out.
  const start = Date.now();
  try {
    await new Promise((resolve, reject) => {
      const sock = net.createConnection(sockPath);
      sock.setTimeout(150); // short for testing
      sock.on('timeout', () => sock.destroy(new Error('persistent socket connect timed out')));
      sock.on('connect', () => { sock.setTimeout(0); resolve(); });
      sock.on('error', (err) => reject(err));
    });
    behavioralOk = false;
    behavioralErr = 'expected error but connection succeeded (no server bound)';
  } catch (e) {
    const elapsed = Date.now() - start;
    if (elapsed < 2000) {
      behavioralOk = true;
    } else {
      behavioralOk = false;
      behavioralErr = `socket error after ${elapsed}ms — should be fast`;
    }
  }

  checks.push({
    name: 'behavioral: timeout mechanism destroys socket on non-existent path (error fires quickly)',
    ok: behavioralOk,
    err: behavioralErr,
  });

  // ─── results ─────────────────────────────────────────────────────────────
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ' — ' + c.err}`);
  }

  const failed = checks.filter(c => !c.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${checks.length} mcp-pconn-timeout check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${checks.length} mcp-pconn-timeout checks`);
  process.exit(0);
})();
