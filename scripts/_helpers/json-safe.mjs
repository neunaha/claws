// JSONC-tolerant JSON parsing + abort-on-error file merge.
// Used by install.sh (M-02 .mcp.json) and inject-settings-hooks.js (M-03 settings.json).
// Both helpers in _helpers/ are self-contained — no cross-imports in L0.

import fs from 'fs';
import path from 'path';

export class JsonSafeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'JsonSafeError';
    this.code = code;
  }
}

// Strip JSONC extensions: // line comments, /* block comments */, and trailing commas.
// Handles strings correctly — comment sequences inside quoted values are preserved.
function stripJsonc(input) {
  let result = '';
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];

    if (ch === '"') {
      // Consume a JSON string verbatim (including escape sequences).
      result += ch;
      i++;
      while (i < len) {
        const sc = input[i];
        result += sc;
        if (sc === '\\') {
          i++;
          if (i < len) { result += input[i]; i++; }
          continue;
        }
        if (sc === '"') { i++; break; }
        i++;
      }
      continue;
    }

    if (ch === '/' && i + 1 < len && input[i + 1] === '*') {
      // Block comment — skip everything until closing */, preserving newlines
      // so that line/col error positions remain accurate.
      i += 2;
      while (i + 1 < len && !(input[i] === '*' && input[i + 1] === '/')) {
        if (input[i] === '\n') result += '\n';
        i++;
      }
      i += 2; // consume closing */
      continue;
    }

    if (ch === '/' && i + 1 < len && input[i + 1] === '/') {
      // Line comment — skip to end of line, preserve the newline itself.
      i += 2;
      while (i < len && input[i] !== '\n') i++;
      continue;
    }

    result += ch;
    i++;
  }

  // Remove trailing commas before ] or } (handles whitespace/newlines between).
  return result.replace(/,(\s*[}\]])/g, '$1');
}

// Compute 1-based line/col from a character position within a string.
function posToLineCol(str, pos) {
  const before = str.slice(0, pos);
  const lines = before.split('\n');
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

/**
 * Parse JSON (optionally JSONC) without throwing.
 * @param {string} input
 * @param {{ allowJsonc?: boolean }} [opts]  allowJsonc defaults to true
 * @returns {{ ok: true, data: unknown } | { ok: false, error: { code: string, message: string, line?: number, col?: number, original: string } }}
 */
export function parseJsonSafe(input, opts = {}) {
  if (input == null || typeof input !== 'string') {
    return {
      ok: false,
      error: {
        code: 'PARSE_ERROR',
        message: `Expected string, got ${input === null ? 'null' : typeof input}`,
        original: String(input),
      },
    };
  }
  // Strip UTF-8 BOM (U+FEFF) that Windows editors sometimes write at file start.
  const normalized = input.charCodeAt(0) === 0xFEFF ? input.slice(1) : input;
  const allowJsonc = opts.allowJsonc !== false;
  const source = allowJsonc ? stripJsonc(normalized) : normalized;

  try {
    return { ok: true, data: JSON.parse(source) };
  } catch (e) {
    let line, col;
    // Node's SyntaxError messages include "position N" for the error offset.
    const m = e.message.match(/position (\d+)/);
    if (m) {
      const loc = posToLineCol(source, parseInt(m[1], 10));
      line = loc.line;
      col = loc.col;
    }
    return {
      ok: false,
      error: {
        code: 'PARSE_ERROR',
        message: e.message,
        ...(line != null && { line, col }),
        original: input,
      },
    };
  }
}

// Per-call nonce for unique tmp filenames across concurrent mergeIntoFile calls (F1).
let _mergeNonce = 0;

// Minimal inline atomic write (rename pattern) — avoids importing atomic-file.mjs
// so each L0 helper stays self-contained. Layer 2/3 wiring may replace this.
// Uses pid+nonce for tmp uniqueness (F1) and fsyncs before rename for durability (F2).
async function writeAtomicInline(filePath, content) {
  const tmp = `${filePath}.claws-tmp.${process.pid}-${++_mergeNonce}`;
  let fd;
  try {
    fd = await fs.promises.open(tmp, 'w', 0o644);
    await fd.writeFile(content);
    await fd.sync();
    await fd.close();
    fd = null;
    await fs.promises.rename(tmp, filePath);
  } catch (err) {
    if (fd) {
      try { await fd.close(); } catch { /* ignore */ }
      fd = null;
    }
    try { await fs.promises.unlink(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/**
 * Read filePath, parse JSONC, apply mutator, write back atomically.
 * On parse error: saves a timestamped backup and returns ok:false WITHOUT
 * touching the original file (critical: never silently reset to {}).
 *
 * @param {string} filePath
 * @param {(cfg: object) => object | void} mutator  return new obj or mutate in place
 * @param {{ allowJsonc?: boolean }} [opts]
 * @returns {Promise<{ ok: true, written: boolean } | { ok: false, error: object }>}
 */
export async function mergeIntoFile(filePath, mutator, opts = {}) {
  const allowJsonc = opts.allowJsonc !== false;

  // Read — absent file is treated as empty object, not an error.
  let raw = '{}';
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') {
      return { ok: false, error: { code: 'READ_ERROR', message: e.message } };
    }
  }

  const parsed = parseJsonSafe(raw, { allowJsonc });

  if (!parsed.ok) {
    // Backup the malformed original BEFORE returning — never overwrite it.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${filePath}.claws-bak.${ts}`;
    try {
      await fs.promises.writeFile(backupPath, raw, 'utf8');
    } catch (backupErr) {
      return {
        ok: false,
        error: {
          code: 'PARSE_FAILED',
          message: parsed.error.message,
          backupSavedAt: null,
          backupError: backupErr.message,
          parseError: parsed.error,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'PARSE_FAILED',
        message: parsed.error.message,
        backupSavedAt: backupPath,
        parseError: parsed.error,
      },
    };
  }

  let cfg = parsed.data;
  const mutatorResult = mutator(cfg);
  if (mutatorResult !== undefined && mutatorResult !== null) {
    cfg = mutatorResult;
  }

  const content = JSON.stringify(cfg, null, 2) + '\n';

  try {
    await fs.promises.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
    await writeAtomicInline(filePath, content);
    return { ok: true, written: true };
  } catch (e) {
    return { ok: false, error: { code: 'WRITE_ERROR', message: e.message } };
  }
}
