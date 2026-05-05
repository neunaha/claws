#!/usr/bin/env node
// Inject the dynamic Claws block into a project's CLAUDE.md.
// Usage: node inject-claude-md.js <project-root>
//
// Behavior:
// 1. Migrates legacy v0.1–v0.3 "## CLAWS — Terminal Orchestration Active"
//    section if present.
// 2. Inserts or replaces the fenced block:
//    <!-- CLAWS:BEGIN [v<X.Y.Z>] --> ... <!-- CLAWS:END [v<X.Y.Z>] -->
//    Sentinel match is regex-based so any prior version is cleanly replaced.
// 3. Tool list, lifecycle phase list, and version are derived from code at
//    inject time — see readToolList(), readPhases(), readVersion(). This makes
//    drift between the server and the user-facing CLAUDE.md structurally
//    impossible.
// 4. If CLAUDE.md doesn't exist, creates a minimal stub with a placeholder for
//    project-specific context above the block.
// 5. Preserves every non-Claws line of the file byte-for-byte.

'use strict';
const fs = require('fs');
const path = require('path');

// M-27: atomic write helper (tmp + renameSync) — mirrors atomic-file.mjs writeAtomic.
function writeAtomic(filePath, content) {
  const tmp = filePath + '.claws-tmp.' + process.pid + '-' + (++writeAtomic._nonce);
  let _fd;
  try {
    _fd = fs.openSync(tmp, 'w', 0o644);
    fs.writeSync(_fd, content);
    fs.fsyncSync(_fd);
    fs.closeSync(_fd);
    _fd = null;
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (_fd != null) { try { fs.closeSync(_fd); } catch { /* ignore */ } }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}
writeAtomic._nonce = 0;

const TARGET = process.argv[2];
if (!TARGET) {
  console.error('usage: inject-claude-md.js <project-root>');
  process.exit(2);
}

const REPO_ROOT = path.join(__dirname, '..');
const CLAUDE_MD = path.join(TARGET, 'CLAUDE.md');
const CMD_DIR = path.join(TARGET, '.claude', 'commands');

// ── Source-of-truth readers ────────────────────────────────────────────────
// Tool list: parse mcp_server.js dispatch handlers. Pattern: `name === 'claws_xxx'`.
// One unique entry per tool. Sorted alphabetically for stable diffs.
function readToolList() {
  const mcpPath = path.join(REPO_ROOT, 'mcp_server.js');
  try {
    const src = fs.readFileSync(mcpPath, 'utf8');
    const re = /name === '(claws_[a-z_]+)'/g;
    const set = new Set();
    let m;
    while ((m = re.exec(src)) !== null) set.add(m[1]);
    return Array.from(set).sort();
  } catch (err) {
    return [];
  }
}

// Phase enum: parse extension/src/lifecycle-store.ts `export type Phase = ...`.
// Returned in declaration order (which is also lifecycle order).
function readPhases() {
  const ltPath = path.join(REPO_ROOT, 'extension', 'src', 'lifecycle-store.ts');
  try {
    const src = fs.readFileSync(ltPath, 'utf8');
    const m = src.match(/export type Phase\s*=([^;]+);/);
    if (!m) return [];
    return Array.from(m[1].matchAll(/'([A-Z][A-Z0-9-]+)'/g)).map((x) => x[1]);
  } catch (err) {
    return [];
  }
}

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch (err) {
    return 'unknown';
  }
}

const TOOLS = readToolList();
const PHASES = readPhases();
const VERSION = readVersion();

// Versioned sentinels — emitted with current version, matched with regex
// so prior-version blocks are replaced cleanly on upgrade.
const BEGIN_LITERAL = `<!-- CLAWS:BEGIN v${VERSION} -->`;
const END_LITERAL   = `<!-- CLAWS:END v${VERSION} -->`;
const BEGIN_RE = /<!-- CLAWS:BEGIN(?: v[\d.]+(?:-[\w.]+)?)? -->/;
const END_RE   = /<!-- CLAWS:END(?: v[\d.]+(?:-[\w.]+)?)? -->/;

let cmds = [];
try {
  cmds = fs.readdirSync(CMD_DIR)
    .filter((f) => f.startsWith('claws') && f.endsWith('.md'))
    .map((f) => '/' + f.replace(/\.md$/, ''))
    .sort();
} catch { /* ignore */ }

function buildBlock(target, cmds) {
  const tpl = path.join(REPO_ROOT, 'templates', 'CLAUDE.project.md');
  try {
    const raw = fs.readFileSync(tpl, 'utf8');
    const toList = (arr) => arr.map((t) => '`' + t + '`').join(', ');
    const phaseChain = PHASES.length ? PHASES.join(' → ') : '(unavailable)';
    return raw
      .trimEnd()
      // Replace literal BEGIN/END sentinels in template with versioned ones.
      .replace(/<!-- CLAWS:BEGIN(?: v[\d.]+(?:-[\w.]+)?)? -->/g, BEGIN_LITERAL)
      .replace(/<!-- CLAWS:END(?: v[\d.]+(?:-[\w.]+)?)? -->/g, END_LITERAL)
      .replace(/\{PROJECT_NAME\}/g, path.basename(target))
      .replace(/\{SOCKET_PATH\}/g, '.claws/claws.sock')
      .replace(/\{VERSION\}/g, VERSION)
      .replace(/\{TOOLS_COUNT\}/g, String(TOOLS.length))
      .replace(/\{TOOLS_LIST\}/g, TOOLS.length ? toList(TOOLS) : '_(no tools detected — mcp_server.js missing?)_')
      .replace(/\{LIFECYCLE_PHASES\}/g, phaseChain)
      .replace(/\{CMDS_COUNT\}/g, String(cmds.length))
      .replace(/\{CMDS_LIST\}/g, cmds.length ? toList(cmds) : '_(none installed)_');
  } catch (err) {
    return [
      BEGIN_LITERAL,
      '<!-- ERROR: templates/CLAUDE.project.md not found: ' + err.message + ' -->',
      '## Claws — Terminal Orchestration (MANDATORY)',
      '',
      'You are a Claws orchestrator. Use claws_create + claws_send for long-lived processes.',
      'Always close every terminal you create. Never touch terminals you did not create.',
      END_LITERAL,
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

// ── Insert or replace fenced block (regex match — handles any prior version) ──
const beginMatch = md.match(BEGIN_RE);
const endMatch   = md.match(END_RE);

let next;
if (beginMatch && endMatch && endMatch.index > beginMatch.index) {
  next = md.slice(0, beginMatch.index) + block + md.slice(endMatch.index + endMatch[0].length);
} else if (existed) {
  const sep = md.endsWith('\n\n') ? '' : md.endsWith('\n') ? '\n' : '\n\n';
  next = md + sep + block + '\n';
} else {
  next = '# Project\n\n<!-- Add your project-specific Claude Code context above this line -->\n\n' + block + '\n';
}

let orig = '';
try { orig = fs.readFileSync(CLAUDE_MD, 'utf8'); } catch { /* ignore */ }

if (next !== orig) {
  writeAtomic(CLAUDE_MD, next);
  const prefix = migrated ? 'legacy section migrated; ' : '';
  const action = beginMatch ? 'Claws block updated' : 'Claws block inserted';
  console.log(`CLAUDE.md ${prefix}${existed ? action : 'created with Claws block'} (v${VERSION}, ${TOOLS.length} tools, ${PHASES.length} phases)`);
} else {
  console.log(`CLAUDE.md already has the current Claws block (v${VERSION})`);
}
