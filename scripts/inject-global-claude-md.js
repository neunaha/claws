#!/usr/bin/env node
// Inject the Claws machine-wide policy block into ~/.claude/CLAUDE.md.
// Usage: node inject-global-claude-md.js [--dry-run]
//
// Behavior:
// 1. Reads templates/CLAUDE.global.md (relative to this script).
// 2. Inserts or replaces the fenced block:
//    <!-- CLAWS-GLOBAL:BEGIN v1 --> ... <!-- CLAWS-GLOBAL:END v1 -->
// 3. Creates ~/.claude/CLAUDE.md with a stub if it doesn't exist.
// 4. Preserves all non-Claws content byte-for-byte.
// 5. Idempotent — safe to run on every install.

'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DRY_RUN = process.argv.includes('--dry-run');

const GLOBAL_CLAUDE_MD = path.join(os.homedir(), '.claude', 'CLAUDE.md');
const TEMPLATE_PATH    = path.join(__dirname, '..', 'templates', 'CLAUDE.global.md');

const BEGIN = '<!-- CLAWS-GLOBAL:BEGIN v1 -->';
const END   = '<!-- CLAWS-GLOBAL:END v1 -->';

// Read template
let template;
try {
  template = fs.readFileSync(TEMPLATE_PATH, 'utf8').trim();
} catch (e) {
  console.error(`inject-global-claude-md: cannot read template at ${TEMPLATE_PATH}: ${e.message}`);
  process.exit(1);
}

// Ensure template is wrapped in sentinels (it should already be, but guard)
if (!template.includes(BEGIN)) {
  template = BEGIN + '\n' + template + '\n' + END;
}

// Read existing global CLAUDE.md (or start fresh)
let existing = '';
let existed  = false;
try {
  existing = fs.readFileSync(GLOBAL_CLAUDE_MD, 'utf8');
  existed  = true;
} catch { /* file doesn't exist yet */ }

// Insert or replace the fenced block
const beginIdx = existing.indexOf(BEGIN);
const endIdx   = existing.indexOf(END);

let next;
if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
  // Replace existing block
  next = existing.slice(0, beginIdx) + template + existing.slice(endIdx + END.length);
} else if (existed) {
  // Append to existing file
  const sep = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  next = existing + sep + template + '\n';
} else {
  // Create new file
  next = '# Claude Code — Machine-Wide Configuration\n\n' +
    '<!-- Add your personal Claude Code context above this line -->\n\n' +
    template + '\n';
}

if (DRY_RUN) {
  console.log('[dry-run] would write to:', GLOBAL_CLAUDE_MD);
  console.log(next);
  process.exit(0);
}

// Ensure ~/.claude/ exists
try { fs.mkdirSync(path.dirname(GLOBAL_CLAUDE_MD), { recursive: true }); } catch { /* ignore */ }

let orig = '';
try { orig = fs.readFileSync(GLOBAL_CLAUDE_MD, 'utf8'); } catch { /* ignore */ }

if (next !== orig) {
  fs.writeFileSync(GLOBAL_CLAUDE_MD, next);
  console.log(`~/.claude/CLAUDE.md ${existed ? (beginIdx !== -1 ? 'Claws global block updated' : 'Claws global block inserted') : 'created with Claws global block'}`);
} else {
  console.log('~/.claude/CLAUDE.md already has the current Claws global block');
}
