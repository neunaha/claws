const assert = require('assert');
const vscode = require('vscode');

suite('Extension Test Suite', () => {
  console.log('Start all tests.');

  test('Extension should be present', () => {
    assert.ok(vscode.extensions.getExtension('neunaha.claws'));
  });

  test('Extension should activate', async () => {
    const ext = vscode.extensions.getExtension('neunaha.claws');
    if (!ext) {
      assert.fail('Extension not found');
    }
    await ext.activate();
    assert.ok(ext.isActive);
  });
});
