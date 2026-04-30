#!/usr/bin/env node
// inject-dev-hooks.js — Register Claws dev-discipline hooks into a project's
// .claude/settings.json. Idempotent: detects existing hooks by _source tag
// and updates in place. Safe-merge: never overwrites existing non-Claws hooks.
//
// Claude Code settings.json hooks format:
//   { hooks: { SessionStart: [{matcher, hooks:[{type,command}], _source}], ... } }
//
// Usage: node scripts/inject-dev-hooks.js [project-root]
'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE_TAG = 'claws-dev-hooks';

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

function readSettings(settingsPath) {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeSettings(settingsPath, obj) {
  const dir = path.dirname(settingsPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function inject(projectRoot) {
  const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
  const binDir = path.join(projectRoot, '.claws-bin', 'dev-hooks');
  const settings = readSettings(settingsPath);

  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }

  let totalRegistered = 0;

  for (const def of DEV_HOOK_DEFS) {
    const eventKey = def.event;
    if (!Array.isArray(settings.hooks[eventKey])) {
      settings.hooks[eventKey] = [];
    }
    const arr = settings.hooks[eventKey];

    // Remove stale claws-dev-hooks entry for this exact script (idempotent update)
    const newCommand = `node "${path.join(binDir, def.script)}"`;
    const idx = arr.findIndex(
      (e) => e._source === SOURCE_TAG && e.hooks && e.hooks[0] && e.hooks[0].command === newCommand
    );

    if (idx === -1) {
      // Also remove any old entry for this script path (from a different binDir)
      const oldIdx = arr.findIndex(
        (e) => e._source === SOURCE_TAG && e.hooks && e.hooks[0] &&
               e.hooks[0].command.includes(def.script)
      );
      if (oldIdx !== -1) arr.splice(oldIdx, 1);
      arr.push(buildEntry(def, binDir));
    }
    totalRegistered++;
  }

  writeSettings(settingsPath, settings);
  return totalRegistered;
}

const projectRoot = process.argv[2] || process.cwd();

if (!fs.existsSync(projectRoot)) {
  console.error(`inject-dev-hooks: project root not found: ${projectRoot}`);
  process.exit(1);
}

try {
  const count = inject(projectRoot);
  console.log(`  inject-dev-hooks: ${count} hooks ready (_source: "${SOURCE_TAG}")`);
} catch (e) {
  console.error(`inject-dev-hooks failed: ${e.message}`);
  process.exit(1);
}
