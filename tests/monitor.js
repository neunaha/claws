#!/usr/bin/env node
// Attach a live monitor to a wrapped Claws terminal.
// Polls readLog on increasing offsets; prints only new bytes.
//
// Usage:
//   node tests/monitor.js <terminal-id> [--duration <seconds>] [--poll <ms>] [--no-strip]
//   node tests/monitor.js <terminal-id> --follow   # forever (ctrl-C to stop)
//
// Socket path defaults to ./.claws/claws.sock — override with CLAWS_SOCKET.

'use strict';

const net = require('net');
const path = require('path');

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('usage: monitor.js <terminal-id> [--duration N] [--poll MS] [--no-strip] [--follow]');
  process.exit(2);
}

const termId = args[0];
const getFlag = (name, def) => {
  const i = args.indexOf(name);
  if (i === -1) return def;
  return args[i + 1];
};
const hasFlag = (name) => args.includes(name);

const duration = hasFlag('--follow') ? Infinity : Number(getFlag('--duration', 25));
const pollMs = Number(getFlag('--poll', 500));
const strip = !hasFlag('--no-strip');

const socketPath = process.env.CLAWS_SOCKET
  ? path.resolve(process.env.CLAWS_SOCKET)
  : path.resolve(process.cwd(), '.claws', 'claws.sock');

function sendReq(req) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('socket timeout')); }, 5000);
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        sock.destroy();
        try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function main() {
  // Sanity: confirm the terminal exists
  const list = await sendReq({ cmd: 'list' });
  if (!list.ok) { console.error('list failed:', list); process.exit(1); }
  const term = (list.terminals || []).find((t) => String(t.id) === String(termId));
  if (!term) {
    console.error(`terminal id=${termId} not found. Available:`,
      (list.terminals || []).map((t) => `${t.id}(${t.name})`).join(', '));
    process.exit(1);
  }

  const header = `── monitor attached → terminal ${termId} [${term.name}] ${term.wrapped ? 'wrapped(pty)' : 'unwrapped'} ──`;
  process.stdout.write(`\x1b[1;34m${header}\x1b[0m\n`);

  // Start by reading current state to establish an offset
  const first = await sendReq({ cmd: 'readLog', id: termId, strip, limit: 1024 });
  let offset = first.ok ? first.nextOffset : 0;

  const endAt = duration === Infinity ? Infinity : Date.now() + duration * 1000;
  let tickCount = 0;

  while (Date.now() < endAt) {
    try {
      const r = await sendReq({ cmd: 'readLog', id: termId, offset, strip, limit: 65536 });
      if (r.ok && typeof r.bytes === 'string' && r.bytes.length > 0) {
        process.stdout.write(r.bytes);
        offset = r.nextOffset;
      }
      tickCount++;
    } catch (e) {
      process.stderr.write(`\n[monitor] poll error: ${e.message}\n`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  process.stdout.write(`\n\x1b[2m── monitor detached after ${tickCount} polls (${Math.round(duration)}s) ──\x1b[0m\n`);
}

main().catch((e) => { console.error('monitor error:', e.message); process.exit(1); });
