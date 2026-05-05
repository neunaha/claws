#!/usr/bin/env node
// Inject the Claws machine-wide policy block into ~/.claude/CLAUDE.md.
// Usage: node inject-global-claude-md.js [--dry-run]
//
// Behavior:
// 1. Reads templates/CLAUDE.global.md (relative to this script).
// 2. Substitutes {VERSION} and {LIFECYCLE_PHASES} from code (package.json,
//    extension/src/lifecycle-store.ts).
// 3. Inserts or replaces the fenced block:
//    <!-- CLAWS-GLOBAL:BEGIN [v<X.Y.Z>] --> ... <!-- CLAWS-GLOBAL:END [v<X.Y.Z>] -->
//    Sentinel match is regex-based so prior-version blocks upgrade cleanly.
// 4. Creates ~/.claude/CLAUDE.md with a stub if it doesn't exist.
// 5. Preserves all non-Claws content byte-for-byte.
// 6. Idempotent — safe to run on every install.

'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// M-28: atomic write helper.
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

const REPO_ROOT = path.join(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');

const GLOBAL_CLAUDE_MD = path.join(os.homedir(), '.claude', 'CLAUDE.md');
const TEMPLATE_PATH    = path.join(REPO_ROOT, 'templates', 'CLAUDE.global.md');

const BEGIN_RE = /<!-- CLAWS-GLOBAL:BEGIN(?: v[\d.]+(?:-[\w.]+)?| v1)? -->/;
const END_RE   = /<!-- CLAWS-GLOBAL:END(?: v[\d.]+(?:-[\w.]+)?| v1)? -->/;

// ── Source-of-truth readers ────────────────────────────────────────────────
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

const PHASES = readPhases();
const VERSION = readVersion();

const BEGIN_LITERAL = `<!-- CLAWS-GLOBAL:BEGIN v${VERSION} -->`;
const END_LITERAL   = `<!-- CLAWS-GLOBAL:END v${VERSION} -->`;

// Read template
let template;
try {
  template = fs.readFileSync(TEMPLATE_PATH, 'utf8').trim();
} catch (e) {
  console.error(`inject-global-claude-md: cannot read template at ${TEMPLATE_PATH}: ${e.message}`);
  process.exit(1);
}

// Substitute parameters in the template body, then re-stamp sentinels.
const phaseChain = PHASES.length ? PHASES.join(' → ') : '(unavailable)';
template = template
  .replace(/\{VERSION\}/g, VERSION)
  .replace(/\{LIFECYCLE_PHASES\}/g, phaseChain)
  .replace(/<!-- CLAWS-GLOBAL:BEGIN(?: v[\d.]+(?:-[\w.]+)?| v1)? -->/g, BEGIN_LITERAL)
  .replace(/<!-- CLAWS-GLOBAL:END(?: v[\d.]+(?:-[\w.]+)?| v1)? -->/g, END_LITERAL);

// Ensure template is wrapped in sentinels (it should already be, but guard)
if (!template.includes(BEGIN_LITERAL)) {
  template = BEGIN_LITERAL + '\n' + template + '\n' + END_LITERAL;
}

// Read existing global CLAUDE.md (or start fresh)
let existing = '';
let existed  = false;
try {
  existing = fs.readFileSync(GLOBAL_CLAUDE_MD, 'utf8');
  existed  = true;
} catch { /* file doesn't exist yet */ }

// Insert or replace the fenced block (regex match — accepts any prior version).
const beginMatch = existing.match(BEGIN_RE);
const endMatch   = existing.match(END_RE);

let next;
if (beginMatch && endMatch && endMatch.index > beginMatch.index) {
  next = existing.slice(0, beginMatch.index) + template + existing.slice(endMatch.index + endMatch[0].length);
} else if (existed) {
  const sep = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  next = existing + sep + template + '\n';
} else {
  next = '# Claude Code — Machine-Wide Configuration\n\n' +
    '<!-- Add your personal Claude Code context above this line -->\n\n' +
    template + '\n';
}

if (DRY_RUN) {
  console.log('[dry-run] would write to:', GLOBAL_CLAUDE_MD);
  console.log(next);
  process.exit(0);
}

try { fs.mkdirSync(path.dirname(GLOBAL_CLAUDE_MD), { recursive: true }); } catch { /* ignore */ }

let orig = '';
try { orig = fs.readFileSync(GLOBAL_CLAUDE_MD, 'utf8'); } catch { /* ignore */ }

if (next !== orig) {
  writeAtomic(GLOBAL_CLAUDE_MD, next);
  const action = beginMatch ? 'Claws global block updated' : 'Claws global block inserted';
  console.log(`~/.claude/CLAUDE.md ${existed ? action : 'created with Claws global block'} (v${VERSION}, ${PHASES.length} phases)`);
} else {
  console.log(`~/.claude/CLAUDE.md already has the current Claws global block (v${VERSION})`);
}
