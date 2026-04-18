---
name: claws-doctor
description: One-shot health check for your Claws install. 8 checks, copy-pasteable fixes when anything fails. Use this whenever the claws_* tools aren't working or after install/update.
---

# /claws-doctor

Single self-diagnostic. Replaces the multi-step `/claws-fix` flow with one command that runs every check and prints a clear PASS/FAIL/WARN per item plus a copy-pasteable fix line.

## What to do

Run this single command and let the output speak for itself:

```bash
bash ~/.claws-src/scripts/doctor.sh
```

If `~/.claws-src` doesn't exist, the user hasn't installed yet — point them to:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/neunaha/claws/main/scripts/install.sh)
```

## After the output

The doctor already prints the verdict and the next steps. Do NOT add commentary or re-explain the output. The user can read it.

If the verdict is "All systems go" → say nothing more, the user is ready to use Claws.

If there are failures → tell the user ONE thing: "Run the fix shown above each FAIL line, then run `/claws-doctor` again. Once all pass, reload VS Code and restart Claude Code so the MCP tools load."
