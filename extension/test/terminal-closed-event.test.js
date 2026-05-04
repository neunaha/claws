#!/usr/bin/env node
'use strict';
const fs   = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = path.resolve(__dirname, '../src');
const ROOT = path.resolve(__dirname, '../..');

// 1. Schema presence
const schema = fs.readFileSync(path.join(SRC, 'event-schemas.ts'), 'utf8');
assert.ok(schema.includes('TerminalClosedV1'),          'TerminalClosedV1 schema must exist');
assert.ok(schema.includes('close_origin'),              'close_origin field must exist');
assert.ok(schema.includes("'terminal-closed-v1'") ||
          schema.includes('"terminal-closed-v1"'),      'terminal-closed-v1 must be registered in SCHEMA_BY_NAME');
assert.ok(schema.includes('TerminalCloseOriginEnum'),   'TerminalCloseOriginEnum must exist');

// 2. Topic registry
const topicReg = fs.readFileSync(path.join(SRC, 'topic-registry.ts'), 'utf8');
assert.ok(topicReg.includes('system.terminal.closed'),  'system.terminal.closed must be in TOPIC_REGISTRY');
assert.ok(topicReg.includes('TerminalClosedV1'),         'TerminalClosedV1 must be imported in topic-registry.ts');

// 3. Server emission via callback
const server = fs.readFileSync(path.join(SRC, 'server.ts'), 'utf8');
assert.ok(server.includes("'system.terminal.closed'"),   'server.ts must emit system.terminal.closed');
const closeOriginUses = (server.match(/close_origin/g) || []).length;
assert.ok(closeOriginUses >= 2, `server.ts must use close_origin in ≥2 places, found ${closeOriginUses}`);

// 4. Terminal-manager passes origin to callback
const tm = fs.readFileSync(path.join(SRC, 'terminal-manager.ts'), 'utf8');
assert.ok(tm.includes('TerminalCloseOrigin'),             'terminal-manager.ts must import TerminalCloseOrigin');
assert.ok(/close\(id[^)]*origin/.test(tm),               'close() must accept origin parameter');
assert.ok(tm.includes("'user'"),                          'onTerminalClosed must pass origin user');

// 5. mcp_server.js — close_origin propagation in watcher close calls
const mcp = fs.readFileSync(path.join(ROOT, 'mcp_server.js'), 'utf8');
assert.ok(mcp.includes('close_origin'),                   'mcp_server.js must pass close_origin in close calls');
const closeOriginMcpCount = (mcp.match(/close_origin/g) || []).length;
assert.ok(closeOriginMcpCount >= 4, `mcp_server.js must have ≥4 close_origin usages, found ${closeOriginMcpCount}`);

// 6. Monitor pattern updated in all 5 sites
// The file has 4 actual backslash chars before .closed in each awk pattern
const _bs4 = '\\'.repeat(4);
const _termClosedStr = 'terminal' + _bs4 + '.closed';
const terminalClosedCount = mcp.split(_termClosedStr).length - 1;
assert.ok(terminalClosedCount >= 5, `monitor pattern must include terminal.closed in ≥5 sites, found ${terminalClosedCount}`);

console.log('terminal-closed-event.test.js: 6/6 PASS');
