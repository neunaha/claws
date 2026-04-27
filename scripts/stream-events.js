#!/usr/bin/env node
// Claws stream-events sidecar.
//
// Holds ONE persistent connection to .claws/claws.sock, registers as a
// claws/2 peer, subscribes to a topic pattern, and prints every server-push
// frame to stdout as a single line of JSON. Designed to be spawned via
// Bash run_in_background and consumed by the Monitor tool — each push frame
// becomes one notification with sub-50ms latency.
//
// Env:
//   CLAWS_SOCKET     override socket path
//   CLAWS_TOPIC      subscribe pattern (default '**' = everything)
//   CLAWS_PEER_NAME  peer label (default 'orchestrator-stream')
//   CLAWS_ROLE       'orchestrator' | 'worker' | 'observer' (default 'observer')
//
// Output line shapes (all on stdout, one JSON per line):
//   {"type":"sidecar.connected", "socket":"...", "ts":"..."}
//   {"type":"sidecar.hello.ack", "peerId":"p7", ...}
//   {"type":"sidecar.subscribed", "topic":"**", "subscriptionId":"s3", ...}
//   {"type":"event", "push":"message", "topic":"...", "from":"...", "payload":{...}}
//   {"type":"sidecar.error", "error":"..."}
//   {"type":"sidecar.closed", "ts":"..."}

'use strict';
const net  = require('net');
const fs   = require('fs');
const path = require('path');

function findSocket() {
  if (process.env.CLAWS_SOCKET) return process.env.CLAWS_SOCKET;
  for (const start of [process.cwd(), __dirname]) {
    let dir = start;
    while (dir && dir !== '/' && dir !== path.dirname(dir)) {
      const c = path.join(dir, '.claws', 'claws.sock');
      try { if (fs.statSync(c).isSocket()) return c; } catch { /* */ }
      dir = path.dirname(dir);
    }
  }
  return null;
}

const SOCK      = findSocket();
const TOPIC     = process.env.CLAWS_TOPIC     || '**';
const PEER_NAME = process.env.CLAWS_PEER_NAME || 'orchestrator-stream';
const ROLE      = process.env.CLAWS_ROLE      || 'observer';

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

if (!SOCK) {
  emit({ type: 'sidecar.error', error: 'no .claws/claws.sock found' });
  process.exit(1);
}

let buf = '';
const sock = net.createConnection(SOCK);

sock.on('connect', () => {
  emit({ type: 'sidecar.connected', socket: SOCK, role: ROLE, ts: new Date().toISOString() });
  sock.write(JSON.stringify({ id: 1, cmd: 'hello', protocol: 'claws/2', role: ROLE, peerName: PEER_NAME }) + '\n');
});

sock.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch (e) { emit({ type: 'sidecar.parse-error', line, error: e.message }); continue; }

    if (msg.rid === 1 && msg.peerId) {
      emit({ type: 'sidecar.hello.ack', peerId: msg.peerId, ts: new Date().toISOString() });
      sock.write(JSON.stringify({ id: 2, cmd: 'subscribe', topic: TOPIC }) + '\n');
      continue;
    }
    if (msg.rid === 2) {
      emit({ type: 'sidecar.subscribed', topic: TOPIC, subscriptionId: msg.subscriptionId, ok: msg.ok, ts: new Date().toISOString() });
      continue;
    }
    if (msg.push) {
      emit({ type: 'event', ...msg, recvTs: new Date().toISOString() });
      continue;
    }
    emit({ type: 'sidecar.unknown', msg });
  }
});

sock.on('error', (e) => {
  emit({ type: 'sidecar.error', error: e.message });
  process.exit(1);
});

sock.on('close', () => {
  emit({ type: 'sidecar.closed', ts: new Date().toISOString() });
  process.exit(0);
});

const shutdown = () => { try { sock.end(); } catch {} process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
