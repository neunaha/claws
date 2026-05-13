<!-- CLAWS:BEGIN -->
## Claws — {PROJECT_NAME} (v{VERSION}) · npm: claws-code

The Claws MCP server is running at `{SOCKET_PATH}`. Machine-wide invariants (boot sequence, completion convention, Monitor pattern, lifecycle phases, Wave Discipline) live in `~/.claude/CLAUDE.md` — do not duplicate them here.

### Where to start

- **`/claws-do "<task>"`** — daily driver. Auto-classifies into shell / worker / fleet / wave.
- **`/claws-status`** — live terminal table + lifecycle state.
- **`/claws-help`** — full command + tool reference.

### MCP tools available ({TOOLS_COUNT})

{TOOLS_LIST}

### Slash commands ({CMDS_COUNT})

{CMDS_LIST}

### Lifecycle phases

```
{LIFECYCLE_PHASES}
```

(Workers report a 9-phase subset — see `~/.claude/CLAUDE.md` for details.)

### Reminders

- Workers boot themselves via `claws_worker` / `claws_fleet` — do not run the send sequence manually.
- Completion is `claws_done()` (zero-arg, F3 of the five-layer convention).
- Marker recognized by the server: `__CLAWS_DONE__` only.
- `claws_fleet` and `claws_worker` are non-blocking by default in mission mode (LH-14.1) — poll via `claws_workers_wait`.
- Worker binary: defaults to `claude`. Override with `/claws-bin <name>` or write to `.claws/claude-bin`.

See `~/.claude/CLAUDE.md` for the complete invariant policy.
<!-- CLAWS:END -->
