---
name: claws-help
description: Complete reference for Claws slash commands and MCP tools.
---

# /claws-help

## What this does
Prints the complete Claws command and tool reference. Use this when you want to know what's available and how to use it.

## Commands (8 total)

| Command | Description |
|---|---|
| `/claws` | Master: show live terminal dashboard or forward a task |
| `/claws-do <task>` | Universal verb: classify and execute any task |
| `/claws-help` | This reference |
| `/claws-status` | Dashboard of active terminals with lifecycle state |
| `/claws-cleanup` | Close all worker terminals after a fleet run |
| `/claws-update` | Pull latest Claws and re-run installer |
| `/claws-fix` | Diagnose and auto-repair a broken installation |
| `/claws-report` | Bundle diagnostics into a shareable bug report |

## MCP Tools (available via tool use)

| Tool | Description |
|---|---|
| `claws_worker` | Spawn a single Claude Code worker with auto-boot |
| `claws_fleet` | Spawn N parallel workers; returns terminal_ids immediately |
| `claws_dispatch_subworker` | Dispatch a sub-worker from within a Wave LEAD |
| `claws_exec` | Run a one-shot shell command; returns output + exitCode |
| `claws_list` | List all active terminals |
| `claws_create` | Create a terminal (wrapped or unwrapped) |
| `claws_send` | Send text into a terminal |
| `claws_read_log` | Read pty log from a wrapped terminal |
| `claws_close` | Close a terminal |
| `claws_drain_events` | Block-wait for pub/sub events (use in LEAD workers) |
| `claws_lifecycle_plan` | Log a lifecycle plan (required gate before create) |

## User mental model

**5 daily commands**: `/claws-do` for tasks, `/claws` for status, `/claws-status` for details, `/claws-cleanup` after fleet runs, `/claws-help` when lost.

**3 system commands**: `/claws-update` to update, `/claws-fix` when broken, `/claws-report` to file a bug.

**Power users**: call MCP tools directly. Claws is just terminals over a Unix socket — bend it however you want.
