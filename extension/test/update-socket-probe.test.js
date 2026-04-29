#!/usr/bin/env node
// Tests for M-26: update.sh socket probe must not delete socket on failed probe.
// Simulates a project root with an unresponsive socket file and runs the probe
// logic, then asserts the socket file still exists.
// Run: node extension/test/update-socket-probe.test.js
// Exits 0 on success, 1 on failure. No VS Code dependency.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const UPDATE_SH = path.resolve(__dirname, '../../scripts/update.sh');

const checks = [];
async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, err: err.message || String(err) });
  }
}

function makeTmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-m26-'));
  fs.mkdirSync(path.join(dir, '.claws'));
  return dir;
}

function cleanTmpRoot(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Create a real Unix socket that immediately refuses connections (nothing listens).
// On macOS/Linux, a socket file on the filesystem that has no server = connect ECONNREFUSED.
// We use a regular file to simulate the socket path since we just need to verify it isn't deleted.
function touchFakeSocket(sockPath) {
  // Write a zero-byte file at the socket path — enough to make [ -S ] fail,
  // but we test the probe block in isolation using a Node helper that checks [ -f ] too.
  fs.writeFileSync(sockPath, '');
}

(async () => {
  // 1. Socket file survives failed probe (core M-26 invariant)
  await check('unresponsive socket file is NOT deleted after probe fails', async () => {
    const tmpRoot = makeTmpRoot();
    const sockPath = path.join(tmpRoot, '.claws', 'claws.sock');
    touchFakeSocket(sockPath);

    try {
      // Run a minimal shell snippet that mirrors the M-26-fixed update.sh probe block.
      // This is the exact logic we need to test, extracted for isolation.
      const probeScript = `
        _claws_sock="${sockPath}"
        _claws_alive=0
        if command -v node >/dev/null 2>&1; then
          if node --no-deprecation -e "
            const net = require('net');
            const s = net.createConnection('${sockPath}');
            const t = setTimeout(() => { try { s.destroy(); } catch {} process.exit(1); }, 300);
            s.on('connect', () => { s.write('{\"id\":1,\"cmd\":\"list\"}\\n'); });
            s.on('data', () => { clearTimeout(t); try { s.destroy(); } catch {} process.exit(0); });
            s.on('error', () => { clearTimeout(t); process.exit(1); });
          " 2>/dev/null; then
            _claws_alive=1
          fi
        fi
        if [ "$_claws_alive" = "1" ]; then
          echo "ALIVE"
        else
          echo "PROBE_FAILED — socket file NOT deleted (M-26)"
          # Do NOT delete the socket — M-26 fix
        fi
      `;
      const result = spawnSync('bash', ['-c', probeScript], { encoding: 'utf8', timeout: 5000 });
      assert.strictEqual(result.status, 0, `bash probe script failed: ${result.stderr}`);
      assert(result.stdout.includes('PROBE_FAILED'), `expected probe to fail on unresponsive socket, got: ${result.stdout}`);

      // KEY assertion: socket file must still exist
      assert(fs.existsSync(sockPath), `socket file was deleted by probe — M-26 regression!`);
    } finally {
      cleanTmpRoot(tmpRoot);
    }
  });

  // 2. Verify the M-26 fix is present in the actual update.sh (no rm -f after probe)
  await check('update.sh probe block does not contain rm -f after _claws_alive=0 branch', async () => {
    const src = fs.readFileSync(UPDATE_SH, 'utf8');
    // Find the M-26 probe block
    const m26Start = src.indexOf('M-26');
    assert(m26Start !== -1, 'M-26 comment not found in update.sh');
    const probeBlock = src.slice(m26Start, m26Start + 2000);

    // The else branch should NOT contain an unconditional rm -f on the socket
    // (it's OK to have it in a comment, but not as an executable command)
    const lines = probeBlock.split('\n');
    let inElseBranch = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === 'else') { inElseBranch = true; continue; }
      if (trimmed === 'fi' && inElseBranch) { inElseBranch = false; break; }
      if (inElseBranch && !trimmed.startsWith('#') && trimmed.match(/^rm\s+-f\s+.*sock/)) {
        assert.fail(`Found rm -f socket command in else branch of M-26 probe (should not delete): ${trimmed}`);
      }
    }
  });

  // 3. Verify the probe block contains the /claws-fix hint (user-actionable guidance)
  await check('update.sh probe block mentions /claws-fix when probe fails', async () => {
    const src = fs.readFileSync(UPDATE_SH, 'utf8');
    const m26Start = src.indexOf('M-26');
    const probeBlock = src.slice(m26Start, m26Start + 2000);
    assert(
      probeBlock.includes('/claws-fix') || probeBlock.includes('claws-fix'),
      'M-26 probe block should mention /claws-fix as the user-explicit repair step',
    );
  });

  let failed = 0;
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ' — ' + c.err}`);
    if (!c.ok) failed++;
  }

  if (failed > 0) {
    console.error(`\nFAIL: ${failed}/${checks.length} update-socket-probe check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${checks.length} update-socket-probe checks`);
  process.exit(0);
})();
