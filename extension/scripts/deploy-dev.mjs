#!/usr/bin/env node
// Deploys the freshly built extension into VS Code's installed-extensions
// directory so a window reload picks up local changes. Without this step
// `npm run build` only writes to ./dist — VS Code keeps loading whatever
// version was last installed via VSIX or the marketplace.
//
// Finds every `~/.vscode/extensions/<publisher>.<name>-*` directory matching
// the package.json publisher+name, copies dist/extension.js, and rsyncs the
// native/ bundle. Reports what was updated.

import { readFileSync, statSync, readdirSync, copyFileSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const extRoot = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(extRoot, 'package.json'), 'utf8'));
const slug = `${pkg.publisher}.${pkg.name}`;
const extensionsDir = join(homedir(), '.vscode', 'extensions');

const candidates = readdirSync(extensionsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith(slug + '-'))
  .map((e) => join(extensionsDir, e.name));

if (candidates.length === 0) {
  console.error(`[deploy-dev] no installed extension matching ${slug}-* in ${extensionsDir}`);
  console.error(`[deploy-dev] install once with: code --install-extension <path-to.vsix>`);
  process.exit(1);
}

const distSrc = join(extRoot, 'dist', 'extension.js');
const nativeSrc = join(extRoot, 'native');
try { statSync(distSrc); } catch { console.error(`[deploy-dev] missing ${distSrc} — run npm run build first`); process.exit(1); }

let deployed = 0;
for (const target of candidates) {
  const distDst = join(target, 'dist');
  mkdirSync(distDst, { recursive: true });
  copyFileSync(distSrc, join(distDst, 'extension.js'));
  const r = spawnSync('rsync', ['-a', '--delete', nativeSrc + '/', join(target, 'native') + '/'], { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`[deploy-dev] rsync failed for ${target}`); process.exit(r.status ?? 1); }
  console.log(`[deploy-dev] updated ${target}`);
  deployed++;
}

console.log(`[deploy-dev] ${deployed} install${deployed === 1 ? '' : 's'} updated. Reload VS Code: Cmd+Shift+P → Developer: Reload Window`);
