#!/usr/bin/env node
// Tests for scripts/_helpers/json-safe.mjs (L0 utility — M-02, M-03 foundation).
// Run: node extension/test/json-safe.test.js
// Exits 0 on success, 1 on failure. No VS Code dependency.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HELPER_PATH = path.resolve(__dirname, '../../scripts/_helpers/json-safe.mjs');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claws-jsonsafe-'));
}

function cleanTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─── main ─────────────────────────────────────────────────────────────────────

(async () => {
  const { parseJsonSafe, mergeIntoFile, JsonSafeError } = await import(HELPER_PATH);

  // 1. Valid JSON parses OK
  await check('parseJsonSafe: valid JSON', () => {
    const r = parseJsonSafe('{"a":1,"b":true}');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.data, { a: 1, b: true });
  });

  // 2. Valid JSONC with line comment + trailing comma
  await check('parseJsonSafe: JSONC line comment and trailing comma', () => {
    const r = parseJsonSafe('{\n  // a comment\n  "x": 1,\n  "y": 2,\n}');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.data, { x: 1, y: 2 });
  });

  // 3. Malformed JSON returns ok:false with location info
  await check('parseJsonSafe: malformed JSON returns ok:false with location', () => {
    const r = parseJsonSafe('{bad json here}');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.code, 'PARSE_ERROR');
    assert.ok(typeof r.error.message === 'string' && r.error.message.length > 0, 'has message');
    assert.strictEqual(r.error.original, '{bad json here}');
  });

  // 4. allowJsonc=false uses strict JSON.parse
  await check('parseJsonSafe: allowJsonc=false rejects JSONC', () => {
    const r = parseJsonSafe('{"a":1,}', { allowJsonc: false });
    assert.strictEqual(r.ok, false, 'trailing comma must be rejected in strict mode');
  });

  // 5. parseJsonSafe never throws
  await check('parseJsonSafe: never throws even on garbage input', () => {
    assert.doesNotThrow(() => parseJsonSafe(null));
    assert.doesNotThrow(() => parseJsonSafe(undefined));
    assert.doesNotThrow(() => parseJsonSafe(''));
  });

  // 6. mergeIntoFile on missing file — cfg starts as {}, file written
  await check('mergeIntoFile: missing file treated as {} and written', async () => {
    const dir = makeTmpDir();
    try {
      const p = path.join(dir, 'sub', 'new.json');
      const r = await mergeIntoFile(p, cfg => { cfg.added = true; });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.written, true);
      const written = JSON.parse(fs.readFileSync(p, 'utf8'));
      assert.strictEqual(written.added, true);
    } finally { cleanTmpDir(dir); }
  });

  // 7. mergeIntoFile on JSONC file — preserves existing values, writes mutation
  await check('mergeIntoFile: JSONC file — preserves values, writes mutation', async () => {
    const dir = makeTmpDir();
    try {
      const p = path.join(dir, 'config.json');
      // Write a JSONC file with trailing comma and comment
      fs.writeFileSync(p, '{\n  // kept\n  "existing": 42,\n  "other": "hello",\n}\n');
      const r = await mergeIntoFile(p, cfg => { cfg.added = 'new'; });
      assert.strictEqual(r.ok, true);
      const written = JSON.parse(fs.readFileSync(p, 'utf8'));
      assert.strictEqual(written.existing, 42, 'existing value preserved');
      assert.strictEqual(written.other, 'hello', 'other value preserved');
      assert.strictEqual(written.added, 'new', 'new value added');
    } finally { cleanTmpDir(dir); }
  });

  // 8. mergeIntoFile on malformed file — ok:false, backup created, original UNCHANGED (M-02/M-03)
  await check('mergeIntoFile: malformed file → backup created, original file unchanged', async () => {
    const dir = makeTmpDir();
    try {
      const p = path.join(dir, 'broken.json');
      const originalContent = '{not valid json{{';
      fs.writeFileSync(p, originalContent);

      const r = await mergeIntoFile(p, cfg => { cfg.claws = true; });

      // Must return ok:false
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error.code, 'PARSE_FAILED');

      // Backup must exist
      assert.ok(
        typeof r.error.backupSavedAt === 'string',
        'backupSavedAt must be a string path'
      );
      assert.ok(fs.existsSync(r.error.backupSavedAt), 'backup file must exist on disk');
      assert.strictEqual(
        fs.readFileSync(r.error.backupSavedAt, 'utf8'),
        originalContent,
        'backup content must match original'
      );

      // CRITICAL: original file must be UNCHANGED
      assert.strictEqual(
        fs.readFileSync(p, 'utf8'),
        originalContent,
        'original file must not be modified after parse failure'
      );
    } finally { cleanTmpDir(dir); }
  });

  // 9. mergeIntoFile mutator returning undefined (in-place mutation) — still writes
  await check('mergeIntoFile: mutator returns undefined (in-place) → still writes', async () => {
    const dir = makeTmpDir();
    try {
      const p = path.join(dir, 'data.json');
      fs.writeFileSync(p, '{"count":0}');
      const r = await mergeIntoFile(p, cfg => {
        cfg.count++;  // mutate in place, return undefined
      });
      assert.strictEqual(r.ok, true);
      const written = JSON.parse(fs.readFileSync(p, 'utf8'));
      assert.strictEqual(written.count, 1);
    } finally { cleanTmpDir(dir); }
  });

  // 10. mergeIntoFile concurrent calls — all succeed, no .claws-tmp.* leftovers (F1+F2)
  await check('mergeIntoFile: 10 concurrent calls all succeed, no tmp leftover', async () => {
    const dir = makeTmpDir();
    try {
      const p = path.join(dir, 'concurrent.json');
      fs.writeFileSync(p, '{"calls":0}');
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          mergeIntoFile(p, cfg => { cfg[`key${i}`] = i; })
        )
      );
      // All 10 calls must succeed (nonce ensures unique tmp per call)
      results.forEach((r, i) =>
        assert.strictEqual(r.ok, true, `call ${i} must succeed, got: ${JSON.stringify(r.error)}`)
      );
      // File must be valid JSON with no corruption
      const written = JSON.parse(fs.readFileSync(p, 'utf8'));
      assert.ok(typeof written === 'object', 'result must be valid JSON object');
      // No .claws-tmp.* files should remain
      const leftovers = fs.readdirSync(dir).filter(n => n.includes('.claws-tmp.'));
      assert.deepStrictEqual(leftovers, [], `tmp files leaked: ${leftovers.join(', ')}`);
    } finally { cleanTmpDir(dir); }
  });

  // 11. writeAtomicInline concurrent calls don't collide — unique nonce per call (F1)
  await check('writeAtomicInline: concurrent in-process calls do not collide', async () => {
    const dir = makeTmpDir();
    try {
      const p = path.join(dir, 'nonce-test.json');
      fs.writeFileSync(p, '{}');
      const inputs = Array.from({ length: 10 }, (_, i) => JSON.stringify({ v: i }) + '\n');
      // mergeIntoFile uses writeAtomicInline internally — 10 concurrent mutations
      const results = await Promise.all(
        inputs.map((_, i) => mergeIntoFile(p, () => ({ v: i })))
      );
      // All must succeed — pid-only suffix would cause collisions and WRITE_ERROR returns
      results.forEach((r, i) =>
        assert.strictEqual(r.ok, true, `call ${i} returned error: ${JSON.stringify(r.error)}`)
      );
      // File must be valid JSON, no .claws-tmp.* leftovers
      JSON.parse(fs.readFileSync(p, 'utf8'));
      const leftovers = fs.readdirSync(dir).filter(n => n.includes('.claws-tmp.'));
      assert.deepStrictEqual(leftovers, [], `tmp files leaked: ${leftovers.join(', ')}`);
    } finally { cleanTmpDir(dir); }
  });

  // 13. JsonSafeError is an Error subclass
  await check('JsonSafeError is an Error subclass', () => {
    const e = new JsonSafeError('test', 'TEST_CODE');
    assert.ok(e instanceof Error);
    assert.strictEqual(e.name, 'JsonSafeError');
    assert.strictEqual(e.code, 'TEST_CODE');
  });

  // 14. parseJsonSafe: // inside a string value is preserved (not treated as comment)
  await check('parseJsonSafe: // inside string value is not stripped', () => {
    const r = parseJsonSafe('{"url":"http://example.com/path"}');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.url, 'http://example.com/path');
  });

  // 15. parseJsonSafe: inline /* block comment */ is stripped (F3)
  await check('parseJsonSafe: inline /* block comment */ stripped', () => {
    const r = parseJsonSafe('{ "a": 1 /* inline */, "b": 2 }');
    assert.strictEqual(r.ok, true, `expected ok:true but got: ${JSON.stringify(r.error)}`);
    assert.deepStrictEqual(r.data, { a: 1, b: 2 });
  });

  // 16. parseJsonSafe: multi-line /* block comment */ is stripped (F3)
  await check('parseJsonSafe: multiline /* block comment */ stripped', () => {
    const r = parseJsonSafe('{\n  /* multi\n  line */\n  "x": 3\n}');
    assert.strictEqual(r.ok, true, `expected ok:true but got: ${JSON.stringify(r.error)}`);
    assert.deepStrictEqual(r.data, { x: 3 });
  });

  // ─── results ─────────────────────────────────────────────────────────────────

  for (const a of assertions) {
    console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
  }

  const failed = assertions.filter(a => !a.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${assertions.length} json-safe check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${assertions.length} json-safe checks`);
  process.exit(0);

})().catch(err => {
  console.error('FAIL: uncaught error in test runner:', err);
  process.exit(1);
});
