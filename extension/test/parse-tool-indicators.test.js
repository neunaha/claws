#!/usr/bin/env node
// Regression: parseToolIndicators must match Claude TUI's actual `⏺ToolName(args)`
// format (zero whitespace between ⏺ and tool name). The original regex used \s+
// and missed every real tool indicator. See .local/audits/cascade-parser-mismatch.md.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Extract parseToolIndicators from mcp_server.js source via regex, then eval it
// as a standalone function. This avoids turning mcp_server.js into a CJS module.
const src = fs.readFileSync(path.resolve(__dirname, '../../mcp_server.js'), 'utf8');
const fnMatch = src.match(/function parseToolIndicators\(text, sinceOffset\) \{[\s\S]*?\n\}/);
assert.ok(fnMatch, 'parseToolIndicators function not found in mcp_server.js');
// eslint-disable-next-line no-new-func
const parseToolIndicators = new Function('text', 'sinceOffset',
  fnMatch[0]
    .replace(/^function parseToolIndicators\(text, sinceOffset\) \{/, '')
    .slice(0, -1)  // remove trailing }
);

// Test 1: 62KB real pty fixture — must find ≥3 tool matches including Bash
const fixture = fs.readFileSync(
  path.resolve(__dirname, 'fixtures/claude-tui-pty-sample.txt'), 'utf8'
);
const allMatches = parseToolIndicators(fixture, 0);
assert.ok(allMatches.length >= 3, `expected ≥3 tool matches in fixture, got ${allMatches.length}`);
assert.ok(allMatches.some(m => m.tool === 'Bash'), 'expected at least one Bash match in fixture');

// Test 2: zero-whitespace format (actual TUI render — the case \s+ missed)
const noWhitespace = '⏺Bash(echo hello)';
const m1 = parseToolIndicators(noWhitespace, 0);
assert.strictEqual(m1.length, 1, 'must match ⏺Bash(...) with zero whitespace');
assert.strictEqual(m1[0].tool, 'Bash');

// Test 3: one-space format (backward compat — docs + task-description examples)
const withSpace = '⏺ Bash(echo hello)';
const m2 = parseToolIndicators(withSpace, 0);
assert.strictEqual(m2.length, 1, 'must still match ⏺ Bash(...) with one whitespace');
assert.strictEqual(m2[0].tool, 'Bash');

// Test 4: spinner frame must NOT match (regression guard)
const spinner = '⏺\r✳Orbiting…';
const m3 = parseToolIndicators(spinner, 0);
assert.strictEqual(m3.length, 0, 'spinner frame ⏺\\r✳… must not produce a match');

// Test 5: sinceOffset skips earlier content
const twoTools = '⏺Read(a.ts)\n⏺Write(b.ts)';
const m4 = parseToolIndicators(twoTools, twoTools.indexOf('\n') + 1);
assert.strictEqual(m4.length, 1, 'sinceOffset must skip first tool');
assert.strictEqual(m4[0].tool, 'Write');

console.log('parse-tool-indicators.test.js: 5/5 PASS');
