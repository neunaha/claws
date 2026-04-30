#!/usr/bin/env node
// Stop hook: list open wrapped terminals via raw socket; warn if >0 remain open.
// Always exits 0 — warnings only. Timeout < 5s. Logs misfires to /tmp/claws-dev-hooks.log.
'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');

const LOG = '/tmp/claws-dev-hooks.log';

function log(msg) {
  const ts = new Date().toISOString();
  try { fs.appendFileSync(LOG, `${ts} [check-open-claws-terminals] ${msg}\n`); } catch (_) {}
}

function findSock() {
  if (process.env.CLAWS_SOCKET) return process.env.CLAWS_SOCKET;
  let d = process.env.PROJECT_ROOT || process.cwd();
  for (let i = 0; i < 20 && d && d !== '/'; i++) {
    const candidate = path.join(d, '.claws', 'claws.sock');
    try { if (fs.statSync(candidate).isSocket()) return candidate; } catch (_) {}
    d = path.dirname(d);
  }
  return null;
}

function listTerminals(sockPath) {
  return new Promise((resolve) => {
    const s = net.createConnection(sockPath);
    const timer = setTimeout(() => { s.destroy(); resolve([]); }, 4000);
    s.on('connect', () => s.write(JSON.stringify({ id: 1, cmd: 'list' }) + '\n'));
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(buf.slice(0, nl));
          resolve(parsed.terminals || []);
        } catch (_) { resolve([]); }
        s.destroy();
      }
    });
    s.on('error', () => { clearTimeout(timer); resolve([]); });
  });
}

async function main() {
  const sockPath = findSock();
  if (!sockPath) return; // no socket — not a Claws session

  let terminals = [];
  try { terminals = await listTerminals(sockPath); } catch (e) {
    log(`list failed: ${e.message}`);
    return;
  }

  const wrapped = terminals.filter((t) => t.logPath || t.wrapped);
  if (wrapped.length > 0) {
    const names = wrapped.map((t) => `#${t.id} ${t.name || '(unnamed)'}`).join(', ');
    console.warn(
      `\n⚠️  [claws-dev-hook] ${wrapped.length} wrapped terminal(s) still open: ${names}\n` +
      `   Close them before ending your session to avoid stale pty logs.\n`
    );
  }
}

main().catch((e) => log(`uncaught: ${e.message}`)).then(() => process.exit(0));
