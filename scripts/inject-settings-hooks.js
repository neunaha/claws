#!/usr/bin/env node
// Register Claws lifecycle hooks into ~/.claude/settings.json.
// Usage: node inject-settings-hooks.js [claws-bin-dir] [--dry-run] [--remove]
//
// Adds three hooks (all tagged _source:"claws" for clean uninstall):
//   SessionStart  — emits lifecycle reminder when .claws/claws.sock detected
//   PreToolUse:Bash — nudges long-running commands toward claws_create
//   Stop          — reminds model to close terminals before session ends
//
// Idempotent: running twice produces the same result.
// --remove: strips all _source:"claws" hooks without touching others.
//
// claws-bin-dir defaults to <install-dir>/.claws-bin so hooks always point
// at the global source (~/.claws-src/.claws-bin/hooks/) — not a per-project
// copy. This means hooks work correctly across multiple Claws projects.

'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Default: resolve from this script's location (scripts/ → ../.claws-bin)
const DEFAULT_CLAWS_BIN = path.join(__dirname, '..', '.claws-bin');
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
  return `node "${scriptPath}"`;
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

// Define the four hooks to inject
const HOOKS_TO_ADD = [
  { event: 'SessionStart', entry: makeHookEntry('*',            'session-start-claws.js') },
  { event: 'PreToolUse',   entry: makeHookEntry('*',            'pre-tool-use-claws.js') },
  { event: 'PostToolUse',  entry: makeHookEntry('mcp__claws__*','post-tool-use-claws.js') },
  { event: 'Stop',         entry: makeHookEntry('*',            'stop-claws.js') },
];

let changed = 0;
for (const { event, entry } of HOOKS_TO_ADD) {
  if (!settings.hooks[event]) settings.hooks[event] = [];
  const arr = settings.hooks[event];

  // Check if already present (match by _source + matcher + script name)
  const scriptName = entry.hooks[0].command.split('/').pop().replace('"', '');
  const alreadyPresent = arr.some(e =>
    e._source === SOURCE_TAG &&
    e.matcher === entry.matcher &&
    e.hooks && e.hooks[0] && e.hooks[0].command.includes(scriptName)
  );

  if (!alreadyPresent) {
    arr.push(entry);
    changed++;
  }
}

if (changed > 0) {
  saveSettings(settings);
  console.log(`Added ${changed} Claws hook(s) to ${SETTINGS_PATH}`);
} else {
  console.log('Claws hooks already present in settings.json');
}
