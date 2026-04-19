#!/usr/bin/env node
// Verifies that `npm run build` produced a self-contained native bundle at
// <extension>/native/node-pty/. Skips gracefully if native/ does not exist
// (e.g. when running test:smoke in isolation without a build step), so smoke
// tests do not become dependent on Phase 2 bundling succeeding.
//
// Run: node extension/test/native-bundle.test.js
// Exits 0 on success (or skip), 1 on failure.

const fs = require('fs');
const path = require('path');

const EXT_ROOT = path.resolve(__dirname, '..');
const NATIVE_ROOT = path.join(EXT_ROOT, 'native');
const NODE_PTY_DIR = path.join(NATIVE_ROOT, 'node-pty');
const PTY_NODE = path.join(NODE_PTY_DIR, 'build', 'Release', 'pty.node');
const METADATA = path.join(NATIVE_ROOT, '.metadata.json');
const PKG_JSON = path.join(NODE_PTY_DIR, 'package.json');

if (!fs.existsSync(NATIVE_ROOT)) {
  console.log('  · native/ directory not found — SKIP');
  console.log('    (run `npm run build` to produce the native bundle)');
  process.exit(0);
}

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, err: err.message || String(err) });
  }
}

check('native/node-pty/build/Release/pty.node exists', () => {
  if (!fs.existsSync(PTY_NODE)) throw new Error(`not found at ${PTY_NODE}`);
  const st = fs.statSync(PTY_NODE);
  if (st.size === 0) throw new Error('pty.node is zero bytes');
});

check('native/.metadata.json exists', () => {
  if (!fs.existsSync(METADATA)) throw new Error(`not found at ${METADATA}`);
});

check('metadata has required fields', () => {
  const raw = fs.readFileSync(METADATA, 'utf8');
  const meta = JSON.parse(raw);
  const required = ['electronVersion', 'platform', 'arch', 'nodePtyVersion'];
  for (const field of required) {
    if (!meta[field]) throw new Error(`missing field: ${field} (got ${JSON.stringify(meta)})`);
  }
});

check('bundled package.json parses', () => {
  if (!fs.existsSync(PKG_JSON)) throw new Error(`not found at ${PKG_JSON}`);
  const raw = fs.readFileSync(PKG_JSON, 'utf8');
  const pkg = JSON.parse(raw);
  if (pkg.name !== 'node-pty') throw new Error(`expected name=node-pty, got ${pkg.name}`);
  if (!pkg.main) throw new Error('no main field');
});

let failed = 0;
for (const c of checks) {
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ' — ' + c.err}`);
  if (!c.ok) failed++;
}

if (failed > 0) {
  console.error(`\nFAIL: ${failed}/${checks.length} native-bundle check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS: ${checks.length} native-bundle checks`);
process.exit(0);
