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
  // M-29: atomic write (tmp + renameSync) — mirrors extension/src/lifecycle-store.ts.
  // Prevents partial lifecycle-state.json if the hook process is killed mid-write.
  const content = JSON.stringify(state, null, 2) + '\n';
  const tmp = p + '.claws-tmp.' + process.pid + '-' + (++writeState._nonce);
  try {
    fs.writeFileSync(tmp, content, { mode: 0o644 });
    fs.renameSync(tmp, p);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}
writeState._nonce = 0;

module.exports = { readState, writeState, PHASES, phaseIndex };
