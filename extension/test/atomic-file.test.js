#!/usr/bin/env node
// Tests for scripts/_helpers/atomic-file.mjs (L0 utility — M-01, M-09 foundation).
// Run: node extension/test/atomic-file.test.js
// Exits 0 on success, 1 on failure. No VS Code dependency.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HELPER_PATH = path.resolve(__dirname, '../../scripts/_helpers/atomic-file.mjs');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claws-atomicfile-'));
}

function cleanTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function listTmpFiles(dir) {
  try {
    return fs.readdirSync(dir).filter(n => n.includes('.claws-tmp.'));
  } catch { return []; }
}

// ─── main ─────────────────────────────────────────────────────────────────────

(async () => {
  const { writeAtomic, copyDirAtomic, backupFile } = await import(HELPER_PATH);

  // 1. writeAtomic happy path — correct content, no .claws-tmp.* leftover
  await check('writeAtomic: happy path — content correct, no tmp leftover', async () => {
    const dir = makeTmpDir();
    try {
      const p = path.join(dir, 'out.txt');
      await writeAtomic(p, 'hello world');
      assert.strictEqual(fs.readFileSync(p, 'utf8'), 'hello world');
      assert.deepStrictEqual(listTmpFiles(dir), [], 'no .claws-tmp.* file should remain');
    } finally { cleanTmpDir(dir); }
  });

  // 2. writeAtomic with mode option — file has correct permission (POSIX only)
  await check('writeAtomic: mode option sets correct file permissions', async () => {
    if (process.platform === 'win32') {
      // Skip permission check on Windows — best-effort only
      return;
    }
    const dir = makeTmpDir();
    try {
      const p = path.join(dir, 'secret.txt');
      await writeAtomic(p, 'data', { mode: 0o600 });
      const stat = fs.statSync(p);
      const actual = stat.mode & 0o777;
      assert.strictEqual(actual, 0o600, `expected 0o600, got 0o${actual.toString(8)}`);
    } finally { cleanTmpDir(dir); }
  });

  // 3. writeAtomic concurrent writes — no corruption (10 parallel writes to same file)
  await check('writeAtomic: 10 concurrent writes produce valid file (no corruption)', async () => {
    const dir = makeTmpDir();
    try {
      const p = path.join(dir, 'concurrent.txt');
      const payloads = Array.from({ length: 10 }, (_, i) => `payload-${i}\n`);
      await Promise.all(payloads.map(content => writeAtomic(p, content)));
      // File must exist and contain exactly one of the payloads (last rename wins)
      const content = fs.readFileSync(p, 'utf8');
      assert.ok(payloads.some(pl => content === pl), `content "${content}" must be one of the payloads`);
      // No tmp files should be left
      assert.deepStrictEqual(listTmpFiles(dir), [], 'no .claws-tmp.* files should remain');
    } finally { cleanTmpDir(dir); }
  });

  // 4. writeAtomic creates parent directories if needed
  await check('writeAtomic: creates parent directories', async () => {
    const dir = makeTmpDir();
    try {
      const p = path.join(dir, 'a', 'b', 'c', 'file.txt');
      await writeAtomic(p, 'nested');
      assert.strictEqual(fs.readFileSync(p, 'utf8'), 'nested');
    } finally { cleanTmpDir(dir); }
  });

  // 5. copyDirAtomic happy path — dest matches src, no .claws-tmp.* leftover
  await check('copyDirAtomic: happy path — destination matches source, no tmp leftover', async () => {
    const dir = makeTmpDir();
    try {
      const src = path.join(dir, 'src');
      const dest = path.join(dir, 'dest');
      fs.mkdirSync(src);
      fs.writeFileSync(path.join(src, 'a.js'), 'console.log("a")');
      fs.writeFileSync(path.join(src, 'b.js'), 'console.log("b")');
      fs.mkdirSync(path.join(src, 'sub'));
      fs.writeFileSync(path.join(src, 'sub', 'c.js'), 'console.log("c")');

      await copyDirAtomic(src, dest);

      assert.strictEqual(fs.readFileSync(path.join(dest, 'a.js'), 'utf8'), 'console.log("a")');
      assert.strictEqual(fs.readFileSync(path.join(dest, 'b.js'), 'utf8'), 'console.log("b")');
      assert.strictEqual(fs.readFileSync(path.join(dest, 'sub', 'c.js'), 'utf8'), 'console.log("c")');

      // No .claws-tmp.* directories should remain
      const leftovers = fs.readdirSync(dir).filter(n => n.includes('.claws-tmp.') || n.includes('.claws-old.'));
      assert.deepStrictEqual(leftovers, [], `unexpected temp dirs: ${leftovers.join(', ')}`);
    } finally { cleanTmpDir(dir); }
  });

  // 6. copyDirAtomic with existing destination — old content swapped, no tmp leftover (M-09)
  await check('copyDirAtomic: existing destination replaced atomically, new content correct', async () => {
    const dir = makeTmpDir();
    try {
      const src = path.join(dir, 'src');
      const dest = path.join(dir, 'dest');

      // Set up initial dest with old content
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'old.js'), 'old content');

      // Set up src with new content
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, 'new.js'), 'new content');

      await copyDirAtomic(src, dest);

      // dest must have new content
      assert.ok(fs.existsSync(path.join(dest, 'new.js')), 'new.js must exist in dest');
      assert.strictEqual(fs.readFileSync(path.join(dest, 'new.js'), 'utf8'), 'new content');

      // old content must not be in dest
      assert.ok(!fs.existsSync(path.join(dest, 'old.js')), 'old.js must NOT exist in dest');

      // No lingering .claws-tmp.* or .claws-old.* dirs
      const leftovers = fs.readdirSync(dir).filter(n => n.includes('.claws-tmp.') || n.includes('.claws-old.'));
      assert.deepStrictEqual(leftovers, [], `unexpected temp dirs: ${leftovers.join(', ')}`);
    } finally { cleanTmpDir(dir); }
  });

  // 7. backupFile — creates timestamped backup, returns path, original preserved
  await check('backupFile: creates timestamped backup, original preserved', async () => {
    const dir = makeTmpDir();
    try {
      const p = path.join(dir, 'original.json');
      const originalContent = '{"key":"value"}';
      fs.writeFileSync(p, originalContent);

      const backupPath = await backupFile(p);

      // Backup must exist
      assert.ok(fs.existsSync(backupPath), 'backup file must exist');
      assert.ok(backupPath.includes('.claws-bak.'), 'backup path must include .claws-bak.');

      // Backup content must match original
      assert.strictEqual(fs.readFileSync(backupPath, 'utf8'), originalContent);

      // Original must be unchanged
      assert.strictEqual(fs.readFileSync(p, 'utf8'), originalContent, 'original must be unchanged');
    } finally { cleanTmpDir(dir); }
  });

  // 8. backupFile with suffix — suffix appended to backup path
  await check('backupFile: optional suffix is appended', async () => {
    const dir = makeTmpDir();
    try {
      const p = path.join(dir, 'file.json');
      fs.writeFileSync(p, '{}');
      const backupPath = await backupFile(p, 'pre-install');
      assert.ok(backupPath.endsWith('.pre-install'), `expected suffix, got: ${backupPath}`);
      assert.ok(fs.existsSync(backupPath));
    } finally { cleanTmpDir(dir); }
  });

  // 9. writeAtomic Buffer input — written correctly
  await check('writeAtomic: Buffer input written correctly', async () => {
    const dir = makeTmpDir();
    try {
      const p = path.join(dir, 'buf.bin');
      const buf = Buffer.from([0x01, 0x02, 0x03, 0xff]);
      await writeAtomic(p, buf);
      const read = fs.readFileSync(p);
      assert.ok(Buffer.isBuffer(read));
      assert.strictEqual(read.length, 4);
      assert.strictEqual(read[3], 0xff);
    } finally { cleanTmpDir(dir); }
  });

  // ─── results ─────────────────────────────────────────────────────────────────

  for (const a of assertions) {
    console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
  }

  const failed = assertions.filter(a => !a.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${assertions.length} atomic-file check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${assertions.length} atomic-file checks`);
  process.exit(0);

})().catch(err => {
  console.error('FAIL: uncaught error in test runner:', err);
  process.exit(1);
});
