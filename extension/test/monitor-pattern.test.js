#!/usr/bin/env node
// Test: monitor_arm_command from mcp_server.js uses awk + heartbeat topic at all 5 sites.
const path = require('path');
const assert = require('assert');

const MCP = path.resolve(__dirname, '../../mcp_server.js');
const src = require('fs').readFileSync(MCP, 'utf8');

// Use simple string splitting to count occurrences (avoids backslash-escaping complexity)
function countOccurrences(haystack, needle) {
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

// The heartbeat topic needle as it appears in the raw source
const HEARTBEAT_NEEDLE = "CLAWS_TOPIC='worker.${";
// The awk-exit needle as it appears in the raw source
const AWK_NEEDLE = "awk '{print; fflush()} /system";
// The old grep-m1 needle that must be gone
const OLD_GREP_NEEDLE = "grep --line-buffered -m1 'system";

const heartbeatCount = countOccurrences(src, HEARTBEAT_NEEDLE);
const awkCount = countOccurrences(src, AWK_NEEDLE);
const oldGrepCount = countOccurrences(src, OLD_GREP_NEEDLE);

assert.strictEqual(heartbeatCount, 5, `expected 5 heartbeat-topic sites, got ${heartbeatCount}`);
assert.strictEqual(awkCount, 5, `expected 5 awk-exit sites, got ${awkCount}`);
assert.strictEqual(oldGrepCount, 0, `expected 0 old grep -m1 sites, got ${oldGrepCount}`);

console.log('monitor-pattern.test.js: 3/3 PASS');
