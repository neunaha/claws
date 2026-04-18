#!/usr/bin/env node
// Unit test for the CaptureStore ring buffer. Compiles src/capture-store.ts
// on demand via esbuild (already a devDep) so we can require the class
// directly without needing ts-node. The bundle inlines the ansi-strip
// dependency so the output is self-contained.
//
// Covers:
//   1. basic append + read
//   2. overflow causes oldest chunks to drop and offset to advance
//   3. setMaxBytesPerTerminal triggers immediate re-trim
//   4. clear() drops the terminal's state
//
// Run: node extension/test/capture-store-trim.test.js
// Exits 0 on success, 1 on failure.

const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const EXT_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(EXT_ROOT, 'src', 'capture-store.ts');
const OUT = path.join(EXT_ROOT, 'dist', 'capture-store-test.js');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
esbuild.buildSync({
  entryPoints: [SRC],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: OUT,
  logLevel: 'silent',
});

const { CaptureStore } = require(OUT);

const assertions = [];
function check(name, fn) {
  try { fn(); assertions.push({ name, ok: true }); }
  catch (e) { assertions.push({ name, ok: false, err: e.message || String(e) }); }
}

// 1. Basic append + read
check('append + read returns exact bytes with offset=0', () => {
  const store = new CaptureStore(100);
  store.append('t1', 'abc');
  const slice = store.read('t1', undefined, 100, false);
  if (slice.bytes !== 'abc') throw new Error(`bytes=${JSON.stringify(slice.bytes)}`);
  if (slice.offset !== 0) throw new Error(`offset=${slice.offset}`);
  if (slice.totalSize !== 3) throw new Error(`totalSize=${slice.totalSize}`);
});

// 2. Overflow: store max=10, append 5 chunks of 4 bytes (total=20).
//    After trimming, present bytes must be <= 10 and offset must reflect drops.
check('overflow drops oldest chunks and advances offset', () => {
  const store = new CaptureStore(10);
  for (let i = 0; i < 5; i++) store.append('t1', 'abcd'); // 4 bytes each
  const slice = store.read('t1', undefined, 100, false);
  if (slice.totalSize !== 20) throw new Error(`totalSize=${slice.totalSize}, expected 20`);
  if (slice.bytes.length > 10) throw new Error(`present bytes=${slice.bytes.length}, expected <=10`);
  if (slice.offset <= 0) throw new Error(`offset=${slice.offset}, expected > 0`);
  if (slice.bytes.length === 0) throw new Error('present bytes must be > 0');
});

// 3. setMaxBytesPerTerminal re-trims immediately when called with a smaller cap.
check('setMaxBytesPerTerminal re-trims to new cap', () => {
  const store = new CaptureStore(100);
  for (let i = 0; i < 5; i++) store.append('t1', 'abcd'); // 20 bytes present
  let before = store.read('t1', undefined, 200, false);
  if (before.bytes.length !== 20) throw new Error(`pre-trim bytes=${before.bytes.length}, expected 20`);

  store.setMaxBytesPerTerminal(5);
  const after = store.read('t1', undefined, 200, false);
  if (after.bytes.length > 5) throw new Error(`post-trim bytes=${after.bytes.length}, expected <=5`);
  if (after.totalSize !== 20) throw new Error(`totalSize should still be 20, got ${after.totalSize}`);
});

// 4. clear() drops the terminal entirely — subsequent reads are empty.
check('clear() drops terminal state', () => {
  const store = new CaptureStore(100);
  store.append('t1', 'abc');
  if (!store.has('t1')) throw new Error('expected has(t1) === true before clear');
  store.clear('t1');
  if (store.has('t1')) throw new Error('expected has(t1) === false after clear');
  const slice = store.read('t1', undefined, 100, false);
  if (slice.bytes !== '') throw new Error(`bytes after clear=${JSON.stringify(slice.bytes)}`);
  if (slice.totalSize !== 0) throw new Error(`totalSize after clear=${slice.totalSize}`);
});

// 5. Single-growable-buffer correctness: many small appends then a read at
//    an arbitrary offset should return exactly the right slice and handle
//    the grow-and-copy path.
check('many small appends yield contiguous bytes (growable-buffer path)', () => {
  // Cap is larger than the cumulative total so no trimming occurs and we
  // can verify exact byte identity end-to-end.
  const store = new CaptureStore(8192);
  let expected = '';
  for (let i = 0; i < 200; i++) {
    const piece = `chunk${i}|`;
    store.append('t1', piece);
    expected += piece;
  }
  const slice = store.read('t1', 0, expected.length, false);
  if (slice.bytes !== expected) {
    throw new Error(`mismatch (len actual=${slice.bytes.length}, expected=${expected.length})`);
  }
  if (slice.totalSize !== expected.length) throw new Error(`totalSize=${slice.totalSize}`);
});

// 6. Read from a non-zero offset inside the live window returns the exact
//    tail bytes — exercises the subarray() path of the rewritten store.
check('read from arbitrary offset returns correct tail', () => {
  const store = new CaptureStore(1024);
  store.append('t1', '0123456789');
  const slice = store.read('t1', 4, 100, false);
  if (slice.bytes !== '456789') throw new Error(`bytes=${JSON.stringify(slice.bytes)}`);
  if (slice.offset !== 4) throw new Error(`offset=${slice.offset}`);
  if (slice.nextOffset !== 10) throw new Error(`nextOffset=${slice.nextOffset}`);
});

// 7. Overflow with a LARGE trim (one append exceeds cap by a lot) to ensure
//    the trim shifts the live window correctly and droppedBefore is accurate.
check('large-chunk overflow trims to cap and advances offset', () => {
  const store = new CaptureStore(8);
  store.append('t1', 'abcdefghijklmnop'); // 16 bytes
  const slice = store.read('t1', undefined, 100, false);
  if (slice.bytes.length !== 8) throw new Error(`present=${slice.bytes.length}, expected 8`);
  if (slice.totalSize !== 16) throw new Error(`totalSize=${slice.totalSize}`);
  if (slice.offset !== 8) throw new Error(`offset=${slice.offset}`);
  if (slice.bytes !== 'ijklmnop') throw new Error(`bytes=${JSON.stringify(slice.bytes)}`);
});

// 8. ANSI strip covers CSI, OSC (title), DCS, and single-char ESC. These
//    are the patterns we see in real wrapped-terminal captures (claude,
//    iTerm hyperlinks, vim, htop).
check('stripAnsi removes CSI, OSC, DCS, and single-ESC sequences', () => {
  // CSI + SGR + cursor control
  const input1 = '\x1b[2J\x1b[H\x1b[38;5;123mhello\x1b[0m\x1b[?25h';
  const store = new CaptureStore(4096);
  store.append('s1', input1);
  const s1 = store.read('s1', 0, 4096, true);
  if (s1.bytes !== 'hello') throw new Error(`csi/sgr: ${JSON.stringify(s1.bytes)}`);

  // OSC with BEL terminator (common form)
  store.append('s2', '\x1b]0;my terminal title\x07text');
  const s2 = store.read('s2', 0, 4096, true);
  if (s2.bytes !== 'text') throw new Error(`osc bel: ${JSON.stringify(s2.bytes)}`);

  // OSC with ST terminator (ESC \\)
  store.append('s3', '\x1b]0;title\x1b\\after');
  const s3 = store.read('s3', 0, 4096, true);
  if (s3.bytes !== 'after') throw new Error(`osc st: ${JSON.stringify(s3.bytes)}`);

  // DCS sequence
  store.append('s4', '\x1bP1;2;3|content\x1b\\tail');
  const s4 = store.read('s4', 0, 4096, true);
  if (s4.bytes !== 'tail') throw new Error(`dcs: ${JSON.stringify(s4.bytes)}`);

  // Single-char ESC (charset select)
  store.append('s5', 'pre\x1b(Bmid\x1b=end');
  const s5 = store.read('s5', 0, 4096, true);
  if (s5.bytes !== 'premidend') throw new Error(`single-esc: ${JSON.stringify(s5.bytes)}`);

  // Plaintext with \n, \r, \t is preserved
  store.append('s6', 'line1\nline2\tcol\r\n');
  const s6 = store.read('s6', 0, 4096, true);
  if (s6.bytes !== 'line1\nline2\tcol\r\n') throw new Error(`plain: ${JSON.stringify(s6.bytes)}`);
});

for (const a of assertions) {
  console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
}
const failed = assertions.filter((a) => !a.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${assertions.length} capture-store check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS: ${assertions.length} capture-store checks`);
process.exit(0);
