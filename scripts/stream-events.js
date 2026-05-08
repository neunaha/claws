#!/usr/bin/env node
// Claws stream-events sidecar.
//
// Modes:
//   Default (no --wait): holds ONE persistent connection, registers as a claws/2 peer,
//       subscribes to a topic pattern, and prints every server-push frame to stdout as
//       a single line of JSON. Designed to be spawned via Bash run_in_background and
//       consumed by the Monitor tool — each push frame becomes one notification.
//   --wait <uuid>: connects, sends hello, subscribes to system.worker.completed and
//       system.terminal.closed with fromCursor='0000:0' (atomic historical replay + live),
//       exits 0 when a push frame with matching correlation_id arrives, 2 on socket close
//       before match, 3 on timeout. No awk/grep — server-side topic filter only.
//
//   --wait flags:
//     --keep-alive-on <termId>   activates in-process rearm. When the inner timer fires,
//                                run a 3-check decision: (1) system.worker.completed in
//                                events.log? → exit 0. (2) terminal closed/terminated in
//                                events.log? → exit 0. (3) eventsSeen(termId, staleMs)?
//                                → rearm. Otherwise → exit 2 (truly stuck).
//     --stale-threshold <ms>     liveness window for eventsSeen check (default 120000).
//     --rearm-cycle <ms>         interval between rearm checks (default = --timeout-ms).
//
// Env:
//   CLAWS_SOCKET     override socket path (both modes; used by tests)
//   CLAWS_TOPIC      subscribe pattern (default '**')  [default mode only]
//   CLAWS_PEER_NAME  peer label (default 'orchestrator-stream') [default mode only]
//   CLAWS_ROLE       'orchestrator' | 'worker' | 'observer' (default 'observer') [default mode only]
//   CLAWS_DEBUG      '1' or 'true' → emit one structured JSON line to stderr per decision
//                    point in the rearm loop (Check 1, Check 2, Check 3, rearm, exit).
//                    Additive only — does NOT change exit codes or default stdout output.
//
// Default-mode output lines (stdout, one JSON per line):
//   {"type":"sidecar.connected", "socket":"...", "ts":"..."}
//   {"type":"sidecar.hello.ack", "peerId":"p7", ...}
//   {"type":"sidecar.subscribed", "topic":"**", "subscriptionId":"s3", ...}
//   {"type":"event", "push":"message", "topic":"...", "from":"...", "payload":{...}}
//   {"type":"sidecar.error", "error":"..."}
//   {"type":"sidecar.closed", "ts":"..."}
//
// Wait-mode output on match (stdout, exactly one JSON line):
//   {"topic":"system.terminal.closed","payload":{...}}

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

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

// ── Arg parsing ───────────────────────────────────────────────────────────────
const _argv = process.argv.slice(2);
let _waitCorrId    = null;
let _waitFlagSeen  = false;
let _waitTimeoutMs = 600000;
let _hasAutoSidecar = false;
let _keepAliveTermId   = null;
let _staleThresholdMs  = 120000;
let _rearmCycleMs      = null;

for (let i = 0; i < _argv.length; i++) {
  if (_argv[i] === '--auto-sidecar') {
    _hasAutoSidecar = true;
  } else if (_argv[i] === '--wait') {
    _waitFlagSeen = true;
    i++;
    _waitCorrId = (_argv[i] !== undefined) ? _argv[i] : null;
  } else if (_argv[i] === '--timeout-ms') {
    i++;
    _waitTimeoutMs = (_argv[i] !== undefined) ? Number(_argv[i]) : NaN;
  } else if (_argv[i] === '--keep-alive-on') {
    i++;
    _keepAliveTermId = (_argv[i] !== undefined) ? String(_argv[i]) : null;
  } else if (_argv[i] === '--stale-threshold') {
    i++;
    _staleThresholdMs = (_argv[i] !== undefined) ? Number(_argv[i]) : NaN;
  } else if (_argv[i] === '--rearm-cycle') {
    i++;
    _rearmCycleMs = (_argv[i] !== undefined) ? Number(_argv[i]) : NaN;
  }
}

if (_rearmCycleMs === null) _rearmCycleMs = _waitTimeoutMs;

if (_hasAutoSidecar && _waitFlagSeen) {
  process.stderr.write('stream-events.js: --wait and --auto-sidecar are mutually exclusive\n');
  process.exit(1);
}

// ── Wait mode ─────────────────────────────────────────────────────────────────
if (_waitFlagSeen) {
  if (_waitCorrId === null || !/^[0-9a-f-]{36}$/.test(_waitCorrId)) {
    process.stderr.write('stream-events.js: --wait requires a valid UUID (36 hex/dash chars)\n');
    process.exit(1);
  }
  if (!Number.isInteger(_waitTimeoutMs) || _waitTimeoutMs <= 0) {
    process.stderr.write('stream-events.js: --timeout-ms must be a positive integer\n');
    process.exit(1);
  }

  const _wSockPath = findSocket();
  if (!_wSockPath) {
    process.stderr.write('stream-events.js --wait: cannot connect to claws.sock\n');
    process.exit(1);
  }

  let _wBuf = '';
  let _wMatched = false;
  const _wCorrId = _waitCorrId;

  const _debug = process.env.CLAWS_DEBUG === '1' || process.env.CLAWS_DEBUG === 'true';
  function dbg(obj) { if (_debug) process.stderr.write(JSON.stringify(obj) + '\n'); }

  // ── Helper: scan events.log for a matching completed/terminated event ──────────
  // Returns true if events.log contains a line matching topic + (corrId or terminal_id).
  function eventsLogContains({ topic, corrId, terminal_id }) {
    try {
      const sockDir = path.dirname(_wSockPath);
      const evLog   = path.join(sockDir, 'events.log');
      if (!fs.existsSync(evLog)) return false;
      const stat    = fs.statSync(evLog);
      const readSz  = Math.min(stat.size, 512 * 1024);
      const fd      = fs.openSync(evLog, 'r');
      const buf     = Buffer.alloc(readSz);
      fs.readSync(fd, buf, 0, readSz, Math.max(0, stat.size - readSz));
      fs.closeSync(fd);
      const topicStr = `"topic":"${topic}"`;
      const corrStr  = corrId      ? `"correlation_id":"${corrId}"` : null;
      const termStr  = terminal_id ? `"terminal_id":"${terminal_id}"` : null;
      for (const line of buf.toString('utf8').split('\n').reverse()) {
        if (!line.includes(topicStr)) continue;
        if (corrStr  && line.includes(corrStr))  return true;
        if (termStr  && line.includes(termStr))  return true;
      }
    } catch { /* swallow */ }
    return false;
  }

  // ── Helper: scan events.log for any recent event belonging to termId ──────────
  // Checks both snake_case ("terminal_id") and camelCase ("terminalId") fields
  // so it catches system.worker.* (snake_case) and vehicle.* (camelCase) events.
  // Returns true if any matching line has sentAt (Unix ms) within withinMs of now.
  function eventsSeen(termId, withinMs) {
    try {
      const sockDir   = path.dirname(_wSockPath);
      const evLog     = path.join(sockDir, 'events.log');
      if (!fs.existsSync(evLog)) return false;
      const stat      = fs.statSync(evLog);
      const readSz    = Math.min(stat.size, 512 * 1024);
      const fd        = fs.openSync(evLog, 'r');
      const buf       = Buffer.alloc(readSz);
      fs.readSync(fd, buf, 0, readSz, Math.max(0, stat.size - readSz));
      fs.closeSync(fd);
      const now       = Date.now();
      const matchA    = `"terminal_id":"${termId}"`;
      const matchB    = `"terminalId":"${termId}"`;
      for (const line of buf.toString('utf8').split('\n').reverse()) {
        if (!line.includes(matchA) && !line.includes(matchB)) continue;
        try {
          const ev = JSON.parse(line);
          if (typeof ev.sentAt === 'number' && (now - ev.sentAt) < withinMs) return true;
        } catch { /* malformed line — skip */ }
      }
    } catch { /* swallow */ }
    return false;
  }

  // ── Rearm decision loop (fires when inner timer expires) ──────────────────────
  function rearmDecisionLoop() {
    const _now = Date.now();

    // Check 1: completion event already persisted in events.log? (race: Monitor armed after done)
    const _c1Matched = eventsLogContains({ topic: 'system.worker.completed', corrId: _wCorrId });
    dbg({ check: 1, event: 'completion-scan', corrId: _wCorrId, matched: _c1Matched, matchedAt: _c1Matched ? _now : null, now: _now });
    if (_c1Matched) {
      process.stderr.write(`stream-events.js --wait: matched (raced) — system.worker.completed in events.log\n`);
      dbg({ event: 'exit', code: 0, reason: 'check1-completed', corrId: _wCorrId, now: _now });
      clearTimeout(_wTimer);
      try { _wSock.destroy(); } catch {}
      process.exit(0);
    }

    // Check 2: termination — corrId-only matching for both system.terminal.closed and
    //          system.worker.terminated. terminal_id is session-local: VS Code resets the
    //          counter on extension reload and recycles integers as terminals open/close.
    //          events.log is globally append-only, so any prior-session terminated event
    //          with the same numeric terminal_id would false-positive here. correlation_id
    //          is a UUID — globally unique, collision-free across sessions and reloads.
    if (_keepAliveTermId) {
      const closedByCorrId     = eventsLogContains({ topic: 'system.terminal.closed',   corrId: _wCorrId });
      const terminatedByCorrId = eventsLogContains({ topic: 'system.worker.terminated', corrId: _wCorrId });
      dbg({ check: 2, event: 'termination-scan', corrId: _wCorrId, closedByCorrId, terminatedByCorrId, now: _now });
      if (closedByCorrId || terminatedByCorrId) {
        const which = closedByCorrId ? 'system.terminal.closed(corrId)' : 'system.worker.terminated(corrId)';
        process.stderr.write(`stream-events.js --wait: matched (raced) — ${which} in events.log\n`);
        dbg({ event: 'exit', code: 0, reason: 'check2-termination', corrId: _wCorrId, now: _now });
        clearTimeout(_wTimer);
        try { _wSock.destroy(); } catch {}
        process.exit(0);
      }
    }

    // Check 3: events.log recency scan — is the terminal still producing bus events?
    if (_keepAliveTermId) {
      const alive = eventsSeen(_keepAliveTermId, _staleThresholdMs);
      dbg({ check: 3, event: 'liveness-scan', termId: _keepAliveTermId, alive, staleThresholdMs: _staleThresholdMs, now: _now });
      if (alive) {
        dbg({ event: 'rearm', reason: 'alive', now: _now });
        process.stderr.write(`stream-events.js --wait: rearming — terminal ${_keepAliveTermId} active in events.log within ${_staleThresholdMs}ms\n`);
        _wTimer = setTimeout(rearmDecisionLoop, _rearmCycleMs);
        return;
      }
      dbg({ event: 'exit', code: 2, reason: 'no-events-for-terminal', corrId: _wCorrId, now: _now });
      process.stderr.write(`stream-events.js --wait: exit stuck — no events for terminal ${_keepAliveTermId} within ${_staleThresholdMs}ms\n`);
      try { _wSock.destroy(); } catch {}
      process.exit(2);
    }

    // No --keep-alive-on provided: original timeout behavior (backwards compat)
    dbg({ event: 'rearm', reason: 'no-keep-alive', now: _now });
    process.stderr.write(`stream-events.js --wait: timeout waiting for close event (correlation_id=${_wCorrId})\n`);
    process.exit(3);
  }

  let _wTimer = setTimeout(rearmDecisionLoop, _keepAliveTermId ? _rearmCycleMs : _waitTimeoutMs);

  const _wSock = net.createConnection(_wSockPath);

  _wSock.on('error', (e) => {
    clearTimeout(_wTimer);
    if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
      process.stderr.write('stream-events.js --wait: cannot connect to claws.sock\n');
      process.exit(1);
    }
    process.stderr.write('stream-events.js --wait: socket closed before close event\n');
    process.exit(2);
  });

  _wSock.on('connect', () => {
    _wSock.write(JSON.stringify({ id: 1, cmd: 'hello', protocol: 'claws/2', role: 'observer', peerName: 'wait-mode' }) + '\n');
  });

  _wSock.on('data', (d) => {
    _wBuf += d.toString('utf8');
    let nl;
    while ((nl = _wBuf.indexOf('\n')) !== -1) {
      const line = _wBuf.slice(0, nl);
      _wBuf = _wBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch (_) {
        process.stderr.write(`stream-events.js --wait: malformed event: ${line.slice(0, 200)}\n`);
        continue;
      }

      const rid = msg.rid != null ? msg.rid : msg.id;

      if (rid === 1 && msg.peerId) {
        // Hello ack — subscribe to both terminal-state topics with full historical replay.
        // fromCursor:'0000:0' makes the server replay matching events from the event log
        // before delivering live pushes, closing the subscribe-before-drain race gap.
        _wSock.write(JSON.stringify({ id: 2, cmd: 'subscribe', topic: 'system.worker.completed', fromCursor: '0000:0' }) + '\n');
        _wSock.write(JSON.stringify({ id: 3, cmd: 'subscribe', topic: 'system.terminal.closed',  fromCursor: '0000:0' }) + '\n');
        continue;
      }
      if (rid === 2 || rid === 3) continue; // subscribe acks — no action needed

      // Push frames (both replayed historical and live events arrive the same way)
      if (msg.push === 'message' &&
          (msg.topic === 'system.worker.completed' || msg.topic === 'system.terminal.closed') &&
          msg.payload != null && msg.payload.correlation_id === _wCorrId) {
        _wMatched = true;
        process.stdout.write(JSON.stringify({ topic: msg.topic, payload: msg.payload }) + '\n');
        clearTimeout(_wTimer);
        _wSock.destroy();
        process.exit(0);
      }
    }
  });

  _wSock.on('close', () => {
    if (!_wMatched) {
      clearTimeout(_wTimer);
      process.stderr.write('stream-events.js --wait: socket closed before close event\n');
      process.exit(2);
    }
  });

  process.on('SIGTERM', () => { clearTimeout(_wTimer); try { _wSock.destroy(); } catch {} process.exit(143); });
  process.on('SIGINT',  () => { clearTimeout(_wTimer); try { _wSock.destroy(); } catch {} process.exit(130); });
  process.stdout.on('error', (e) => { if (e.code === 'EPIPE') { clearTimeout(_wTimer); process.exit(141); } });

} else {
  // ── Default mode (unchanged) ──────────────────────────────────────────────────
  const SOCK      = findSocket();
  const TOPIC     = process.env.CLAWS_TOPIC     || '**';
  const PEER_NAME = process.env.CLAWS_PEER_NAME || 'orchestrator-stream';
  const ROLE      = process.env.CLAWS_ROLE      || 'observer';

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
}
