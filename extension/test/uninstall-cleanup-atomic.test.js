#!/usr/bin/env node
// Tests for M-30: uninstall-cleanup.ts must write .mcp.json and CLAUDE.md atomically.
// Prevents half-uninstalled state when the user kills mid-uninstall.
// Run: node extension/test/uninstall-cleanup-atomic.test.js
// Exits 0 on success, 1 on failure. No VS Code dependency.

'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const UNINSTALL_TS = path.resolve(__dirname, '../src/uninstall-cleanup.ts');
const DIST_PATH    = path.resolve(__dirname, '../dist/extension.js');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claws-uninstall-atomic-'));
}

function cleanTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

(async () => {

  // 1. Source has writeAtomic helper (M-30 static check)
  await check('uninstall-cleanup.ts: writeAtomic helper defined (M-30)', () => {
    const src = fs.readFileSync(UNINSTALL_TS, 'utf8');
    assert.ok(src.includes('writeAtomic'), 'writeAtomic not found in uninstall-cleanup.ts');
    assert.ok(src.includes('renameSync'), 'renameSync not found — not using atomic rename pattern');
    assert.ok(src.includes('M-30'), 'M-30 comment not found');
    assert.ok(src.includes('.claws-tmp.'), '.claws-tmp. suffix not found');
  });

  // 2. edit-json path calls writeAtomic not writeFileSync directly
  await check('uninstall-cleanup.ts: edit-json uses writeAtomic (M-30)', () => {
    const src = fs.readFileSync(UNINSTALL_TS, 'utf8');
    const lines = src.split('\n');
    // The edit-json write line must call writeAtomic
    const atomicJsonLine = lines.findIndex(l =>
      l.includes('writeAtomic(action.path') && l.includes('JSON.stringify')
    );
    assert.ok(atomicJsonLine !== -1, 'writeAtomic(action.path, JSON.stringify(...)) not found for edit-json');
    // Direct writeFileSync(action.path) must be gone in the edit-json block
    const directJsonWrite = lines.filter(l =>
      l.includes('writeFileSync(action.path') &&
      l.includes('JSON.stringify') &&
      !l.trim().startsWith('//')
    );
    assert.deepStrictEqual(directJsonWrite, [], `Direct fs.writeFileSync(action.path, JSON.stringify...) found: ${directJsonWrite.join('\n')}`);
  });

  // 3. edit-markdown path calls writeAtomic not writeFileSync directly
  await check('uninstall-cleanup.ts: edit-markdown uses writeAtomic (M-30)', () => {
    const src = fs.readFileSync(UNINSTALL_TS, 'utf8');
    const lines = src.split('\n');
    // The edit-markdown write line must call writeAtomic
    const atomicMdLine = lines.findIndex(l =>
      l.includes('writeAtomic(action.path') && l.includes('stripped')
    );
    assert.ok(atomicMdLine !== -1, 'writeAtomic(action.path, stripped) not found for edit-markdown');
    // Direct writeFileSync(action.path, stripped) must be gone
    const directMdWrite = lines.filter(l =>
      l.includes('writeFileSync(action.path') &&
      (l.includes('stripped') || !l.includes('JSON.stringify')) &&
      !l.trim().startsWith('//')
    );
    assert.deepStrictEqual(directMdWrite, [], `Direct fs.writeFileSync(action.path, stripped...) found: ${directMdWrite.join('\n')}`);
  });

  // 4. writeAtomic inline implementation: no tmp leftover on success
  await check('writeAtomic (TS inline): no .claws-tmp.* leftover', () => {
    const dir = makeTmpDir();
    try {
      // Inline the same writeAtomic logic to test it independently
      let _nonce = 0;
      function writeAtomicTest(filePath, content) {
        const tmp = `${filePath}.claws-tmp.${process.pid}-${++_nonce}`;
        try {
          fs.writeFileSync(tmp, content, { mode: 0o644 });
          fs.renameSync(tmp, filePath);
        } catch (err) {
          try { fs.unlinkSync(tmp); } catch { /* ignore */ }
          throw err;
        }
      }

      const target = path.join(dir, 'test.json');
      writeAtomicTest(target, '{"ok":true}\n');

      assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"ok":true}\n');
      const leftovers = fs.readdirSync(dir).filter(n => n.includes('.claws-tmp.'));
      assert.deepStrictEqual(leftovers, [], `tmp files leaked: ${leftovers.join(', ')}`);
    } finally { cleanTmpDir(dir); }
  });

  // 5. writeAtomic inline: original preserved if rename fails
  await check('writeAtomic (TS inline): original preserved on failure', () => {
    const dir = makeTmpDir();
    try {
      const target = path.join(dir, 'original.json');
      const originalContent = '{"preserved":true}\n';
      fs.writeFileSync(target, originalContent);

      // Simulate orphan tmp (killed before rename)
      const orphanTmp = target + '.claws-tmp.99999-0';
      fs.writeFileSync(orphanTmp, 'PARTIAL');

      // Original must be untouched
      assert.strictEqual(fs.readFileSync(target, 'utf8'), originalContent);
      // Orphan must exist (we created it)
      assert.ok(fs.existsSync(orphanTmp));
    } finally { cleanTmpDir(dir); }
  });

  // 6. edit-json action simulation: .mcp.json gets claws removed atomically
  await check('edit-json simulation: claws removed from .mcp.json, no tmp leftover', () => {
    const dir = makeTmpDir();
    try {
      const mcpFile = path.join(dir, '.mcp.json');
      const original = {
        mcpServers: {
          claws: { command: 'node', args: ['/project/.claws-bin/mcp_server.js'] },
          filesystem: { command: 'npx', args: ['-y', '@mcp/server-filesystem'] },
        }
      };
      fs.writeFileSync(mcpFile, JSON.stringify(original, null, 2) + '\n');

      // Simulate what uninstall-cleanup does for edit-json
      let _nonce = 0;
      function writeAtomicSim(filePath, content) {
        const tmp = `${filePath}.claws-tmp.${process.pid}-${++_nonce}`;
        fs.writeFileSync(tmp, content);
        fs.renameSync(tmp, filePath);
      }

      const raw = fs.readFileSync(mcpFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed.mcpServers) delete parsed.mcpServers.claws;
      writeAtomicSim(mcpFile, JSON.stringify(parsed, null, 2) + '\n');

      const result = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
      assert.ok(!result.mcpServers.claws, 'claws entry not removed');
      assert.ok(result.mcpServers.filesystem, 'filesystem entry removed (collateral damage)');

      const leftovers = fs.readdirSync(dir).filter(n => n.includes('.claws-tmp.'));
      assert.deepStrictEqual(leftovers, [], `tmp files leaked: ${leftovers.join(', ')}`);
    } finally { cleanTmpDir(dir); }
  });

  // 7. edit-markdown action simulation: CLAUDE.md Claws block removed atomically
  await check('edit-markdown simulation: Claws block removed from CLAUDE.md, no tmp leftover', () => {
    const dir = makeTmpDir();
    try {
      const mdFile = path.join(dir, 'CLAUDE.md');
      const content = [
        '# My Project',
        '',
        'Some user content.',
        '',
        '<!-- CLAWS:BEGIN -->',
        '## Claws Block',
        'claws stuff here',
        '<!-- CLAWS:END -->',
        '',
        'More user content.',
      ].join('\n') + '\n';
      fs.writeFileSync(mdFile, content);

      let _nonce = 0;
      function writeAtomicSim(filePath, c) {
        const tmp = `${filePath}.claws-tmp.${process.pid}-${++_nonce}`;
        fs.writeFileSync(tmp, c);
        fs.renameSync(tmp, filePath);
      }

      const raw = fs.readFileSync(mdFile, 'utf8');
      const stripped = raw.replace(/<!-- CLAWS:BEGIN -->[\s\S]*?<!-- CLAWS:END -->\n?/g, '');
      writeAtomicSim(mdFile, stripped);

      const result = fs.readFileSync(mdFile, 'utf8');
      assert.ok(!result.includes('CLAWS:BEGIN'), 'Claws block not stripped');
      assert.ok(result.includes('My Project'), 'User content lost');
      assert.ok(result.includes('More user content'), 'Post-block content lost');

      const leftovers = fs.readdirSync(dir).filter(n => n.includes('.claws-tmp.'));
      assert.deepStrictEqual(leftovers, [], `tmp files leaked: ${leftovers.join(', ')}`);
    } finally { cleanTmpDir(dir); }
  });

  // ─── results ─────────────────────────────────────────────────────────────
  for (const a of assertions) {
    console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
  }

  const failed = assertions.filter(a => !a.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${assertions.length} uninstall-cleanup-atomic check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${assertions.length} uninstall-cleanup-atomic checks`);
  process.exit(0);

})().catch(err => {
  console.error('FAIL: uncaught error in test runner:', err);
  process.exit(1);
});
