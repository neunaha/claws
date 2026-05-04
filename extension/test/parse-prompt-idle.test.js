#!/usr/bin/env node
// Regression: parsePromptIdle detects Claude TUI's idle state via the
// "⏵⏵ bypass permissions on" footer. ANSI strip collapses the ❯ prompt
// onto a single line with surrounding box-drawing chars, so the prompt char
// itself is unreliable. The bypass-permissions footer is a clean signal.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.resolve(__dirname, '../../mcp_server.js'), 'utf8');
const fnMatch = src.match(/function parsePromptIdle\(text\) \{[\s\S]*?\n\}/);
assert.ok(fnMatch, 'parsePromptIdle function not found');
const parsePromptIdle = new Function('text',
  fnMatch[0].replace(/^function parsePromptIdle\(text\) \{/, '').replace(/\}$/, '')
);

// Test 1: real Claude TUI render at idle (bypass-permissions present)
const realIdle = [
  '─────────────────❯                              ─────────────────',
  '[█░░░░░░░░░] 18% in:719 out:332 cost:$2376.70',
  '⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');
assert.strictEqual(parsePromptIdle(realIdle), true,
  'must detect bypass-permissions footer');

// Test 2: Claude is working (no bypass-permissions footer visible)
const workingState = [
  '⏺Bash(echo hello)',
  '  ⎿ hello',
  '✻ Brewed for 5s',
].join('\n');
assert.strictEqual(parsePromptIdle(workingState), false,
  'no idle signal when Claude is in tool execution');

// Test 3: empty text
assert.strictEqual(parsePromptIdle(''), false);

// Test 4: bypass-permissions string deep in history (still > 30 lines from end → not idle)
const oldHistory = [
  '⏵⏵ bypass permissions on (old footer)',
  ...Array(50).fill('some output line'),
  'current work line',
].join('\n');
assert.strictEqual(parsePromptIdle(oldHistory), false,
  'bypass-permissions in old history (>30 lines from end) should not count as currently idle');

console.log('parse-prompt-idle.test.js: 4/4 PASS');
