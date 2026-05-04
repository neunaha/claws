#!/usr/bin/env node
// REGRESSION GUARD: wave-violation auto-close wiring (Layer LH-1)
//
// When a sub-worker is silent past the violation threshold, WaveRegistry emits
// wave.<id>.violation. Before LH-1 the terminal stayed alive (silent leak).
// LH-1 wires markSubWorkerAutoClosed() into the violation callback in server.ts
// so the terminal is closed with origin='wave_violation' automatically.
//
// THIS TEST LOCKS IN the LH-1 contract:
//   1. event-schemas.ts declares 'wave_violation' as a close origin
//   2. wave-registry.ts exposes markSubWorkerAutoClosed()
//   3. wave-registry.ts constructor accepts violationThresholdMs
//   4. _checkViolation guards reschedule with !entry.complete
//   5. No bare VIOLATION_THRESHOLD_MS runtime references remain
//   6. server.ts violation callback calls markSubWorkerAutoClosed
//   7. server.ts violation callback calls terminalManager.close with 'wave_violation'
'use strict';

const fs   = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = path.resolve(__dirname, '../src');
const SCHEMAS  = fs.readFileSync(path.join(SRC, 'event-schemas.ts'), 'utf8');
const REGISTRY = fs.readFileSync(path.join(SRC, 'wave-registry.ts'), 'utf8');
const SERVER   = fs.readFileSync(path.join(SRC, 'server.ts'), 'utf8');

let passed = 0;
let failed = 0;
const results = [];

function check(label, condition, hint) {
  if (condition) {
    results.push(`  PASS  ${label}`);
    passed++;
  } else {
    results.push(`  FAIL  ${label}${hint ? '\n        hint: ' + hint : ''}`);
    failed++;
  }
}

// ─── 1. event-schemas.ts: 'wave_violation' declared in TerminalCloseOriginEnum ──
check(
  "event-schemas.ts: 'wave_violation' present in TerminalCloseOriginEnum",
  /TerminalCloseOriginEnum[\s\S]{0,500}wave_violation/.test(SCHEMAS),
  "Add 'wave_violation' to the z.enum([...]) in TerminalCloseOriginEnum",
);

// ─── 2. wave-registry.ts: markSubWorkerAutoClosed method exists ───────────────
check(
  'wave-registry.ts: markSubWorkerAutoClosed method defined',
  /markSubWorkerAutoClosed\s*\(/.test(REGISTRY),
  'Add public markSubWorkerAutoClosed(waveId, role) method to WaveRegistry',
);

// ─── 3. wave-registry.ts: constructor accepts violationThresholdMs ────────────
check(
  'wave-registry.ts: constructor accepts violationThresholdMs parameter',
  /violationThresholdMs\s*:\s*number/.test(REGISTRY),
  'Constructor 3rd param must be: violationThresholdMs: number = DEFAULT_VIOLATION_THRESHOLD_MS',
);

// ─── 4. wave-registry.ts: _checkViolation guards reschedule with !entry.complete ─
check(
  'wave-registry.ts: _checkViolation has !entry.complete guard on reschedule',
  /if\s*\(\s*!entry\.complete\s*\)[\s\S]{0,200}violationTimer\s*=\s*setTimeout/.test(REGISTRY),
  '_checkViolation must only reschedule if (!entry.complete)',
);

// ─── 5. wave-registry.ts: no bare VIOLATION_THRESHOLD_MS runtime refs ────────
//
// Allowed: DEFAULT_VIOLATION_THRESHOLD_MS (constant name) and JSDoc comments.
// Banned: any line that uses VIOLATION_THRESHOLD_MS as a runtime value (not
//         prefixed by DEFAULT_ and not inside a JSDoc /* */ block).
const runtimeRefs = REGISTRY
  .split('\n')
  .filter(line => /VIOLATION_THRESHOLD_MS/.test(line))
  .filter(line => !/DEFAULT_VIOLATION_THRESHOLD_MS/.test(line))
  .filter(line => !/^\s*\*/.test(line));   // filter JSDoc comment lines

check(
  'wave-registry.ts: no bare VIOLATION_THRESHOLD_MS runtime references',
  runtimeRefs.length === 0,
  `Found bare references: ${runtimeRefs.join(' | ')}`,
);

// ─── 6. server.ts: violation callback calls markSubWorkerAutoClosed ───────────
check(
  'server.ts: violation callback calls markSubWorkerAutoClosed',
  /markSubWorkerAutoClosed\s*\(waveId,\s*role\)/.test(SERVER),
  'Violation callback must call this.waveRegistry.markSubWorkerAutoClosed(waveId, role)',
);

// ─── 7. server.ts: violation callback calls terminalManager.close with 'wave_violation' ─
check(
  "server.ts: violation callback calls terminalManager.close(..., 'wave_violation')",
  /terminalManager\.close\s*\(\s*terminalId\s*,\s*['"]wave_violation['"]\s*\)/.test(SERVER),
  "Must call opts.terminalManager.close(terminalId, 'wave_violation') in the sub-worker violation callback",
);

// ─── 8. wave-registry.ts: markSubWorkerAutoClosed sets entry.complete = true ─
check(
  'wave-registry.ts: markSubWorkerAutoClosed sets entry.complete = true',
  /markSubWorkerAutoClosed[\s\S]{0,500}entry\.complete\s*=\s*true/.test(REGISTRY),
  'markSubWorkerAutoClosed must set entry.complete = true before returning',
);

// ─── 9. wave-registry.ts: markSubWorkerAutoClosed prunes from subWorkerTerminals ─
//
// Without the prune, _checkLeadViolation keeps counting an auto-closed
// terminal as "active" and lead-silence violations keep firing every
// threshold cycle. Verified noisy in Phase 4 of LH-1 (events 7-9).
check(
  'wave-registry.ts: markSubWorkerAutoClosed prunes terminal from subWorkerTerminals[]',
  /markSubWorkerAutoClosed[\s\S]{0,1500}subWorkerTerminals\.splice/.test(REGISTRY),
  'markSubWorkerAutoClosed must remove entry.terminalId from wave.subWorkerTerminals[] (idx >= 0 splice)',
);

// ─── Print results ─────────────────────────────────────────────────────────────
const total = passed + failed;
results.forEach(r => console.log(r));
console.log('');
console.log(`wave-violation-close.test.js: ${passed}/${total} PASS`);

if (failed > 0) {
  process.exit(1);
}
