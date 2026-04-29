#!/usr/bin/env node
// Register Claws lifecycle hooks into ~/.claude/settings.json.
// M-03/M-38: uses json-safe.mjs mergeIntoFile — atomic write, JSONC-tolerant,
// abort-on-malformed (NEVER silently reset to {}).
//
// Usage: node inject-settings-hooks.js [claws-bin-dir] [--dry-run] [--remove]
//
// Adds three hooks (all tagged _source:"claws" for clean uninstall):
//   SessionStart — emits lifecycle reminder when .claws/claws.sock detected
//   PreToolUse   — nudges long-running Bash commands toward claws_create
//   Stop         — reminds model to close terminals before session ends
// (PostToolUse removed in v0.6.5 — lifecycle gate moved server-side)
//
// Idempotent: running twice produces the same result.
// --remove: strips all _source:"claws" hooks without touching others.

'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { pathToFileURL } = require('url');

const DEFAULT_CLAWS_BIN = __dirname;
const CLAWS_BIN = (process.argv[2] && !process.argv[2].startsWith('--'))
  ? process.argv[2]
  : DEFAULT_CLAWS_BIN;

const DRY_RUN = process.argv.includes('--dry-run');
const REMOVE  = process.argv.includes('--remove');
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const SOURCE_TAG    = 'claws';

const HELPERS_URL = pathToFileURL(path.resolve(__dirname, '_helpers', 'json-safe.mjs')).href;

function hookCmd(scriptName) {
  const scriptPath = path.join(CLAWS_BIN, 'hooks', scriptName);
  // Wrap in `sh -c` with a file-exists check (v0.7.3 hardening). Without
  // this, Claude Code reports a "non-blocking status code" error on every
  // tool call when the hook script's path is missing. The wrapper makes
  // missing-path a silent no-op instead of a visible error. Path is passed
  // as $0 to avoid shell-escape pitfalls with spaces or apostrophes.
  return `sh -c '[ -f "$0" ] && exec node "$0" || exit 0' ${JSON.stringify(scriptPath)}`;
}

function makeHookEntry(matcher, scriptName) {
  return {
    matcher,
    _source: SOURCE_TAG,
    hooks: [{ type: 'command', command: hookCmd(scriptName) }],
  };
}

(async () => {
  const { mergeIntoFile, parseJsonSafe } = await import(HELPERS_URL);

  const HOOKS_TO_ADD = [
    { event: 'SessionStart', scriptName: 'session-start-claws.js', entry: makeHookEntry('*', 'session-start-claws.js') },
    { event: 'PreToolUse',   scriptName: 'pre-tool-use-claws.js',  entry: makeHookEntry('*', 'pre-tool-use-claws.js') },
    { event: 'Stop',         scriptName: 'stop-claws.js',          entry: makeHookEntry('*', 'stop-claws.js') },
  ];

  if (DRY_RUN) {
    let raw = '{}';
    try { raw = fs.readFileSync(SETTINGS_PATH, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parsed = parseJsonSafe(raw, { allowJsonc: true });
    if (!parsed.ok) {
      console.error('[claws] settings.json is malformed — dry-run aborted (file unchanged).');
      console.error('  Error:', parsed.error.message);
      process.exit(1);
    }
    const cfg = parsed.data;
    if (!cfg.hooks) cfg.hooks = {};
    for (const { event, scriptName, entry } of HOOKS_TO_ADD) {
      if (!cfg.hooks[event]) cfg.hooks[event] = [];
      const arr = cfg.hooks[event];
      const existingIdx = arr.findIndex(e =>
        e._source === SOURCE_TAG && e.matcher === entry.matcher &&
        e.hooks && e.hooks[0] && e.hooks[0].command &&
        e.hooks[0].command.includes(scriptName)
      );
      if (existingIdx === -1) arr.push(entry);
      else if (arr[existingIdx].hooks[0].command !== entry.hooks[0].command) arr[existingIdx] = entry;
    }
    console.log('[dry-run] would write to:', SETTINGS_PATH);
    console.log(JSON.stringify(cfg, null, 2));
    return;
  }

  if (REMOVE) {
    let removed = 0;
    const result = await mergeIntoFile(SETTINGS_PATH, (cfg) => {
      if (!cfg.hooks) return;
      for (const [event, arr] of Object.entries(cfg.hooks)) {
        if (!Array.isArray(arr)) continue;
        const filtered = arr.filter(e => e._source !== SOURCE_TAG);
        removed += arr.length - filtered.length;
        cfg.hooks[event] = filtered;
      }
    });
    if (!result.ok) {
      console.error('[claws] Failed to update settings.json:', result.error.message);
      if (result.error.backupSavedAt) {
        console.error('  Original backed up to:', result.error.backupSavedAt);
        console.error('  Aborting — your settings.json is unchanged.');
      }
      process.exit(1);
    }
    console.log(`Removed ${removed} Claws hook(s) from ${SETTINGS_PATH}`);
    return;
  }

  // Add/update hooks
  let changed = 0;
  const result = await mergeIntoFile(SETTINGS_PATH, (cfg) => {
    if (!cfg.hooks) cfg.hooks = {};
    for (const { event, scriptName, entry } of HOOKS_TO_ADD) {
      if (!cfg.hooks[event]) cfg.hooks[event] = [];
      const arr = cfg.hooks[event];

      // Find any existing Claws entry for this script. Match by scriptName
      // substring so we can detect old-format entries (plain `node "<path>"`)
      // and replace them in place with the new wrapped form, avoiding
      // duplicate accumulation on repeated runs across versions.
      const existingIdx = arr.findIndex(e =>
        e._source === SOURCE_TAG &&
        e.matcher === entry.matcher &&
        e.hooks && e.hooks[0] &&
        e.hooks[0].command && e.hooks[0].command.includes(scriptName)
      );

      if (existingIdx === -1) {
        arr.push(entry);
        changed++;
      } else if (arr[existingIdx].hooks[0].command !== entry.hooks[0].command) {
        // Old-format or stale-path entry — upgrade it in place
        arr[existingIdx] = entry;
        changed++;
      }
    }
  });

  if (!result.ok) {
    console.error('[claws] Failed to update settings.json:', result.error.message);
    if (result.error.backupSavedAt) {
      console.error('  Original backed up to:', result.error.backupSavedAt);
      console.error('  Aborting — your settings.json is unchanged.');
    }
    process.exit(1);
  }

  if (changed > 0) {
    console.log(`Added ${changed} Claws hook(s) to ${SETTINGS_PATH}`);
  } else {
    console.log('Claws hooks already present in settings.json');
  }
})().catch(e => {
  console.error('[claws] inject-settings-hooks unexpected error:', e.message);
  process.exit(1);
});
