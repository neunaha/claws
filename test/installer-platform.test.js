'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  findCodeCli,
  detectOneDrivePath,
  longPathPreflight,
  defenderExclusionCommand,
  getDefaultShellRcFile,
  dryRunLog,
} = require('../lib/platform.js');

// ---------------------------------------------------------------------------
// findCodeCli
// ---------------------------------------------------------------------------

describe('findCodeCli', () => {
  test('returns CLAWS_VSCODE_CLI env override when the path exists', () => {
    const fake = '/usr/local/bin/code-override';
    const result = findCodeCli({
      platform: 'darwin',
      env:      { CLAWS_VSCODE_CLI: fake },
      existsFn: (p) => p === fake,
      spawnFn:  () => ({ status: 1, stdout: '' }),
    });
    assert.equal(result, fake);
  });

  test('ignores CLAWS_VSCODE_CLI when path does not exist', () => {
    const linuxPath = '/usr/bin/code';
    const result = findCodeCli({
      platform: 'linux',
      env:      { CLAWS_VSCODE_CLI: '/nonexistent/code' },
      existsFn: (p) => p === linuxPath,
      spawnFn:  () => ({ status: 1, stdout: '' }),
    });
    assert.equal(result, linuxPath);
  });

  test('win32: returns LOCALAPPDATA path when it exists', () => {
    const localApp = 'C:\\Users\\Test\\AppData\\Local';
    const expected = path.join(localApp, 'Programs', 'Microsoft VS Code', 'bin', 'Code.cmd');
    const result = findCodeCli({
      platform: 'win32',
      env:      { LOCALAPPDATA: localApp, ProgramFiles: 'C:\\Program Files' },
      existsFn: (p) => p === expected,
      spawnFn:  () => ({ status: 1, stdout: '' }),
    });
    assert.equal(result, expected);
  });

  test('darwin: returns Mac app-bundle path when it exists', () => {
    const mac = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
    const result = findCodeCli({
      platform: 'darwin',
      env:      {},
      existsFn: (p) => p === mac,
      spawnFn:  () => ({ status: 1, stdout: '' }),
    });
    assert.equal(result, mac);
  });

  test('falls back to which/where result when no known path exists', () => {
    const result = findCodeCli({
      platform: 'linux',
      env:      {},
      existsFn: () => false,
      spawnFn:  () => ({ status: 0, stdout: '/usr/local/bin/code\n' }),
    });
    assert.equal(result, '/usr/local/bin/code');
  });

  test('returns null when nothing is found', () => {
    const result = findCodeCli({
      platform: 'linux',
      env:      {},
      existsFn: () => false,
      spawnFn:  () => ({ status: 1, stdout: '' }),
    });
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// detectOneDrivePath
// ---------------------------------------------------------------------------

describe('detectOneDrivePath', () => {
  test('returns true when path contains OneDrive', () => {
    assert.equal(detectOneDrivePath('C:\\Users\\Alice\\OneDrive - Corp\\Documents'), true);
  });

  test('returns false for a normal home directory', () => {
    assert.equal(detectOneDrivePath('/Users/alice'), false);
  });
});

// ---------------------------------------------------------------------------
// longPathPreflight
// ---------------------------------------------------------------------------

describe('longPathPreflight', () => {
  test('returns a warning for paths longer than 100 characters', () => {
    const longPath = '/home/' + 'x'.repeat(96);
    const msg = longPathPreflight(longPath);
    assert.ok(msg !== null, 'expected a warning string');
    assert.ok(msg.includes('Warning'), 'warning should contain "Warning"');
  });

  test('returns a warning for OneDrive-rooted paths', () => {
    const msg = longPathPreflight('C:\\Users\\Alice\\OneDrive\\Desktop');
    assert.ok(msg !== null, 'expected a warning string');
    assert.ok(msg.includes('OneDrive'), 'warning should mention OneDrive');
  });

  test('returns null for a short, normal path', () => {
    assert.equal(longPathPreflight('/Users/alice'), null);
  });
});

// ---------------------------------------------------------------------------
// defenderExclusionCommand
// ---------------------------------------------------------------------------

describe('defenderExclusionCommand', () => {
  test('returns a PowerShell Add-MpPreference snippet on win32', () => {
    const installPath = 'C:\\Users\\Alice\\.vscode\\extensions';
    const cmd = defenderExclusionCommand(installPath, { platform: 'win32' });
    assert.ok(cmd !== null, 'expected a non-null command');
    assert.ok(cmd.includes('Add-MpPreference'), 'should include Add-MpPreference');
    assert.ok(cmd.includes(installPath), 'should include the install path');
  });

  test('returns null on darwin', () => {
    assert.equal(
      defenderExclusionCommand('/Users/alice/.vscode/extensions', { platform: 'darwin' }),
      null,
    );
  });

  test('returns null on linux', () => {
    assert.equal(
      defenderExclusionCommand('/home/alice/.vscode/extensions', { platform: 'linux' }),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// getDefaultShellRcFile
// ---------------------------------------------------------------------------

describe('getDefaultShellRcFile', () => {
  test('returns ~/.zshrc when $SHELL is zsh', () => {
    const result = getDefaultShellRcFile({
      platform: 'linux',
      env:      { SHELL: '/bin/zsh' },
      home:     '/home/alice',
    });
    assert.equal(result, '/home/alice/.zshrc');
  });

  test('returns ~/.bashrc when $SHELL is bash', () => {
    const result = getDefaultShellRcFile({
      platform: 'linux',
      env:      { SHELL: '/bin/bash' },
      home:     '/home/alice',
    });
    assert.equal(result, '/home/alice/.bashrc');
  });

  test('returns fish config when $SHELL is fish', () => {
    const result = getDefaultShellRcFile({
      platform: 'linux',
      env:      { SHELL: '/usr/bin/fish' },
      home:     '/home/alice',
    });
    assert.equal(result, path.join('/home/alice', '.config', 'fish', 'config.fish'));
  });

  test('win32: returns PowerShell $PROFILE resolved by powershell', () => {
    const psProfile = 'C:\\Users\\Alice\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1';
    const result = getDefaultShellRcFile({
      platform: 'win32',
      env:      {},
      home:     'C:\\Users\\Alice',
      execFn:   () => psProfile,
    });
    assert.equal(result, psProfile);
  });

  test('win32: falls back to canonical profile path when powershell is unavailable', () => {
    const result = getDefaultShellRcFile({
      platform: 'win32',
      env:      {},
      home:     'C:\\Users\\Alice',
      execFn:   () => { throw new Error('powershell not found'); },
    });
    assert.ok(result.includes('Microsoft.PowerShell_profile.ps1'));
  });

  test('darwin: falls back to ~/.zshrc when $SHELL is unset', () => {
    const result = getDefaultShellRcFile({
      platform: 'darwin',
      env:      {},
      home:     '/Users/alice',
    });
    assert.equal(result, '/Users/alice/.zshrc');
  });
});

// ---------------------------------------------------------------------------
// dryRunLog
// ---------------------------------------------------------------------------

describe('dryRunLog', () => {
  test('writes a [dry-run] prefixed line to stdout', () => {
    const captured = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
    try {
      dryRunLog('install mcp_server.js');
    } finally {
      process.stdout.write = orig;
    }
    assert.equal(captured.join(''), '[dry-run] install mcp_server.js\n');
  });
});
