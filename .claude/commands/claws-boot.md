---
description: Boot a worker Claude in a wrapped Claws terminal — follows the exact 7-step sequence (create → activate → trust → bypass → mission → CR). Required before any worker mission.
---

# /claws-boot <name> <mission>

Boot a single worker Claude following the mandatory 7-step sequence.
NEVER skip steps. NEVER send the mission before "bypass" is detected.

## Step 1 — Create wrapped terminal

```
claws_create name="<name>" wrapped=true
```

Note the returned terminal ID (e.g. `id: "7"`).

## Step 2 — Activate Claude

```
claws_send id=<N> text="claude --model claude-sonnet-4-6 --dangerously-skip-permissions"
```

Wait ~3s for the command to register.

## Step 3 — Poll for trust prompt

Call `claws_read_log id=<N> offset=0 limit=2000 strip=true` every 5 seconds.
Wait until output contains the word **"trust"** (the trust-all-tools prompt).
This typically takes 15–25 seconds.

## Step 4 — Accept trust

```
claws_send id=<N> text="1" newline=false
```

The `newline=false` is CRITICAL — do not omit it.

## Step 5 — Poll for bypass confirmation

Continue polling `claws_read_log` every 5 seconds.
Wait until output contains **"bypass"** (bypass-permissions banner).
This typically takes 5–15 seconds.

## Step 6 — Send mission

```
claws_send id=<N> text="<your full mission text here>" newline=false
```

The `newline=false` is CRITICAL — mission must be submitted by Step 7 CR, not here.

## Step 7 — Submit (CR)

```
claws_send id=<N> text="
" newline=false
```

This is a separate call. The worker now begins executing.

## After booting

Attach monitoring: poll `claws_read_log` every 30s.
Worker signals completion with `MISSION_COMPLETE`.
When done: call `claws_close id=<N>`.

## CRITICAL RULES

- ALWAYS use `claude --model claude-sonnet-4-6 --dangerously-skip-permissions`
- ALWAYS use `wrapped=true`
- NEVER send mission before "bypass" detected
- NEVER use newline=true on Steps 4, 6, 7
- ALWAYS close the terminal when done
