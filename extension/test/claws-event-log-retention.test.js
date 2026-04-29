#!/usr/bin/env node
// Tests for EventLogWriter L8 durability: retention + compaction + .idx files.
// Run: node extension/test/claws-event-log-retention.test.js
// Exits 0 on all pass, 1 on any failure.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const EXT_ROOT = path.resolve(__dirname, '..');
const tmpBundle = path.join(os.tmpdir(), 'claws-event-log-retention.bundle.cjs');

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

const { EventLogWriter, EventLogReader } = require(tmpBundle);

// ─── helpers ──────────────────────────────────────────────────────────────────

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claws-retention-test-'));
}

function cleanTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function listSegmentFiles(streamDir) {
  try {
    return fs.readdirSync(streamDir)
      .filter(n => /^\d{4}-.*\.jsonl$/.test(n))
      .sort();
  } catch { return []; }
}

function listIdxFiles(streamDir) {
  try {
    return fs.readdirSync(streamDir)
      .filter(n => /^\d{4}-.*\.idx$/.test(n))
      .sort();
  } catch { return []; }
}

function setMtimeDaysAgo(filePath, daysAgo) {
  const t = new Date(Date.now() - daysAgo * 86400_000);
  fs.utimesSync(filePath, t, t);
}

function makeManifest(streamDir, entries, currentId, currentOffset, seqCounter) {
  const manifest = {
    stream: 'default',
    segments: entries,
    current_segment: currentId,
    current_offset: currentOffset,
    sequence_counter: seqCounter,
  };
  fs.writeFileSync(path.join(streamDir, 'manifest.json'), JSON.stringify(manifest));
}

// ─── tests ────────────────────────────────────────────────────────────────────

(async () => {

  // T1: runRetention(0) deletes ALL old segments
  await check('retention: runRetention(0) deletes segments older than 0 days', async () => {
    const tmp = makeTmpDir();
    try {
      const w = new EventLogWriter({ sizeThreshold: 500, ageThresholdMs: 9999999 });
      await w.open(tmp);
      await w.append({ topic: 'test.a', payload: 1 });
      await w.close();

      const streamDir = path.join(tmp, '.claws', 'events', 'default');
      for (const f of listSegmentFiles(streamDir)) {
        setMtimeDaysAgo(path.join(streamDir, f), 10);
      }

      const w2 = new EventLogWriter({ sizeThreshold: 500, ageThresholdMs: 9999999 });
      await w2.open(tmp);
      await w2.runRetention(0);
      await w2.close();

      const remaining = listSegmentFiles(streamDir);
      assert.strictEqual(remaining.length, 0, `expected 0 segments after retention(0), got ${remaining.length}`);
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // T2: runRetention(7) deletes old, keeps recent
  await check('retention: runRetention(7) deletes 8-day-old segments, keeps 1-day-old', async () => {
    const tmp = makeTmpDir();
    try {
      const streamDir = path.join(tmp, '.claws', 'events', 'default');
      fs.mkdirSync(streamDir, { recursive: true });

      const oldSeg1 = path.join(streamDir, '0001-2026-04-20T00.jsonl');
      const oldSeg2 = path.join(streamDir, '0002-2026-04-21T00.jsonl');
      const recentSeg = path.join(streamDir, '0003-2026-04-29T00.jsonl');

      const line = '{"topic":"t","sequence":0,"ts_server":"2026-04-20T00:00:00Z","payload":1}\n';
      fs.writeFileSync(oldSeg1, line);
      fs.writeFileSync(oldSeg2, line);
      fs.writeFileSync(recentSeg, line);

      setMtimeDaysAgo(oldSeg1, 10);
      setMtimeDaysAgo(oldSeg2, 9);
      setMtimeDaysAgo(recentSeg, 1);

      makeManifest(streamDir, [
        { id: '0001', path: '0001-2026-04-20T00.jsonl', size: line.length, first_ts: null, last_ts: null },
        { id: '0002', path: '0002-2026-04-21T00.jsonl', size: line.length, first_ts: null, last_ts: null },
        { id: '0003', path: '0003-2026-04-29T00.jsonl', size: line.length, first_ts: null, last_ts: null },
      ], '0003', line.length, 3);

      const w = new EventLogWriter();
      await w.open(tmp);
      await w.runRetention(7);
      await w.close();

      const remaining = listSegmentFiles(streamDir);
      assert.ok(!remaining.includes('0001-2026-04-20T00.jsonl'), 'old seg 1 should be deleted');
      assert.ok(!remaining.includes('0002-2026-04-21T00.jsonl'), 'old seg 2 should be deleted');
      assert.ok(remaining.includes('0003-2026-04-29T00.jsonl'), 'recent seg should be kept');
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // T3: runRetention closes open fd before deleting active segment
  await check('retention: fd closed before deleting active segment (no EBUSY)', async () => {
    const tmp = makeTmpDir();
    try {
      const w = new EventLogWriter({ sizeThreshold: 500, ageThresholdMs: 9999999 });
      await w.open(tmp);
      await w.append({ topic: 'fd.test', payload: 'x' });

      const streamDir = path.join(tmp, '.claws', 'events', 'default');
      for (const f of listSegmentFiles(streamDir)) {
        setMtimeDaysAgo(path.join(streamDir, f), 10);
      }

      // Should not throw EBUSY or any error
      await w.runRetention(0);
      await w.close();

      const remaining = listSegmentFiles(streamDir);
      assert.strictEqual(remaining.length, 0, 'all segments should be gone');
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // T4: manifest updated after retention
  await check('retention: manifest updated after deletion removes old segment entries', async () => {
    const tmp = makeTmpDir();
    try {
      const streamDir = path.join(tmp, '.claws', 'events', 'default');
      fs.mkdirSync(streamDir, { recursive: true });

      const line = '{"topic":"t","sequence":0,"payload":1}\n';
      fs.writeFileSync(path.join(streamDir, '0001-2026-04-10T00.jsonl'), line);
      fs.writeFileSync(path.join(streamDir, '0002-2026-04-29T00.jsonl'), line);
      setMtimeDaysAgo(path.join(streamDir, '0001-2026-04-10T00.jsonl'), 20);
      setMtimeDaysAgo(path.join(streamDir, '0002-2026-04-29T00.jsonl'), 1);

      makeManifest(streamDir, [
        { id: '0001', path: '0001-2026-04-10T00.jsonl', size: line.length, first_ts: null, last_ts: null },
        { id: '0002', path: '0002-2026-04-29T00.jsonl', size: line.length, first_ts: null, last_ts: null },
      ], '0002', line.length, 2);

      const w = new EventLogWriter();
      await w.open(tmp);
      await w.runRetention(7);
      await w.close();

      const m = JSON.parse(fs.readFileSync(path.join(streamDir, 'manifest.json'), 'utf8'));
      const segIds = m.segments.map(s => s.id);
      assert.ok(!segIds.includes('0001'), 'old segment should be removed from manifest');
      assert.ok(segIds.includes('0002'), 'recent segment should remain in manifest');
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // T5: .idx file written alongside .jsonl
  await check('idx: .idx file written alongside .jsonl after append', async () => {
    const tmp = makeTmpDir();
    try {
      const w = new EventLogWriter({ sizeThreshold: 10 * 1024 * 1024, ageThresholdMs: 9999999 });
      await w.open(tmp);
      await w.append({ topic: 'idx.test.a', payload: 1 });
      await w.append({ topic: 'idx.test.b', payload: 2 });
      await w.close();

      const streamDir = path.join(tmp, '.claws', 'events', 'default');
      const segments = listSegmentFiles(streamDir);
      const idxFiles = listIdxFiles(streamDir);
      assert.ok(segments.length >= 1, 'should have at least 1 segment');
      assert.ok(idxFiles.length >= 1, `.idx file should be written alongside .jsonl, got: ${JSON.stringify(fs.readdirSync(streamDir))}`);
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // T6: .idx format is <topic>\t<byte_offset>\n
  await check('idx: format is topic TAB byte_offset newline per entry', async () => {
    const tmp = makeTmpDir();
    try {
      const w = new EventLogWriter({ sizeThreshold: 10 * 1024 * 1024, ageThresholdMs: 9999999 });
      await w.open(tmp);
      await w.append({ topic: 'foo.bar', payload: 'alpha' });
      await w.append({ topic: 'baz.qux', payload: 'beta' });
      await w.close();

      const streamDir = path.join(tmp, '.claws', 'events', 'default');
      const idxFiles = listIdxFiles(streamDir);
      assert.ok(idxFiles.length >= 1, 'need at least one .idx file');

      const idxContent = fs.readFileSync(path.join(streamDir, idxFiles[0]), 'utf8');
      const lines = idxContent.split('\n').filter(l => l.trim());
      assert.ok(lines.length >= 2, `expected >= 2 idx entries, got ${lines.length}`);

      for (const line of lines) {
        const parts = line.split('\t');
        assert.strictEqual(parts.length, 2,
          `idx line should have exactly 2 tab-separated fields, got: ${JSON.stringify(line)}`);
        const [topic, offset] = parts;
        assert.ok(typeof topic === 'string' && topic.length > 0, 'topic should be non-empty');
        assert.ok(/^\d+$/.test(offset.trim()),
          `offset should be a decimal integer, got: ${JSON.stringify(offset)}`);
      }
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // T7: compact() merges 3 small segments into 1
  await check('compact: 3 small segments (< 1KB each) merge into 1', async () => {
    const tmp = makeTmpDir();
    try {
      const streamDir = path.join(tmp, '.claws', 'events', 'default');
      fs.mkdirSync(streamDir, { recursive: true });

      const lines = [
        '{"topic":"t.a","sequence":0,"ts_server":"2026-04-29T00:00:00Z","payload":1}\n',
        '{"topic":"t.b","sequence":1,"ts_server":"2026-04-29T00:00:01Z","payload":2}\n',
        '{"topic":"t.c","sequence":2,"ts_server":"2026-04-29T00:00:02Z","payload":3}\n',
      ];
      fs.writeFileSync(path.join(streamDir, '0001-2026-04-28T00.jsonl'), lines[0]);
      fs.writeFileSync(path.join(streamDir, '0002-2026-04-28T01.jsonl'), lines[1]);
      fs.writeFileSync(path.join(streamDir, '0003-2026-04-29T00.jsonl'), lines[2]);

      makeManifest(streamDir, [
        { id: '0001', path: '0001-2026-04-28T00.jsonl', size: lines[0].length, first_ts: null, last_ts: null },
        { id: '0002', path: '0002-2026-04-28T01.jsonl', size: lines[1].length, first_ts: null, last_ts: null },
        { id: '0003', path: '0003-2026-04-29T00.jsonl', size: lines[2].length, first_ts: null, last_ts: null },
      ], '0003', lines[2].length, 3);

      const w = new EventLogWriter();
      await w.open(tmp);
      await w.compact();
      await w.close();

      const remaining = listSegmentFiles(streamDir);
      assert.strictEqual(remaining.length, 1,
        `expected 1 merged segment after compact, got ${remaining.length}: ${remaining.join(', ')}`);
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // T8: compact() preserves sequence ordering
  await check('compact: sequence ordering preserved after merge', async () => {
    const tmp = makeTmpDir();
    try {
      const streamDir = path.join(tmp, '.claws', 'events', 'default');
      fs.mkdirSync(streamDir, { recursive: true });

      const lines = [
        '{"topic":"t.1","sequence":0,"ts_server":"2026-04-29T00:00:00Z","payload":1}\n',
        '{"topic":"t.2","sequence":1,"ts_server":"2026-04-29T00:00:01Z","payload":2}\n',
        '{"topic":"t.3","sequence":2,"ts_server":"2026-04-29T00:00:02Z","payload":3}\n',
      ];
      fs.writeFileSync(path.join(streamDir, '0001-2026-04-28T00.jsonl'), lines[0]);
      fs.writeFileSync(path.join(streamDir, '0002-2026-04-28T01.jsonl'), lines[1]);
      fs.writeFileSync(path.join(streamDir, '0003-2026-04-29T00.jsonl'), lines[2]);

      makeManifest(streamDir, [
        { id: '0001', path: '0001-2026-04-28T00.jsonl', size: lines[0].length, first_ts: null, last_ts: null },
        { id: '0002', path: '0002-2026-04-28T01.jsonl', size: lines[1].length, first_ts: null, last_ts: null },
        { id: '0003', path: '0003-2026-04-29T00.jsonl', size: lines[2].length, first_ts: null, last_ts: null },
      ], '0003', lines[2].length, 3);

      const w = new EventLogWriter();
      await w.open(tmp);
      await w.compact();
      await w.close();

      const remaining = listSegmentFiles(streamDir);
      assert.strictEqual(remaining.length, 1, 'should have 1 merged segment');

      const merged = fs.readFileSync(path.join(streamDir, remaining[0]), 'utf8');
      const records = merged.trim().split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

      assert.strictEqual(records.length, 3, 'merged segment should have all 3 records');
      assert.ok(records[0].sequence < records[1].sequence, 'seq 0 < seq 1');
      assert.ok(records[1].sequence < records[2].sequence, 'seq 1 < seq 2');
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // T9: scanFrom replay works after compact()
  await check('compact: scanFrom replay works correctly after compaction', async () => {
    const tmp = makeTmpDir();
    try {
      const streamDir = path.join(tmp, '.claws', 'events', 'default');
      fs.mkdirSync(streamDir, { recursive: true });

      const lines = [
        '{"topic":"replay.a","sequence":0,"ts_server":"2026-04-29T00:00:00Z","payload":1}\n',
        '{"topic":"replay.b","sequence":1,"ts_server":"2026-04-29T00:00:01Z","payload":2}\n',
        '{"topic":"replay.c","sequence":2,"ts_server":"2026-04-29T00:00:02Z","payload":3}\n',
      ];
      fs.writeFileSync(path.join(streamDir, '0001-2026-04-28T00.jsonl'), lines[0]);
      fs.writeFileSync(path.join(streamDir, '0002-2026-04-28T01.jsonl'), lines[1]);
      fs.writeFileSync(path.join(streamDir, '0003-2026-04-29T00.jsonl'), lines[2]);

      makeManifest(streamDir, [
        { id: '0001', path: '0001-2026-04-28T00.jsonl', size: lines[0].length, first_ts: null, last_ts: null },
        { id: '0002', path: '0002-2026-04-28T01.jsonl', size: lines[1].length, first_ts: null, last_ts: null },
        { id: '0003', path: '0003-2026-04-29T00.jsonl', size: lines[2].length, first_ts: null, last_ts: null },
      ], '0003', lines[2].length, 3);

      const w = new EventLogWriter();
      await w.open(tmp);
      await w.compact();
      await w.close();

      const reader = new EventLogReader(tmp);
      const replayed = [];
      for await (const rec of reader.scanFrom('0001:0', 'replay.*')) {
        replayed.push(rec);
      }
      assert.strictEqual(replayed.length, 3, `expected 3 replayed records, got ${replayed.length}`);
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // T10: .idx byte offsets match actual line start positions
  await check('idx: byte offsets in .idx match actual line start positions in .jsonl', async () => {
    const tmp = makeTmpDir();
    try {
      const w = new EventLogWriter({ sizeThreshold: 10 * 1024 * 1024, ageThresholdMs: 9999999 });
      await w.open(tmp);
      await w.append({ topic: 'offset.check.a', payload: 'first' });
      await w.append({ topic: 'offset.check.b', payload: 'second' });
      await w.append({ topic: 'offset.check.c', payload: 'third' });
      await w.close();

      const streamDir = path.join(tmp, '.claws', 'events', 'default');
      const segments = listSegmentFiles(streamDir);
      const idxFiles = listIdxFiles(streamDir);
      assert.ok(segments.length >= 1, 'need segment');
      assert.ok(idxFiles.length >= 1, 'need .idx file');

      const segBuf = fs.readFileSync(path.join(streamDir, segments[0]));
      const idxContent = fs.readFileSync(path.join(streamDir, idxFiles[0]), 'utf8');
      const idxEntries = idxContent.split('\n').filter(l => l.trim()).map(l => {
        const [topic, offStr] = l.split('\t');
        return { topic: topic.trim(), offset: parseInt(offStr.trim(), 10) };
      });

      for (let i = 0; i < idxEntries.length; i++) {
        const { offset, topic: idxTopic } = idxEntries[i];
        let end = offset;
        while (end < segBuf.length && segBuf[end] !== 0x0a) end++;
        const rec = JSON.parse(segBuf.slice(offset, end).toString('utf8'));
        assert.strictEqual(rec.topic, idxTopic,
          `idx entry ${i}: expected topic "${rec.topic}" at offset ${offset}, idx says "${idxTopic}"`);
      }
    } finally {
      cleanTmpDir(tmp);
    }
  });

  // ─── results ────────────────────────────────────────────────────────────────

  const passed = assertions.filter(a => a.ok).length;
  const failed = assertions.filter(a => !a.ok);

  for (const a of assertions) {
    console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}`);
    if (!a.ok) console.log(`      ERR: ${a.err}`);
  }
  console.log(`\n${passed}/${assertions.length} passed`);

  if (failed.length > 0) process.exit(1);

})();
