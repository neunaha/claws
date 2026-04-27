#!/usr/bin/env node
// Claws Stop hook — enforce CLEANUP and REFLECT before session ends.
'use strict';
const fs   = require('fs');
const path = require('path');
const { readState } = require('./lifecycle-state');

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  let cwd = process.cwd();
  try {
    const parsed = JSON.parse(input);
    if (parsed.cwd) cwd = parsed.cwd;
  } catch { /* use process.cwd() */ }

  const socketPath = path.join(cwd, '.claws', 'claws.sock');
  if (!fs.existsSync(socketPath)) process.exit(0);

  const state = readState(cwd);

  if (!state) {
    // No lifecycle state — emit simple reminder
    process.stderr.write(
      `[claws] Session ending — if you created terminals this session, close them now:\n` +
      `        claws_list → identify terminals you own → claws_close each one.\n`
    );
    process.exit(0);
  }

  // Check for unclosed workers
  const workers = Array.isArray(state.workers) ? state.workers : [];
  const unclosed = workers.filter(w => typeof w === 'object' ? !w.closed : false);
  if (unclosed.length > 0) {
    const ids = unclosed.map(w => w.id).join(', ');
    process.stderr.write(
      `[LIFECYCLE CLEANUP] ${unclosed.length} terminal(s) still open: ${ids}.\n` +
      `        Close them with claws_close before ending.\n`
    );
  }

  // Check for missing REFLECT phase
  const phases_completed = Array.isArray(state.phases_completed) ? state.phases_completed : [];
  if (!phases_completed.includes('REFLECT')) {
    process.stderr.write(
      `[LIFECYCLE REFLECT] Write your reflect summary to .claws/lifecycle-reflect.md\n` +
      `        — what succeeded, what failed, what to improve next time.\n`
    );
  }

  process.exit(0);
});
