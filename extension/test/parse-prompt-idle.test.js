#!/usr/bin/env node
// Regression: parsePromptIdle must detect the ❯ prompt even when it's NOT the
// last non-empty line. Claude TUI renders the prompt above the bypass-permissions
// + cost footer, so the LAST non-empty line is always the footer.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Extract parsePromptIdle from mcp_server.js source
const src = fs.readFileSync(path.resolve(__dirname, '../../mcp_server.js'), 'utf8');
const fnMatch = src.match(/function parsePromptIdle\(text\) \{[\s\S]*?\n\}/);
assert.ok(fnMatch, 'parsePromptIdle function not found');
const parsePromptIdle = new Function('text',
  fnMatch[0].replace(/^function parsePromptIdle\(text\) \{/, '').replace(/\}$/, '')
);

// Test 1: real Claude TUI render at idle (prompt above footer)
const realRender = [
  '─────────────────────────────',
  '❯ ',
  '─────────────────────────────',
  '[█░░░░░░░░░] 18% in:719 out:332 cost:$2376.70',
  '⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');
assert.strictEqual(parsePromptIdle(realRender), true,
  'must detect ❯ prompt even when it is above the footer (real TUI layout)');

// Test 2: prompt as last non-empty line still works (don't regress)
const simpleRender = [
  'some output',
  '❯ ',
].join('\n');
assert.strictEqual(parsePromptIdle(simpleRender), true);

// Test 3: no prompt → false
const noPrompt = ['some text', 'no prompt here'].join('\n');
assert.strictEqual(parsePromptIdle(noPrompt), false);

// Test 4: prompt has user-typed text → not idle
const typedPrompt = [
  '─────',
  '❯ user typed something',
  '─────',
  'cost footer',
].join('\n');
assert.strictEqual(parsePromptIdle(typedPrompt), false,
  '❯ followed by user input means NOT idle');

console.log('parse-prompt-idle.test.js: 4/4 PASS');
