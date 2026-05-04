---
name: claws-prompt-templates
description: Production-grade prompt templates for crafting Claws worker missions. Patterns for mission text, completion markers, and hard gates.
type: skill
---

# Claws Prompt Templates

Patterns for crafting mission text sent to Claws workers. The boot mechanics are handled by `claws_worker` / `claws_fleet` — these templates are about what you put in the `mission` field.

## Core rules for every mission

1. **End with a completion marker**: `print __CLAWS_DONE__ when done. go.`
2. **Include F1–F5 final actions** for missions that commit code:
   - F1: `git status --short` — verify clean working tree
   - F2: `git log --oneline -5` — verify commits landed
   - F3 (PRIMARY): `claws_publish(topic="worker.<termId>.complete", payload={"status":"completed","marker":"__CLAWS_DONE__"})` — MCP bus signal
   - F4 (BACKUP): `printf '%s\n' '__CLAWS_DONE__'` — pty-visible completion signal
   - F5 (BACKUP): end final assistant message with `__CLAWS_DONE__` on its own line
3. **Set hard gates**: "all tests must pass before commit", "zero tsc errors", "no --no-verify"
4. **Scope constraints explicitly**: list what files are off-limits

---

## Template 1 — Single Mission Worker

```
new mission. one task, one deliverable, exit when done.

context: [2-3 sentences the worker needs]

your job: [clear, specific objective in one sentence]

steps:
1. [first concrete action]
2. [second concrete action]
3. [verification — npm test or equivalent; must be green]
4. [commit with conventional commit message — no --no-verify]

final actions:
F1: git status --short
F2: git log --oneline -5
F3: claws_publish(topic="worker.<termId>.complete", payload={"status":"completed","marker":"__CLAWS_DONE__"})
F4: printf '%s\n' '__CLAWS_DONE__'
F5: end final message with __CLAWS_DONE__ on its own line

constraints:
- do not edit files outside [scope]
- do not push
- all tests must pass before committing
- zero tsc errors after any .ts edit

print __CLAWS_DONE__ when done. go.
```

---

## Template 2 — Analysis / Audit (read-only)

```
analysis mission. read-only except for the output file.

context: [what prompted this, what prior work exists]

your job: [specific question to answer]

method:
1. [primary data source]
2. [secondary source or comparison]
3. [specific computation or comparison]

output: write findings to [output-path] with sections:
(a) [metrics table]
(b) [ranked recommendations]
(c) [evidence trail]

constraints:
- do not edit any file outside [output-path]
- do not commit
- numbers first, prose light

F1: git status --short
F2: git log --oneline -3
F3: claws_publish(topic="worker.<termId>.complete", payload={"status":"completed","marker":"__CLAWS_DONE__"})
F4: printf '%s\n' '__CLAWS_DONE__'
F5: end final message with __CLAWS_DONE__ on its own line

print __CLAWS_DONE__ when done. go.
```

---

## Template 3 — Multi-Commit Implementation

```
implementation mission. ship [N] commits in sequence.

context: [reference to the plan that produced these changes]

commit plan:
1. [description] — edit [files] — message: "[exact message]"
2. [description] — edit [files] — message: "[exact message]"

for each commit:
1. make the edits
2. npx tsc --noEmit — zero errors required
3. npm test — zero failures required
4. git add [specific files] && git commit -m "[message]"

if a commit fails verification after 3 retries, write [slug]-FAILED.status and stop.

F1: git status --short
F2: git log --oneline -5
F3: claws_publish(topic="worker.<termId>.complete", payload={"status":"completed","marker":"__CLAWS_DONE__"})
F4: printf '%s\n' '__CLAWS_DONE__'
F5: end final message with __CLAWS_DONE__ on its own line

constraints:
- do not push
- no --no-verify

print __CLAWS_DONE__ when done. go.
```

---

## Template 4 — Parallel Fleet Worker

```
worker [A/B/C] of [N]. do not coordinate with other workers.

your scope: [specific subset of the work]

shared context: [background all workers share]

your specific mission: [what THIS worker does]

output: write to [worker-specific-output-path]

constraints:
- edit ONLY files in your scope
- if you need to touch a shared file, write to a temp path and flag it for manual merge
- do not commit unless instructed

F1: git status --short
F2: git log --oneline -3
F3: claws_publish(topic="worker.<termId>.complete", payload={"status":"completed","marker":"__CLAWS_DONE__"})
F4: printf '%s\n' '__CLAWS_DONE__'
F5: end final message with __CLAWS_DONE__ on its own line

print __CLAWS_DONE__ when done. go.
```

---

## Anti-patterns

**Vague objective** — worker wastes tokens exploring:
```
# BAD
look at the codebase and suggest improvements

# GOOD
read extension/src/server.ts lines 120-180. identify which event handlers lack error boundaries. write findings to /tmp/audit.md as a table: handler × line × missing-guard.
```

**Missing constraints** — worker may commit, push, or run expensive ops:
```
# BAD
fix the bug in auth.ts

# GOOD
fix the KeyError at auth.ts:87. do not commit. do not push. edit only auth.ts.
```

**Missing completion marker** — watcher cannot detect completion:
```
# BAD
do the thing and tell me when done

# GOOD
...print MARK_FIX_AUTH_OK when done. go.
```
