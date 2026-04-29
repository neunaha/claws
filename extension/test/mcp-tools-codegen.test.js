#!/usr/bin/env node
// Tests for the generated schemas/mcp-tools.json and mcp_server.js migration (§4.2).
// Run: node extension/test/mcp-tools-codegen.test.js
// Exits 0 on success, 1 on failure.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const EXT_ROOT   = path.resolve(__dirname, '..');
const REPO_ROOT  = path.resolve(EXT_ROOT, '..');
const TOOLS_JSON = path.join(REPO_ROOT, 'schemas', 'mcp-tools.json');
const MCP_SERVER = path.join(REPO_ROOT, 'mcp_server.js');

const EXPECTED_NAMES = [
  'claws_list', 'claws_create', 'claws_send', 'claws_exec',
  'claws_read_log', 'claws_poll', 'claws_close', 'claws_worker',
  'claws_hello', 'claws_subscribe', 'claws_publish', 'claws_broadcast',
  'claws_ping', 'claws_peers',
  'claws_lifecycle_plan', 'claws_lifecycle_advance',
  'claws_lifecycle_snapshot', 'claws_lifecycle_reflect',
  'claws_wave_create', 'claws_wave_status', 'claws_wave_complete',
];

const assertions = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => assertions.push({ name, ok: true }),
        (e) => assertions.push({ name, ok: false, err: e.message || String(e) }),
      );
    }
    assertions.push({ name, ok: true });
  } catch (e) {
    assertions.push({ name, ok: false, err: e.message || String(e) });
  }
}

// ─── Static checks on schemas/mcp-tools.json ─────────────────────────────────

check('schemas/mcp-tools.json exists', () => {
  assert.ok(fs.existsSync(TOOLS_JSON), `${TOOLS_JSON} not found`);
});

const TOOLS = fs.existsSync(TOOLS_JSON) ? require(TOOLS_JSON) : [];

check('tool count is 21', () => {
  assert.strictEqual(TOOLS.length, 21, `expected 21 tools, got ${TOOLS.length}`);
});

check('all 21 tool names present in correct order', () => {
  const names = TOOLS.map((t) => t.name);
  assert.deepStrictEqual(names, EXPECTED_NAMES, `tool names or order mismatch`);
});

check('claws_create inputSchema has name, cwd, wrapped properties', () => {
  const tool = TOOLS.find((t) => t.name === 'claws_create');
  assert.ok(tool, 'claws_create not found');
  const props = tool.inputSchema.properties || {};
  assert.ok(props.name, 'claws_create.name missing');
  assert.ok(props.cwd !== undefined, 'claws_create.cwd missing');
  assert.ok(props.wrapped !== undefined, 'claws_create.wrapped missing');
});

check('claws_lifecycle_plan inputSchema has plan as required property', () => {
  const tool = TOOLS.find((t) => t.name === 'claws_lifecycle_plan');
  assert.ok(tool, 'claws_lifecycle_plan not found');
  const props = tool.inputSchema.properties || {};
  const req   = tool.inputSchema.required || [];
  assert.ok(props.plan, 'plan property missing');
  assert.ok(req.includes('plan'), 'plan not in required array');
});

check('each tool has name, description, and inputSchema', () => {
  for (const t of TOOLS) {
    assert.ok(typeof t.name === 'string' && t.name.length > 0, `tool missing name: ${JSON.stringify(t)}`);
    assert.ok(typeof t.description === 'string' && t.description.length > 0, `${t.name}: missing description`);
    assert.ok(t.inputSchema && typeof t.inputSchema === 'object', `${t.name}: missing inputSchema`);
    assert.ok(t.inputSchema.type === 'object', `${t.name}: inputSchema.type should be 'object'`);
  }
});

// ─── mcp_server.js tools/list smoke test ─────────────────────────────────────

check('mcp_server.js tools/list returns 21 tools with correct names', () => {
  const input = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
  ].join('\n') + '\n';

  const out = execSync(`printf '%s' '${input.replace(/'/g, "'\\''")}' | node "${MCP_SERVER}"`, {
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, CLAWS_SOCKET: '/tmp/claws-codegen-test-nonexistent.sock' },
  });

  const lines = out.trim().split('\n').filter((l) => l.startsWith('{'));
  const toolsResp = lines.find((l) => {
    try { return JSON.parse(l).id === 2; } catch { return false; }
  });
  assert.ok(toolsResp, 'no tools/list response found in mcp_server output');
  const parsed = JSON.parse(toolsResp);
  const tools  = parsed.result.tools;
  assert.ok(Array.isArray(tools), 'tools is not an array');
  assert.strictEqual(tools.length, 21, `expected 21 tools from mcp_server, got ${tools.length}`);
  const names = tools.map((t) => t.name);
  assert.deepStrictEqual(names, EXPECTED_NAMES, 'mcp_server tool names or order mismatch');
});

// ─── results ─────────────────────────────────────────────────────────────────

for (const a of assertions) {
  console.log(`  ${a.ok ? '✓' : '✗'} ${a.name}${a.ok ? '' : ' — ' + a.err}`);
}
const failed = assertions.filter((a) => !a.ok);
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length}/${assertions.length} mcp-tools-codegen check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS: ${assertions.length} mcp-tools-codegen checks`);
process.exit(0);
