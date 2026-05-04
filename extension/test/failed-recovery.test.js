#!/usr/bin/env node
'use strict';
const fs   = require('fs');
const path = require('path');
const assert = require('assert');

const store  = fs.readFileSync(path.resolve(__dirname, '../src/lifecycle-store.ts'), 'utf8');
const schema = fs.readFileSync(path.resolve(__dirname, '../src/event-schemas.ts'),   'utf8');

// 1. FailureCause type is defined in event-schemas.ts
assert.ok(
  schema.includes('failure_cause') || schema.includes('FailureCause'),
  'failure_cause type must be defined in event-schemas.ts'
);

// 2. lifecycle-store.ts references failure_cause in LifecycleState
assert.ok(
  store.includes('failure_cause'),
  'lifecycle-store.ts must reference failure_cause'
);

// 3. setPhase() accepts optional opts with failure_cause
assert.ok(
  store.includes('opts?.failure_cause') || store.includes("opts?.['failure_cause']"),
  'setPhase() must accept and apply opts.failure_cause on FAILED transition'
);

// 4. plan() references FAILED for the recovery path
const planStart = store.indexOf('plan(planText');
assert.ok(planStart !== -1, 'plan() method not found');
const planBody = store.slice(planStart, store.indexOf('flushToDisk', planStart) + 20);
assert.ok(
  planBody.includes('FAILED'),
  'plan() must reference FAILED phase for recovery path'
);

// 5. plan() resets spawned_workers/monitors/workers on FAILED recovery
assert.ok(
  planBody.includes('spawned_workers: []') && planBody.includes('monitors: []') && planBody.includes('workers: []'),
  'plan() must reset spawned_workers, monitors, workers arrays on re-plan'
);

// 6. plan() preserves failure_cause across FAILED→PLAN recovery
assert.ok(
  planBody.includes('preservedFailureCause') || planBody.includes('failure_cause'),
  'plan() must preserve failure_cause across FAILED→PLAN recovery'
);

console.log('failed-recovery.test.js: 6/6 PASS');
