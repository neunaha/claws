#!/usr/bin/env node
// Claws SDK — typed publish helpers for worker scripts.
// Usage (CLI):   node .claws-bin/claws-sdk.js publish <type> [flags]
// Usage (module): const { ClawsSDK } = require('.claws-bin/claws-sdk.js')
//
// Supported types: boot | phase | event | heartbeat | complete
// Zero dependencies — stdlib only.

'use strict';

const net    = require('net');
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');

const VERSION = '0.7.6.1';

// ── Socket discovery ──────────────────────────────────────────────────────────

function findSocket(startDir) {
  let dir = startDir || process.cwd();
  for (let i = 0; i < 20; i++) {
    const candidate = path.join(dir, '.claws', 'claws.sock');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ── Envelope builder ─────────────────────────────────────────────────────────

function buildEnvelope(peerId, peerName, schemaName, data) {
  return {
    v:            1,
    id:           crypto.randomUUID(),
    from_peer:    peerId,
    from_name:    peerName || 'unknown',
    ts_published: new Date().toISOString(),
    schema:       schemaName,
    data,
  };
}

// ── ClawsSDK class (module API) ───────────────────────────────────────────────

class ClawsSDK {
  constructor({ socketPath, peerId, peerName, terminalId } = {}) {
    this.socketPath   = socketPath || process.env.CLAWS_SOCKET || findSocket();
    // _topicPeerId is captured once from constructor/env and never overwritten by hello().
    // This ensures CLAWS_PEER_ID always governs topic routing even when the server
    // assigns a different connection-identity peerId.
    this._topicPeerId = peerId || process.env.CLAWS_PEER_ID || null;
    this.peerId       = this._topicPeerId;
    this.peerName     = peerName   || process.env.CLAWS_PEER_NAME   || 'sdk-worker';
    this.terminalId   = terminalId || process.env.CLAWS_TERMINAL_ID || '';
    this._sock        = null;
    this._buf         = '';
    this._pending     = new Map();
    this._rid         = 1;
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (!this.socketPath) return reject(new Error('no socket path — is Claws running?'));
      const sock = net.createConnection(this.socketPath);
      sock.setEncoding('utf8');
      // M-37: 5-second connect ceiling — prevents indefinite hang when socket file is
      // stale (VS Code crashed, server not running). destroy(err) triggers 'error' → reject.
      sock.setTimeout(5000);
      sock.on('timeout', () => {
        sock.destroy(new Error('connect timed out after 5s — is Claws running? Run /claws-fix'));
      });
      sock.on('data', (chunk) => {
        this._buf += chunk;
        let nl;
        while ((nl = this._buf.indexOf('\n')) !== -1) {
          const line = this._buf.slice(0, nl).trim();
          this._buf  = this._buf.slice(nl + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            const p = this._pending.get(msg.id ?? msg.rid);
            if (p) { this._pending.delete(msg.id ?? msg.rid); p(msg); }
          } catch { /* ignore non-JSON */ }
        }
      });
      sock.on('connect', () => { sock.setTimeout(0); this._sock = sock; resolve(this); });
      sock.on('error',   reject);
    });
  }

  close() {
    if (this._sock) { this._sock.destroy(); this._sock = null; }
  }

  _send(obj, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (!this._sock) return reject(new Error('not connected'));
      const rid = this._rid++;
      obj.id  = rid;
      obj.rid = rid;
      // M-37: per-request timeout — prevents _pending Map leaking if server stops
      // responding after connect (e.g., extension reloading, partial write).
      const timer = setTimeout(() => {
        this._pending.delete(rid);
        reject(new Error(`request ${rid} timed out after ${timeoutMs}ms — server may be reloading`));
      }, timeoutMs);
      this._pending.set(rid, (msg) => { clearTimeout(timer); resolve(msg); });
      this._sock.write(JSON.stringify(obj) + '\n');
    });
  }

  hello(role) {
    const req = {
      cmd:        'hello',
      protocol:   'claws/2',
      role:       role || 'worker',
      peerName:   this.peerName,
      terminalId: this.terminalId,
    };
    return this._send(req).then((r) => {
      if (r.ok && r.peerId) {
        this.peerId = r.peerId;
        // Only populate _topicPeerId from hello when not set via env/constructor.
        // When CLAWS_PEER_ID is set, _topicPeerId is immutable so topics stay correct.
        if (!this._topicPeerId) this._topicPeerId = r.peerId;
      }
      return r;
    });
  }

  publish(topic, schemaName, data) {
    if (!this._topicPeerId) throw new Error('peerId required — call hello() first or set CLAWS_PEER_ID');
    const payload = buildEnvelope(this._topicPeerId, this.peerName, schemaName, data);
    return this._send({ cmd: 'publish', protocol: 'claws/2', topic, payload });
  }

  publishBoot({ missionSummary, role, capabilities }) {
    return this.publish(`worker.${this._topicPeerId}.boot`, 'worker-boot-v1', {
      model:           process.env.CLAWS_MODEL || 'unknown',
      role:            role || 'worker',
      parent_peer_id:  process.env.CLAWS_PARENT_PEER_ID || null,
      mission_summary: missionSummary,
      capabilities:    capabilities || [],
      cwd:             process.cwd(),
      terminal_id:     this.terminalId || '',
    });
  }

  publishPhase({ phase, prev, transitionReason, phasesCompleted, metadata }) {
    return this.publish(`worker.${this._topicPeerId}.phase`, 'worker-phase-v1', {
      phase,
      prev:              prev || null,
      transition_reason: transitionReason || 'unspecified',
      phases_completed:  phasesCompleted || [],
      ...(metadata ? { metadata } : {}),
    });
  }

  publishEvent({ kind, message, severity, requestId, data }) {
    return this.publish(`worker.${this._topicPeerId}.event`, 'worker-event-v1', {
      kind,
      severity: severity || 'info',
      message:  message,
      ...(requestId ? { request_id: requestId } : {}),
      ...(data ? { data } : {}),
    });
  }

  publishHeartbeat({ currentPhase, timeInPhaseMs, tokensUsed, costUsd, lastEventId, activeSubWorkers }) {
    return this.publish(`worker.${this._topicPeerId}.heartbeat`, 'worker-heartbeat-v1', {
      current_phase:      currentPhase,
      time_in_phase_ms:   timeInPhaseMs    || 0,
      tokens_used:        tokensUsed       || 0,
      cost_usd:           costUsd          || 0,
      last_event_id:      lastEventId      || null,
      active_sub_workers: activeSubWorkers || [],
    });
  }

  publishComplete({ result, summary, artifacts, phasesCompleted, totalTokens, totalCostUsd, durationMs }) {
    return this.publish(`worker.${this._topicPeerId}.complete`, 'worker-complete-v1', {
      result,
      summary,
      artifacts:        artifacts        || [],
      phases_completed: phasesCompleted  || [],
      total_tokens:     totalTokens      || 0,
      total_cost_usd:   totalCostUsd     || 0,
      duration_ms:      durationMs       || 0,
    });
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function cli(argv) {
  const [subcmd, type, ...rest] = argv;

  if (!subcmd || subcmd === '--help' || subcmd === '-h') {
    process.stdout.write([
      `claws-sdk v${VERSION}`,
      '',
      'Usage:',
      '  node claws-sdk.js publish <type> [options]',
      '',
      'Types:',
      '  boot        --mission <text> [--role worker] [--caps a,b]',
      '  phase       --phase <PHASE> [--prev <PHASE>] [--reason <text>]',
      '  event       --kind <KIND> --message <text> [--severity info|warn|error|fatal]',
      '  heartbeat   --phase <PHASE> [--tokens N]',
      '  complete    --result ok|failed|cancelled --summary <text>',
      '',
      'Environment:',
      '  CLAWS_SOCKET          Unix socket path (auto-discovered if unset)',
      '  CLAWS_PEER_ID         Peer ID (required; locked in for topic routing)',
      '  CLAWS_PEER_NAME       Human label (default: sdk-worker)',
      '  CLAWS_TERMINAL_ID     Terminal ID for correlation',
      '  CLAWS_MODEL           Model name for boot event (default: unknown)',
      '  CLAWS_PARENT_PEER_ID  Spawning parent peer ID (default: none)',
      '',
    ].join('\n'));
    process.exit(0);
  }

  if (subcmd === '--version' || subcmd === '-v') {
    process.stdout.write(VERSION + '\n');
    process.exit(0);
  }

  if (subcmd !== 'publish') {
    process.stderr.write(`Unknown command: ${subcmd}\n`);
    process.exit(1);
  }

  if (!type) {
    process.stderr.write('publish requires a type argument\n');
    process.exit(1);
  }

  if (!process.env.CLAWS_PEER_ID) {
    process.stderr.write('CLAWS_PEER_ID is required\n');
    process.exit(1);
  }

  // Parse remaining flags into a map
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (k.startsWith('--')) {
      flags[k.slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
    }
  }

  const sdk = new ClawsSDK();
  await sdk.connect();
  await sdk.hello('worker');

  let result;
  switch (type) {
    case 'boot':
      if (!flags.mission) { process.stderr.write('--mission required\n'); process.exit(1); }
      result = await sdk.publishBoot({
        missionSummary: flags.mission,
        role:           flags.role || 'worker',
        capabilities:   flags.caps ? flags.caps.split(',') : [],
      });
      break;
    case 'phase':
      if (!flags.phase) { process.stderr.write('--phase required\n'); process.exit(1); }
      result = await sdk.publishPhase({
        phase:            flags.phase,
        prev:             flags.prev,
        transitionReason: flags.reason || 'unspecified',
        phasesCompleted:  [],
      });
      break;
    case 'event':
      if (!flags.kind || !(flags.message || flags.summary)) {
        process.stderr.write('--kind and --message required\n');
        process.exit(1);
      }
      result = await sdk.publishEvent({
        kind:     flags.kind,
        message:  flags.message || flags.summary,
        severity: flags.severity,
      });
      break;
    case 'heartbeat':
      if (!flags.phase) { process.stderr.write('--phase required\n'); process.exit(1); }
      result = await sdk.publishHeartbeat({
        currentPhase:     flags.phase,
        timeInPhaseMs:    0,
        tokensUsed:       flags.tokens ? parseInt(flags.tokens, 10) : 0,
        costUsd:          0,
        lastEventId:      null,
        activeSubWorkers: [],
      });
      break;
    case 'complete':
      if (!flags.result || !flags.summary) { process.stderr.write('--result and --summary required\n'); process.exit(1); }
      result = await sdk.publishComplete({
        result:          flags.result,
        summary:         flags.summary,
        phasesCompleted: [],
        totalTokens:     0,
        totalCostUsd:    0,
        durationMs:      0,
      });
      break;
    default:
      process.stderr.write(`Unknown type: ${type}\n`);
      sdk.close();
      process.exit(1);
  }

  sdk.close();
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result && result.ok ? 0 : 1);
}

// ── Entry ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  cli(process.argv.slice(2)).catch((e) => {
    process.stderr.write(e.message + '\n');
    process.exit(1);
  });
} else {
  module.exports = { ClawsSDK, buildEnvelope, findSocket, VERSION };
}
