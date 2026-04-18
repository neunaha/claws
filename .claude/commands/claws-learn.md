---
name: claws-learn
description: Interactive prompt guide — teaches you how to use Claws through examples at your level. From first-timer to fleet commander.
---

# /claws learn

Teach the user how to talk to Claws naturally.

## What to do

Show this guide, then ask what level they want to explore:

---

**Welcome to Claws. Here's how to use it — just talk naturally.**

**Beginner** — start here:
```
/claws do run my tests
/claws do build the project
/claws watch
```

**Intermediate** — parallel work:
```
/claws do lint test and typecheck in parallel
/claws do start the server and run tests at the same time
```

**Advanced** — AI workers:
```
/claws go fix the bug in auth.ts
/claws go write tests for the payment module
/claws go audit this codebase for security issues
```

**Power user** — fleet orchestration:
```
/claws do spawn 3 workers: lint, test, build — run all in parallel
/claws go refactor the entire API layer to use async/await
```

**The golden rule:** just describe what you want done. Claws figures out whether to use one terminal, three terminals, or a full AI worker fleet.

**All commands:**
- `/claws` — status dashboard
- `/claws do <task>` — magic command, does anything
- `/claws go <mission>` — spawn an AI worker
- `/claws watch` — see all terminals
- `/claws learn` — this guide
- `/claws setup` — first-time install
- `/claws update` — pull latest + full rebuild
- `/claws cleanup` — close all worker terminals

---

After showing the guide, ask: "Want to try something? Just tell me what you want to build, test, or fix."
