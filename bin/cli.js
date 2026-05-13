#!/usr/bin/env node
'use strict';

const { parseArgs } = require('util');

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    force:       { type: 'boolean', short: 'f' },
    'dry-run':   { type: 'boolean' },
    'no-hooks':  { type: 'boolean' },
    'vscode-cli': { type: 'string' },
    version:     { type: 'boolean', short: 'v' },
    help:        { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
});

if (values.version) {
  const pkg = require('../package.json');
  process.stdout.write(`claws-code ${pkg.version}\n`);
  process.exit(0);
}

if (values.help) {
  _printHelp();
  process.exit(0);
}

const cmd = positionals[0] || 'install';

const opts = {
  force:     values.force      || false,
  dryRun:    values['dry-run'] || false,
  noHooks:   values['no-hooks'] || false,
  vscodeCli: values['vscode-cli'] || null,
};

switch (cmd) {
  case 'install':
  case 'i':
    require('../lib/install').run(opts);
    break;

  case 'update':
  case 'u':
    require('../lib/install').run({ ...opts, force: true });
    break;

  case 'uninstall':
    require('../lib/uninstall').run(opts);
    break;

  case 'status':
  case 's':
    require('../lib/verify').status();
    break;

  default:
    process.stderr.write(`Unknown command: ${cmd}\n`);
    _printHelp();
    process.exit(1);
}

function _printHelp() {
  process.stdout.write(`
Usage: claws-code <command> [options]

Commands:
  install     Install Claws into the current project (default)
  update      Re-run install with --force
  uninstall   Remove Claws from the current project
  status      Show installation status

Options:
  --force, -f          Re-run all steps even if up-to-date
  --dry-run            Print every step without executing
  --no-hooks           Skip ~/.claude/settings.json hook registration
  --vscode-cli <path>  Override VS Code CLI path (env: CLAWS_VSCODE_CLI)
  --version, -v        Print version and exit
  --help, -h           Show this help

`);
}
