#!/usr/bin/env node
// Tests for detectElectronVersion() in bundle-native.mjs (M-22, M-23, M-25).
// Verifies TERM_PROGRAM preference, empty-detection warning, and Linux Cursor/Windsurf paths.
// Run: node extension/test/bundle-native-editor-detect.test.js
// Exits 0 on success, 1 on failure. No VS Code dependency.

const assert = require('assert');
const path = require('path');

const SCRIPT_PATH = path.resolve(__dirname, '../scripts/bundle-native.mjs');

const checks = [];
async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, err: err.message || String(err) });
  }
}

// Capture stderr output during fn execution
async function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { chunks.push(String(chunk)); return orig(chunk, ...rest); };
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
  return chunks.join('');
}

(async () => {
  const { detectElectronVersion } = await import(SCRIPT_PATH);

  // 1. CLAWS_ELECTRON_VERSION env override → returns override, no file checks
  await check('CLAWS_ELECTRON_VERSION env override → returns override immediately', async () => {
    process.env.CLAWS_ELECTRON_VERSION = '33.0.0';
    let existsCalled = false;
    try {
      const result = detectElectronVersion({
        platform: 'darwin',
        existsFn: () => { existsCalled = true; return true; },
        execFn: () => '33.0.0',
      });
      assert.strictEqual(result.version, '33.0.0');
      assert.strictEqual(result.source, 'env');
      assert.strictEqual(existsCalled, false, 'should not check filesystem for env override');
    } finally {
      delete process.env.CLAWS_ELECTRON_VERSION;
    }
  });

  // 2. TERM_PROGRAM=cursor → Cursor plist tried before VS Code plist (M-22)
  await check('TERM_PROGRAM=cursor → Cursor candidate tried before VS Code', async () => {
    delete process.env.CLAWS_ELECTRON_VERSION;
    const tried = [];
    detectElectronVersion({
      platform: 'darwin',
      termProgram: 'cursor',
      existsFn: (p) => { tried.push(p); return false; }, // nothing found
      execFn: () => '99.0.0',
    });
    const cursorIdx = tried.findIndex(p => p.includes('Cursor'));
    const vscodeIdx = tried.findIndex(p => p.includes('Visual Studio Code') && !p.includes('Insiders'));
    assert(cursorIdx !== -1, 'Cursor plist should be in the tried list');
    assert(vscodeIdx !== -1, 'VS Code plist should be in the tried list');
    assert(cursorIdx < vscodeIdx, `Cursor (idx ${cursorIdx}) should be tried before VS Code (idx ${vscodeIdx})`);
  });

  // 3. TERM_PROGRAM=windsurf → Windsurf plist tried before VS Code plist (M-22)
  await check('TERM_PROGRAM=windsurf → Windsurf candidate tried before VS Code', async () => {
    delete process.env.CLAWS_ELECTRON_VERSION;
    const tried = [];
    detectElectronVersion({
      platform: 'darwin',
      termProgram: 'windsurf',
      existsFn: (p) => { tried.push(p); return false; },
      execFn: () => '99.0.0',
    });
    const windsurfIdx = tried.findIndex(p => p.includes('Windsurf'));
    const vscodeIdx = tried.findIndex(p => p.includes('Visual Studio Code') && !p.includes('Insiders'));
    assert(windsurfIdx !== -1, 'Windsurf plist should be in the tried list');
    assert(vscodeIdx !== -1, 'VS Code plist should be in the tried list');
    assert(windsurfIdx < vscodeIdx, `Windsurf (idx ${windsurfIdx}) should be tried before VS Code (idx ${vscodeIdx})`);
  });

  // 4. No TERM_PROGRAM → VS Code tried first (default order unchanged)
  await check('no TERM_PROGRAM → VS Code tried first (default order)', async () => {
    delete process.env.CLAWS_ELECTRON_VERSION;
    const tried = [];
    detectElectronVersion({
      platform: 'darwin',
      termProgram: '',
      existsFn: (p) => { tried.push(p); return false; },
      execFn: () => '99.0.0',
    });
    const vscodeIdx = tried.findIndex(p => p.includes('Visual Studio Code') && !p.includes('Insiders'));
    const cursorIdx = tried.findIndex(p => p.includes('Cursor'));
    assert(vscodeIdx !== -1 && cursorIdx !== -1);
    assert(vscodeIdx < cursorIdx, `VS Code (idx ${vscodeIdx}) should be tried before Cursor (idx ${cursorIdx}) with no TERM_PROGRAM`);
  });

  // 5. Linux: Cursor paths included (M-25)
  await check('Linux: Cursor/Windsurf paths included in candidate list', async () => {
    delete process.env.CLAWS_ELECTRON_VERSION;
    const tried = [];
    detectElectronVersion({
      platform: 'linux',
      termProgram: '',
      existsFn: (p) => { tried.push(p); return false; },
      execFn: () => '99.0.0',
    });
    assert(tried.some(p => p.includes('cursor')), `Cursor path not tried. Tried: ${tried.join(', ')}`);
    assert(tried.some(p => p.includes('windsurf')), `Windsurf path not tried. Tried: ${tried.join(', ')}`);
  });

  // 6. Linux: TERM_PROGRAM=cursor → Cursor paths tried before VS Code (M-22 on Linux)
  await check('Linux: TERM_PROGRAM=cursor → Cursor paths tried before VS Code', async () => {
    delete process.env.CLAWS_ELECTRON_VERSION;
    const tried = [];
    detectElectronVersion({
      platform: 'linux',
      termProgram: 'cursor',
      existsFn: (p) => { tried.push(p); return false; },
      execFn: () => '99.0.0',
    });
    const cursorIdx = tried.findIndex(p => p.includes('cursor'));
    const vscodeIdx = tried.findIndex(p => p.includes('/code/'));
    assert(cursorIdx !== -1, 'Cursor path should be in tried list');
    assert(vscodeIdx !== -1, 'VS Code path should be in tried list');
    assert(cursorIdx < vscodeIdx, `Cursor (idx ${cursorIdx}) should be before VS Code (idx ${vscodeIdx})`);
  });

  // 7. No editor found → fallback returned AND stderr warning emitted (M-23)
  await check('No editor found → fallback returned + stderr warning about CLAWS_ELECTRON_VERSION', async () => {
    delete process.env.CLAWS_ELECTRON_VERSION;
    let stderrOutput = '';
    await captureStderr(async () => {
      const result = detectElectronVersion({
        platform: 'darwin',
        termProgram: '',
        existsFn: () => false,
        execFn: () => '',
      });
      assert.strictEqual(result.source, 'fallback', `expected 'fallback', got '${result.source}'`);
      stderrOutput = ''; // captured by captureStderr wrapper
    });
    // Re-run to actually capture stderr
    const stderr = await captureStderr(async () => {
      detectElectronVersion({
        platform: 'darwin',
        termProgram: '',
        existsFn: () => false,
        execFn: () => '',
      });
    });
    assert(
      stderr.includes('CLAWS_ELECTRON_VERSION') || stderr.includes('WARNING'),
      `expected stderr warning about CLAWS_ELECTRON_VERSION, got: ${stderr}`,
    );
  });

  // 8. TERM_PROGRAM=cursor, Cursor plist found → returns Cursor's Electron version
  await check('TERM_PROGRAM=cursor, Cursor plist exists → returns Cursor version', async () => {
    delete process.env.CLAWS_ELECTRON_VERSION;
    const cursorPlist = '/Applications/Cursor.app/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist';
    const result = detectElectronVersion({
      platform: 'darwin',
      termProgram: 'cursor',
      existsFn: (p) => p === cursorPlist,
      execFn: (cmd, args) => {
        if (args.includes(cursorPlist)) return '32.1.0';
        return '';
      },
    });
    assert.strictEqual(result.version, '32.1.0');
    assert(result.source.includes('Cursor'), `expected Cursor source, got: ${result.source}`);
  });

  let failed = 0;
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ' — ' + c.err}`);
    if (!c.ok) failed++;
  }

  if (failed > 0) {
    console.error(`\nFAIL: ${failed}/${checks.length} bundle-native-editor-detect check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${checks.length} bundle-native-editor-detect checks`);
  process.exit(0);
})();
