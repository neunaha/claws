---
name: claws-help
description: Show the complete Claws prompt guide — how to talk to Claude to get the most out of multi-terminal orchestration. Examples from beginner to power user.
---

# /claws-help

Show the user how to use Claws through natural prompts.

## What to do

Print this guide exactly:

---

## Claws Prompt Guide — Powered by Claude Opus

Your Claude Code session is now a terminal orchestrator. Here's how to use it — just talk naturally.

### Level 1 — Basic (single terminal)

**Run something visibly:**
```
run npm test in a visible terminal
```
```
build the project — I want to watch
```
```
start the dev server in a terminal I can see
```

**Check what's running:**
```
what terminals are open right now?
```
```
show me what's happening in terminal 3
```

**Read a terminal's output:**
```
read the last 50 lines of terminal 2
```
```
what did the build output?
```

---

### Level 2 — Parallel (multiple terminals)

**Run tasks in parallel:**
```
run lint, test, and typecheck in parallel — 3 separate terminals
```
```
spawn 3 workers: one runs npm test, one runs npm run lint, one runs tsc --noEmit
```

**Monitor everything:**
```
check all workers — which ones finished, which ones failed?
```
```
show me the results from all 3 workers
```

---

### Level 3 — AI Workers (Claude controlling Claude)

**Spawn an AI worker:**
```
spawn a Claude worker to fix the failing test in auth.test.ts
```
```
create a worker terminal, launch claude in it, and send this mission: refactor the database module to use connection pooling
```

**Spawn a fleet:**
```
spawn 3 Claude workers in parallel:
- worker A: audit the codebase for security issues
- worker B: analyze test coverage gaps
- worker C: find dead code and unused exports
```

**Monitor AI workers:**
```
what's the Claude worker doing right now?
```
```
read the worker's terminal — has it finished?
```

---

### Level 4 — Orchestration (you direct, AI executes)

**Step-by-step control:**
```
create a wrapped terminal called "refactor"
launch claude in it with full permissions
send it this mission: migrate all API routes from Express to Fastify, one file at a time, commit after each
monitor it and tell me when each commit lands
```

**Conditional workflows:**
```
run the tests first — if they pass, deploy to staging. if they fail, spawn a worker to fix them
```

**Multi-stage pipelines:**
```
stage 1: run the linter and fix all auto-fixable issues
stage 2: run the test suite
stage 3: if all green, build and show me the bundle size
run each stage in a visible terminal
```

---

### Level 5 — Power User

**Full fleet orchestration:**
```
I need a complete codebase audit. spawn workers for:
1. latency profiling (analyze all API response times)
2. dependency audit (outdated packages, security vulnerabilities)
3. code quality (complexity, duplication, dead code)
4. test coverage analysis
run all 4 in parallel, aggregate the findings, and give me a ranked action plan
```

**Pair programming with oversight:**
```
spawn a worker to implement the new payment integration
I want to watch every step — don't commit without showing me the diff first
if it hits an error, show me before it tries to fix it
```

**Cross-project coordination:**
```
create 2 terminals:
- terminal 1: run the API server (backend/)
- terminal 2: run the frontend dev server (frontend/)
monitor both — if either crashes, restart it and tell me what happened
```

---

### Quick Reference — Slash Commands

| Command | What it does |
|---|---|
| `/claws-help` | This guide |
| `/claws-status` | Show bridge status + active terminals |
| `/claws-create name` | Create a wrapped terminal |
| `/claws-send id text` | Send text to a terminal |
| `/claws-exec id cmd` | Run command + capture output |
| `/claws-read id` | Read a terminal's pty log |
| `/claws-worker name cmd` | Full worker pattern (create + launch + monitor) |
| `/claws-fleet tasks` | Parallel fleet dispatch |
| `/claws-update` | Pull latest + re-inject everything |
| `/claws-install` | First-time install |

### Shell Commands (available in every terminal)

| Command | What it does |
|---|---|
| `claws-ls` | List all terminals |
| `claws-new name` | Create a wrapped terminal |
| `claws-run id cmd` | Execute in a terminal |
| `claws-log id` | Read a terminal's log |

---

**The golden rule:** just describe what you want done and say "in a visible terminal" or "spawn a worker" — Claude handles the rest.
