'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const {
  _removePriorBlock, _removeLegacyBlock, _getStandardRcFiles, _injectPowershellHook,
} = require('../lib/shell-hook.js');

const FAKE_INSTALL = '/fake/install';
const HOOK_SH = `${FAKE_INSTALL}/scripts/shell-hook.sh`;

// Simulate what _injectIntoFile appends after _removePriorBlock.
function inject(content, hookSh = HOOK_SH) {
  const block = `\n# CLAWS terminal hook\nsource "${hookSh}"\n`;
  return _removePriorBlock(content) + block;
}

describe('shell-hook — marker format (W7h-1)', () => {

  // (a) injection produces install.sh-style canonical marker (no legacy >>> format)
  test('(a) inject produces canonical "# CLAWS terminal hook" marker', () => {
    const result = inject('');
    assert.ok(result.includes('# CLAWS terminal hook'), 'must include canonical marker');
    assert.ok(result.includes(`source "${HOOK_SH}"`), 'must include source line');
    assert.ok(!result.includes('>>>'), 'must NOT use legacy >>> format');
    assert.ok(!result.includes('<<<'), 'must NOT use legacy <<< format');
    assert.ok(!result.includes('[ -f'), 'must NOT use conditional [ -f ] form');
  });

  // (b-1) cleanup removes canonical marker + source line
  test('(b-1) _removePriorBlock removes canonical marker + source line', () => {
    const content = [
      'export FOO=1',
      '# CLAWS terminal hook',
      `source "${HOOK_SH}"`,
      'export BAR=2',
    ].join('\n');
    const result = _removePriorBlock(content);
    assert.ok(!result.includes('# CLAWS terminal hook'), 'marker must be removed');
    assert.ok(!result.includes('shell-hook.sh'), 'source line must be removed');
    assert.ok(result.includes('FOO=1'), 'pre-content preserved');
    assert.ok(result.includes('BAR=2'), 'post-content preserved');
  });

  // (b-2) cleanup removes legacy >>>...<<< block
  test('(b-2) _removePriorBlock removes legacy >>>...<<< block', () => {
    const content = [
      'export FOO=1',
      '# >>> claws-code shell hook >>>',
      `[ -f "/old/scripts/shell-hook.sh" ] && source "/old/scripts/shell-hook.sh"`,
      '# <<< claws-code shell hook <<<',
      'export BAR=2',
    ].join('\n');
    const result = _removePriorBlock(content);
    assert.ok(!result.includes('>>>'), 'legacy begin marker removed');
    assert.ok(!result.includes('<<<'), 'legacy end marker removed');
    assert.ok(!result.includes('shell-hook.sh'), 'legacy source line removed');
    assert.ok(result.includes('FOO=1'), 'pre-content preserved');
    assert.ok(result.includes('BAR=2'), 'post-content preserved');
  });

  // (b-3) cleanup removes both formats when both are present (transition scenario)
  test('(b-3) _removePriorBlock removes both legacy and canonical when both exist', () => {
    const content = [
      'export FOO=1',
      '# >>> claws-code shell hook >>>',
      `[ -f "/old/scripts/shell-hook.sh" ] && source "/old/scripts/shell-hook.sh"`,
      '# <<< claws-code shell hook <<<',
      'export MID=mid',
      '# CLAWS terminal hook',
      `source "${HOOK_SH}"`,
      'export BAR=2',
    ].join('\n');
    const result = _removePriorBlock(content);
    assert.ok(!result.includes('>>>'), 'legacy begin removed');
    assert.ok(!result.includes('<<<'), 'legacy end removed');
    assert.ok(!result.includes('# CLAWS terminal hook'), 'canonical marker removed');
    assert.ok(!result.includes('shell-hook.sh'), 'all source lines removed');
    assert.ok(result.includes('FOO=1'), 'pre-content preserved');
    assert.ok(result.includes('MID=mid'), 'mid-content preserved');
    assert.ok(result.includes('BAR=2'), 'post-content preserved');
  });

  // (c) idempotent: injecting twice produces exactly one block
  test('(c) inject is idempotent — double inject produces exactly one marker', () => {
    const base = 'export FOO=1\nexport BAR=2';
    const afterFirst  = inject(base);
    const afterSecond = inject(afterFirst);
    const count = (afterSecond.match(/# CLAWS terminal hook/g) || []).length;
    assert.equal(count, 1, 'exactly 1 marker after two injections');
    assert.equal(
      (afterSecond.match(/shell-hook\.sh/g) || []).length,
      1,
      'exactly 1 source line after two injections'
    );
  });

  // (c-2) idempotent: remove is stable (double remove == single remove)
  test('(c-2) _removePriorBlock is stable — double removal equals single removal', () => {
    const content = [
      'export FOO=1',
      '# CLAWS terminal hook',
      `source "${HOOK_SH}"`,
      'export BAR=2',
    ].join('\n');
    const afterOne = _removePriorBlock(content);
    const afterTwo = _removePriorBlock(afterOne);
    assert.equal(afterOne, afterTwo, 'double removal equals single removal');
  });

  // (c-3) _removeLegacyBlock exported correctly and strips only legacy format
  test('(c-3) _removeLegacyBlock does not strip canonical marker', () => {
    const content = [
      '# CLAWS terminal hook',
      `source "${HOOK_SH}"`,
    ].join('\n');
    const result = _removeLegacyBlock(content);
    assert.ok(result.includes('# CLAWS terminal hook'), 'canonical marker untouched by legacy remover');
  });

  // (d-1) _removePriorBlock handles PowerShell dot-source line (W7h-32 / W7-4)
  test('(d-1) _removePriorBlock removes canonical marker + PS1 dot-source line', () => {
    const content = [
      '$env:FOO = 1',
      '# CLAWS terminal hook',
      '. "/fake/install/scripts/shell-hook.ps1"',
      '$env:BAR = 2',
    ].join('\n');
    const result = _removePriorBlock(content);
    assert.ok(!result.includes('# CLAWS terminal hook'), 'marker must be removed');
    assert.ok(!result.includes('shell-hook.ps1'), 'PS1 dot-source line must be removed');
    assert.ok(result.includes('FOO'), 'pre-content preserved');
    assert.ok(result.includes('BAR'), 'post-content preserved');
  });

  // (d-2) _removePriorBlock idempotent for PS1 form
  test('(d-2) _removePriorBlock is idempotent for PS1 form', () => {
    const HOOK_PS1 = '/fake/install/scripts/shell-hook.ps1';
    const base = '$env:FOO = 1';
    const withBlock = base + '\n# CLAWS terminal hook\n. "' + HOOK_PS1 + '"\n';
    const afterOne = _removePriorBlock(withBlock);
    const afterTwo = _removePriorBlock(afterOne);
    assert.equal(afterOne, afterTwo, 'double removal equals single removal for PS1');
    assert.ok(!afterOne.includes('shell-hook.ps1'), 'PS1 source line removed');
  });
});

describe('shell-hook — win32 rc-file list (W7h-32)', () => {
  // _getStandardRcFiles returns [] on win32 (PS injection handled separately)
  test('win32 _getStandardRcFiles returns empty array', () => {
    const files = _getStandardRcFiles({ platform: 'win32', home: '/home/test' });
    assert.deepEqual(files, [], 'win32 must return [] (PS injection is handled by _injectPowershellHook)');
  });
});

describe('shell-hook — W7-4B: PS hook sourced from stable ~/.claude/claws/ path', () => {
  function makeTmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'w74b-'));
  }
  // Suppress powershell fallback for all tests in this suite.
  const noExec = () => { throw new Error('powershell not available'); };

  // (e-1) _injectPowershellHook copies hook to stable dir and $PROFILE references stable path.
  test('(e-1) $PROFILE references stable ~/.claude/claws/shell-hook.ps1, not installDir', () => {
    const tmp = makeTmp();
    try {
      const installDir = path.join(tmp, 'install');
      const homeDir    = path.join(tmp, 'home');
      fs.mkdirSync(path.join(installDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(installDir, 'scripts', 'shell-hook.ps1'), '# hook', 'utf8');

      _injectPowershellHook(installDir, false, { home: homeDir, execFn: noExec });

      const stableHook  = path.join(homeDir, '.claude', 'claws', 'shell-hook.ps1');
      const profilePath = path.join(homeDir, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
      assert.ok(fs.existsSync(stableHook),          'shell-hook.ps1 must exist at stable location');
      const content = fs.readFileSync(profilePath, 'utf8');
      assert.ok(content.includes(stableHook),       '$PROFILE must reference stable path');
      assert.ok(!content.includes(installDir),      '$PROFILE must NOT reference installDir');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // (e-2) re-install strips orphan claws-install-* temp-path block and injects stable path.
  test('(e-2) re-install removes orphan claws-install-* temp path and injects stable path', () => {
    const tmp = makeTmp();
    try {
      const installDir = path.join(tmp, 'install');
      const homeDir    = path.join(tmp, 'home');
      fs.mkdirSync(path.join(installDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(installDir, 'scripts', 'shell-hook.ps1'), '# hook', 'utf8');

      // Simulate an existing $PROFILE with the orphan temp-dir line from a prior bad install.
      const profileDir  = path.join(homeDir, 'Documents', 'WindowsPowerShell');
      const profilePath = path.join(profileDir, 'Microsoft.PowerShell_profile.ps1');
      fs.mkdirSync(profileDir, { recursive: true });
      const orphan = '. "C:\\Users\\claws\\AppData\\Local\\Temp\\2\\claws-install-71aab029\\extract\\claws-0.8-alpha\\scripts\\shell-hook.ps1"';
      fs.writeFileSync(profilePath, `# CLAWS terminal hook\n${orphan}\n`, 'utf8');

      _injectPowershellHook(installDir, false, { home: homeDir, execFn: noExec });

      const content = fs.readFileSync(profilePath, 'utf8');
      assert.ok(!content.includes('claws-install-'), 'orphan claws-install-* path must be removed');
      const stableHook = path.join(homeDir, '.claude', 'claws', 'shell-hook.ps1');
      assert.ok(content.includes(stableHook), '$PROFILE must reference stable path after re-install');
      assert.equal((content.match(/# CLAWS terminal hook/g) || []).length, 1, 'exactly one marker after re-install');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // (e-3) dryRun does not write any files.
  test('(e-3) dryRun writes nothing to disk', () => {
    const tmp = makeTmp();
    try {
      const installDir = path.join(tmp, 'install');
      const homeDir    = path.join(tmp, 'home');
      fs.mkdirSync(path.join(installDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(installDir, 'scripts', 'shell-hook.ps1'), '# hook', 'utf8');

      _injectPowershellHook(installDir, true, { home: homeDir, execFn: noExec });

      const stableHook = path.join(homeDir, '.claude', 'claws', 'shell-hook.ps1');
      assert.ok(!fs.existsSync(stableHook), 'dryRun must not copy hook to stable location');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
