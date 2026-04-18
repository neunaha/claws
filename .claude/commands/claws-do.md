---
name: claws-do
description: The magic command. Describe any task in natural language and Claws figures out the terminal strategy — single worker, parallel fleet, or direct exec. Just say what you want done.
---

# /claws do <anything>

The user describes what they want. You figure out the right Claws pattern and execute it.

## What to do

Read the user's task description and decide the strategy:

**If it's a single command** (build, test, lint, deploy):
→ Create one wrapped terminal, run it visibly, read the result, close.

**If it's multiple independent tasks** (lint + test + build):
→ Create N wrapped terminals in parallel, fire all commands, monitor all, aggregate results, close all.

**If it's a complex mission** (refactor a module, fix a bug, audit the code):
→ Use `claws_worker` to spawn a Claude Code session with full permissions, send the mission, monitor via read_log.

**If it's a multi-step workflow** (test → if pass → deploy):
→ Run step by step in visible terminals, branch based on results.

Always:
- Use wrapped terminals so you can observe
- Name terminals descriptively
- Close every terminal when done
- Report results clearly

## Examples the user might say

- `/claws do run the tests` → single wrapped terminal, npm test, report
- `/claws do lint test and build` → 3 parallel workers
- `/claws do fix the bug in auth.ts` → spawn Claude worker with mission
- `/claws do deploy to staging` → single terminal, visible deploy
- `/claws do audit this codebase for security issues` → spawn Claude worker
- `/claws do start the dev server and watch for crashes` → watchdog pattern
