// Rename-pattern atomic file and directory operations.
// Used by install.sh (M-09 hooks-copy atomicity, M-01 dotfile backup)
// and json-safe.mjs (mergeIntoFile).
// Self-contained — no imports from other _helpers/ modules in L0.

import fs from 'fs';
import path from 'path';

let _nonce = 0;
function tmpSuffix() {
  return `${process.pid}-${++_nonce}`;
}

/**
 * Write content to filePath atomically via a tmp → rename pattern.
 * Writes to ${filePath}.claws-tmp.${pid}, fsyncs, then renames over the target.
 * On POSIX the rename is atomic; on Windows it is best-effort (no atomic rename API).
 *
 * @param {string} filePath
 * @param {string | Buffer} content
 * @param {{ mode?: number }} [opts]  mode defaults to 0o644
 */
export async function writeAtomic(filePath, content, opts = {}) {
  const mode = opts.mode ?? 0o644;
  const tmp = `${filePath}.claws-tmp.${tmpSuffix()}`;

  let fd;
  try {
    await fs.promises.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
    fd = await fs.promises.open(tmp, 'w', mode);
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
 * Copy srcDir to destDir atomically via:
 *   1. Copy srcDir → destDir.claws-tmp.${pid}
 *   2. Move existing destDir → destDir.claws-old.${ts}
 *   3. Rename tmp → destDir
 *   4. Remove the moved-aside old dir
 *
 * On failure before step 3, destDir is left untouched (tmp is cleaned up).
 *
 * @param {string} srcDir
 * @param {string} destDir
 */
export async function copyDirAtomic(srcDir, destDir) {
  const tmp = `${destDir}.claws-tmp.${tmpSuffix()}`;
  const ts = Date.now();

  // Step 1: copy into tmp
  try {
    await fs.promises.rm(tmp, { recursive: true, force: true });
    await copyDirRecursive(srcDir, tmp);
  } catch (err) {
    // Clean up partial tmp — destDir untouched
    try { await fs.promises.rm(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  }

  // Step 2+3: swap atomically — move old aside, rename tmp into place
  const old = `${destDir}.claws-old.${ts}`;
  let destExisted = false;
  try {
    await fs.promises.access(destDir);
    destExisted = true;
  } catch { /* doesn't exist */ }

  try {
    if (destExisted) {
      await fs.promises.rename(destDir, old);
    }
    await fs.promises.rename(tmp, destDir);
  } catch (err) {
    // Roll back: restore old dir if we moved it, remove tmp
    if (destExisted) {
      try {
        await fs.promises.access(destDir);
      } catch {
        // destDir is gone — put old back
        try { await fs.promises.rename(old, destDir); } catch { /* ignore */ }
      }
    }
    try { await fs.promises.rm(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  }

  // Step 4: remove the moved-aside old dir (best-effort)
  if (destExisted) {
    try { await fs.promises.rm(old, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Create a timestamped backup of filePath.
 * Backup path: ${filePath}.claws-bak.${ISO-timestamp}[.suffix]
 * Returns the backup path.
 *
 * @param {string} filePath
 * @param {string} [suffix]  optional extra suffix appended after the timestamp
 * @returns {Promise<string>}
 */
export async function backupFile(filePath, suffix) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${filePath}.claws-bak.${ts}${suffix ? '.' + suffix : ''}`;
  await fs.promises.copyFile(filePath, backupPath);
  return backupPath;
}

// ─── internal ────────────────────────────────────────────────────────────────

async function copyDirRecursive(src, dest) {
  await fs.promises.mkdir(dest, { recursive: true });
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  await Promise.all(entries.map(entry => {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      return copyDirRecursive(srcPath, destPath);
    }
    return fs.promises.copyFile(srcPath, destPath);
  }));
}
