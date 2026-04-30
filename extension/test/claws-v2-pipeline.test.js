#!/usr/bin/env node
// L11 Pipeline Composition — integration tests.
// Verifies pipeline.create/list/close commands, source→sink output wiring,
// pipeline step events, and pipeline.*.closed bus event.
//
// Run: node extension/test/claws-v2-pipeline.test.js
// Exits 0 on success, 1 on failure.

const assert = require('assert');
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

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claws-v2-pipeline-'));
const logs = [];

// ─── Capture sendText calls per terminal ─────────────────────────────────────
const terminalSentText = new Map(); // terminalRef → string[]

// ─── vscode mock ─────────────────────────────────────────────────────────────

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => { const i = this.listeners.indexOf(listener); if (i >= 0) this.listeners.splice(i, 1); } };
    };
  }
  fire(arg) { for (const l of this.listeners.slice()) l(arg); }
  dispose() { this.listeners = []; }
}

class TerminalProfile { constructor(options) { this.options = options; } }
class MarkdownString {
  constructor() { this.value = ''; this.isTrusted = false; }
  appendMarkdown(s) { this.value += s; return this; }
}
class ThemeColor { constructor(id) { this.id = id; } }

const onOpen = new EventEmitter();
const onClose = new EventEmitter();

const vscode = {
  EventEmitter, TerminalProfile, MarkdownString, ThemeColor,
  StatusBarAlignment: { Left: 1, Right: 2 },
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file', path: p }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
    getConfiguration: (_s) => ({ get: (_k, fb) => fb }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
  },
  window: {
    terminals: [],
    activeTerminal: undefined,
    createOutputChannel: () => ({ appendLine: (m) => logs.push(m), show: () => {}, dispose: () => {} }),
    createStatusBarItem: () => ({
      text: '', tooltip: '', color: undefined, command: '', name: '',
      show: () => {}, hide: () => {}, dispose: () => {},
    }),
    createTerminal: (opts) => {
      const sent = [];
      const t = {
        name: (opts && opts.name) || 'mock',
        processId: Promise.resolve(12345),
        shellIntegration: undefined,
        show: () => {},
        sendText: (text) => { sent.push(text); },
        dispose: () => { onClose.fire(t); },
        _sent: sent,
      };
      terminalSentText.set(t, sent);
      vscode.window.terminals.push(t);
      // Simulate VS Code calling Pseudoterminal.open() for wrapped terminals.
      if (opts && opts.pty && typeof opts.pty.open === 'function') {
        setTimeout(() => opts.pty.open({ columns: 80, rows: 24 }), 20);
      }
      return t;
    },
    onDidOpenTerminal: onOpen.event,
    onDidCloseTerminal: onClose.event,
    registerTerminalProfileProvider: () => ({ dispose: () => {} }),
    activeColorTheme: { kind: 2 },
    showErrorMessage: () => ({ then: () => {} }),
    showInformationMessage: () => ({ then: () => {} }),
    showWarningMessage: () => ({ then: () => {} }),
    showQuickPick: () => Promise.resolve(undefined),
  },
  commands: {
    registerCommand: () => ({ dispose: () => {} }),
    executeCommand: () => Promise.resolve(),
  },
  extensions: { getExtension: () => undefined },
};

Module._resolveFilename = ((orig) => (req, parent, isMain, opts) => {
  if (req === 'vscode') return '__vscode__';
  return orig(req, parent, isMain, opts);
})(Module._resolveFilename);
Module._cache['__vscode__'] = { id: '__vscode__', filename: '__vscode__', loaded: true, exports: vscode };

const ext = require(BUNDLE);
ext.activate({ subscriptions: [], extensionPath: EXT_ROOT, extension: { packageJSON: { version: '0.7.5' } } });

const sockPath = path.join(workspaceRoot, '.claws', 'claws.sock');

// ─── helpers ─────────────────────────────────────────────────────────────────

async function waitFor(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
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
        const msg = JSON.parse(line);
        if (msg.rid !== undefined) {
          responses.set(msg.rid, msg);
        } else if (msg.push) {
          pushes.push(msg);
        }
      } catch { /* ignore */ }
    }
  });
  let seq = 1;
  const send = (msg) => new Promise((resolve, reject) => {
    const id = seq++;
    msg.id = id;
    responses.set(id, null);
    s.write(JSON.stringify(msg) + '\n');
    const start = Date.now();
    const poll = setInterval(() => {
      const r = responses.get(id);
      if (r !== null) { clearInterval(poll); resolve(r); }
      if (Date.now() - start > 5000) { clearInterval(poll); reject(new Error(`timeout on cmd: ${msg.cmd}`)); }
    }, 10);
  });
  return { s, send, pushes };
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message || String(e) });
    console.log(`  FAIL  ${name}: ${e.message || e}`);
  }
}

// ─── tests ───────────────────────────────────────────────────────────────────

(async () => {
  const ready = await waitFor(() => fs.existsSync(sockPath), 4000);
  await check('socket is ready', () => {
    if (!ready) throw new Error('socket never appeared');
  });
  if (!ready) { console.error('FAIL: no socket'); process.exit(1); }

  // Lifecycle plan required by the create gate
  await check('lifecycle.plan accepted', async () => {
    const c = connect();
    await waitFor(() => c.s.writable, 1000);
    const r = await c.send({ cmd: 'lifecycle.plan', plan: 'Wave 9 L11 pipeline composition test' });
    c.s.destroy();
    assert.strictEqual(r.ok, true, `lifecycle.plan failed: ${JSON.stringify(r)}`);
  });

  // ── Suite 1: pipeline.create / list / close ────────────────────────────────
  console.log('\n[Suite 1] pipeline create / list / close');
  {
    const orch = connect();
    await waitFor(() => orch.s.writable, 1000);
    const hO = await orch.send({ cmd: 'hello', protocol: 'claws/2', role: 'orchestrator', peerName: 'orch1' });
    check('orchestrator hello ok', async () => assert.strictEqual(hO.ok, true, JSON.stringify(hO)));

    // Create two terminals
    const cr1 = await orch.send({ cmd: 'create', name: 'pipe-source', wrapped: true });
    await check('create source terminal ok', async () => assert.strictEqual(cr1.ok, true, JSON.stringify(cr1)));
    const t1 = String(cr1.id);

    const cr2 = await orch.send({ cmd: 'create', name: 'pipe-sink', wrapped: true });
    await check('create sink terminal ok', async () => assert.strictEqual(cr2.ok, true, JSON.stringify(cr2)));
    const t2 = String(cr2.id);

    // Subscribe to pipeline events
    const subPipeline = await orch.send({ cmd: 'subscribe', protocol: 'claws/2', topic: 'pipeline.**' });
    await check('subscribe pipeline.** accepted', async () => {
      assert.strictEqual(subPipeline.ok, true, JSON.stringify(subPipeline));
      assert.match(subPipeline.subscriptionId, /^s_/, 'subscriptionId should start with s_');
    });

    // pipeline.create
    const pipeResp = await orch.send({
      cmd: 'pipeline.create',
      name: 'test-pipeline',
      steps: [
        { role: 'source', terminalId: t1 },
        { role: 'sink', terminalId: t2 },
      ],
    });
    await check('pipeline.create returns ok', async () => assert.strictEqual(pipeResp.ok, true, JSON.stringify(pipeResp)));
    await check('pipeline.create returns pipelineId', async () => {
      assert.ok(pipeResp.pipelineId, 'expected pipelineId');
      assert.match(String(pipeResp.pipelineId), /^pipe_/, 'pipelineId should start with pipe_');
    });

    const pipelineId = pipeResp.pipelineId;

    // pipeline.*.created event should be emitted
    await check('pipeline.*.created event emitted', async () => {
      const ok = await waitFor(
        () => orch.pushes.some((p) => p.topic === `pipeline.${pipelineId}.created`),
        2000,
      );
      assert.ok(ok, `pipeline.${pipelineId}.created event not received. pushes: ${JSON.stringify(orch.pushes.map(p => p.topic))}`);
    });

    // pipeline.list
    const listResp = await orch.send({ cmd: 'pipeline.list' });
    await check('pipeline.list returns ok', async () => assert.strictEqual(listResp.ok, true, JSON.stringify(listResp)));
    await check('pipeline.list includes created pipeline', async () => {
      assert.ok(Array.isArray(listResp.pipelines), 'expected pipelines array');
      const found = listResp.pipelines.find((p) => p.pipelineId === pipelineId);
      assert.ok(found, `pipeline ${pipelineId} not found in list: ${JSON.stringify(listResp.pipelines)}`);
    });
    await check('pipeline.list shows active state', async () => {
      const found = listResp.pipelines.find((p) => p.pipelineId === pipelineId);
      assert.strictEqual(found.state, 'active', `expected active, got: ${found.state}`);
    });
    await check('pipeline steps include source and sink', async () => {
      const found = listResp.pipelines.find((p) => p.pipelineId === pipelineId);
      assert.ok(Array.isArray(found.steps), 'expected steps array');
      const sourceStep = found.steps.find((s) => s.role === 'source');
      const sinkStep = found.steps.find((s) => s.role === 'sink');
      assert.ok(sourceStep, 'source step not found');
      assert.ok(sinkStep, 'sink step not found');
      assert.strictEqual(String(sourceStep.terminalId), t1);
      assert.strictEqual(String(sinkStep.terminalId), t2);
    });

    // pipeline.close
    const closeResp = await orch.send({ cmd: 'pipeline.close', pipelineId });
    await check('pipeline.close returns ok', async () => assert.strictEqual(closeResp.ok, true, JSON.stringify(closeResp)));

    // pipeline.*.closed event emitted
    await check('pipeline.*.closed event emitted on close', async () => {
      const ok = await waitFor(
        () => orch.pushes.some((p) => p.topic === `pipeline.${pipelineId}.closed`),
        2000,
      );
      assert.ok(ok, `pipeline.${pipelineId}.closed event not received. pushes: ${JSON.stringify(orch.pushes.map(p => p.topic))}`);
    });

    // After close, pipeline.list shows closed state
    const listResp2 = await orch.send({ cmd: 'pipeline.list' });
    await check('pipeline.list shows closed state after close', async () => {
      const found = listResp2.pipelines.find((p) => p.pipelineId === pipelineId);
      assert.ok(found, `pipeline ${pipelineId} not in list after close`);
      assert.strictEqual(found.state, 'closed', `expected closed, got: ${found.state}`);
    });

    orch.s.destroy();
  }

  // ── Suite 2: output.* → sink send wiring ──────────────────────────────────
  console.log('\n[Suite 2] output.* → sink send pipeline wiring');
  {
    const orch2 = connect();
    await waitFor(() => orch2.s.writable, 1000);
    const hO2 = await orch2.send({ cmd: 'hello', protocol: 'claws/2', role: 'orchestrator', peerName: 'orch2', capabilities: ['publish'] });
    await check('orch2 hello ok', async () => assert.strictEqual(hO2.ok, true, JSON.stringify(hO2)));

    const crA = await orch2.send({ cmd: 'create', name: 'wire-source', wrapped: false });
    await check('create wire-source terminal ok', async () => assert.strictEqual(crA.ok, true, JSON.stringify(crA)));
    const tA = String(crA.id);

    const crB = await orch2.send({ cmd: 'create', name: 'wire-sink', wrapped: false });
    await check('create wire-sink terminal ok', async () => assert.strictEqual(crB.ok, true, JSON.stringify(crB)));
    const tB = String(crB.id);

    // Subscribe to pipeline step events
    const subSteps = await orch2.send({ cmd: 'subscribe', protocol: 'claws/2', topic: 'pipeline.**' });
    await check('subscribe pipeline.** for wiring test', async () => assert.strictEqual(subSteps.ok, true, JSON.stringify(subSteps)));

    // Create pipeline
    const pipeResp2 = await orch2.send({
      cmd: 'pipeline.create',
      name: 'wiring-pipeline',
      steps: [
        { role: 'source', terminalId: tA },
        { role: 'sink', terminalId: tB },
      ],
    });
    await check('pipeline created for wiring test', async () => assert.strictEqual(pipeResp2.ok, true, JSON.stringify(pipeResp2)));
    const pipelineId2 = pipeResp2.pipelineId;

    // Find the source step id for later verification
    const sourceStep = pipeResp2.pipeline.steps.find((s) => s.role === 'source');
    await check('pipeline response includes steps', async () => assert.ok(sourceStep, 'source step missing'));

    // Publish output.tA.line event to simulate pty output from terminal A
    const testText = `pipeline-test-${Date.now()}`;
    const pubResp = await orch2.send({
      cmd: 'publish',
      protocol: 'claws/2',
      topic: `output.${tA}.line`,
      payload: { text: testText, terminalId: tA },
    });
    await check('publish output.tA.line accepted', async () => assert.strictEqual(pubResp.ok, true, JSON.stringify(pubResp)));

    // Verify pipeline step event fired
    await check('pipeline step event emitted after output publish', async () => {
      const ok = await waitFor(
        () => orch2.pushes.some((p) => p.topic && p.topic.startsWith(`pipeline.${pipelineId2}.step.`)),
        2000,
      );
      assert.ok(ok, `no pipeline.${pipelineId2}.step.* event received. pushes: ${JSON.stringify(orch2.pushes.map(p => p.topic))}`);
    });

    // Verify the step event payload is correct
    await check('pipeline step event has correct pipelineId', async () => {
      const stepEvent = orch2.pushes.find((p) => p.topic && p.topic.startsWith(`pipeline.${pipelineId2}.step.`));
      assert.ok(stepEvent, 'step event not found');
      assert.strictEqual(stepEvent.payload.pipelineId, pipelineId2);
      assert.strictEqual(stepEvent.payload.role, 'source');
      assert.strictEqual(String(stepEvent.payload.terminalId), tA);
    });

    // Verify sink terminal received the text (sendText was called with testText)
    await check('sink terminal received forwarded text from pipeline', async () => {
      // The sink is an unwrapped terminal; its sendText mock is in the vscode mock above.
      // We need to find the terminal object for tB and check its _sent array.
      // Wait briefly for async sendText to complete
      await new Promise((r) => setTimeout(r, 100));
      const sinkTerminalObj = vscode.window.terminals.find((t) => t.name === 'wire-sink');
      assert.ok(sinkTerminalObj, 'sink terminal not found in vscode.window.terminals');
      const sent = sinkTerminalObj._sent || [];
      assert.ok(
        sent.includes(testText),
        `sink terminal did not receive "${testText}". Received: ${JSON.stringify(sent)}`,
      );
    });

    orch2.s.destroy();
  }

  // ── Suite 3: pipeline error cases ─────────────────────────────────────────
  console.log('\n[Suite 3] pipeline error cases');
  {
    const orch3 = connect();
    await waitFor(() => orch3.s.writable, 1000);
    const hO3 = await orch3.send({ cmd: 'hello', protocol: 'claws/2', role: 'orchestrator', peerName: 'orch3' });
    await check('orch3 hello ok', async () => assert.strictEqual(hO3.ok, true, JSON.stringify(hO3)));

    // Missing steps
    const noSteps = await orch3.send({ cmd: 'pipeline.create', name: 'bad', steps: [] });
    await check('pipeline.create with empty steps returns error', async () => {
      assert.strictEqual(noSteps.ok, false, `expected error, got: ${JSON.stringify(noSteps)}`);
    });

    // Missing source step
    const noSource = await orch3.send({
      cmd: 'pipeline.create',
      name: 'no-source',
      steps: [{ role: 'sink', terminalId: '99' }],
    });
    await check('pipeline.create without source step returns error', async () => {
      assert.strictEqual(noSource.ok, false, `expected error, got: ${JSON.stringify(noSource)}`);
    });

    // pipeline.close with unknown id
    const closeUnknown = await orch3.send({ cmd: 'pipeline.close', pipelineId: 'pipe_9999' });
    await check('pipeline.close with unknown id returns error', async () => {
      assert.strictEqual(closeUnknown.ok, false, `expected error, got: ${JSON.stringify(closeUnknown)}`);
    });

    orch3.s.destroy();
  }

  // ── Suite 4: pipeline topic subscriptions registered ──────────────────────
  console.log('\n[Suite 4] pipeline topic subscriptions registered');
  {
    const obs = connect();
    await waitFor(() => obs.s.writable, 1000);
    const hObs = await obs.send({ cmd: 'hello', protocol: 'claws/2', role: 'observer', peerName: 'obs4' });
    await check('observer hello ok', async () => assert.strictEqual(hObs.ok, true, JSON.stringify(hObs)));

    const sub1 = await obs.send({ cmd: 'subscribe', protocol: 'claws/2', topic: 'pipeline.*.created' });
    await check('pipeline.*.created subscription accepted', async () => {
      assert.strictEqual(sub1.ok, true, JSON.stringify(sub1));
      assert.ok(sub1.subscriptionId);
    });

    const sub2 = await obs.send({ cmd: 'subscribe', protocol: 'claws/2', topic: 'pipeline.*.closed' });
    await check('pipeline.*.closed subscription accepted', async () => {
      assert.strictEqual(sub2.ok, true, JSON.stringify(sub2));
      assert.ok(sub2.subscriptionId);
    });

    const sub3 = await obs.send({ cmd: 'subscribe', protocol: 'claws/2', topic: 'pipeline.*.step.*' });
    await check('pipeline.*.step.* subscription accepted', async () => {
      assert.strictEqual(sub3.ok, true, JSON.stringify(sub3));
      assert.ok(sub3.subscriptionId);
    });

    obs.s.destroy();
  }

  // ─── results ─────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log('');
  console.log(`[claws-v2-pipeline] ${passed} passed, ${failed} failed (${results.length} total)`);
  if (failed > 0) {
    console.log('\nFailed assertions:');
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  - ${r.name}: ${r.err}`);
    }
    process.exit(1);
  }
  ext.deactivate?.();
  process.exit(0);
})();
