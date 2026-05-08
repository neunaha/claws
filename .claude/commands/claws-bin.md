---
name: claws-bin
description: View or change the worker binary used for spawns (multi-account / alias support).
---

# /claws-bin [<binary-name> | reset]

Sets or reports the binary used by `claws_worker` / `claws_fleet` /
`claws_dispatch_subworker` to spawn worker terminals. Useful for teams using
multiple Claude accounts via shell aliases.

## Usage

- `/claws-bin claude-neu` → sets worker binary to `claude-neu`. Persists in
  `.claws/claude-bin` (gitignored). Takes effect immediately — next spawn uses it.
- `/claws-bin reset` → clears the file, reverts to default (`claude`) or
  `CLAWS_CLAUDE_BIN` env var if set.
- `/claws-bin` (no arg) → reports current binary and source (file/env/default).

## How to act

1. If user passed `<binary-name>` → call `claws_set_bin(name: "<name>")`,
   confirm in chat with the returned message.
2. If user passed `reset` → call `claws_set_bin()` (no args), confirm.
3. If no arg → call `claws_get_bin()`, show result.

This is a single MCP tool call. No deliberation, no pre-verification. Trust the
result.
