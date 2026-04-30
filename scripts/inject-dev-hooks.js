#!/usr/bin/env node
// inject-dev-hooks.js — Register Claws dev-discipline hooks into a project's
// .claude/settings.json. Idempotent: detects existing hooks by _source tag
// and updates in place. Safe-merge: uses json-safe.mjs mergeIntoFile —
// atomic write, JSONC-tolerant, abort-on-malformed (FINDING-B-3).
//
// Claude Code settings.json hooks format:
//   { hooks: { SessionStart: [{matcher, hooks:[{type,command}], _source}], ... } }
//
// Usage: node scripts/inject-dev-hooks.js [project-root]
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const SOURCE_TAG = 'claws-dev-hooks';

const HELPERS_MJS = pathToFileURL(
  path.resolve(__dirname, '_helpers', 'json-safe.mjs')
).href;

// Five dev-hook definitions — event → script file in .claws-bin/dev-hooks/
const DEV_HOOK_DEFS = [
  { event: 'SessionStart', matcher: '*', script: 'check-stale-main.js' },
  { event: 'PostToolUse',  matcher: 'Bash', script: 'check-tag-pushed.js' },
  { event: 'PostToolUse',  matcher: 'Bash', script: 'check-tag-vs-main.js' },
  { event: 'Stop',         matcher: '*', script: 'check-open-claws-terminals.js' },
  { event: 'SessionStart', matcher: '*', script: 'check-extension-dirs.js' },
];

function buildEntry(def, binDir) {
  return {
    _source: SOURCE_TAG,
    matcher: def.matcher,
    hooks: [{ type: 'command', command: `node "${path.join(binDir, def.script)}"` }],
  };
}

async function inject(projectRoot) {
  const { mergeIntoFile } = await import(HELPERS_MJS);
  const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
  const binDir = path.join(projectRoot, '.claws-bin', 'dev-hooks');

  let totalRegistered = 0;
  const result = await mergeIntoFile(settingsPath, (settings) => {
    // Migrate legacy array format (same guard as inject-settings-hooks.js)
    if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
      settings.hooks = {};
    }

    for (const def of DEV_HOOK_DEFS) {
      if (!Array.isArray(settings.hooks[def.event])) {
        settings.hooks[def.event] = [];
      }
      const arr = settings.hooks[def.event];
      const newCmd = `node "${path.join(binDir, def.script)}"`;
      const exactIdx = arr.findIndex(
        (e) => e._source === SOURCE_TAG && e.hooks && e.hooks[0] && e.hooks[0].command === newCmd
      );
      if (exactIdx === -1) {
        // Also remove any old entry for this script path (from a different binDir)
        const oldIdx = arr.findIndex(
          (e) => e._source === SOURCE_TAG && e.hooks && e.hooks[0] &&
                 e.hooks[0].command.includes(def.script)
        );
        if (oldIdx !== -1) arr[oldIdx] = buildEntry(def, binDir);
        else arr.push(buildEntry(def, binDir));
      }
      totalRegistered++;
    }
  }, { allowJsonc: true });

  if (!result.ok) {
    const e = result.error;
    process.stderr.write(`inject-dev-hooks: settings merge failed: ${e.message}\n`);
    if (e.backupSavedAt) process.stderr.write(`  original backed up to: ${e.backupSavedAt}\n`);
    process.exit(1);
  }
  return totalRegistered;
}

const projectRoot = process.argv[2] || process.cwd();

if (!fs.existsSync(projectRoot)) {
  console.error(`inject-dev-hooks: project root not found: ${projectRoot}`);
  process.exit(1);
}

(async () => {
  const count = await inject(projectRoot);
  console.log(`  inject-dev-hooks: ${count} hooks ready (_source: "${SOURCE_TAG}")`);
})().catch((e) => {
  console.error(`inject-dev-hooks failed: ${e.message}`);
  process.exit(1);
});
