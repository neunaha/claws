#!/usr/bin/env node
// L4.2 regression test: sequence counter persists across restarts.
// Writes 5 events, simulates a restart by constructing a new writer instance
// (which reads the manifest), writes 5 more events, and asserts that the second
// batch starts at sequence 6..10 (last+1, allowing for the +1 recovery gap).
//
// Run: node extension/test/sequence-persist.test.js
// Exits 0 on success, 1 on failure.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const EXT_ROOT = path.resolve(__dirname, '..');
const tmpBundle = path.join(os.tmpdir(), 'claws-event-log-persist.bundle.cjs');

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

const { EventLogWriter } = require(tmpBundle);

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claws-seq-persist-'));
}

function cleanTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function readSequences(streamDir) {
  const files = fs.readdirSync(streamDir).filter(n => /^\d{4}-.*\.jsonl$/.test(n)).sort();
  const seqs = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(streamDir, f), 'utf8')
      .split('\n').filter(l => l.trim());
    for (const line of lines) {
      const rec = JSON.parse(line);
      if (typeof rec.sequence === 'number') seqs.push(rec.sequence);
    }
  }
  return seqs;
}

(async () => {
  const tmpDir = makeTmpDir();
  try {
    // ── Phase 1: write 5 events with writer instance A ────────────────────────
    const writerA = new EventLogWriter();
    await writerA.open(tmpDir);

    for (let i = 0; i < 5; i++) {
      await writerA.append({ topic: 'test.event', from: 'test', payload: { i } });
    }
    await writerA.close();

    const streamDir = path.join(tmpDir, '.claws', 'events', 'default');

    await check('phase-1: 5 events written', () => {
      const seqs = readSequences(streamDir);
      assert.strictEqual(seqs.length, 5, `expected 5 events, got ${seqs.length}`);
    });

    await check('phase-1: sequences are 0..4', () => {
      const seqs = readSequences(streamDir);
      for (let i = 0; i < 5; i++) {
        assert.strictEqual(seqs[i], i, `seq[${i}] = ${seqs[i]}, expected ${i}`);
      }
    });

    await check('phase-1: manifest has sequence_counter present', () => {
      const manifestPath = path.join(streamDir, 'manifest.json');
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.strictEqual(typeof m.sequence_counter, 'number', 'sequence_counter missing from manifest');
      // sequenceCounter is the NEXT value to issue, so after writing seqs 0..4 it is 5.
      assert.strictEqual(m.sequence_counter, 5, `sequence_counter=${m.sequence_counter}, expected 5 (next-to-issue after 5 events)`);
    });

    // ── Phase 2: simulate restart — new writer instance reads the manifest ────
    const writerB = new EventLogWriter();
    await writerB.open(tmpDir);

    for (let i = 0; i < 5; i++) {
      await writerB.append({ topic: 'test.event', from: 'test', payload: { i } });
    }
    await writerB.close();

    const allSeqs = readSequences(streamDir);

    await check('phase-2: total 10 events after restart', () => {
      assert.strictEqual(allSeqs.length, 10, `expected 10 total events, got ${allSeqs.length}`);
    });

    // The second batch must not overlap with the first batch (0..4).
    // With +1 recovery the second batch starts at 5 (exact) or 6 (conservative test).
    await check('phase-2: second batch does not reuse sequences 0..4', () => {
      const secondBatch = allSeqs.slice(5);
      for (const seq of secondBatch) {
        assert(seq >= 5, `second batch sequence ${seq} overlaps pre-restart range 0..4`);
      }
    });

    await check('phase-2: second batch is monotonically increasing', () => {
      const secondBatch = allSeqs.slice(5);
      for (let i = 1; i < secondBatch.length; i++) {
        assert(secondBatch[i] > secondBatch[i - 1],
          `sequence not monotonic: ${secondBatch[i - 1]} -> ${secondBatch[i]}`);
      }
    });

    // Exactly one gap is allowed at the restart boundary (the +1 skip).
    await check('phase-2: at most one gap at restart boundary', () => {
      const gap = allSeqs[5] - allSeqs[4];
      assert(gap === 1 || gap === 2,
        `gap at restart boundary = ${gap} (expected 1 for exact or 2 for +1 skip)`);
    });

  } finally {
    cleanTmpDir(tmpDir);
  }

  const failed = assertions.filter(a => !a.ok);
  for (const a of assertions) {
    console.log(`${a.ok ? 'PASS' : 'FAIL'} ${a.name}${a.err ? ': ' + a.err : ''}`);
  }
  console.log(`\n${assertions.length - failed.length}/${assertions.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
})();
