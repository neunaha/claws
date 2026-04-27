#!/usr/bin/env node
// Shared module — read/write .claws/lifecycle-state.json
'use strict';
const fs   = require('fs');
const path = require('path');

const PHASES = [
  'PLAN-REQUIRED',
  'PLAN',
  'SPAWN',
  'DEPLOY',
  'OBSERVE',
  'RECOVER',
  'HARVEST',
  'CLEANUP',
  'REFLECT',
];

function phaseIndex(phase) {
  return PHASES.indexOf(phase);
}

function statePath(cwd) {
  return path.join(cwd, '.claws', 'lifecycle-state.json');
}

function readState(cwd) {
  const p = statePath(cwd);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(cwd, state) {
  const p = statePath(cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n');
}

module.exports = { readState, writeState, PHASES, phaseIndex };
