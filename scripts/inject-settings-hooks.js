#!/usr/bin/env node
// Register Claws lifecycle hooks into ~/.claude/settings.json.
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
//
// claws-bin-dir defaults to <install-dir>/scripts so hooks resolve to
// <install-dir>/scripts/hooks/ — the committed source-of-truth. one registration
// serves every project, /claws-update from any project applies to all, project
// deletion never orphans the registration.

'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Default: resolve from this script's location (scripts/ → ../.claws-bin)
const DEFAULT_CLAWS_BIN = __dirname;
const CLAWS_BIN = (process.argv[2] && !process.argv[2].startsWith('--'))
  ? process.argv[2]
  : DEFAULT_CLAWS_BIN;

const DRY_RUN = process.argv.includes('--dry-run');
const REMOVE  = process.argv.includes('--remove');
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const SOURCE_TAG    = 'claws';

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(data) {
  if (DRY_RUN) {
    console.log('[dry-run] would write to:', SETTINGS_PATH);
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2) + '\n');
}

function hookCmd(scriptName) {
  const scriptPath = path.join(CLAWS_BIN, 'hooks', scriptName);
  // Wrap in `sh -c` with a file-exists check (v0.7.3 hardening). Without
  // this, Claude Code reports a "non-blocking status code" error on every
  // tool call when the hook script's path is missing (install dir moved,
  // sandbox path leaked into settings.json, etc.). The wrapper makes
  // missing-path a silent no-op instead of a visible error. The path is
  // passed as $0 to avoid shell-escape pitfalls with paths containing
  // spaces or apostrophes.
  return `sh -c '[ -f "$0" ] && exec node "$0" || exit 0' ${JSON.stringify(scriptPath)}`;
}

function makeHookEntry(matcher, scriptName) {
  return {
    matcher,
    _source: SOURCE_TAG,
    hooks: [{ type: 'command', command: hookCmd(scriptName) }],
  };
}

const settings = loadSettings();
if (!settings.hooks) settings.hooks = {};

if (REMOVE) {
  // Strip all _source:"claws" entries from all hook arrays
  let removed = 0;
  for (const [event, arr] of Object.entries(settings.hooks)) {
    if (!Array.isArray(arr)) continue;
    const filtered = arr.filter(e => e._source !== SOURCE_TAG);
    removed += arr.length - filtered.length;
    settings.hooks[event] = filtered;
  }
  saveSettings(settings);
  console.log(`Removed ${removed} Claws hook(s) from ${SETTINGS_PATH}`);
  process.exit(0);
}

// Define the three hooks to inject (PostToolUse removed in v0.6.5 — gate moved server-side)
const HOOKS_TO_ADD = [
  { event: 'SessionStart', scriptName: 'session-start-claws.js', entry: makeHookEntry('*', 'session-start-claws.js') },
  { event: 'PreToolUse',   scriptName: 'pre-tool-use-claws.js',  entry: makeHookEntry('*', 'pre-tool-use-claws.js') },
  { event: 'Stop',         scriptName: 'stop-claws.js',          entry: makeHookEntry('*', 'stop-claws.js') },
];

let changed = 0;
for (const { event, scriptName, entry } of HOOKS_TO_ADD) {
  if (!settings.hooks[event]) settings.hooks[event] = [];
  const arr = settings.hooks[event];

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

if (changed > 0) {
  saveSettings(settings);
  console.log(`Added ${changed} Claws hook(s) to ${SETTINGS_PATH}`);
} else {
  console.log('Claws hooks already present in settings.json');
}
