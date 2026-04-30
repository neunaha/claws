// version-drift.test.js — single-source-of-truth check for the project version.
//
// Three places hard-code the project version:
//   - package.json (root)
//   - extension/package.json
//   - extension/package-lock.json (root version + nested packages."" entry)
//
// They MUST all agree. Drift between them has caused real shipping bugs
// (e.g. extension/package-lock.json sat at 0.7.5 for three releases without
// anyone noticing). This test fails the suite if any of them disagree.
//
// To bump the version, ALWAYS use scripts/bump-version.sh — never edit by hand.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail || '' });
}

const rootPkg = readJson('package.json');
const extPkg = readJson('extension/package.json');
const extLock = readJson('extension/package-lock.json');

const versions = {
  'root package.json':                    rootPkg.version,
  'extension/package.json':               extPkg.version,
  'extension/package-lock.json (top)':    extLock.version,
  'extension/package-lock.json (nested)': extLock.packages && extLock.packages[''] && extLock.packages[''].version,
};

const distinct = new Set(Object.values(versions));

check(
  `all four version fields agree (saw: ${[...distinct].join(', ')})`,
  distinct.size === 1,
  Object.entries(versions).map(([k, v]) => `${k}=${v}`).join('; '),
);

// SemVer 2.0 strict — MAJOR.MINOR.PATCH only. Four-segment versions like
// 0.7.7.1 are rejected by VS Code's extension manifest validator.
check(
  `version is SemVer 2.0 compliant (MAJOR.MINOR.PATCH, not 4-segment)`,
  /^[0-9]+\.[0-9]+\.[0-9]+$/.test(rootPkg.version),
  `root version is "${rootPkg.version}"`,
);

let pass = 0;
let fail = 0;
for (const c of checks) {
  if (c.ok) {
    console.log('  ✓ ' + c.name);
    pass++;
  } else {
    console.log('  ✗ ' + c.name);
    if (c.detail) console.log('       ' + c.detail);
    fail++;
  }
}
console.log(`\nPASS: ${pass} version-drift checks`);
if (fail > 0) {
  console.log(`FAIL: ${fail} checks failed`);
  process.exit(1);
}
