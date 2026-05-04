#!/usr/bin/env node
// REGRESSION GUARD: LH-9 bulletproof state management contract.
//
// LH-9 reorganized worker lifetime from "honor-system + Stop hook force-close"
// to "TTL watchdog inside the extension + reconcile-on-boot + single-writer
// lifecycle-state.json". This file locks the structural wiring so future
// edits cannot silently re-introduce the drift bugs.
//
// Layers covered:
//   1A  setTerminalCloseCallback funnels every close through markWorkerStatus
//   1B  close handler updates lifecycle BEFORE alreadyClosed early return
//   1C  LifecycleStore exposes reconcileWithLiveTerminals
//   1D  ClawsServer constructor calls reconcile after loadFromDisk
//   2A  SpawnedWorker carries idle_ms / max_ms / last_activity_at fields
//   2A  LifecycleStore exposes extendTtl + markActivity + findExpiredWorkers
//   2B  Server registers a 30s setInterval watchdog calling findExpiredWorkers
//   2B  Watchdog routes closes via terminalManager.close(id, reason)
//   2C  TerminalCloseOriginEnum includes 'idle_timeout' and 'ttl_max'
//   2D  CaptureStore.setOnAppend wired by ClawsServer to markActivity
//   3A  stop-claws.js no longer reads lifecycle-state nor sends 'close' frames
//   1A  TerminalManager exposes liveTerminalIds()
'use strict';

const fs   = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../src');
const HOOKS = path.resolve(__dirname, '../../scripts/hooks');

const SCHEMAS = fs.readFileSync(path.join(SRC, 'event-schemas.ts'), 'utf8');
const STORE   = fs.readFileSync(path.join(SRC, 'lifecycle-store.ts'), 'utf8');
const SERVER  = fs.readFileSync(path.join(SRC, 'server.ts'), 'utf8');
const TM      = fs.readFileSync(path.join(SRC, 'terminal-manager.ts'), 'utf8');
const CAPTURE = fs.readFileSync(path.join(SRC, 'capture-store.ts'), 'utf8');
const STOP    = fs.readFileSync(path.join(HOOKS, 'stop-claws.js'), 'utf8');

let passed = 0;
let failed = 0;
const results = [];
function check(label, condition, hint) {
  if (condition) { results.push(`  PASS  ${label}`); passed++; }
  else { results.push(`  FAIL  ${label}${hint ? '\n        hint: ' + hint : ''}`); failed++; }
}

// ─── Layer 2C: enum has idle_timeout + ttl_max ────────────────────────────────
check(
  "event-schemas.ts: TerminalCloseOriginEnum includes 'idle_timeout'",
  /TerminalCloseOriginEnum[\s\S]{0,500}'idle_timeout'/.test(SCHEMAS),
  "Add 'idle_timeout' to z.enum([...]) in TerminalCloseOriginEnum",
);
check(
  "event-schemas.ts: TerminalCloseOriginEnum includes 'ttl_max'",
  /TerminalCloseOriginEnum[\s\S]{0,500}'ttl_max'/.test(SCHEMAS),
  "Add 'ttl_max' to z.enum([...]) in TerminalCloseOriginEnum",
);

// ─── Layer 2A: SpawnedWorker has TTL fields ───────────────────────────────────
check(
  'lifecycle-store.ts: SpawnedWorker has idle_ms field',
  /SpawnedWorker[\s\S]{0,800}idle_ms\?:\s*number/.test(STORE),
  'Add idle_ms?: number to SpawnedWorker interface',
);
check(
  'lifecycle-store.ts: SpawnedWorker has max_ms field',
  /SpawnedWorker[\s\S]{0,800}max_ms\?:\s*number/.test(STORE),
  'Add max_ms?: number to SpawnedWorker interface',
);
check(
  'lifecycle-store.ts: SpawnedWorker has last_activity_at field',
  /SpawnedWorker[\s\S]{0,1500}last_activity_at\?:\s*string/.test(STORE),
  'Add last_activity_at?: string to SpawnedWorker interface',
);

// ─── Layer 2A: TTL defaults exported with rationale ───────────────────────────
check(
  'lifecycle-store.ts: DEFAULT_IDLE_MS exported',
  /export\s+const\s+DEFAULT_IDLE_MS\s*=\s*600_000/.test(STORE),
  'Export DEFAULT_IDLE_MS = 600_000 (10min idle window)',
);
check(
  'lifecycle-store.ts: DEFAULT_MAX_MS exported',
  /export\s+const\s+DEFAULT_MAX_MS\s*=\s*14_400_000/.test(STORE),
  'Export DEFAULT_MAX_MS = 14_400_000 (4h hard ceiling)',
);

// ─── Layer 2A: store methods present ─────────────────────────────────────────
check(
  'lifecycle-store.ts: registerSpawn accepts opts {idle_ms, max_ms}',
  /registerSpawn\s*\([\s\S]{0,400}opts\?:\s*\{\s*idle_ms\?:\s*number;\s*max_ms\?:\s*number/.test(STORE),
  'registerSpawn signature must accept opts?: {idle_ms?, max_ms?}',
);
check(
  'lifecycle-store.ts: registerSpawn seeds last_activity_at = spawned_at',
  /registerSpawn\s*\(\s*terminalId[\s\S]{0,2000}last_activity_at:\s*spawnedAt/.test(STORE),
  'registerSpawn must seed last_activity_at to the just-set spawned_at',
);
check(
  'lifecycle-store.ts: markActivity method defined',
  /markActivity\s*\(\s*terminalId:\s*string/.test(STORE),
  'Add public markActivity(terminalId, atIso?) method',
);
check(
  'lifecycle-store.ts: markActivity throttles disk flush at >=5s gap',
  /markActivity[\s\S]{0,1500}>=\s*5000[\s\S]{0,200}flushToDisk/.test(STORE),
  'markActivity must self-throttle disk flushes (5s gap minimum)',
);
check(
  'lifecycle-store.ts: extendTtl method defined',
  /extendTtl\s*\(\s*terminalId:\s*string,\s*addMs:\s*number/.test(STORE),
  'Add public extendTtl(terminalId, addMs) method',
);
check(
  'lifecycle-store.ts: extendTtl returns null when worker non-spawned (race guard)',
  /extendTtl[\s\S]{0,500}status\s*!==\s*'spawned'\)\s*return\s*null/.test(STORE),
  'extendTtl must reject if status !== spawned (lost race with watchdog)',
);
check(
  'lifecycle-store.ts: reconcileWithLiveTerminals method defined',
  /reconcileWithLiveTerminals\s*\(\s*liveIds:\s*ReadonlySet<string>\s*\)/.test(STORE),
  'Add public reconcileWithLiveTerminals(liveIds) method',
);
check(
  'lifecycle-store.ts: reconcile only mutates spawned-status workers',
  /reconcileWithLiveTerminals[\s\S]{0,1000}status\s*!==\s*'spawned'\s*\|\|\s*liveIds\.has/.test(STORE),
  'reconcile must skip workers already in non-spawned status',
);
check(
  'lifecycle-store.ts: findExpiredWorkers method defined',
  /findExpiredWorkers\s*\(\s*nowMs[\s\S]{0,200}=\s*Date\.now\(\)/.test(STORE),
  'Add public findExpiredWorkers(nowMs?) method with Date.now() default',
);
check(
  'lifecycle-store.ts: findExpiredWorkers checks max_ms before idle_ms',
  /findExpiredWorkers[\s\S]{0,1500}ttl_max[\s\S]{0,500}idle_timeout/.test(STORE),
  'findExpiredWorkers must check ttl_max first (prevents double-emit when both expired)',
);

// ─── Layer 1A: terminal-manager exposes liveTerminalIds ───────────────────────
check(
  'terminal-manager.ts: liveTerminalIds() method defined',
  /liveTerminalIds\(\)\s*:\s*Set<string>/.test(TM),
  'Add public liveTerminalIds(): Set<string> to TerminalManager',
);

// ─── Layer 2D: capture-store activity sink ────────────────────────────────────
check(
  'capture-store.ts: setOnAppend hook exposed',
  /setOnAppend\s*\(\s*cb:\s*CaptureAppendCallback\s*\|\s*null\s*\):\s*void/.test(CAPTURE),
  'Add public setOnAppend(cb) method to CaptureStore',
);
check(
  'capture-store.ts: append() invokes onAppend before mutation, errors swallowed',
  /append\s*\([\s\S]{0,500}onAppend\?\.\([\s\S]{0,200}catch\s*\{[^}]*sink errors must not break capture/.test(CAPTURE),
  'append() must invoke onAppend inside try/catch BEFORE buffer mutation',
);

// ─── Layer 1A: server close-callback updates lifecycle ────────────────────────
check(
  'server.ts: setTerminalCloseCallback wires markWorkerStatus',
  /setTerminalCloseCallback\(\([^)]+\)\s*=>\s*\{[\s\S]{0,1200}lifecycleStore\.markWorkerStatus\(String\(id\),\s*'closed'\)/.test(SERVER),
  "setTerminalCloseCallback handler must call lifecycleStore.markWorkerStatus(id, 'closed')",
);

// ─── Layer 1B: close handler order — markWorkerStatus BEFORE tm.close ─────────
{
  const closeHandler = SERVER.match(/cmd === 'close'[\s\S]{0,2000}/);
  const ok = !!closeHandler && /markWorkerStatus\(idStr,\s*'closed'\)[\s\S]{0,400}tm\.close\(r\.id/.test(closeHandler[0]);
  check(
    'server.ts: close handler runs markWorkerStatus BEFORE tm.close (LH-9 1B)',
    ok,
    'Move markWorkerStatus call above the alreadyClosed early-return so stale state heals',
  );
}

// ─── Layer 1B: close handler accepts new origins ─────────────────────────────
check(
  "server.ts: close-origin allowlist includes 'idle_timeout' and 'ttl_max'",
  /closeOrigin\s*=\s*\(\[[^\]]*'idle_timeout'[^\]]*'ttl_max'[^\]]*\]/.test(SERVER),
  "Add 'idle_timeout' and 'ttl_max' to the close_origin allowlist tuple in close handler",
);

// ─── Layer 1D: server constructor calls reconcile ─────────────────────────────
check(
  'server.ts: constructor calls reconcileWithLiveTerminals on boot',
  /lifecycleStore\.reconcileWithLiveTerminals\(\s*liveIds\s*\)/.test(SERVER) ||
  /reconcileWithLiveTerminals\(opts\.terminalManager\.liveTerminalIds\(\)\)/.test(SERVER),
  'Constructor must call this.lifecycleStore.reconcileWithLiveTerminals(opts.terminalManager.liveTerminalIds())',
);

// ─── Layer 2D: server wires CaptureStore activity sink ────────────────────────
check(
  'server.ts: constructor wires captureStore.setOnAppend → markActivity',
  /captureStore\.setOnAppend\([\s\S]{0,200}lifecycleStore\.markActivity/.test(SERVER),
  'opts.captureStore.setOnAppend((id) => lifecycleStore.markActivity(String(id)))',
);
check(
  'server.ts: stop() detaches captureStore activity sink',
  /stop\(\)\s*:\s*void\s*\{[\s\S]{0,800}captureStore\.setOnAppend\(null\)/.test(SERVER),
  'stop() must call this.opts.captureStore.setOnAppend(null) to drop the reference',
);

// ─── Layer 2B: server has TTL watchdog interval ──────────────────────────────
check(
  'server.ts: ttlWatchdogTimer field declared',
  /ttlWatchdogTimer:\s*NodeJS\.Timeout\s*\|\s*null\s*=\s*null/.test(SERVER),
  'Add private ttlWatchdogTimer field to ClawsServer',
);
check(
  'server.ts: TTL watchdog scan interval is 30_000ms',
  /TTL_SCAN_INTERVAL_MS\s*=\s*30_000/.test(SERVER),
  'Use TTL_SCAN_INTERVAL_MS = 30_000 (30s) for the watchdog interval',
);
check(
  'server.ts: watchdog calls findExpiredWorkers and tm.close per entry',
  /findExpiredWorkers[\s\S]{0,800}terminalManager\.close\(\s*id,\s*reason/.test(SERVER),
  'Watchdog must iterate findExpiredWorkers() output and call terminalManager.close(id, reason)',
);
check(
  'server.ts: stop() clears ttlWatchdogTimer',
  /stop\(\)\s*:\s*void\s*\{[\s\S]{0,800}clearInterval\(this\.ttlWatchdogTimer\)/.test(SERVER),
  'stop() must clearInterval(ttlWatchdogTimer) and null the field',
);

// ─── Layer 3A: stop-claws.js no longer force-closes ──────────────────────────
check(
  'stop-claws.js: lifecycle-state require removed',
  !/require\(['"]\.\/lifecycle-state['"]\)/.test(STOP),
  "Remove `require('./lifecycle-state').readState` — Stop hook no longer reads state",
);
check(
  'stop-claws.js: no socket connectIONs writing close frames',
  !/JSON\.stringify\(\s*\{\s*cmd:\s*['"]close['"]/.test(STOP),
  "Remove the net.createConnection + cmd:'close' force-close block — TTL watchdog handles cleanup",
);
check(
  'stop-claws.js: still kills auto-sidecar (preserved)',
  /pgrep[\s\S]{0,200}stream-events[\s\S]{0,40}auto-sidecar/.test(STOP),
  'sidecar SIGTERM cleanup must remain — only the force-close logic was removed',
);
check(
  'stop-claws.js: still removes pre-tool-use grace file (preserved)',
  /claws-pretooluse-grace-/.test(STOP),
  'grace file unlink must remain — only the force-close logic was removed',
);

// ─── LH-10: Monitor closure parity contract checks ────────────────────────────

// LH-10 Layer A: correlation_id flows into system.terminal.closed payload
check(
  'server.ts: setTerminalCloseCallback includes correlation_id in payload via lifecycleStore.snapshot lookup',
  /setTerminalCloseCallback[\s\S]{0,600}lifecycleStore\.snapshot\(\)[\s\S]{0,300}spawned_workers[\s\S]{0,200}\.correlation_id/.test(SERVER),
  'setTerminalCloseCallback must look up correlation_id from lifecycleStore.snapshot().spawned_workers and include it in system.terminal.closed payload',
);

// LH-10 Layer B: removeMonitorByTerminalId called after markWorkerStatus in close callback
check(
  'server.ts: setTerminalCloseCallback calls removeMonitorByTerminalId after markWorkerStatus',
  /setTerminalCloseCallback[\s\S]{0,2500}markWorkerStatus\(String\(id\),\s*'closed'\)[\s\S]{0,400}removeMonitorByTerminalId\(String\(id\)\)/.test(SERVER),
  "setTerminalCloseCallback must call removeMonitorByTerminalId(String(id)) after markWorkerStatus to heal monitor metadata on every close",
);

// LH-10 Layer B: removeMonitorByTerminalId method exists in lifecycle-store
check(
  'lifecycle-store.ts: removeMonitorByTerminalId method defined',
  /removeMonitorByTerminalId\s*\(\s*terminalId:\s*string\s*\):\s*boolean/.test(STORE),
  'Add public removeMonitorByTerminalId(terminalId: string): boolean to LifecycleStore',
);

// LH-10 Layer B: reconcileWithLiveTerminals return type upgraded to {workersClosed, monitorsDropped}
check(
  'lifecycle-store.ts: reconcileWithLiveTerminals returns {workersClosed, monitorsDropped} shape',
  /reconcileWithLiveTerminals[\s\S]{0,300}:\s*\{\s*workersClosed:\s*string\[\];\s*monitorsDropped:\s*string\[\]/.test(STORE),
  'reconcileWithLiveTerminals return type must be { workersClosed: string[]; monitorsDropped: string[] }',
);

// LH-10 Layer B: reconcileWithLiveTerminals touches monitors[] array
check(
  'lifecycle-store.ts: reconcileWithLiveTerminals also touches monitors[] array',
  /reconcileWithLiveTerminals[\s\S]{0,3000}monitors:\s*newMonitors/.test(STORE),
  'reconcileWithLiveTerminals must assign newMonitors into state (drop orphan monitor records)',
);

// LH-10: no schema change — TerminalClosedV1.correlation_id was already optional
check(
  'event-schemas.ts: TerminalClosedV1.correlation_id already z.string().optional() (no schema change)',
  /TerminalClosedV1[\s\S]{0,400}correlation_id:\s*z\.string\(\)\.optional\(\)/.test(SCHEMAS),
  'TerminalClosedV1 must already have correlation_id: z.string().optional() — no schema change needed for LH-10',
);

// ─── Print results ─────────────────────────────────────────────────────────────
const total = passed + failed;
results.forEach(r => console.log(r));
console.log('');
console.log(`lh9-state-bulletproof.test.js: ${passed}/${total} PASS`);

if (failed > 0) process.exit(1);
