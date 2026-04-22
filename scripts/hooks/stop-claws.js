#!/usr/bin/env node
// Claws Stop hook — remind model to clean up terminals before session ends.
'use strict';
const fs   = require('fs');
const path = require('path');

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

  // Emit cleanup reminder
  process.stderr.write(
    `[claws] Session ending — if you created terminals this session, close them now:\n` +
    `        claws_list → identify terminals you own → claws_close each one.\n`
  );
  process.exit(0);
});
