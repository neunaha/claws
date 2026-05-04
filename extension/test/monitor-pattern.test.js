#!/usr/bin/env node
// Test: monitor_arm_command from mcp_server.js uses awk + CLAWS_TOPIC='**' at all 5 sites.
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

// CLAWS_TOPIC must be '**' (subscribe-all) so stream-events.js receives a single valid topic.
// Comma-separated topics are NOT supported by stream-events.js:43 — it passes CLAWS_TOPIC as
// one literal string to the server's subscribe call.
const TOPIC_NEEDLE = "CLAWS_TOPIC='**'";
// The awk-exit needle as it appears in the raw source
const AWK_NEEDLE = "awk '{print; fflush()} /system";
// The old per-worker heartbeat topic that must be gone
const OLD_HEARTBEAT_NEEDLE = "CLAWS_TOPIC='worker.${";
// The old grep-m1 needle that must be gone
const OLD_GREP_NEEDLE = "grep --line-buffered -m1 'system";

const topicCount = countOccurrences(src, TOPIC_NEEDLE);
const awkCount = countOccurrences(src, AWK_NEEDLE);
const oldHeartbeatCount = countOccurrences(src, OLD_HEARTBEAT_NEEDLE);
const oldGrepCount = countOccurrences(src, OLD_GREP_NEEDLE);

assert.strictEqual(topicCount, 5, `expected 5 CLAWS_TOPIC='**' sites, got ${topicCount}`);
assert.strictEqual(awkCount, 5, `expected 5 awk-exit sites, got ${awkCount}`);
assert.strictEqual(oldHeartbeatCount, 0, `expected 0 old per-worker heartbeat topic sites, got ${oldHeartbeatCount}`);
assert.strictEqual(oldGrepCount, 0, `expected 0 old grep -m1 sites, got ${oldGrepCount}`);

console.log('monitor-pattern.test.js: 4/4 PASS');
