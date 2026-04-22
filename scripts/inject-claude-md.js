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

const TOOLS_V1 = [
  'claws_list', 'claws_create', 'claws_send', 'claws_exec',
  'claws_read_log', 'claws_poll', 'claws_close', 'claws_worker',
];
const TOOLS_V2 = [
  'claws_hello', 'claws_subscribe', 'claws_publish', 'claws_broadcast',
  'claws_ping', 'claws_peers', 'claws_task_assign', 'claws_task_update',
  'claws_task_complete', 'claws_task_cancel', 'claws_task_list',
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

function buildBlock(target, cmds) {
  const tpl = path.join(__dirname, '..', 'templates', 'CLAUDE.project.md');
  try {
    const raw = fs.readFileSync(tpl, 'utf8');
    const toList = (arr) => arr.map((t) => '`' + t + '`').join(', ');
    return raw
      .trimEnd()
      .replace(/\{PROJECT_NAME\}/g, path.basename(target))
      .replace(/\{SOCKET_PATH\}/g, '.claws/claws.sock')
      .replace(/\{TOOLS_V1_COUNT\}/g, String(TOOLS_V1.length))
      .replace(/\{TOOLS_V1_LIST\}/g, toList(TOOLS_V1))
      .replace(/\{TOOLS_V2_COUNT\}/g, String(TOOLS_V2.length))
      .replace(/\{TOOLS_V2_LIST\}/g, toList(TOOLS_V2))
      .replace(/\{CMDS_COUNT\}/g, String(cmds.length))
      .replace(/\{CMDS_LIST\}/g, cmds.length ? toList(cmds) : '_(none installed)_');
  } catch (err) {
    return [
      BEGIN,
      '<!-- ERROR: templates/CLAUDE.project.md not found: ' + err.message + ' -->',
      '## Claws — Terminal Orchestration (MANDATORY)',
      '',
      'You are a Claws orchestrator. Use claws_create + claws_send for long-lived processes.',
      'Always close every terminal you create. Never touch terminals you did not create.',
      END,
    ].join('\n');
  }
}

const block = buildBlock(TARGET, cmds);

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
