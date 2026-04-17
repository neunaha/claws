const assert = require('assert');
const vscode = require('vscode');
const { publisher, name } = require('../../package.json');

const extensionId = `${publisher}.${name}`;

suite('Extension Test Suite', () => {
  vscode.window.showInformationMessage('Start all tests.');

  test('Extension should be present', () => {
    assert.ok(vscode.extensions.getExtension(extensionId));
  });

  test('Extension should activate', async () => {
    const ext = vscode.extensions.getExtension(extensionId);
    if (!ext) {
      assert.fail('Extension not found');
    }
    await ext.activate();
    assert.ok(ext.isActive);
  });
});
