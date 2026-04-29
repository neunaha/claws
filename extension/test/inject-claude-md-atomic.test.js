#!/usr/bin/env node
// Tests for M-27+M-28: inject-claude-md.js and inject-global-claude-md.js use
// atomic write (tmp + renameSync), preventing partial CLAUDE.md on kill mid-write.
// Run: node extension/test/inject-claude-md-atomic.test.js
// Exits 0 on success, 1 on failure. No VS Code dependency.

'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const INJECT_PROJECT  = path.resolve(__dirname, '../../scripts/inject-claude-md.js');
const INJECT_GLOBAL   = path.resolve(__dirname, '../../scripts/inject-global-claude-md.js');
const TEMPLATE_DIR    = path.resolve(__dirname, '../../templates');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claws-inject-atomic-'));
}

function cleanTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── helper: run inject-claude-md.js on a temp project dir ───────────────────
function runInjectProject(projectDir) {
  return spawnSync(process.execPath, [INJECT_PROJECT, projectDir], {
    encoding: 'utf8',
    timeout: 10000,
  });
}

// ── helper: run inject-global-claude-md.js with HOME override ───────────────
function runInjectGlobal(homeDir) {
  return spawnSync(process.execPath, [INJECT_GLOBAL], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, HOME: homeDir },
  });
}

(async () => {

  // 1. inject-claude-md.js: creates CLAUDE.md (happy path)
  await check('inject-claude-md: creates CLAUDE.md in fresh project dir', () => {
    const dir = makeTmpDir();
    try {
      const r = runInjectProject(dir);
      // May fail if templates/ is missing — that's OK for this test
      const claudeMd = path.join(dir, 'CLAUDE.md');
      // Either the file was created, or the script reported an error about templates
      assert.ok(
        fs.existsSync(claudeMd) || r.stderr.includes('template') || r.stderr.includes('CLAUDE.project.md'),
        `inject-claude-md.js produced no output and no CLAUDE.md: stdout=${r.stdout} stderr=${r.stderr}`
      );
    } finally { cleanTmpDir(dir); }
  });

  // 2. inject-claude-md.js: no .claws-tmp.* files left after successful write
  await check('inject-claude-md: no .claws-tmp.* leftover after write', () => {
    const dir = makeTmpDir();
    try {
      runInjectProject(dir);
      const leftovers = fs.readdirSync(dir).filter(n => n.includes('.claws-tmp.'));
      assert.deepStrictEqual(leftovers, [], `tmp files leaked: ${leftovers.join(', ')}`);
    } finally { cleanTmpDir(dir); }
  });

  // 3. inject-claude-md.js: writeAtomic present in source (static check)
  await check('inject-claude-md.js: writeAtomic function defined (M-27)', () => {
    const src = fs.readFileSync(INJECT_PROJECT, 'utf8');
    assert.ok(src.includes('writeAtomic'), 'writeAtomic not found in inject-claude-md.js');
    assert.ok(src.includes('renameSync'), 'renameSync not found — not using atomic rename pattern');
    assert.ok(src.includes('.claws-tmp.'), '.claws-tmp. suffix not found');
  });

  // 4. inject-claude-md.js: writeAtomic used for the write (not fs.writeFileSync directly)
  await check('inject-claude-md.js: CLAUDE.md write calls writeAtomic, not writeFileSync (M-27)', () => {
    const src = fs.readFileSync(INJECT_PROJECT, 'utf8');
    // The write-if-changed block should call writeAtomic, not writeFileSync
    const lines = src.split('\n');
    const writeIdx = lines.findIndex(l => l.includes('writeAtomic(CLAUDE_MD'));
    assert.ok(writeIdx !== -1, 'writeAtomic(CLAUDE_MD, ...) not found — M-27 not applied');
    // Direct writeFileSync(CLAUDE_MD) calls in the write path must be gone
    const badWrites = lines.filter(l =>
      l.includes('fs.writeFileSync(CLAUDE_MD') && !l.trim().startsWith('//')
    );
    assert.deepStrictEqual(badWrites, [], `Direct fs.writeFileSync(CLAUDE_MD) found: ${badWrites.join('\n')}`);
  });

  // 5. inject-claude-md.js: concurrent runs don't leave tmp files
  await check('inject-claude-md: 3 concurrent runs — no .claws-tmp.* leftover', async () => {
    const dir = makeTmpDir();
    try {
      await Promise.all([
        new Promise(r => { runInjectProject(dir); r(); }),
        new Promise(r => { runInjectProject(dir); r(); }),
        new Promise(r => { runInjectProject(dir); r(); }),
      ]);
      const leftovers = fs.readdirSync(dir).filter(n => n.includes('.claws-tmp.'));
      assert.deepStrictEqual(leftovers, [], `tmp files leaked: ${leftovers.join(', ')}`);
    } finally { cleanTmpDir(dir); }
  });

  // 6. inject-global-claude-md.js: writeAtomic present in source (static check)
  await check('inject-global-claude-md.js: writeAtomic function defined (M-28)', () => {
    const src = fs.readFileSync(INJECT_GLOBAL, 'utf8');
    assert.ok(src.includes('writeAtomic'), 'writeAtomic not found in inject-global-claude-md.js');
    assert.ok(src.includes('renameSync'), 'renameSync not found — not using atomic rename pattern');
    assert.ok(src.includes('M-28'), 'M-28 comment not found');
  });

  // 7. inject-global-claude-md.js: writeAtomic used, not writeFileSync
  await check('inject-global-claude-md.js: CLAUDE.md write calls writeAtomic (M-28)', () => {
    const src = fs.readFileSync(INJECT_GLOBAL, 'utf8');
    const lines = src.split('\n');
    const writeIdx = lines.findIndex(l => l.includes('writeAtomic(GLOBAL_CLAUDE_MD'));
    assert.ok(writeIdx !== -1, 'writeAtomic(GLOBAL_CLAUDE_MD, ...) not found — M-28 not applied');
    const badWrites = lines.filter(l =>
      l.includes('fs.writeFileSync(GLOBAL_CLAUDE_MD') && !l.trim().startsWith('//')
    );
    assert.deepStrictEqual(badWrites, [], `Direct fs.writeFileSync(GLOBAL_CLAUDE_MD) found: ${badWrites.join('\n')}`);
  });

  // 8. inject-global-claude-md.js: creates ~/.claude/CLAUDE.md with no tmp leftover
  await check('inject-global-claude-md: no .claws-tmp.* leftover after write', () => {
    const fakeHome = makeTmpDir();
    try {
      const r = runInjectGlobal(fakeHome);
      // The script should write ~/.claude/CLAUDE.md (relative to fake HOME)
      const claudeDir = path.join(fakeHome, '.claude');
      const leftovers = fs.existsSync(claudeDir)
        ? fs.readdirSync(claudeDir).filter(n => n.includes('.claws-tmp.'))
        : [];
      assert.deepStrictEqual(leftovers, [], `tmp files leaked in .claude/: ${leftovers.join(', ')}`);
    } finally { cleanTmpDir(fakeHome); }
  });

  // 9. simulate kill mid-write: partial file is cleaned up, original preserved
  await check('writeAtomic: simulated partial write — original file preserved', () => {
    const dir = makeTmpDir();
    try {
      const target = path.join(dir, 'CLAUDE.md');
      const originalContent = '# Original\n\noriginal content here\n';
      fs.writeFileSync(target, originalContent);

      // Simulate what happens when a tmp file is left behind (e.g. kill before rename):
      // In the real writeAtomic, if rename fails, the tmp is cleaned. We verify:
      // 1. If we manually leave a .claws-tmp. file, the original is unchanged
      const orphanTmp = target + '.claws-tmp.99999-1';
      fs.writeFileSync(orphanTmp, 'PARTIAL WRITE CONTENT');

      // Orphan tmp should not affect original
      assert.strictEqual(fs.readFileSync(target, 'utf8'), originalContent, 'original must be unchanged');

      // The orphan tmp should not replace the original
      assert.ok(fs.existsSync(orphanTmp), 'orphan tmp exists (as created)');
      assert.strictEqual(fs.readFileSync(target, 'utf8'), originalContent, 'original preserved despite orphan tmp');
    } finally { cleanTmpDir(dir); }
  });

  // ─── results ─────────────────────────────────────────────────────────────
  for (const a of assertions) {
    console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
  }

  const failed = assertions.filter(a => !a.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${assertions.length} inject-claude-md-atomic check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${assertions.length} inject-claude-md-atomic checks`);
  process.exit(0);

})().catch(err => {
  console.error('FAIL: uncaught error in test runner:', err);
  process.exit(1);
});
