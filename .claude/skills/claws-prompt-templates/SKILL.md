---
name: claws-prompt-templates
description: Production-grade prompt templates for controlling terminals via Claws. Copy-paste patterns for AI orchestration, worker spawning, fleet management, and pair-programming workflows. Use when composing missions for worker terminals.
---

# Claws Prompt Templates

Battle-tested prompt patterns for terminal orchestration. Each template is a complete, self-contained mission prompt designed to be sent into a Claws-controlled terminal running Claude Code or any AI agent.

## Template 1 — Single Mission Worker

**Use when**: you have one scoped task for one terminal.

```
new mission. one task, one deliverable, exit when done.

context: [2-3 sentences of relevant background the worker needs]

your job: [clear, specific objective in one sentence]

steps:
1. [first concrete action]
2. [second concrete action]
3. [verification step]
4. [write output to <path>]

constraints:
- stay inside this repo
- do not edit files outside [scope]
- do not run [dangerous thing]
- do not commit unless instructed

when done, print MISSION_COMPLETE on its own line. go.
```

**Key principles**:
- Context first, then objective, then steps, then constraints
- Steps are numbered only when order matters
- Constraints are explicit prohibitions, not suggestions
- `MISSION_COMPLETE` is the machine-parseable completion marker
- End with "go." — single imperative, no preamble

---

## Template 2 — Analysis + Write Findings

**Use when**: you need an audit, review, or analysis with a written deliverable.

```
analysis mission. read-only except for the output file.

context: [what prompted this analysis, what prior work exists]

prior art: read [file1] and [file2] first. do not re-derive findings that already exist there. build on top of them.

your job: [specific analysis question to answer]

method:
1. [primary data source to read]
2. [secondary data source to cross-reference]
3. [specific computation or comparison to perform]
4. [graphify query or structural analysis if applicable]

output: write findings to [output-path] with these sections:
(a) [section 1 — data table or metrics]
(b) [section 2 — ranked recommendations]
(c) [section 3 — evidence trail / citations]
(d) [section 4 — meta-eval on method quality]

constraints:
- do not edit any file outside [output-path]
- do not run any pipeline commands
- do not commit
- numbers first, prose light — tables beat paragraphs

when done, print MISSION_COMPLETE [slug] on its own line. go.
```

---

## Template 3 — Multi-Commit Implementation

**Use when**: you have a planned set of code changes to ship as atomic commits.

```
implementation mission. ship [N] commits in sequence.

context: [reference to the analysis/plan that produced these changes]

read [plan-file] for the exact diffs. each commit is specified there with files, changes, and commit message.

implementation order (respects dependencies):

commit 1 — [short description]. edit [files]. message: '[exact commit message]'
commit 2 — [short description]. edit [files]. message: '[exact commit message]'
commit 3 — [short description]. edit [files]. message: '[exact commit message]'

for each commit:
1. make the edits
2. verify syntax (python -c "import ast; ..." or equivalent)
3. verify runbook/config still parses if applicable
4. git add [specific files] && git commit -m "[message]"

after all [N] commits, run [verification command] to confirm nothing broke.

constraints:
- do not run content pipelines or generate artifacts
- do not push
- do not edit files outside the listed scope per commit
- if a commit fails verification, fix and retry up to 3 times. if still failing, write [slug]-FAILED.status with the error and stop.

when all commits are on disk and verification passes, print MISSION_COMPLETE [slug] on its own line. go.
```

---

## Template 4 — Interactive Pair-Programming Session

**Use when**: you want an ongoing conversation with a worker, not a fire-and-forget mission.

```
pair programming session. i am the orchestrator, you are the engineer.

project context: [one paragraph on what the project is and what state it's in]

your role: [specific expertise area — e.g., "frontend performance", "database migrations", "CI pipeline"]

working style:
- after each action, report what you did in one line and what you plan to do next
- if you hit an error, show the error and your diagnosis before attempting a fix
- if you need a decision, present 2 options with tradeoffs and wait for my input
- do not commit without explicit instruction from me
- do not refactor code you weren't asked to change

first task: [specific starting point]

go.
```

**How to use this**: send this as the initial prompt. Then send follow-up prompts via `/claws-send` as the conversation progresses. Read the terminal's state via `/claws-read` before each follow-up to maintain context.

---

## Template 5 — Parallel Fleet Dispatch

**Use when**: you need multiple independent workers running simultaneously.

```
worker [A/B/C] of [N]. parallel fleet — do not coordinate with other workers.

your scope: [specific subset of the work]

context shared across all workers: [common background]

your specific mission: [what THIS worker does, different from siblings]

output: write to [worker-specific-output-path]

constraints:
- edit ONLY files in your scope
- if you need to edit a file another worker might also touch, write to a temporary path and flag it in your output for manual merge
- budget: ~[N] minutes, ~$[N] tokens. if you're burning through budget without progress, write a FAILED status and exit.

when done, print MISSION_COMPLETE worker-[letter] on its own line. go.
```

---

## Template 6 — Graphify-Driven Exploration

**Use when**: you want the worker to use the project's knowledge graph as its primary reasoning surface.

```
graphify-driven analysis. use the knowledge graph as your primary reasoning tool, not intuition.

graph location: graphify-out/graph.json (N nodes, M edges). if >24h stale, run /graph-refresh first.

method:
1. start with /graph-query on [broad question about the codebase]
2. chain /graph-path between [node A] and [node B] to trace the connection
3. use /graph-explain on any surprising node to understand its role
4. ONLY read source code files AFTER the graph has pointed you at them

output: [output-path] with sections:
(a) [findings from graph queries — cite exact queries used]
(b) [findings from code reading — only files the graph pointed to]
(c) [meta-eval: was graphify useful here? where did it add value vs not?]

constraints:
- do not read code top-down — graph first, code second
- cite every graph query you ran with its result
- if graphify cannot answer a question, say so honestly and fall back to grep/read
- do not edit any file outside [output-path]

when done, print MISSION_COMPLETE [slug] on its own line. go.
```

---

## Template 7 — Error Recovery / Debugging

**Use when**: a previous worker failed or a process is broken and you need a terminal to diagnose and fix it.

```
debugging mission. something broke — your job is to diagnose and fix.

symptom: [exact error message or observable behavior]
where it happens: [file, command, or process that fails]
what changed recently: [last N commits, or "unknown"]

method:
1. reproduce the error: [exact command to run]
2. read the error output carefully
3. trace the root cause — read the failing code, check git blame for recent changes, check dependencies
4. propose a fix — describe what you'll change and why before editing
5. apply the fix (minimal diff)
6. verify the fix by re-running the reproduction command
7. if the fix works, commit: "[fix type]: [description]"
8. if the fix doesn't work, iterate up to 3 times. if still broken, write a diagnosis report to [output-path] with what you tried and why it didn't work.

constraints:
- minimal diffs only — fix the bug, don't refactor surrounding code
- do not change tests to make them pass — fix the implementation
- verify before committing

when done, print MISSION_COMPLETE [slug] on its own line. go.
```

---

## Template 8 — Streaming Worker (Real-time Event Publishing)

**Use when**: the orchestrator must track the worker's progress in real-time via the pub/sub bus rather than polling the pty log. Required when running ≥3 parallel workers or when latency matters.

The worker MUST publish at every checkpoint:

| Checkpoint | SDK call | Notes |
|---|---|---|
| Process start | `publish boot` | First action after accepting the trust prompt |
| Phase transition | `publish phase` | Every lifecycle phase change |
| Significant decision | `publish event --kind DECISION` | Blocking choices |
| Blocker hit | `publish event --kind BLOCKED` | Before asking orchestrator |
| Every ~10s | `publish heartbeat` | Keeps orchestrator alive even during silent work |
| Final outcome | `publish complete` | Last action before printing MISSION_COMPLETE |

**Mission prompt template**:

```
streaming worker mission. you are worker <slug>, peerId will be assigned at connect.

env contract (already set in this terminal):
  CLAWS_PEER_ID   — your registered peer id
  CLAWS_PEER_NAME — <slug>

sdk: node ./.claws-bin/claws-sdk.js publish <type> [flags]

REQUIRED PUBLISH SEQUENCE:
1. publish boot immediately (before doing any work):
   node ./.claws-bin/claws-sdk.js publish boot \
     --mission "<one-sentence mission summary>" \
     --role worker

2. publish phase at every lifecycle transition:
   node ./.claws-bin/claws-sdk.js publish phase --phase PLAN
   node ./.claws-bin/claws-sdk.js publish phase --phase DEPLOY --prev PLAN
   (etc.)

3. publish heartbeat every ~10 seconds during long-running steps:
   node ./.claws-bin/claws-sdk.js publish heartbeat --phase <current-phase>

4. publish event for sentinels:
   node ./.claws-bin/claws-sdk.js publish event \
     --kind BLOCKED --summary "<what you are waiting for>" --severity warn
   node ./.claws-bin/claws-sdk.js publish event \
     --kind DECISION --summary "<what you decided and why>"

5. publish complete as the very last step before MISSION_COMPLETE:
   node ./.claws-bin/claws-sdk.js publish complete \
     --result ok --summary "<what was accomplished>"

context: [2-3 sentences the worker needs]

your job: [clear objective in one sentence]

steps:
1. publish boot (above — do this first)
2. [first concrete action]
3. [second concrete action]
4. [verification step]
5. publish complete (above — do this last)

RECEIVING ORCHESTRATOR COMMANDS:
The orchestrator may inject a command into this terminal at any time. When you
see a line matching the pattern below, process it immediately and then continue
your mission:

  [CLAWS_CMD r=<id>] <action>: <json-payload>

Rules:
- Correlate <id> against any request_id you published in a BLOCKED or REQUEST
  event. Ignore any [CLAWS_CMD] whose r value does not match a request_id you
  are currently waiting on.
- Do NOT echo this line back as output or include it in any publish payload.
- Process these five actions:
    approve_request  — you are unblocked; proceed with the approved path
    reject_request   — your request was denied; stop or use your fallback
    abort            — stop the current task immediately; publish complete --result failed
    pause            — suspend at the next safe checkpoint; wait for resume
    resume           — continue from your paused state

constraints:
- stay inside [scope]
- do not commit unless instructed
- do not skip publish steps — the orchestrator relies on them

when done, print MISSION_COMPLETE <slug> on its own line. go.
```

**Orchestrator setup** (before sending the mission):

```
# 1. Register orchestrator peer
peerId = claws_hello(role="orchestrator", peerName="orch")

# 2. Subscribe to all worker events
claws_subscribe(topic="worker.**")

# 3. Launch stream-events sidecar (keeps pub/sub frames arriving)
#    (in a separate bash terminal or background Monitor)

# 4. Boot worker terminal via standard 7-step sequence
# 5. Set CLAWS_PEER_ID + CLAWS_PEER_NAME env in the worker terminal:
claws_send(id=<termId>, text='export CLAWS_PEER_ID=<workerPeerId>')
claws_send(id=<termId>, text='export CLAWS_PEER_NAME=<slug>')

# 6. Send the streaming worker mission
```

---

## Anti-patterns — What NOT to Do

**Don't send vague missions**:
```
# BAD — too vague, worker will waste tokens exploring
look at the codebase and suggest improvements

# GOOD — scoped, measurable, concrete output
read pipeline/runbooks/infographic-new.yaml and identify which tiers are sequential that could be parallel. write findings to /tmp/parallelism-audit.md with a table of tier × dependency × parallel-safe.
```

**Don't skip constraints**:
```
# BAD — worker might commit, push, run expensive pipelines
fix the bug in committee.py

# GOOD — explicit boundaries
fix the KeyError in committee.py line 234. do not commit. do not run /infographic-new. edit only committee.py.
```

**Don't forget the completion marker**:
```
# BAD — monitor can't detect completion
do the thing

# GOOD — machine-parseable end signal
when done, print MISSION_COMPLETE fix-keyerror on its own line. go.
```

**Don't send multi-line prompts without bracketed paste**:
```
# BAD — fragments into multiple submissions
client.send(id, "line 1\nline 2\nline 3")

# GOOD — Claws auto-wraps in bracketed paste when newlines detected
# Just send normally — Claws handles it
client.send(id, "line 1\nline 2\nline 3")
```
