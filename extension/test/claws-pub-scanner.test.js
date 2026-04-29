#!/usr/bin/env node
// Unit test: [CLAWS_PUB] line scanner in runBlockingWorker.
//
// Verifies:
//   1. Parser extracts topic + key=value pairs (bare, quoted, numeric, boolean)
//   2. publish is called once per [CLAWS_PUB] line, with correct topic + payload
//   3. Offset tracking prevents re-publishing on duplicate scans
//   4. New lines added after the last scan offset ARE published
//   5. Malformed [CLAWS_PUB] lines (missing topic=) are skipped without throwing
//
// Run: node extension/test/claws-pub-scanner.test.js
// Exits 0 on success, 1 on failure.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const MCP_SERVER_JS = path.resolve(__dirname, '..', '..', 'mcp_server.js');
const src = fs.readFileSync(MCP_SERVER_JS, 'utf8');

const checks = [];
async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
  } catch (e) {
    checks.push({ name, ok: false, err: String(e.message || e) });
  }
}

// ─── Reference implementation (spec test) ────────────────────────────────────
// Faithful re-implementation of _scanAndPublishCLAWSPUB with a mock publish
// callback, allowing precise assertion of topic/payload per call.

function makeScanner(onPublish) {
  const MARKER_RE = /^\[CLAWS_PUB\]\s+topic=(\S+)\s*(.*)?$/;
  const KV_RE = /(\w+)=("([^"]*)"|(\S+))/g;

  return async function scanAndPublish(newText) {
    for (const line of newText.split('\n')) {
      const m = MARKER_RE.exec(line);
      if (!m) continue;
      const topic = m[1];
      const rest = m[2] || '';
      const payload = {};
      KV_RE.lastIndex = 0;
      let kv;
      while ((kv = KV_RE.exec(rest)) !== null) {
        const key = kv[1];
        const rawVal = kv[3] !== undefined ? kv[3] : kv[4];
        if (rawVal === 'true') payload[key] = true;
        else if (rawVal === 'false') payload[key] = false;
        else if (/^-?\d+(\.\d+)?$/.test(rawVal)) payload[key] = parseFloat(rawVal);
        else payload[key] = rawVal;
      }
      await onPublish({ topic, payload });
    }
  };
}

(async () => {
  // ─── Source-level checks ────────────────────────────────────────────────────

  await check('_scanAndPublishCLAWSPUB is defined in mcp_server.js', async () => {
    assert(src.includes('async function _scanAndPublishCLAWSPUB'),
      '_scanAndPublishCLAWSPUB not found in mcp_server.js');
  });

  await check('[CLAWS_PUB] MARKER_RE regex is present in scanner', async () => {
    const fnIdx = src.indexOf('async function _scanAndPublishCLAWSPUB');
    assert(fnIdx !== -1, 'scanner function not found');
    const fnBody = src.slice(fnIdx, fnIdx + 1200);
    assert(fnBody.includes('CLAWS_PUB'), '[CLAWS_PUB] marker not referenced in scanner');
    assert(fnBody.includes('MARKER_RE'), 'MARKER_RE not found in scanner body');
  });

  await check('_scanAndPublishCLAWSPUB is called in poll loop (step 6)', async () => {
    const pollIdx = src.indexOf('// 6. Poll for completion');
    assert(pollIdx !== -1, '"// 6. Poll for completion" comment not found');
    const pollSection = src.slice(pollIdx, pollIdx + 2500);
    assert(pollSection.includes('_scanAndPublishCLAWSPUB'),
      '_scanAndPublishCLAWSPUB not called in poll loop');
  });

  await check('pubScanOffset tracks scan position in poll loop', async () => {
    assert(src.includes('pubScanOffset'), 'pubScanOffset not found in mcp_server.js');
    const pollIdx = src.indexOf('// 6. Poll for completion');
    const pollSection = src.slice(pollIdx, pollIdx + 2500);
    assert(pollSection.includes('pubScanOffset'), 'pubScanOffset not in poll loop section');
  });

  await check('_pconnEnsureRegistered is called inside _scanAndPublishCLAWSPUB', async () => {
    const fnIdx = src.indexOf('async function _scanAndPublishCLAWSPUB');
    const fnBody = src.slice(fnIdx, fnIdx + 1200);
    assert(fnBody.includes('_pconnEnsureRegistered'), '_pconnEnsureRegistered not called in scanner');
  });

  // ─── Behavioral checks ──────────────────────────────────────────────────────

  await check('3 [CLAWS_PUB] lines mixed with normal pty output → 3 publish calls', async () => {
    const calls = [];
    const scan = makeScanner(async (r) => calls.push(r));

    const ptyText = [
      'normal pty output line',
      '[CLAWS_PUB] topic=worker.w1.phase kind=DEPLOY step=1',
      'more pty output',
      '[CLAWS_PUB] topic=worker.w1.event kind=PROGRESS step=3 total=10',
      'even more pty output',
      '[CLAWS_PUB] topic=worker.w1.complete status=ok',
      'MISSION_COMPLETE',
    ].join('\n');

    await scan(ptyText);

    assert.strictEqual(calls.length, 3, `expected 3 publish calls, got ${calls.length}`);
    assert.strictEqual(calls[0].topic, 'worker.w1.phase');
    assert.deepStrictEqual(calls[0].payload, { kind: 'DEPLOY', step: 1 });
    assert.strictEqual(calls[1].topic, 'worker.w1.event');
    assert.deepStrictEqual(calls[1].payload, { kind: 'PROGRESS', step: 3, total: 10 });
    assert.strictEqual(calls[2].topic, 'worker.w1.complete');
    assert.deepStrictEqual(calls[2].payload, { status: 'ok' });
  });

  await check('offset tracking: scanning same bytes again does not re-publish', async () => {
    const calls = [];
    const scan = makeScanner(async (r) => calls.push(r));

    const text = 'boot\n[CLAWS_PUB] topic=worker.x.event kind=TEST\nmore\n';

    // First scan: full text
    await scan(text);
    assert.strictEqual(calls.length, 1, 'first scan should produce 1 publish call');

    // Simulate next poll with same full text — offset = text.length yields empty slice
    const pubScanOffset = text.length;
    await scan(text.slice(pubScanOffset));
    assert.strictEqual(calls.length, 1, 'second scan of already-scanned bytes must not re-publish');
  });

  await check('offset tracking: new lines appended after offset are published', async () => {
    const calls = [];
    const scan = makeScanner(async (r) => calls.push(r));

    const firstChunk = 'boot output\n[CLAWS_PUB] topic=worker.y.boot status=started\n';
    const secondChunk = '[CLAWS_PUB] topic=worker.y.phase kind=PLAN\n';
    const fullText = firstChunk + secondChunk;

    await scan(firstChunk);
    assert.strictEqual(calls.length, 1, 'poll 1: 1 publish call');
    assert.strictEqual(calls[0].topic, 'worker.y.boot');

    // Poll 2: scan only newly appended bytes
    await scan(fullText.slice(firstChunk.length));
    assert.strictEqual(calls.length, 2, 'poll 2: 1 additional publish call (2 total)');
    assert.strictEqual(calls[1].topic, 'worker.y.phase');
  });

  await check('malformed [CLAWS_PUB] lines (missing topic=) are skipped without throwing', async () => {
    const calls = [];
    const scan = makeScanner(async (r) => calls.push(r));

    const text = [
      '[CLAWS_PUB] nopayload',                          // no topic= prefix
      '[CLAWS_PUB]',                                     // completely empty
      '[CLAWS_PUB] topic=worker.z.good kind=OK',        // valid
      '[CLAWS_PUB] some random text without topic key',  // no topic=
    ].join('\n');

    let threw = false;
    try { await scan(text); } catch { threw = true; }
    assert(!threw, 'scanner must not throw on malformed input');
    assert.strictEqual(calls.length, 1, 'only the valid [CLAWS_PUB] line should publish');
    assert.strictEqual(calls[0].topic, 'worker.z.good');
    assert.deepStrictEqual(calls[0].payload, { kind: 'OK' });
  });

  await check('quoted values with spaces are parsed correctly', async () => {
    const calls = [];
    const scan = makeScanner(async (r) => calls.push(r));

    await scan('[CLAWS_PUB] topic=worker.q.event msg="hello world" ok=true count=42');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].payload.msg, 'hello world');
    assert.strictEqual(calls[0].payload.ok, true);
    assert.strictEqual(calls[0].payload.count, 42);
  });

  await check('boolean false and floating-point numbers are coerced to correct types', async () => {
    const calls = [];
    const scan = makeScanner(async (r) => calls.push(r));

    await scan('[CLAWS_PUB] topic=worker.r.event flag=false ratio=3.14 zero=0');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].payload.flag, false);
    assert.strictEqual(calls[0].payload.ratio, 3.14);
    assert.strictEqual(calls[0].payload.zero, 0);
  });

  await check('lines without [CLAWS_PUB] prefix are completely ignored', async () => {
    const calls = [];
    const scan = makeScanner(async (r) => calls.push(r));

    await scan('CLAWS_PUB topic=sneaky.inject\njust a normal log line\n[INFO] topic=fake');
    assert.strictEqual(calls.length, 0, 'no publish calls for non-prefixed lines');
  });

  // ─── Results ─────────────────────────────────────────────────────────────────

  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ' — ' + c.err}`);
  }
  const failed = checks.filter(c => !c.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${checks.length} claws-pub-scanner check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${checks.length} claws-pub-scanner checks`);
  process.exit(0);
})();
