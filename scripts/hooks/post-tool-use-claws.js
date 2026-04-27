#!/usr/bin/env node
// Claws PostToolUse hook — auto-advance lifecycle phase after claws_* tool calls.
'use strict';
const fs   = require('fs');
const path = require('path');
const { readState, writeState } = require('./lifecycle-state');

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  let data = {};
  try { data = JSON.parse(input); } catch { process.exit(0); }

  const toolName = data.tool_name || '';
  const cwd      = data.cwd || process.cwd();

  // Only act if Claws socket is present
  const socketPath = path.join(cwd, '.claws', 'claws.sock');
  if (!fs.existsSync(socketPath)) process.exit(0);

  // Only handle claws_* MCP tools
  if (!toolName.startsWith('mcp__claws__claws_')) process.exit(0);

  const state = readState(cwd);
  if (!state) process.exit(0);

  const toolResult = data.tool_result || {};

  if (toolName === 'mcp__claws__claws_create') {
    // Advance to SPAWN and track worker id
    const workerId = toolResult.id;
    const workers = Array.isArray(state.workers) ? state.workers : [];
    if (workerId !== undefined && workerId !== null) {
      const alreadyTracked = workers.some(w => (typeof w === 'object' ? w.id : w) === workerId);
      if (!alreadyTracked) {
        workers.push({ id: workerId, closed: false });
      }
    }
    const phases_completed = Array.isArray(state.phases_completed) ? state.phases_completed : [];
    if (!phases_completed.includes('SPAWN')) phases_completed.push('SPAWN');
    writeState(cwd, { ...state, phase: 'SPAWN', phases_completed, workers });

  } else if (toolName === 'mcp__claws__claws_send') {
    // Advance to DEPLOY once we start sending (from SPAWN)
    if (state.phase === 'SPAWN') {
      const phases_completed = Array.isArray(state.phases_completed) ? state.phases_completed : [];
      if (!phases_completed.includes('DEPLOY')) phases_completed.push('DEPLOY');
      writeState(cwd, { ...state, phase: 'DEPLOY', phases_completed });
    }

  } else if (toolName === 'mcp__claws__claws_close') {
    // Mark worker closed; if all closed → advance to CLEANUP
    const closedId = data.tool_input && data.tool_input.id;
    const workers = Array.isArray(state.workers) ? state.workers : [];
    const updatedWorkers = workers.map(w => {
      const wId = typeof w === 'object' ? w.id : w;
      if (closedId !== undefined && wId === closedId) {
        return typeof w === 'object' ? { ...w, closed: true } : { id: w, closed: true };
      }
      return w;
    });
    const allClosed = updatedWorkers.length > 0 && updatedWorkers.every(w =>
      typeof w === 'object' ? w.closed : false
    );
    const phases_completed = Array.isArray(state.phases_completed) ? state.phases_completed : [];
    let newPhase = state.phase;
    if (allClosed && !phases_completed.includes('CLEANUP')) {
      phases_completed.push('CLEANUP');
      newPhase = 'CLEANUP';
    }
    writeState(cwd, { ...state, phase: newPhase, phases_completed, workers: updatedWorkers });
  }

  process.exit(0);
});
