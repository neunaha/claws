#!/usr/bin/env node
// Unit tests for EventLogWriter (event-log.ts).
// Run: node extension/test/event-log.test.js
// Exits 0 on success, 1 on failure.
// No VS Code dependency — pure Node.js.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const EXT_ROOT = path.resolve(__dirname, '..');
const tmpBundle = path.join(os.tmpdir(), 'claws-event-log.bundle.cjs');

// Bundle event-log.ts once for all tests.
try {
  const esbuildBin = path.join(EXT_ROOT, 'node_modules', '.bin', 'esbuild');
  const src = path.join(EXT_ROOT, 'src', 'event-log.ts');
  execSync(
    `"${esbuildBin}" "${src}" --bundle --format=cjs --platform=node --outfile="${tmpBundle}"`,
    { stdio: 'pipe' },
  );
} catch (err) {
  console.error('FAIL: esbuild bundle failed:', err.stderr?.toString() ?? String(err));
  process.exit(1);
}

const { EventLogWriter, formatCursor, parseCursor } = require(tmpBundle);

// ─── helpers ─────────────────────────────────────────────────────────────────

const assertions = [];

async function check(name, fn) {
  try {
    await fn();
    assertions.push({ name, ok: true });
  } catch (e) {
    assertions.push({ name, ok: false, err: e.message || String(e) });
  }
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claws-eventlog-test-'));
}

function cleanTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function readLines(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw.split('\n').filter(l => l.trim().length > 0);
}

function listSegmentFiles(streamDir) {
  return fs.readdirSync(streamDir)
    .filter(n => /^\d{4}-.*\.jsonl$/.test(n))
    .sort();
}

// ─── main async test runner ───────────────────────────────────────────────────

(async () => {

  // ── cursor helpers ──────────────────────────────────────────────────────────

  await check('formatCursor produces correct format', () => {
    assert.strictEqual(formatCursor(1, 0), '0001:0');
    assert.strictEqual(formatCursor(2, 1428), '0002:1428');
    assert.strictEqual(formatCursor(999, 99999), '0999:99999');
  });

  await check('parseCursor round-trips correctly', () => {
    const c = formatCursor(3, 512);
    const parsed = parseCursor(c);
    assert.ok(parsed, 'should parse');
    assert.strictEqual(parsed.segmentId, 3);
    assert.strictEqual(parsed.offset, 512);
  });

  await check('parseCursor returns null for invalid cursor', () => {
    assert.strictEqual(parseCursor(''), null);
    assert.strictEqual(parseCursor('abc:def'), null);
    assert.strictEqual(parseCursor('001:0'), null);  // must be 4 digits
    assert.strictEqual(parseCursor('0001'), null);   // no colon
  });

  // ── append-basic ────────────────────────────────────────────────────────────

  await check('append-basic: 1000 events produce valid JSONL with correct line count', async () => {
    const dir = makeTmpDir();
    try {
      const w = new EventLogWriter();
      await w.open(dir);
      for (let i = 0; i < 1000; i++) {
        await w.append({ topic: 'test.event', from: 'p_001', payload: { i } });
      }
      await w.close();

      const streamDir = path.join(dir, '.claws', 'events', 'default');
      const segments = listSegmentFiles(streamDir);
      assert.ok(segments.length >= 1, 'at least one segment');
      let totalLines = 0;
      for (const seg of segments) {
        const lines = readLines(path.join(streamDir, seg));
        for (const line of lines) {
          JSON.parse(line); // must be valid JSON
        }
        totalLines += lines.length;
      }
      assert.strictEqual(totalLines, 1000, `expected 1000 lines, got ${totalLines}`);
    } finally {
      cleanTmpDir(dir);
    }
  });

  // ── cursor-monotonic ────────────────────────────────────────────────────────

  await check('cursor-monotonic: cursors are strictly increasing byte offsets within a segment', async () => {
    const dir = makeTmpDir();
    try {
      const w = new EventLogWriter();
      await w.open(dir);
      let prevOffset = -1;
      let prevSegId = -1;
      for (let i = 0; i < 50; i++) {
        const { cursor } = await w.append({ topic: 'x', from: 'p', payload: { i } });
        const parsed = parseCursor(cursor);
        assert.ok(parsed, `cursor "${cursor}" must parse`);
        // Within same segment offsets must strictly increase;
        // across a rotation the segment ID increments and offset resets.
        if (parsed.segmentId === prevSegId) {
          assert.ok(parsed.offset > prevOffset,
            `same-segment offset ${parsed.offset} must exceed ${prevOffset}`);
        }
        prevOffset = parsed.offset;
        prevSegId = parsed.segmentId;
      }
      await w.close();
    } finally {
      cleanTmpDir(dir);
    }
  });

  // ── sequence-monotonic ──────────────────────────────────────────────────────

  await check('sequence-monotonic: sequence 0..999 with no gaps across 1000 appends', async () => {
    const dir = makeTmpDir();
    try {
      const w = new EventLogWriter();
      await w.open(dir);
      for (let i = 0; i < 1000; i++) {
        const { sequence } = await w.append({ topic: 't', from: 'p', payload: { i } });
        assert.strictEqual(sequence, i, `expected sequence ${i}, got ${sequence}`);
      }
      await w.close();
    } finally {
      cleanTmpDir(dir);
    }
  });

  // ── sequence survives rotation ──────────────────────────────────────────────

  await check('sequence-across-rotation: sequence is monotonic across segment boundary', async () => {
    const dir = makeTmpDir();
    try {
      const w = new EventLogWriter({ sizeThreshold: 512 });
      await w.open(dir);
      let prevSeq = -1;
      for (let i = 0; i < 40; i++) {
        const { sequence } = await w.append({ topic: 't', from: 'p', payload: { i } });
        assert.ok(sequence > prevSeq, `sequence ${sequence} must exceed ${prevSeq}`);
        prevSeq = sequence;
      }
      const streamDir = path.join(dir, '.claws', 'events', 'default');
      const segs = listSegmentFiles(streamDir);
      assert.ok(segs.length >= 2, `expected ≥2 segments, got ${segs.length}`);
      await w.close();
    } finally {
      cleanTmpDir(dir);
    }
  });

  // ── rotation-size ───────────────────────────────────────────────────────────

  await check('rotation-size: second segment created when 1 KB threshold exceeded', async () => {
    const dir = makeTmpDir();
    try {
      const w = new EventLogWriter({ sizeThreshold: 1024 });
      await w.open(dir);
      const streamDir = path.join(dir, '.claws', 'events', 'default');
      let rotated = false;
      let firstSegId = '';
      for (let i = 0; i < 200; i++) {
        const { cursor } = await w.append({ topic: 't', from: 'p', payload: { data: 'x'.repeat(20) } });
        const segPart = cursor.split(':')[0];
        if (!firstSegId) firstSegId = segPart;
        if (segPart !== firstSegId) {
          rotated = true;
          assert.ok(parseInt(segPart, 10) > parseInt(firstSegId, 10),
            'rotated segment ID must be higher');
          break;
        }
      }
      assert.ok(rotated, 'expected rotation within 200 appends at 1 KB threshold');
      const segs = listSegmentFiles(streamDir);
      assert.ok(segs.length >= 2, `expected ≥2 segments, got ${segs.length}`);
      await w.close();
    } finally {
      cleanTmpDir(dir);
    }
  });

  // ── rotation-restart ────────────────────────────────────────────────────────

  await check('rotation-restart: open() on dir with 0003-*.jsonl creates 0004-*.jsonl', async () => {
    const dir = makeTmpDir();
    const streamDir = path.join(dir, '.claws', 'events', 'default');
    try {
      fs.mkdirSync(streamDir, { recursive: true });
      // Place a segment file to simulate a prior process (no manifest → directory scan)
      fs.writeFileSync(
        path.join(streamDir, '0003-2026-04-28T18.jsonl'),
        '{"topic":"t","sequence":0}\n',
      );

      const w = new EventLogWriter();
      await w.open(dir);
      await w.append({ topic: 't', from: 'p', payload: {} });

      const segs = listSegmentFiles(streamDir);
      const newSeg = segs.find(s => s.startsWith('0004-'));
      assert.ok(newSeg, `expected 0004-*.jsonl, found: ${segs.join(', ')}`);
      await w.close();
    } finally {
      cleanTmpDir(dir);
    }
  });

  // ── manifest-written ────────────────────────────────────────────────────────

  await check('manifest-written: manifest.json exists after 100 appends and parses correctly', async () => {
    const dir = makeTmpDir();
    const streamDir = path.join(dir, '.claws', 'events', 'default');
    try {
      const w = new EventLogWriter();
      await w.open(dir);
      for (let i = 0; i < 100; i++) {
        await w.append({ topic: 't', from: 'p', payload: { i } });
      }
      // 100th append triggers flush
      const manifestPath = path.join(streamDir, 'manifest.json');
      assert.ok(fs.existsSync(manifestPath), 'manifest.json must exist after 100 appends');

      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.strictEqual(m.stream, 'default');
      assert.ok(Array.isArray(m.segments) && m.segments.length >= 1);
      assert.ok(typeof m.current_segment === 'string');
      assert.ok(typeof m.current_offset === 'number');

      const seg = m.segments.find(s => s.id === m.current_segment);
      assert.ok(seg, 'current_segment must be in segments array');
      const actualSize = fs.statSync(path.join(streamDir, seg.path)).size;
      assert.ok(m.current_offset <= actualSize,
        `manifest offset ${m.current_offset} must be ≤ actual file size ${actualSize}`);
      await w.close();
    } finally {
      cleanTmpDir(dir);
    }
  });

  // ── manifest-on-rotate ──────────────────────────────────────────────────────

  await check('manifest-on-rotate: manifest lists both segments with correct sizes after rotation', async () => {
    const dir = makeTmpDir();
    const streamDir = path.join(dir, '.claws', 'events', 'default');
    try {
      const w = new EventLogWriter({ sizeThreshold: 512 });
      await w.open(dir);
      for (let i = 0; i < 60; i++) {
        await w.append({ topic: 't', from: 'p', payload: { data: 'y'.repeat(15) } });
      }
      await w.close(); // writes final manifest

      const m = JSON.parse(fs.readFileSync(path.join(streamDir, 'manifest.json'), 'utf8'));
      assert.ok(m.segments.length >= 2, `expected ≥2 segments, got ${m.segments.length}`);
      for (const seg of m.segments) {
        assert.ok(fs.existsSync(path.join(streamDir, seg.path)), `segment ${seg.path} must exist`);
        assert.ok(typeof seg.size === 'number' && seg.size >= 0);
      }
    } finally {
      cleanTmpDir(dir);
    }
  });

  // ── crash-recovery ──────────────────────────────────────────────────────────

  await check('crash-recovery: re-open resumes at correct offset; no duplicate sequences', async () => {
    const dir = makeTmpDir();
    const streamDir = path.join(dir, '.claws', 'events', 'default');
    try {
      // Phase 1: write 200 events, then abandon writer (simulate crash)
      const w1 = new EventLogWriter();
      await w1.open(dir);
      for (let i = 0; i < 200; i++) {
        await w1.append({ topic: 't', from: 'p', payload: { i } });
      }
      const crashCursor = w1.currentCursor();
      // Simulate crash: close the fd without calling close() (no manifest flush).
      if (w1.fd !== null) {
        try { require('fs').closeSync(w1.fd); } catch { /* ignore */ }
        w1.fd = null;
      }

      // Phase 2: recovery
      const w2 = new EventLogWriter();
      await w2.open(dir);
      const recoveryCursor = w2.currentCursor();

      const crashParsed = parseCursor(crashCursor);
      const recoveryParsed = parseCursor(recoveryCursor);
      assert.ok(crashParsed && recoveryParsed);
      assert.strictEqual(recoveryParsed.segmentId, crashParsed.segmentId,
        'recovery segment must match crash segment');
      assert.ok(recoveryParsed.offset > 0, 'recovery offset must be > 0');

      // Phase 3: write 50 more events
      for (let i = 0; i < 50; i++) {
        await w2.append({ topic: 't', from: 'p', payload: { phase: 'recovery', i } });
      }
      await w2.close();

      // Phase 4: verify no duplicate sequence numbers within any single writer's run
      // (sequences reset between w1 and w2 — that is acceptable v1 behavior)
      const segFiles = listSegmentFiles(streamDir);
      let w1Seqs = [];
      let w2Seqs = [];
      let seenReset = false;
      let allSeqs = [];
      for (const seg of segFiles) {
        const lines = readLines(path.join(streamDir, seg));
        for (const line of lines) {
          const rec = JSON.parse(line);
          if (typeof rec.sequence === 'number') allSeqs.push(rec.sequence);
        }
      }
      // Within each monotonically increasing run, no duplicate sequences
      let inRun = [];
      for (let i = 0; i < allSeqs.length; i++) {
        const s = allSeqs[i];
        if (inRun.length > 0 && s < inRun[inRun.length - 1]) {
          // Sequence reset (new writer) — validate previous run had no dups
          const uniq = new Set(inRun);
          assert.strictEqual(uniq.size, inRun.length, `duplicate sequence in run before reset at position ${i}`);
          inRun = [s];
        } else {
          inRun.push(s);
        }
      }
      const uniqFinal = new Set(inRun);
      assert.strictEqual(uniqFinal.size, inRun.length, 'duplicate sequence in final run');
      void w1Seqs; void w2Seqs; void seenReset; // suppress unused-var lint
    } finally {
      cleanTmpDir(dir);
    }
  });

  // ── degraded-mode ───────────────────────────────────────────────────────────

  await check('degraded-mode: read-only dir → open() does not throw; append() returns sentinel', async () => {
    const dir = makeTmpDir();
    const wsDir = path.join(dir, 'ws');
    fs.mkdirSync(wsDir);
    const clawsDir = path.join(wsDir, '.claws');
    fs.mkdirSync(clawsDir);
    // Make .claws read-only so creating events/ inside it fails
    fs.chmodSync(clawsDir, 0o444);
    try {
      const w = new EventLogWriter();
      await w.open(wsDir); // must not throw
      const result = await w.append({ topic: 't', from: 'p', payload: {} });
      assert.strictEqual(result.cursor, '', 'degraded cursor must be empty string');
      assert.strictEqual(result.sequence, -1, 'degraded sequence must be -1');
      await w.close(); // must not throw
    } finally {
      try { fs.chmodSync(clawsDir, 0o755); } catch { /* ignore */ }
      cleanTmpDir(dir);
    }
  });

  // ── currentCursor ───────────────────────────────────────────────────────────

  await check('currentCursor() reflects correct offset after appends', async () => {
    const dir = makeTmpDir();
    try {
      const w = new EventLogWriter();
      await w.open(dir);
      assert.strictEqual(w.currentCursor(), '0001:0', 'initial cursor must be 0001:0');
      for (let i = 0; i < 10; i++) {
        await w.append({ topic: 't', from: 'p', payload: { i } });
      }
      const cursor = w.currentCursor();
      const parsed = parseCursor(cursor);
      assert.ok(parsed);
      assert.strictEqual(parsed.segmentId, 1);
      assert.ok(parsed.offset > 0);
      await w.close();
    } finally {
      cleanTmpDir(dir);
    }
  });

  // ── ts_server and sequence stamped on stored records ────────────────────────

  await check('ts_server and sequence are stamped on stored records', async () => {
    const dir = makeTmpDir();
    const streamDir = path.join(dir, '.claws', 'events', 'default');
    try {
      const w = new EventLogWriter();
      await w.open(dir);
      await w.append({ topic: 'my.topic', from: 'p_001', payload: { x: 1 } });
      await w.close();

      const segs = listSegmentFiles(streamDir);
      assert.strictEqual(segs.length, 1);
      const lines = readLines(path.join(streamDir, segs[0]));
      assert.strictEqual(lines.length, 1);
      const rec = JSON.parse(lines[0]);
      assert.ok(typeof rec.ts_server === 'string' && rec.ts_server.length > 0);
      assert.strictEqual(rec.sequence, 0);
      assert.strictEqual(rec.topic, 'my.topic');
    } finally {
      cleanTmpDir(dir);
    }
  });

  // ── results ─────────────────────────────────────────────────────────────────

  try { fs.rmSync(tmpBundle, { force: true }); } catch { /* ignore */ }

  for (const a of assertions) {
    console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
  }

  const failed = assertions.filter(a => !a.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${assertions.length} event-log check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${assertions.length} event-log checks`);
  process.exit(0);

})().catch(err => {
  console.error('FAIL: uncaught error in test runner:', err);
  process.exit(1);
});
