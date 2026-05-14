// W7-5a: tests for UTF-8 BOM handling in json-safe.mjs
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HELPERS_PATH = path.join(REPO_ROOT, 'scripts', '_helpers', 'json-safe.mjs');

const { parseJsonSafe, mergeIntoFile } = await import(HELPERS_PATH);

// ---------------------------------------------------------------------------
// parseJsonSafe — BOM stripping
// ---------------------------------------------------------------------------

describe('parseJsonSafe BOM handling', () => {
  test('parses JSON with leading UTF-8 BOM', () => {
    const input = '﻿{"key":"value"}';
    const result = parseJsonSafe(input);
    assert.equal(result.ok, true, 'should parse successfully with BOM');
    assert.deepEqual(result.data, { key: 'value' });
  });

  test('parses JSONC with leading BOM', () => {
    const input = '﻿{\n  // comment\n  "x": 1\n}';
    const result = parseJsonSafe(input, { allowJsonc: true });
    assert.equal(result.ok, true, 'should parse JSONC with BOM');
    assert.deepEqual(result.data, { x: 1 });
  });

  test('parses normal JSON without BOM unchanged', () => {
    const input = '{"a":1}';
    const result = parseJsonSafe(input);
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { a: 1 });
  });

  test('returns parse error on genuinely malformed JSON (no BOM involved)', () => {
    const result = parseJsonSafe('{ not valid json }');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'PARSE_ERROR');
  });
});

// ---------------------------------------------------------------------------
// mergeIntoFile — BOM-prefixed settings file round-trip
// ---------------------------------------------------------------------------

describe('mergeIntoFile BOM handling', () => {
  test('reads file with BOM, merges successfully, writes back without BOM', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-bom-test-'));
    const filePath = path.join(tmpDir, 'settings.json');
    try {
      // Write a settings.json with a leading UTF-8 BOM (3 bytes: EF BB BF)
      const withBom = '﻿{"hooks":{"SessionStart":[]}}';
      fs.writeFileSync(filePath, withBom, 'utf8');

      // First byte on disk must be the BOM
      const rawBytes = fs.readFileSync(filePath);
      assert.equal(rawBytes[0], 0xEF, 'file must start with BOM byte EF');
      assert.equal(rawBytes[1], 0xBB, 'file must have BOM byte BB');
      assert.equal(rawBytes[2], 0xBF, 'file must have BOM byte BF');

      const result = await mergeIntoFile(filePath, (cfg) => {
        cfg.testKey = 'added';
      });

      assert.equal(result.ok, true, 'mergeIntoFile must succeed on BOM-prefixed file');

      const written = fs.readFileSync(filePath, 'utf8');
      // Written file must not start with BOM
      assert.notEqual(written.charCodeAt(0), 0xFEFF, 'written file must not contain BOM');

      const parsed = JSON.parse(written);
      assert.deepEqual(parsed.hooks, { SessionStart: [] }, 'original hooks must be preserved');
      assert.equal(parsed.testKey, 'added', 'mutated key must be present');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
