#!/usr/bin/env node
// T2/Q6 regression: every peer registered via claws_hello must auto-receive
// the 'push' capability so they can claws_publish without explicit opt-in.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.resolve(__dirname, '../src/server.ts'), 'utf8');

// Verify the registration code path adds 'push' to capabilities via a Set.add call.
const hasAutoPush =
  src.includes("capSet.add('push')") ||
  src.includes('capSet.add("push")') ||
  src.includes(".add('push')");
assert.ok(hasAutoPush, 'server.ts must auto-add push capability on hello register');

// Verify the idempotent re-hello path also ensures push.
const idempotentSection = src.slice(src.indexOf('BUG-03: idempotent hello'));
const idempotentHasPush =
  idempotentSection.slice(0, 700).includes(".add('push')") ||
  idempotentSection.slice(0, 700).includes('.add("push")');
assert.ok(idempotentHasPush, 'server.ts must ensure push on idempotent re-hello path too');

console.log('peer-registry-push.test.js: PASS — push capability auto-granted on hello (fresh + idempotent)');

// Verify the global template no longer mandates push as a BUG-03 workaround.
const tplPath = path.resolve(__dirname, '../../templates/CLAUDE.global.md');
if (fs.existsSync(tplPath)) {
  const tpl = fs.readFileSync(tplPath, 'utf8');
  const stillMandates =
    tpl.includes("capabilities: ['push']") &&
    tpl.includes('BUG-03') &&
    !tpl.includes('auto-granted');
  assert.ok(!stillMandates,
    "CLAUDE.global.md should not mandate explicit push capability — it is auto-granted as of v0.7.13");
  console.log('peer-registry-push.test.js: PASS — CLAUDE.global.md no longer mandates explicit push capability');
} else {
  console.log('peer-registry-push.test.js: SKIP — templates/CLAUDE.global.md not found');
}
