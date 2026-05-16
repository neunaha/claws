#!/usr/bin/env node
// bundle-native.mjs — Harvest node-pty npm prebuilds into native/ for VSIX bundling.
// Copies node_modules/node-pty/prebuilds/<plat>/ → native/node-pty/prebuilds/<plat>/
// for each target platform, filtering .pdb files (Windows debug symbols, ~28 MB each).
// Also copies lib/, package.json, LICENSE, README.md from the node-pty install.
// Uses atomic staging (M-40) to prevent a kill-window leaving native/ empty.
//
// CLI flags:
//   --strict   exit non-zero on any warning (e.g. missing platform dir)

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync, renameSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = resolve(__dirname, '..');
const STRICT = process.argv.includes('--strict');

const NODE_PTY_SRC = join(EXT_ROOT, 'node_modules', 'node-pty');
const NATIVE_ROOT = join(EXT_ROOT, 'native');
const NATIVE_DEST = join(NATIVE_ROOT, 'node-pty');
const METADATA_PATH = join(NATIVE_ROOT, '.metadata.json');
const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64'];

function log(msg) { process.stdout.write(`[bundle-native] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[bundle-native] WARNING: ${msg}\n`); }
function fail(msg) { process.stderr.write(`[bundle-native] ERROR: ${msg}\n`); process.exit(1); }

function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const n = entry.name;
    if (n.endsWith('.pdb') || n.endsWith('.d.ts') || n.endsWith('.test.js') || n.endsWith('.test.js.map')) continue;
    const s = join(src, n), d = join(dest, n);
    if (entry.isDirectory()) copyTree(s, d);
    else copyFileSync(s, d);
  }
}

function setupStagingDir() {
  const staging = NATIVE_DEST + '.claws-new';
  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  return staging;
}

function main() {
  log(`extension root: ${EXT_ROOT}`);
  if (!existsSync(NODE_PTY_SRC)) fail(`node-pty not installed at ${NODE_PTY_SRC}. Run npm install.`);

  const pkg = JSON.parse(readFileSync(join(NODE_PTY_SRC, 'package.json'), 'utf8'));
  const nodePtyVersion = pkg.version;
  log(`bundling node-pty@${nodePtyVersion}`);

  const staging = setupStagingDir();
  const platformsCopied = [];

  // Copy prebuilds for each target platform, skipping .pdb files
  for (const plat of PLATFORMS) {
    const src = join(NODE_PTY_SRC, 'prebuilds', plat);
    if (!existsSync(src)) {
      warn(`prebuilds/${plat}/ not found in node-pty — skipping`);
      if (STRICT) { rmSync(staging, { recursive: true, force: true }); process.exit(1); }
      continue;
    }
    copyTree(src, join(staging, 'prebuilds', plat));
    platformsCopied.push(plat);
    log(`  copied prebuilds/${plat}/`);
    // Preserve executable bit on spawn-helper (darwin/linux only; win32 has no spawn-helper).
    // node-pty uses posix_spawnp to exec spawn-helper; mode 0644 → posix_spawnp EACCES →
    // every wrapped terminal falls back to pipe-mode. Guard with existsSync so win32
    // prebuilds (which have no spawn-helper) never trip a spurious ENOENT.
    const spawnHelperDest = join(staging, 'prebuilds', plat, 'spawn-helper');
    if (existsSync(spawnHelperDest)) {
      chmodSync(spawnHelperDest, 0o755);
      log(`  chmod +x ${plat}/spawn-helper`);
    }
  }

  // Copy JS runtime (lib/) and metadata files
  copyTree(join(NODE_PTY_SRC, 'lib'), join(staging, 'lib'));
  for (const f of ['package.json', 'LICENSE', 'README.md']) {
    const s = join(NODE_PTY_SRC, f);
    if (existsSync(s)) copyFileSync(s, join(staging, f));
  }

  // M-40 atomic swap: staging → NATIVE_DEST via rename(2)
  const oldDest = NATIVE_DEST + '.claws-old';
  if (existsSync(NATIVE_DEST)) renameSync(NATIVE_DEST, oldDest);
  renameSync(staging, NATIVE_DEST);
  if (existsSync(oldDest)) { try { rmSync(oldDest, { recursive: true, force: true }); } catch { /* best-effort */ } }

  // Write metadata for diagnostic visibility
  writeFileSync(METADATA_PATH, JSON.stringify({
    node_pty_version: nodePtyVersion,
    copied_at: new Date().toISOString(),
    platforms_included: platformsCopied,
  }, null, 2) + '\n', 'utf8');
  log(`wrote native/.metadata.json (${platformsCopied.length} platforms: ${platformsCopied.join(', ')})`);
  log('[bundle-native] done.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
