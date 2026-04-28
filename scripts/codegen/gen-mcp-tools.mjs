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
      launch_claude:     z.boolean().describe('Launch claude --dangerously-skip-permissions before sending mission (default: true if mission present, false if command present)').optional(),
      detach:            z.boolean().describe('Return immediately after spawning (legacy behavior, default false).').optional(),
      timeout_ms:        z.number().int().describe('Max wait for completion in ms (default 1800000 = 30 min).').optional(),
      boot_wait_ms:      z.number().int().describe('Max wait for Claude Code boot before sending mission (default 8000).').optional(),
      boot_marker:       z.string().describe('Substring that indicates Claude booted (default "Claude Code").').optional(),
      complete_marker:   z.string().describe('Substring that signals success (default "MISSION_COMPLETE").').optional(),
      error_markers:     z.array(z.string()).describe('Substrings that signal failure (default ["MISSION_FAILED"]).').optional(),
      poll_interval_ms:  z.number().int().describe('How often to check the capture buffer (default 1500).').optional(),
      harvest_lines:     z.number().int().describe('Tail N lines of output to return on completion (default 200).').optional(),
      close_on_complete: z.boolean().describe('Auto-close the terminal after completion (default true).').optional(),
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
  ];

  const outPath = join(repoRoot, 'schemas', 'mcp-tools.json');
  writeFileSync(outPath, JSON.stringify(TOOLS, null, 2) + '\n', 'utf8');
  console.log(`[codegen/gen-mcp-tools] wrote ${TOOLS.length} tool descriptors to schemas/mcp-tools.json`);
}
