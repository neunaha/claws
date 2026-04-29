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

// M-15: canonical install = CLAWS_BIN/hooks/ directory exists on disk.
// When canonical, register hooks as direct `node "<path>"` invocations
// (skips the sh -c fork overhead). When non-canonical (hooks dir absent,
// custom or untested path), use the wrapped form with misfire logging.
function isCanonicalInstall() {
  try {
    return fs.statSync(path.join(CLAWS_BIN, 'hooks')).isDirectory();
  } catch {
    return false;
  }
}
const CANONICAL = isCanonicalInstall();

function hookCmd(scriptName) {
  const scriptPath = path.join(CLAWS_BIN, 'hooks', scriptName);
  if (CANONICAL) {
    // Direct node invocation: hooks/ dir exists, path is guaranteed stable.
    // Skips the sh -c wrapper to reduce fork overhead per hook invocation.
    return `node ${JSON.stringify(scriptPath)}`;
  }
  // Non-canonical path: wrap with file-exists guard + misfire logging.
  // Missing-path logs a forensic entry to /tmp/claws-hook-misfire.log then
  // exits 0 so Claude Code never surfaces a "non-blocking status code" error.
  // Path is passed as $0 to avoid shell-escape pitfalls.
  return (
    `sh -c 'if [ -f "$0" ]; then exec node "$0"; ` +
    `else printf "[claws-hook-misfire] %s missing path: %s\\n" ` +
    `"$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$0" >> /tmp/claws-hook-misfire.log; ` +
    `exit 0; fi' ${JSON.stringify(scriptPath)}`
  );
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
      // Dry-run: use same exact-match dedup as live path (M-14)
      const exactDryIdx = arr.findIndex(e =>
        e._source === SOURCE_TAG && e.matcher === entry.matcher &&
        e.hooks && e.hooks[0] && e.hooks[0].command === entry.hooks[0].command
      );
      if (exactDryIdx === -1) {
        const staleDryIdx = arr.findIndex(e =>
          e._source === SOURCE_TAG && e.matcher === entry.matcher && e.hooks && e.hooks[0]
        );
        if (staleDryIdx !== -1) arr[staleDryIdx] = entry;
        else arr.push(entry);
      }
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

      // M-14: exact-command equality + _source guard for dedup.
      // Previously used command.includes(scriptName) which could match non-Claws
      // hooks whose command happened to contain our script name as a substring.
      // Now: match only on _source === 'claws' AND exact command string.
      // Stale/old-format Claws entries (wrong command) get replaced in-place
      // after detection via _source+matcher lookup.
      const exactIdx = arr.findIndex(e =>
        e._source === SOURCE_TAG &&
        e.matcher === entry.matcher &&
        e.hooks && e.hooks[0] &&
        e.hooks[0].command === entry.hooks[0].command
      );

      if (exactIdx !== -1) {
        // Already current — no-op
      } else {
        // Check for a stale Claws entry to upgrade (different command, same source+matcher)
        const staleIdx = arr.findIndex(e =>
          e._source === SOURCE_TAG &&
          e.matcher === entry.matcher &&
          e.hooks && e.hooks[0]
        );
        if (staleIdx !== -1) {
          arr[staleIdx] = entry;
          changed++;
        } else {
          arr.push(entry);
          changed++;
        }
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
