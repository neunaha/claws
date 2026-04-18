#!/usr/bin/env node
// Inject the dynamic Claws block into a project's CLAUDE.md.
// Usage: node inject-claude-md.js <project-root>
//
// Behavior:
// 1. Migrates legacy v0.1–v0.3 "## CLAWS — Terminal Orchestration Active"
//    section if present.
// 2. Inserts or replaces the fenced block `<!-- CLAWS:BEGIN --> ... <!-- CLAWS:END -->`.
// 3. If CLAUDE.md doesn't exist, creates a minimal stub with a placeholder for
//    project-specific context above the block.
// 4. Preserves every non-Claws line of the file byte-for-byte.

'use strict';
const fs = require('fs');
const path = require('path');

const TARGET = process.argv[2];
if (!TARGET) {
  console.error('usage: inject-claude-md.js <project-root>');
  process.exit(2);
}

const CLAUDE_MD = path.join(TARGET, 'CLAUDE.md');
const CMD_DIR = path.join(TARGET, '.claude', 'commands');

const TOOLS = [
  'claws_list', 'claws_create', 'claws_send', 'claws_exec',
  'claws_read_log', 'claws_poll', 'claws_close', 'claws_worker',
];
const BEGIN = '<!-- CLAWS:BEGIN -->';
const END   = '<!-- CLAWS:END -->';

let cmds = [];
try {
  cmds = fs.readdirSync(CMD_DIR)
    .filter((f) => f.startsWith('claws') && f.endsWith('.md'))
    .map((f) => '/' + f.replace(/\.md$/, ''))
    .sort();
} catch { /* ignore */ }

const block = [
  BEGIN,
  '## Claws — Terminal Orchestration',
  '',
  'This project has Claws terminal-control tooling installed.',
  '',
  `**MCP tools** (${TOOLS.length}): ${TOOLS.map((t) => '`' + t + '`').join(', ')}.`,
  '',
  `**Slash commands** (${cmds.length}): ${cmds.map((c) => '`' + c + '`').join(', ')}.`,
  '',
  '**Operating principles**:',
  '- For visible work (builds, tests, deploys, AI workers) spawn wrapped terminals via `claws_create` + `claws_worker`; for quick lookups stay in Bash.',
  '- Always close terminals you create. Never touch terminals you didn\'t.',
  '- If MCP tools don\'t appear after a restart, run `/claws-fix`. To report a problem, run `/claws-report`.',
  '',
  'Full guide: `/claws-help`. Source: `./.claws-bin/`, `./.claude/`.',
  END,
].join('\n');

let md = '';
let existed = false;
try { md = fs.readFileSync(CLAUDE_MD, 'utf8'); existed = true; } catch { /* ignore */ }

// ── Migrate legacy v0.1–v0.3 section ─────────────────────────────────────
let migrated = false;
const legacyStart = md.indexOf('## CLAWS — Terminal Orchestration Active');
if (legacyStart !== -1) {
  const rest = md.slice(legacyStart);
  const legacyEndPhrase = 'Type `/claws-help` for the full prompt guide.';
  const phraseIdx = rest.indexOf(legacyEndPhrase);
  let legacyEndAbs;
  if (phraseIdx !== -1) {
    const after = legacyStart + phraseIdx + legacyEndPhrase.length;
    const nlAfter = md.indexOf('\n', after);
    legacyEndAbs = nlAfter === -1 ? md.length : nlAfter + 1;
  } else {
    const lines = rest.split('\n');
    let consumed = lines[0].length + 1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) {
        legacyEndAbs = legacyStart + consumed;
        break;
      }
      consumed += lines[i].length + 1;
    }
    if (legacyEndAbs === undefined) legacyEndAbs = md.length;
  }
  let trimStart = legacyStart;
  if (trimStart >= 2 && md.slice(trimStart - 2, trimStart) === '\n\n') {
    trimStart -= 1;
  }
  md = md.slice(0, trimStart) + md.slice(legacyEndAbs);
  migrated = true;
}

// ── Insert or replace fenced block ───────────────────────────────────────
const beginIdx = md.indexOf(BEGIN);
const endIdx   = md.indexOf(END);

let next;
if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
  next = md.slice(0, beginIdx) + block + md.slice(endIdx + END.length);
} else if (existed) {
  const sep = md.endsWith('\n\n') ? '' : md.endsWith('\n') ? '\n' : '\n\n';
  next = md + sep + block + '\n';
} else {
  next = '# Project\n\n<!-- Add your project-specific Claude Code context above this line -->\n\n' + block + '\n';
}

let orig = '';
try { orig = fs.readFileSync(CLAUDE_MD, 'utf8'); } catch { /* ignore */ }

if (next !== orig) {
  fs.writeFileSync(CLAUDE_MD, next);
  const prefix = migrated ? 'legacy section migrated; ' : '';
  console.log(`CLAUDE.md ${prefix}${existed ? (beginIdx !== -1 ? 'Claws block updated' : 'Claws block inserted') : 'created with Claws block'}`);
} else {
  console.log('CLAUDE.md already has the current Claws block');
}
