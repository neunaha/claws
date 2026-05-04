// gen-mcp-tools.mjs — Generate schemas/mcp-tools.json from Zod input schemas.
// Called by index.mjs. Default export is the generator function.
// Descriptions are preserved verbatim from the hand-written mcp_server.js array.

import { writeFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

// ── Tool descriptions (verbatim from mcp_server.js) ──────────────────────────
const DESC = {
  claws_list:
    "List all open VS Code terminals with their ID, name, PID, shell integration status, active state, and pty log path (null if not wrapped). Use this to discover what's running before sending commands.",
  claws_create:
    "Create a new VS Code terminal. Set wrapped=true to enable full pty logging — this lets you read everything that happens in the terminal including TUI sessions (Claude Code, vim, htop, REPLs). The terminal appears visibly in VS Code's panel.",
  claws_send:
    'Send text into a terminal. The text arrives at whatever input is active — shell prompt, TUI input field, REPL prompt. Multi-line text is auto-wrapped in bracketed paste mode. Set newline=false to send raw keystrokes without Enter.',
  claws_exec:
    'Execute a shell command in a terminal and capture the output (stdout + stderr + exit code). Uses file-based capture — works in any terminal type. Waits for the command to finish.',
  claws_read_log:
    "Read a wrapped terminal's pty log with ANSI escapes stripped. Returns clean, readable text of everything that happened — including TUI sessions, build output, AI coding assistant transcripts. Only works for terminals created with wrapped=true.",
  claws_poll:
    'Stream shell-integration command-completion events across all terminals. Pass since=cursor to get only new events. Note: unreliable in wrapped terminals — use claws_read_log instead.',
  claws_close:
    'Close and dispose a terminal. Always close terminals you created when the work is done.',
  claws_worker:
    'Run a complete worker lifecycle in one blocking call: creates a wrapped terminal, optionally launches Claude Code with --dangerously-skip-permissions, sends the mission prompt, polls the capture buffer for a completion marker (default MISSION_COMPLETE) or error markers, harvests the final output, and auto-closes. Returns a structured result. Set detach=true for the legacy fire-and-forget behavior.',
  claws_hello:
    'Register this Claude session with the Claws server as an orchestrator or worker peer. Must be called before subscribe, publish, or task commands. Returns a peerId for this session.',
  claws_subscribe:
    "Subscribe to a topic pattern on the Claws message bus. Patterns support wildcards: '*' matches one segment, '**' matches many. Examples: 'task.status', 'worker.*', 'task.**'. Returns a subscriptionId.",
  claws_publish:
    'Publish a payload to a topic on the Claws message bus. All peers subscribed to a matching pattern will receive a push frame.',
  claws_broadcast:
    "Orchestrator-only: send a text message to all workers (or all peers). Optionally inject the text directly into each worker's terminal via bracketed paste. Useful as a kill-switch or coordination signal.",
  claws_ping:
    "Check that the Claws server is reachable. Returns the server's current timestamp. Useful as a heartbeat.",
  claws_peers:
    'List all currently registered peers on the Claws server (claws/2 connections that have called hello). Returns role, peerName, terminalId, and lastSeen for each peer.',
  claws_lifecycle_plan:
    'Log the PLAN phase — required before any claws_create call. The server-side lifecycle gate blocks terminal creation until this succeeds. Provide a 1–3 sentence summary of what you are about to do. Idempotent: safe to call twice.',
  claws_lifecycle_advance:
    'Advance the server-side lifecycle state machine to the next phase. Legal transitions per event-protocol.md §4: PLAN→SPAWN, SPAWN→DEPLOY|RECOVER|FAILED, DEPLOY→OBSERVE|RECOVER|FAILED, OBSERVE→HARVEST|RECOVER|FAILED, RECOVER→DEPLOY|OBSERVE|FAILED, HARVEST→CLEANUP|FAILED, CLEANUP→REFLECT|FAILED. Idempotent: advancing to the current phase is a no-op.',
  claws_lifecycle_snapshot:
    'Read the current server-side lifecycle state without changing it. Returns null when no PLAN has been logged yet. Use this to check what phase you are in before sending lifecycle commands.',
  claws_lifecycle_reflect:
    'Terminal lifecycle transition: advance to REFLECT and persist your retrospective text. Call this after CLEANUP when all workers are closed and you have assessed the session. The REFLECT phase is terminal — no further transitions are allowed.',
  claws_wave_create:
    "Register a new wave on the server, initialising heartbeat tracking for each expected sub-worker role. Call this as LEAD immediately after hello. waveId should be a stable human-readable slug (e.g. 'embedder-v1'). The server fires a 25s violation timer per sub-worker that resets on each heartbeat.",
  claws_wave_status:
    'Fetch a live snapshot of the wave: sub-worker heartbeat timestamps, completion flags, and wave-level complete/summary fields. Use this to monitor progress or diagnose silent sub-workers.',
  claws_wave_complete:
    'Mark the wave as complete on the server. Clears all sub-worker violation timers. Call this after every sub-worker has published its complete event and the LEAD has committed, built, and run the full test suite. Only the peer that created the wave (LEAD) may call this.',
  claws_deliver_cmd:
    "Deliver a typed command envelope to a specific worker peer over the pub/sub bus. The server validates the payload against the declared schema, allocates a monotonic sequence number, and pushes the command to the worker's auto-subscription. Use idempotencyKey (a UUID) to make retries safe — duplicate keys return {ok:true, duplicate:true} without re-delivering.",
  claws_cmd_ack:
    'Acknowledge receipt and execution of a delivered command (worker-only). The server fans out a cmd.<workerPeerId>.ack event to all orchestrator subscribers. status must be one of: executed, rejected, duplicate.',
  claws_schema_list:
    'Return a sorted list of all Zod schema names registered in the Claws schema registry. Use this to discover which schemas are available before calling claws_schema_get.',
  claws_schema_get:
    "Return a simplified JSON representation of one registered Zod schema by name (e.g. 'worker-boot-v1', 'rpc-request-v1'). Use claws_schema_list to discover valid names.",
  claws_rpc_call:
    'Issue a typed RPC call to a target peer. The server routes the call to rpc.<targetPeerId>.request and waits for the worker to publish a response to rpc.response.<callerPeerId>.<requestId>. Returns the result or a timeout error.',
  claws_task_assign:
    "Orchestrator-only: assign a task to a worker peer. The worker receives a task.assigned.<peerId> push event. Use deliver='inject' to also write the prompt directly into the worker's terminal.",
  claws_task_update:
    'Worker-only: update the status or progress of an assigned task. Emits a task.status push event so orchestrators can track progress.',
  claws_task_complete:
    'Worker-only: mark a task as succeeded, failed, or skipped. Idempotent — calling again on an already-completed task is safe. Emits a task.completed push event.',
  claws_task_cancel:
    'Orchestrator-only: request cancellation of an active task. Emits task.cancel_requested.<assignee> so the worker can react. Does not forcibly terminate the worker.',
  claws_task_list:
    'List tasks in the server registry. Optionally filter by assignee peerId, status, or last-updated timestamp. Available to all peers.',
  claws_drain_events:
    'Drain buffered push-frame events from the persistent socket. On first call auto-subscribes to all topics (**). Returns events received since since_index with a dropped count for aged-out events. Set wait_ms > 0 to block until at least one new event arrives or the timeout fires.',
  claws_pipeline_create:
    'Create a named pipeline with an ordered list of step definitions on the Claws server. Each step can be a string (shell command) or a structured object. Returns a pipelineId.',
  claws_pipeline_list:
    'List all pipelines currently registered on the Claws server.',
  claws_pipeline_close:
    'Close and remove a pipeline from the Claws server by pipelineId.',
  claws_dispatch_subworker:
    'Spawn a wrapped terminal for a wave sub-worker, launch Claude Code with --dangerously-skip-permissions, wait for the trust prompt, confirm bypass, and send the mission prompt. Returns terminalId and bootOk status. Use inside a wave after claws_wave_create.',
  claws_fleet:
    'Spawn a fleet of workers in parallel (single tool call). Internally fans out via Promise.allSettled so all workers boot and run concurrently. Each entry in workers mirrors claws_worker args; shared top-level fields (cwd, model, timeout_ms, etc.) act as defaults overridden per-worker. Set detach=true for non-blocking spawn (pair with claws_workers_wait). Returns a fleet summary with wall-clock time, per-worker status, and marker lines.',
  claws_workers_wait:
    'Poll a set of already-spawned terminal ids (from claws_fleet detach=true or claws_create) for completion. Checks all 4 signals: marker, error_marker, pub_complete ([CLAWS_PUB] topic=worker.<id>.complete), and Wave D terminated (system.worker.completed bus event). Supports min_complete to return when N of M workers finish rather than waiting for all. Returns per-worker results with status, signal, and duration.',
};

export default async function genMcpTools(_bundlePath, repoRoot, extRoot) {
  const require = createRequire(__filename);
  const extRequire = createRequire(join(extRoot, 'package.json'));
  const { zodToJsonSchema } = extRequire('zod-to-json-schema');
  const { z } = extRequire('zod');

  // ── Build tool definitions ─────────────────────────────────────────────────

  function tool(name, schema) {
    const inputSchema = zodToJsonSchema(schema, { $refStrategy: 'none' });
    // Remove the $schema field zodToJsonSchema adds at the top level
    delete inputSchema.$schema;
    return { name, description: DESC[name], inputSchema };
  }

  const TOOLS = [
    tool('claws_list', z.object({})),

    tool('claws_create', z.object({
      name:    z.string().describe('Terminal display name'),
      cwd:     z.string().describe('Working directory (absolute path)').optional(),
      wrapped: z.boolean().describe('Enable script(1) pty logging for full read-back. Defaults to true — all worker terminals should be wrapped for observability. Set false only for interactive UI terminals where logging is undesired.').optional(),
    })),

    tool('claws_send', z.object({
      id:      z.string().describe('Terminal ID from claws_list or claws_create'),
      text:    z.string().describe('Text to send'),
      newline: z.boolean().describe('Append Enter after text (default true)').optional(),
    })),

    tool('claws_exec', z.object({
      id:         z.string().describe('Terminal ID'),
      command:    z.string().describe('Shell command to execute'),
      timeout_ms: z.number().int().describe('Max wait time in ms (default 180000)').optional(),
    })),

    tool('claws_read_log', z.object({
      id:    z.string().describe('Terminal ID (must be wrapped)'),
      lines: z.number().int().describe('Number of lines to return from the tail (default 50)').optional(),
    })),

    tool('claws_poll', z.object({
      since: z.number().int().describe('Sequence cursor — return only events after this (default 0)').optional(),
    })),

    tool('claws_close', z.object({
      id: z.string().describe('Terminal ID to close'),
    })),

    tool('claws_worker', z.object({
      name:              z.string().describe('Worker name (terminal tab)'),
      mission:           z.string().describe('Mission prompt sent to Claude Code. Include your completion marker (default MISSION_COMPLETE) so the blocker knows when to stop.').optional(),
      command:           z.string().describe('Alternative to mission: raw shell command sent to a wrapped terminal. Implies launch_claude=false.').optional(),
      cwd:               z.string().describe('Working directory for the worker terminal. Defaults to the MCP server cwd (project root) so the worker lands in a trusted folder with the project MCP socket reachable.').optional(),
      model:             z.string().describe('Claude Code model flag value. Defaults to "claude-sonnet-4-6" — Sonnet is mandatory for workers per project policy.').optional(),
      launch_claude:     z.boolean().describe('Launch claude --dangerously-skip-permissions before sending mission (default: true if mission present, false if command present)').optional(),
      detach:            z.boolean().describe('Return immediately after spawning (legacy behavior, default false).').optional(),
      timeout_ms:        z.number().int().describe('Max wait for completion in ms (default 300000 = 5 min).').optional(),
      boot_wait_ms:      z.number().int().describe('Max wait for Claude Code boot before sending mission (default 8000).').optional(),
      boot_marker:       z.string().describe('Substring that indicates Claude booted (default "Claude Code").').optional(),
      complete_marker:   z.string().describe('Substring that signals success (default "MISSION_COMPLETE").').optional(),
      error_markers:     z.array(z.string()).describe('Substrings that signal failure (default ["MISSION_FAILED"]).').optional(),
      poll_interval_ms:  z.number().int().describe('How often to check the capture buffer (default 1500).').optional(),
      harvest_lines:     z.number().int().describe('Tail N lines of output to return on completion (default 200).').optional(),
      close_on_complete: z.boolean().describe('Auto-close the terminal after completion (default true).').optional(),
    })),

    tool('claws_fleet', z.object({
      workers: z.array(z.object({
        name: z.string(),
        mission: z.string().optional(),
        command: z.string().optional(),
        cwd: z.string().optional(),
        model: z.string().optional(),
        complete_marker: z.string().optional(),
        error_markers: z.array(z.string()).optional(),
        timeout_ms: z.number().int().optional(),
        boot_wait_ms: z.number().int().optional(),
        launch_claude: z.boolean().optional(),
      })).describe('Worker configs to spawn in parallel (single tool call internally fans out via Promise.all).'),
      cwd: z.string().describe('Shared default cwd.').optional(),
      model: z.string().describe('Shared default model.').optional(),
      timeout_ms: z.number().int().describe('Shared default per-worker timeout.').optional(),
      boot_wait_ms: z.number().int().describe('Shared default boot wait.').optional(),
      poll_interval_ms: z.number().int().describe('Shared default poll interval.').optional(),
      harvest_lines: z.number().int().describe('Shared default harvest lines.').optional(),
      close_on_complete: z.boolean().describe('Shared default auto-close.').optional(),
      detach: z.boolean().describe('If true, return immediately after each worker is spawned (no marker poll). Companion to claws_workers_wait.').optional(),
    })),

    tool('claws_workers_wait', z.object({
      terminal_ids: z.array(z.union([z.string(), z.number()])).describe('Terminal ids to poll (from claws_fleet detach=true or claws_create).'),
      complete_marker: z.string().describe("Substring that signals success (default 'MISSION_COMPLETE').").optional(),
      error_markers: z.array(z.string()).describe("Substrings that signal failure (default ['MISSION_FAILED']).").optional(),
      timeout_ms: z.number().int().describe('Max wait in ms (default 300000).').optional(),
      poll_interval_ms: z.number().int().describe('Poll cadence (default 1500).').optional(),
      min_complete: z.number().int().describe('Return once this many workers complete (default = all workers). Workers still pending are reported in the pending array.').optional(),
    })),

    tool('claws_hello', z.object({
      role:         z.enum(['orchestrator', 'worker', 'observer']).describe('Peer role. Orchestrator may assign/cancel/broadcast; worker may publish status and claim tasks; observer is read-only.'),
      peerName:     z.string().describe("Human label for this peer (e.g. 'sdlc-lead', 'test-worker-1')."),
      terminalId:   z.string().describe('Optional: associate this peer with a specific terminal id so the server can correlate logs and do inject fan-out.').optional(),
      capabilities: z.array(z.string()).describe('Optional list of capability strings the peer advertises (server intersects with its own).').optional(),
    })),

    tool('claws_subscribe', z.object({
      topic: z.string().describe('Topic pattern to subscribe to (dot-namespaced, supports * and ** wildcards).'),
    })),

    tool('claws_publish', z.object({
      topic:   z.string().describe('Topic to publish on.'),
      payload: z.record(z.unknown()).describe('The message payload (arbitrary JSON object).'),
      echo:    z.boolean().describe('If true, sender also receives the message (default false).').optional(),
    })),

    tool('claws_broadcast', z.object({
      text:       z.string().describe('The text payload to broadcast.'),
      targetRole: z.enum(['worker', 'orchestrator', 'observer', 'all']).describe("Which role(s) to target (default 'worker').").optional(),
      inject:     z.boolean().describe("If true, text is also sent into each peer's associated terminal via bracketed paste (default false).").optional(),
    })),

    tool('claws_ping', z.object({})),

    tool('claws_peers', z.object({})),

    tool('claws_lifecycle_plan', z.object({
      plan: z.string().describe('1–3 sentence mission summary. What you are doing, why, and what success looks like.'),
    })),

    tool('claws_lifecycle_advance', z.object({
      to:     z.enum(['SPAWN', 'DEPLOY', 'OBSERVE', 'RECOVER', 'HARVEST', 'CLEANUP', 'REFLECT', 'FAILED']).describe('Target phase.'),
      reason: z.string().describe('Optional human-readable transition reason (logged in state).').optional(),
    })),

    tool('claws_lifecycle_snapshot', z.object({})),

    tool('claws_lifecycle_reflect', z.object({
      reflect: z.string().describe('Retrospective text: what succeeded, what failed, what to improve next time.'),
    })),

    tool('claws_wave_create', z.object({
      waveId:   z.string().describe("Stable human-readable wave identifier (e.g. 'embedder-v1', 'bus-hardening-r2')."),
      layers:   z.array(z.string()).describe("Human-readable layer or goal labels this wave covers (e.g. ['L1-schemas', 'L2-handlers']).").optional(),
      manifest: z.array(z.enum(['lead', 'tester', 'reviewer', 'auditor', 'bench', 'doc'])).describe('Expected sub-worker roles. One violation timer is started per role.'),
    })),

    tool('claws_wave_status', z.object({
      waveId: z.string().describe('Wave identifier to inspect.'),
    })),

    tool('claws_wave_complete', z.object({
      waveId:          z.string().describe('Wave identifier to complete.'),
      summary:         z.string().describe('One-paragraph retrospective: what shipped, test result, any regressions.'),
      commits:         z.array(z.string()).describe('Git commit SHAs produced during this wave.').optional(),
      regressionClean: z.boolean().describe('True if the full test suite passed with no regressions after the wave\'s changes.').optional(),
    })),

    tool('claws_deliver_cmd', z.object({
      targetPeerId:   z.string().describe('peerId of the worker to receive the command.'),
      cmdTopic:       z.string().describe('Full topic the server will push on (e.g. cmd.p_000002.abort).'),
      payload:        z.record(z.unknown()).describe('EnvelopeV1 payload: {v:1, id:uuid, schema:string, from_peer, from_name, ts_published, data}.'),
      idempotencyKey: z.string().uuid().describe('Client-generated UUID. Duplicate keys return {ok:true, duplicate:true} without re-delivering.'),
    })),

    tool('claws_cmd_ack', z.object({
      seq:            z.number().int().nonnegative().describe('Sequence number from the deliver-cmd response.'),
      status:         z.enum(['executed', 'rejected', 'duplicate']).describe('Execution outcome reported by the worker.'),
      correlation_id: z.string().uuid().describe('Optional UUID carried through for orchestrator correlation.').optional(),
    })),

    tool('claws_schema_list', z.object({})),

    tool('claws_schema_get', z.object({
      name: z.string().describe("Schema name as returned by claws_schema_list (e.g. 'worker-boot-v1')."),
    })),

    tool('claws_rpc_call', z.object({
      targetPeerId: z.string().describe('peerId of the peer to call.'),
      method:       z.string().describe("RPC method name (e.g. 'introspect', 'status')."),
      params:       z.record(z.unknown()).describe('Optional method parameters.').optional(),
      timeoutMs:    z.number().int().min(100).max(30000).describe('Milliseconds before the call times out. Default: 5000.').optional(),
    })),

    tool('claws_task_assign', z.object({
      title:     z.string().describe('Short human-readable task title.'),
      assignee:  z.string().describe('peerId of the worker peer to assign the task to.'),
      prompt:    z.string().describe('Full task instructions delivered to the worker.'),
      timeoutMs: z.number().int().describe('Optional deadline in milliseconds from now.').optional(),
      deliver:   z.enum(['publish', 'inject', 'both']).describe("How to deliver the prompt: publish (bus only), inject (terminal only), both (default: publish).").optional(),
    })),

    tool('claws_task_update', z.object({
      taskId:      z.string().describe("Task ID as returned by claws_task_assign (e.g. 't_000001')."),
      status:      z.enum(['pending', 'in_progress', 'blocked']).describe('New task status.'),
      progressPct: z.number().min(0).max(100).describe('Optional progress percentage (0–100).').optional(),
      note:        z.string().describe('Optional human-readable progress note.').optional(),
    })),

    tool('claws_task_complete', z.object({
      taskId:    z.string().describe('Task ID as returned by claws_task_assign.'),
      status:    z.enum(['succeeded', 'failed', 'skipped']).describe('Final task outcome.'),
      result:    z.string().describe('Optional human-readable result summary.').optional(),
      artifacts: z.array(z.string()).describe('Optional list of output artifact paths or identifiers.').optional(),
    })),

    tool('claws_task_cancel', z.object({
      taskId: z.string().describe('Task ID to cancel.'),
      reason: z.string().describe('Optional human-readable cancellation reason.').optional(),
    })),

    tool('claws_task_list', z.object({
      assignee: z.string().describe('Filter by assignee peerId.').optional(),
      status:   z.enum(['pending', 'in_progress', 'blocked', 'succeeded', 'failed', 'skipped']).describe('Filter by task status.').optional(),
      since:    z.number().int().describe('Return only tasks updated at or after this epoch-ms timestamp.').optional(),
    })),

    // D-1: tools present in mcp_server.js handlers but previously missing from schema
    tool('claws_drain_events', z.object({
      since_index: z.number().int().describe('Return only events with absoluteIndex greater than this value. Default 0 (return all buffered events).').optional(),
      wait_ms:     z.number().int().describe('Block up to this many milliseconds for at least one new event. Default 0 (return immediately).').optional(),
      max:         z.number().int().describe('Maximum number of events to return. Default 100.').optional(),
    })),

    tool('claws_pipeline_create', z.object({
      name:  z.string().describe('Human-readable pipeline name.').optional(),
      steps: z.union([z.array(z.unknown()), z.string()]).describe('Ordered pipeline steps. Each step may be a shell-command string or a structured step object. Pass a JSON string if the client cannot send a raw array.'),
    })),

    tool('claws_pipeline_list', z.object({})),

    tool('claws_pipeline_close', z.object({
      pipelineId: z.string().describe('Pipeline ID as returned by claws_pipeline_create.'),
    })),

    tool('claws_dispatch_subworker', z.object({
      waveId:  z.string().describe('Wave identifier (from claws_wave_create) this sub-worker belongs to.'),
      role:    z.string().describe('Sub-worker role label (e.g. "tester", "reviewer"). Used to name the terminal and register the heartbeat slot.'),
      mission: z.string().describe('Mission prompt sent to Claude Code after boot. Include your completion marker.'),
      cwd:     z.string().describe('Working directory for the spawned terminal (absolute path).').optional(),
    })),
  ];

  const outPath = join(repoRoot, 'schemas', 'mcp-tools.json');
  writeFileSync(outPath, JSON.stringify(TOOLS, null, 2) + '\n', 'utf8');
  console.log(`[codegen/gen-mcp-tools] wrote ${TOOLS.length} tool descriptors to schemas/mcp-tools.json`);
}
