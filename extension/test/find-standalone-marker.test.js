#!/usr/bin/env node
// Unit tests for findStandaloneMarker — LH-15 regression suite.
// Verifies zsh backslash wrap-artifact tolerance + standalone-only matching.
// Run: node extension/test/find-standalone-marker.test.js
// Exits 0 on PASS:8 FAIL:0, exits 1 on any failure.
'use strict';

const { findStandaloneMarker } = require('../../mcp_server.js');

let passed = 0;
let failed = 0;

function check(label, condition, hint) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}${hint ? '\n        hint: ' + hint : ''}`);
    failed++;
  }
}

const MARKER = '__CLAWS_DONE__';

// M1: plain marker on its own line
check(
  'M1: plain marker on its own line → match',
  findStandaloneMarker(`abc\n${MARKER}\n`, MARKER) !== null,
  'Baseline: bare marker must match',
);

// M2: marker with TUI bullet (existing behavior must stay)
check(
  'M2: marker with ⏺ TUI bullet → match',
  findStandaloneMarker(`abc\n⏺ ${MARKER}\n`, MARKER) !== null,
  'Claude TUI bullet prefix must still match',
);

// M3: marker with leading backslash — the LH-15 bug
check(
  'M3: marker with leading \\ (zsh wrap artifact) → match',
  findStandaloneMarker(`abc\n\\${MARKER}\n`, MARKER) !== null,
  'LH-15 root cause: zsh emits \\ before marker when line wraps near right margin',
);

// M4: marker with multiple leading backslashes
check(
  'M4: marker with multiple leading \\\\ → match',
  findStandaloneMarker(`abc\n\\\\${MARKER}\n`, MARKER) !== null,
  'Multiple backslashes (double-wrap) must also be tolerated',
);

// M5: marker with backslash + bullet combo
check(
  'M5: marker with \\ + ⏺ bullet → match',
  findStandaloneMarker(`abc\n\\⏺ ${MARKER}\n`, MARKER) !== null,
  'Backslash followed by TUI bullet must match',
);

// M6: marker embedded mid-line — must NOT match (standalone only)
check(
  'M6: marker embedded mid-line → NO match',
  findStandaloneMarker(`abc${MARKER}def`, MARKER) === null,
  'Mid-line embedding must not fire completion; only standalone markers count',
);

// M7: marker with trailing non-whitespace chars — must NOT match
check(
  'M7: marker with trailing chars → NO match',
  findStandaloneMarker(`abc\n${MARKER}xyz\n`, MARKER) === null,
  'Trailing non-whitespace after marker must prevent match',
);

// M8: null/empty inputs → null (no throw)
check(
  'M8: null text → null; null marker → null',
  findStandaloneMarker(null, MARKER) === null &&
  findStandaloneMarker('text', null) === null,
  'Null/undefined inputs must return null without throwing',
);

console.log('');
console.log(`find-standalone-marker.test.js: PASS:${passed} FAIL:${failed}`);
if (failed > 0) process.exit(1);
