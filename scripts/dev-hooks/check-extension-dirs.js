#!/usr/bin/env node
// SessionStart hook: warn if multiple neunaha.claws-* extension dirs exist OR
// if the active extension's package.json has invalid semver.
// Always exits 0 — warnings only. Timeout < 5s. Logs misfires to /tmp/claws-dev-hooks.log.
'use strict';

const fs = require('fs');
const path = require('path');

const LOG = '/tmp/claws-dev-hooks.log';
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function log(msg) {
  const ts = new Date().toISOString();
  try { fs.appendFileSync(LOG, `${ts} [check-extension-dirs] ${msg}\n`); } catch (_) {}
}

function main() {
  const extRoot = path.join(process.env.HOME || process.env.USERPROFILE || '', '.vscode', 'extensions');
  let entries = [];
  try { entries = fs.readdirSync(extRoot); } catch (_) { return; } // no vscode dir

  const clawsDirs = entries.filter((e) => e.startsWith('neunaha.claws-'));

  if (clawsDirs.length > 1) {
    console.warn(
      `\n⚠️  [claws-dev-hook] Multiple Claws extension dirs detected:\n` +
      clawsDirs.map((d) => `   ${path.join(extRoot, d)}`).join('\n') + '\n' +
      `   Remove old versions: rm -rf ~/.vscode/extensions/neunaha.claws-<old>\n` +
      `   Reload VS Code after removal (Cmd+Shift+P → Developer: Reload Window)\n`
    );
  }

  // Validate semver on the newest dir
  const sorted = clawsDirs
    .map((d) => ({ dir: d, ver: d.replace('neunaha.claws-', '') }))
    .filter((x) => SEMVER_RE.test(x.ver))
    .sort((a, b) => {
      const [am, an, ap] = a.ver.split('.').map(Number);
      const [bm, bn, bp] = b.ver.split('.').map(Number);
      return bm - am || bn - an || bp - ap;
    });

  if (sorted.length === 0 && clawsDirs.length > 0) {
    const badDirs = clawsDirs.filter((d) => !SEMVER_RE.test(d.replace('neunaha.claws-', '')));
    if (badDirs.length > 0) {
      console.warn(
        `\n⚠️  [claws-dev-hook] Extension dir(s) with invalid semver: ${badDirs.join(', ')}\n` +
        `   Expected format: neunaha.claws-MAJOR.MINOR.PATCH\n`
      );
      log(`invalid semver dirs: ${badDirs.join(', ')}`);
    }
    return;
  }

  if (sorted.length > 0) {
    const newest = path.join(extRoot, sorted[0].dir);
    let pkgVer = '';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(newest, 'package.json'), 'utf8'));
      pkgVer = pkg.version || '';
    } catch (e) {
      log(`package.json read failed for ${newest}: ${e.message}`);
      return;
    }
    if (!SEMVER_RE.test(pkgVer)) {
      console.warn(
        `\n⚠️  [claws-dev-hook] Extension manifest version "${pkgVer}" is not valid semver.\n` +
        `   Expected: MAJOR.MINOR.PATCH (e.g. 0.7.7)\n`
      );
      log(`invalid manifest version: ${pkgVer} in ${newest}`);
    }
  }
}

try { main(); } catch (e) { log(`uncaught: ${e.message}`); }
process.exit(0);
