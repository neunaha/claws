---
name: dev-protocol-piafeur
description: Architectural-evolution loop — Plan, Implement, Audit, Fix, Evaluate, Update, Repeat. Each wave covers 2-3 protocol layers with a live extension rebuild between waves. Use for any multi-wave protocol or system evolution task where each increment must ship a working bundle before the next starts.
---

# PIAFEU-R — Architectural Evolution Loop

## When to Invoke

Use PIAFEU-R for any task that:
- Spans 2+ protocol layers or system components
- Requires a live extension rebuild to verify correctness
- Is too large to ship as a single atomic commit
- Benefits from auditing before the next layer begins (because the next layer builds on this one)

Do NOT use for single-file bug fixes, doc-only changes, or tasks that can be shipped in one commit.

**Trigger phrase in any prompt:** "run PIAFEU-R on wave N" or "evolve the protocol through L<X>".

---

## The 7 Phases

### PLAN
**Goal:** Produce a concrete, file-level implementation plan before writing any code.

**Verbs:**
- Spawn `architect` agent with the layer spec (from `.local/architecture/claws-tcp-v1.md`) and the gap doc (`.local/architecture/current-vs-target-gap.md`)
- Write the plan to `.local/architecture/wave-<N>-plan.md`: files touched, invariants to enforce, wire formats
- Publish: `{ cmd: 'publish', topic: 'arch.wave.N.boot', payload: { kind:'PLAN', files: [...], layers: [...] } }`
- Gate: plan must be reviewed before IMPLEMENT begins — no "I'll figure it out as I go"

**Deliverable:** `wave-<N>-plan.md` listing every file to change, the invariants each change must satisfy, and the verification criteria.

---

### IMPLEMENT
**Goal:** Write the code. Nothing more.

**Verbs:**
- Work file-by-file in the order listed in the plan
- Run `npm run build` in `extension/` after each file group — never accumulate build errors
- Write tests alongside the implementation (same commit if simple, separate commit if complex)
- Do NOT refactor adjacent code that isn't in scope — keep the diff minimal and reviewable
- Publish: `{ cmd: 'publish', topic: 'wave.N.RESULT', payload: { kind:'IMPLEMENT', status:'in-progress', filesChanged: [...] } }`

**Gate:** Build must pass with zero TypeScript errors before moving to AUDIT.

---

### AUDIT
**Goal:** Independent code review before any further work.

**Verbs:**
- Spawn `code-reviewer` agent with the diff since the last wave baseline
- Also spawn `security-reviewer` agent if the wave touches auth, socket, or input parsing
- Collect all CRITICAL, HIGH, MEDIUM findings into `.local/audits/wave-<N>-audit.md`
- Publish: `{ cmd: 'publish', topic: 'wave.N.RESULT', payload: { kind:'AUDIT', findings: {critical:N, high:N, medium:N} } }`

**Gate:** No CRITICAL findings open. HIGH findings must be in FIX scope.

---

### FIX
**Goal:** Address audit findings. No new features.

**Verbs:**
- Fix all CRITICAL findings first, re-run build after each
- Fix all HIGH findings
- For MEDIUM findings: fix if the change is < 5 lines; defer with a `TODO(wave-<N>)` comment otherwise
- Re-run `npm run build` after each fix
- If a fix reveals a new CRITICAL finding, loop back to AUDIT
- Publish: `{ cmd: 'publish', topic: 'wave.N.RESULT', payload: { kind:'FIX', fixed: [...], deferred: [...] } }`

**Gate:** Build green, no CRITICAL or HIGH findings open.

---

### EVALUATE
**Goal:** Verify the wave's invariants hold under real load. Not theoretical — run it.

**Verbs:**
- Deploy the bundle: `cd extension && npm run build && cp -r dist ~/.vscode/extensions/<id>/dist/`
- Reload VS Code extension host: `Developer: Restart Extension Host`
- Run the wave's stress test (from `wave-execution-plan.md` "Verification" column):
  - Minimum: 1000 events, 3 concurrent peers, 0 sequence gaps
  - Check: all subscribed push frames received in order, no dropped frames under normal load
- Run the full test suite: `cd extension && npm test`
- Publish: `{ cmd: 'publish', topic: 'wave.N.RESULT', payload: { kind:'EVALUATE', tests:'pass', stress:'pass', gapCount:0 } }`

**Gate:** All tests pass, stress test shows 0 gaps, no regressions in prior waves' test suites.

---

### UPDATE
**Goal:** Record that the wave landed. Update all living documents.

**Verbs:**
- Update `.local/architecture/current-vs-target-gap.md`: mark each layer covered by this wave as SHIPPED with the commit hash
- Update `CHANGELOG.md`: add entry under the appropriate version header
- Update `extension/package.json` version if this wave is release-worthy
- Commit with message: `feat(extension): wave-<N> — <short description of layers>`
- Publish: `{ cmd: 'publish', topic: 'wave.N.complete', payload: { kind:'COMPLETE', layers:[...], commit:'<sha>' } }`

**Gate:** All documents updated, commit created, wave complete event published.

---

### REPEAT
**Goal:** Decide whether to start the next wave or stop.

**Verbs:**
- Check `current-vs-target-gap.md` for the next highest-leverage NOT-STARTED layer
- If the next wave has dependencies that aren't SHIPPED yet, wait
- If the context window is > 80% consumed, stop and summarize for the next session
- If the user requests it, start Wave N+1 immediately
- Publish: `{ cmd: 'publish', topic: 'arch.w0.RESULT', payload: { kind:'REPEAT', nextWave: N+1, reason:'...' } }`

---

## Bus Topic Conventions

All PIAFEU-R events are published via the Claws bus. Use these topics:

| Topic | When | Payload |
|-------|------|---------|
| `arch.w0.boot` | Architect peer registers | `{ kind:'BOOT', msg:'...' }` |
| `arch.w0.RESULT` | Architect decision or result | `{ kind:'PLAN\|REPEAT\|COMPLETE', ... }` |
| `wave.<N>.boot` | Wave N begins | `{ kind:'BOOT', layers:[...] }` |
| `wave.<N>.RESULT` | Per-phase result | `{ kind:'IMPLEMENT\|AUDIT\|FIX\|EVALUATE\|UPDATE', ... }` |
| `wave.<N>.complete` | Wave N fully shipped | `{ kind:'COMPLETE', layers:[...], commit:'<sha>' }` |
| `arch.w0.complete` | All waves planned/shipped | `{ kind:'COMPLETE', docs:[...], waves_planned:N }` |

---

## Deploy Step (exact — do not skip)

After every IMPLEMENT and FIX phase, deploy the bundle:

```bash
cd extension
npm run build
# Identify the extension install dir (run once):
ls ~/.vscode/extensions/ | grep claws
# Deploy:
cp -r dist ~/.vscode/extensions/<id>/dist/
```

Then in VS Code: `Ctrl+Shift+P` → `Developer: Restart Extension Host`.

Verify the correct version is running:
```bash
node -e "
const net=require('net');
const s=net.createConnection('<workspaceRoot>/.claws/claws.sock');
s.on('connect',()=>s.write(JSON.stringify({cmd:'introspect'})+'\n'));
s.on('data',d=>{ console.log(d.toString()); s.destroy(); });
"
```
The `extensionVersion` in the response must match `extension/package.json` version.

---

## Repeat Boundary Rules

A wave is complete when ALL of the following are true:
1. Build passes with zero TypeScript errors
2. Full test suite passes with zero failures
3. Stress test: 0 sequence gaps under 3× concurrent peer load
4. All audit findings CRITICAL+HIGH resolved
5. `current-vs-target-gap.md` updated to SHIPPED for all layers in scope
6. `wave.<N>.complete` published on the bus

**Never start the next wave until the current wave is complete.** A partially-shipped wave that is immediately followed by new code creates an untestable tangle. The wave boundary is a hard gate.

---

## Quick Reference Card

```
PLAN       → spawn architect, write plan doc, publish arch.wave.N.boot
IMPLEMENT  → write code, build after each file, publish wave.N.RESULT/IMPLEMENT
AUDIT      → spawn code-reviewer, collect findings, publish wave.N.RESULT/AUDIT
FIX        → fix CRITICAL+HIGH, rebuild, publish wave.N.RESULT/FIX
EVALUATE   → deploy bundle, run stress test, publish wave.N.RESULT/EVALUATE
UPDATE     → update gap doc + CHANGELOG + version, commit, publish wave.N.complete
REPEAT     → check next layer, start wave N+1 or stop
```
