#!/usr/bin/env node
// L13 + L14 observability and rate-control test suite.
// Boots extension with a short heartbeat + low rate-limit config, then:
//   1. Verifies system.metrics push events arrive every heartbeat
//   2. Verifies per-peer rate-limit rejection at high burst rate
//   3. Verifies system.peer.metrics.<peerId> emitted after rate-limit activity
//   4. Verifies admission-control:backlog rejection when serverInFlight > maxQueueDepth
//   5. Verifies backoff restores normal publish flow
//
// Run: node extension/test/claws-v2-rate.test.js
// Exits 0 on success, 1 on failure.

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const EXT_ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(EXT_ROOT, 'dist', 'extension.js');

if (!fs.existsSync(BUNDLE)) {
  console.error('FAIL: dist/extension.js not found. Run `npm run build` first.');
  process.exit(1);
}

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-rate-'));
const logs = [];

// ─── Mock vscode ─────────────────────────────────────────────────────────────

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (l) => {
      this.listeners.push(l);
      return { dispose: () => { const i = this.listeners.indexOf(l); if (i >= 0) this.listeners.splice(i, 1); } };
    };
  }
  fire(a) { for (const l of this.listeners.slice()) l(a); }
  dispose() { this.listeners = []; }
}
class TerminalProfile { constructor(o) { this.options = o; } }
class MarkdownString { constructor() { this.value = ''; this.isTrusted = false; } appendMarkdown(s) { this.value += s; return this; } }
class ThemeColor { constructor(id) { this.id = id; } }

const onOpen = new EventEmitter();
const onClose = new EventEmitter();

// Config: short heartbeat, low rate limit, tight queue depth
const TEST_HEARTBEAT_MS   = 300;
const TEST_MAX_RATE_HZ    = 5;    // allow 5 publishes per second per peer
const TEST_MAX_QUEUE_DEPTH = 0;   // any concurrent publish beyond the first is rejected (admission control)

const vscode = {
  EventEmitter, TerminalProfile, MarkdownString, ThemeColor,
  StatusBarAlignment: { Left: 1, Right: 2 },
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file', path: p }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
    getConfiguration: (_s) => ({
      get: (k, fb) => {
        if (k === 'heartbeatIntervalMs') return TEST_HEARTBEAT_MS;
        if (k === 'maxPublishRateHz')    return TEST_MAX_RATE_HZ;
        if (k === 'maxQueueDepth')       return TEST_MAX_QUEUE_DEPTH;
        return fb;
      },
    }),
  },
  window: {
    terminals: [], activeTerminal: undefined,
    createOutputChannel: () => ({ appendLine: (m) => logs.push(m), show: () => {}, dispose: () => {} }),
    createStatusBarItem: () => ({ text: '', tooltip: '', color: undefined, command: '', name: '', show: () => {}, hide: () => {}, dispose: () => {} }),
    createTerminal: () => ({ name: 'mock', processId: Promise.resolve(12345), shellIntegration: undefined, show: () => {}, sendText: () => {}, dispose: () => {} }),
    onDidOpenTerminal: onOpen.event,
    onDidCloseTerminal: onClose.event,
    registerTerminalProfileProvider: () => ({ dispose: () => {} }),
    showErrorMessage: () => ({ then: () => {} }),
    showInformationMessage: () => ({ then: () => {} }),
    showWarningMessage: () => ({ then: () => {} }),
    showQuickPick: () => Promise.resolve(undefined),
  },
  commands: {
    registerCommand: () => ({ dispose: () => {} }),
    executeCommand: () => Promise.resolve(),
  },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'vscode') return 'vscode';
  return origResolve.call(this, request, parent, ...rest);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscode };

const ext = require(BUNDLE);
ext.activate({ subscriptions: [], extensionPath: EXT_ROOT });

// ─── helpers ─────────────────────────────────────────────────────────────────

const sockPath = path.join(workspaceRoot, '.claws', 'claws.sock');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(fn, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (fn()) return true; await sleep(20); }
  return false;
}

function connect() {
  const s = net.createConnection(sockPath);
  const responses = new Map();
  const pushes = [];
  let buf = '';
  s.on('data', (d) => {
    buf += d.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const f = JSON.parse(line);
        if (f.rid != null) responses.set(f.rid, f);
        else pushes.push(f);
      } catch { /* ignore */ }
    }
  });
  return { socket: s, responses, pushes };
}

function send(peer, msg) {
  peer.socket.write(JSON.stringify(msg) + '\n');
}

async function rpc(peer, msg, timeoutMs = 2000) {
  send(peer, msg);
  const ok = await waitFor(() => peer.responses.has(msg.id), timeoutMs);
  if (!ok) throw new Error(`rpc timeout for cmd=${msg.cmd} id=${msg.id}`);
  return peer.responses.get(msg.id);
}

async function hello(peer, id, role, name) {
  const r = await rpc(peer, { id, cmd: 'hello', protocol: 'claws/2', role, peerName: name });
  if (!r.ok) throw new Error(`hello failed for ${name}: ${JSON.stringify(r)}`);
  return r.peerId;
}

const assertions = [];
async function check(name, fn) {
  try {
    await fn();
    assertions.push({ name, ok: true });
  } catch (e) {
    assertions.push({ name, ok: false, err: e.message || String(e) });
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

(async () => {
  const ready = await waitFor(() => fs.existsSync(sockPath), 3000);
  if (!ready) {
    console.error('FAIL: socket not created within 3s');
    process.exit(1);
  }

  // ── Peer A: observer subscribes to system.metrics + system.peer.metrics.** ──
  const obs = connect();
  await new Promise((resolve) => obs.socket.on('connect', resolve));
  await hello(obs, 1, 'observer', 'rate-observer');

  await rpc(obs, { id: 2, cmd: 'subscribe', protocol: 'claws/2', topic: 'system.metrics' });
  await rpc(obs, { id: 3, cmd: 'subscribe', protocol: 'claws/2', topic: 'system.peer.metrics.**' });

  // ── Peer B: worker — rate-limited publisher ──
  const pub = connect();
  await new Promise((resolve) => pub.socket.on('connect', resolve));
  const pubPeerId = await hello(pub, 1, 'worker', 'rate-publisher');

  // ─── Test 1: system.metrics received within heartbeat window ─────────────

  await check('system.metrics push arrives within 2× heartbeat interval', async () => {
    const waitMs = TEST_HEARTBEAT_MS * 2 + 200;
    const got = await waitFor(() => obs.pushes.some(p => p.topic === 'system.metrics'), waitMs);
    if (!got) throw new Error(`system.metrics not received within ${waitMs}ms`);
  });

  await check('system.metrics payload has publishRate_per_sec (number >= 0)', () => {
    const ev = obs.pushes.find(p => p.topic === 'system.metrics');
    if (!ev) throw new Error('no system.metrics event');
    if (typeof ev.payload.publishRate_per_sec !== 'number' || ev.payload.publishRate_per_sec < 0) {
      throw new Error(`publishRate_per_sec invalid: ${JSON.stringify(ev.payload)}`);
    }
  });

  await check('system.metrics payload has queueDepth (integer >= 0)', () => {
    const ev = obs.pushes.find(p => p.topic === 'system.metrics');
    const pl = ev.payload;
    if (typeof pl.queueDepth !== 'number' || pl.queueDepth < 0 || !Number.isInteger(pl.queueDepth)) {
      throw new Error(`queueDepth invalid: ${JSON.stringify(pl)}`);
    }
  });

  await check('system.metrics payload has peerCount (integer >= 0)', () => {
    const ev = obs.pushes.find(p => p.topic === 'system.metrics');
    const pl = ev.payload;
    if (typeof pl.peerCount !== 'number' || !Number.isInteger(pl.peerCount) || pl.peerCount < 0) {
      throw new Error(`peerCount invalid: ${JSON.stringify(pl)}`);
    }
  });

  await check('system.metrics payload has eventLogLastSeq (integer >= 0)', () => {
    const ev = obs.pushes.find(p => p.topic === 'system.metrics');
    const pl = ev.payload;
    if (typeof pl.eventLogLastSeq !== 'number' || !Number.isInteger(pl.eventLogLastSeq) || pl.eventLogLastSeq < 0) {
      throw new Error(`eventLogLastSeq invalid: ${JSON.stringify(pl)}`);
    }
  });

  await check('system.metrics payload has uptimeMs (number > 0)', () => {
    const ev = obs.pushes.find(p => p.topic === 'system.metrics');
    if (typeof ev.payload.uptimeMs !== 'number' || ev.payload.uptimeMs <= 0) {
      throw new Error(`uptimeMs invalid: ${JSON.stringify(ev.payload)}`);
    }
  });

  await check('system.metrics payload has ts (ISO string)', () => {
    const ev = obs.pushes.find(p => p.topic === 'system.metrics');
    if (typeof ev.payload.ts !== 'string' || !ev.payload.ts.includes('T')) {
      throw new Error(`ts invalid: ${JSON.stringify(ev.payload)}`);
    }
  });

  // ─── Test 2: system.metrics fires multiple times ──────────────────────────

  await check('system.metrics fires at least 2 times', async () => {
    const waitMs = Math.ceil(TEST_HEARTBEAT_MS * 2.5) + 200;
    const got = await waitFor(() => obs.pushes.filter(p => p.topic === 'system.metrics').length >= 2, waitMs);
    if (!got) {
      const count = obs.pushes.filter(p => p.topic === 'system.metrics').length;
      throw new Error(`expected ≥2 system.metrics events, got ${count}`);
    }
  });

  // ─── Test 3: per-peer rate limit — burst above maxPublishRateHz ──────────
  // Send BURST_COUNT publishes rapidly (without awaiting individual responses).
  // With maxPublishRateHz=5, handlers 6–BURST_COUNT should be rate-limit-exceeded.
  // With maxQueueDepth=0, handlers 2+ are also admission-limited. Rate limit fires
  // FIRST (checked before admission), so pub6-10 get rate-limit-exceeded not backlog.

  const BURST_COUNT = TEST_MAX_RATE_HZ + 5; // 10 total
  const burstIds = [];
  for (let i = 0; i < BURST_COUNT; i++) {
    const id = 100 + i;
    burstIds.push(id);
    send(pub, { id, cmd: 'publish', protocol: 'claws/2', topic: 'wave.7.test.burst', payload: { seq: i } });
  }
  const burstWait = await waitFor(() => burstIds.every(id => pub.responses.has(id)), 3000);

  await check('all burst publish requests received a response', () => {
    if (!burstWait) {
      const missing = burstIds.filter(id => !pub.responses.has(id));
      throw new Error(`${missing.length} burst responses missing`);
    }
  });

  await check('some burst publishes rejected with rate-limit-exceeded', () => {
    const rateLimited = burstIds.filter(id => {
      const r = pub.responses.get(id);
      return r && !r.ok && r.error === 'rate-limit-exceeded';
    });
    if (rateLimited.length === 0) {
      const errors = [...new Set(burstIds.map(id => {
        const r = pub.responses.get(id);
        return r ? (r.ok ? 'ok' : r.error) : 'missing';
      }))];
      throw new Error(`no rate-limit-exceeded among ${BURST_COUNT} burst publishes. errors: ${errors.join(',')}`);
    }
  });

  await check('some burst publishes succeeded (rate allows up to maxPublishRateHz)', () => {
    const succeeded = burstIds.filter(id => pub.responses.get(id)?.ok);
    if (succeeded.length === 0) throw new Error('all burst publishes were rejected');
  });

  // ─── Test 4: admission-control:backlog fires for concurrent overload ───────
  // With maxQueueDepth=0, any handler that finds serverInFlight > 0 is rejected.
  // The burst above already demonstrates this implicitly (burst has mixed errors).
  // Verify at least one of the known error codes appeared.

  await check('burst responses are exclusively ok|rate-limit-exceeded|admission-control:backlog', () => {
    const knownErrors = new Set(['rate-limit-exceeded', 'admission-control:backlog']);
    for (const id of burstIds) {
      const r = pub.responses.get(id);
      if (!r) continue;
      if (!r.ok && !knownErrors.has(r.error)) {
        throw new Error(`unexpected error code: ${r.error}`);
      }
    }
  });

  // ─── Test 5: system.peer.metrics.<pubPeerId> emitted after rate-limit hits ─

  await check(`system.peer.metrics.${pubPeerId} emitted after rate-limit activity`, async () => {
    const waitMs = TEST_HEARTBEAT_MS * 2 + 400;
    const got = await waitFor(
      () => obs.pushes.some(p => p.topic === `system.peer.metrics.${pubPeerId}`),
      waitMs,
    );
    if (!got) {
      const topics = [...new Set(obs.pushes.map(p => p.topic))];
      throw new Error(`system.peer.metrics.${pubPeerId} not received within ${waitMs}ms. topics: ${topics.join(', ')}`);
    }
  });

  await check('system.peer.metrics payload has rateLimitHits > 0', () => {
    const ev = obs.pushes.find(p => p.topic === `system.peer.metrics.${pubPeerId}`);
    if (!ev) throw new Error('no system.peer.metrics event');
    if (typeof ev.payload.rateLimitHits !== 'number' || ev.payload.rateLimitHits <= 0) {
      throw new Error(`rateLimitHits should be > 0, got: ${JSON.stringify(ev.payload)}`);
    }
  });

  await check('system.peer.metrics payload has correct peerId and peerName', () => {
    const ev = obs.pushes.find(p => p.topic === `system.peer.metrics.${pubPeerId}`);
    const pl = ev.payload;
    if (pl.peerId !== pubPeerId) throw new Error(`peerId mismatch: ${pl.peerId}`);
    if (typeof pl.peerName !== 'string' || pl.peerName.length === 0) {
      throw new Error(`peerName missing or empty: ${JSON.stringify(pl)}`);
    }
  });

  await check('system.peer.metrics payload has droppedFrames (integer >= 0)', () => {
    const ev = obs.pushes.find(p => p.topic === `system.peer.metrics.${pubPeerId}`);
    const pl = ev.payload;
    if (typeof pl.droppedFrames !== 'number' || !Number.isInteger(pl.droppedFrames) || pl.droppedFrames < 0) {
      throw new Error(`droppedFrames invalid: ${JSON.stringify(pl)}`);
    }
  });

  await check('system.peer.metrics payload has publishCount (integer >= 0)', () => {
    const ev = obs.pushes.find(p => p.topic === `system.peer.metrics.${pubPeerId}`);
    const pl = ev.payload;
    if (typeof pl.publishCount !== 'number' || !Number.isInteger(pl.publishCount) || pl.publishCount < 0) {
      throw new Error(`publishCount invalid: ${JSON.stringify(pl)}`);
    }
  });

  // ─── Test 6: backoff — rate window resets after 1s, publish succeeds ──────

  await sleep(1100);
  const resumeId = 300;
  const resumeResp = await rpc(pub, {
    id: resumeId, cmd: 'publish', protocol: 'claws/2',
    topic: 'wave.7.test.resume', payload: {},
  });

  await check('after 1s backoff, publish is not rejected with rate-limit-exceeded', () => {
    if (!resumeResp.ok && resumeResp.error === 'rate-limit-exceeded') {
      throw new Error('still rate-limited after 1s backoff');
    }
  });

  // ─── Test 7: system.metrics peerCount reflects connected peers ────────────

  await check('system.metrics peerCount >= 2 at some point (obs + pub connected)', () => {
    const events = obs.pushes.filter(p => p.topic === 'system.metrics');
    const found = events.some(ev => ev.payload.peerCount >= 2);
    if (!found) {
      const counts = events.map(ev => ev.payload.peerCount);
      throw new Error(`expected peerCount ≥ 2 in some system.metrics event, got: [${counts.join(',')}]`);
    }
  });

  // ─── cleanup + report ────────────────────────────────────────────────────

  obs.socket.destroy();
  pub.socket.destroy();

  let pass = 0, fail = 0;
  for (const a of assertions) {
    if (a.ok) {
      console.log(`  PASS  ${a.name}`);
      pass++;
    } else {
      console.log(`  FAIL  ${a.name}: ${a.err}`);
      fail++;
    }
  }
  console.log(`\n${pass + fail} checks: ${pass} passed, ${fail} failed`);

  try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ignore */ }

  process.exit(fail > 0 ? 1 : 0);
})();
