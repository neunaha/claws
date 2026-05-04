---
name: claws-report
description: Bundle logs and diagnostics into a shareable file for bug reports.
---

# /claws-report

## What this does
Runs `scripts/report.sh` which captures OS info, Claws source state, extension state, socket status, MCP handshake test, shell hook state, recent install logs, and VS Code extension host logs — all into a single redacted text file you can attach to a GitHub issue.

## Behavior
- Run from the project root where the issue is occurring:
  ```bash
  bash ~/.claws-src/scripts/report.sh "$(pwd)"
  ```
- The file path is printed at the top of the output (e.g. `~/claws-report-<timestamp>.txt`)
- The report redacts `$HOME` paths and strips 32+ character tokens — review before sharing
- Tell the user the file path and offer to help write a GitHub issue title

## Examples
```
/claws-report
generate a diagnostic report
something is broken — help me file a bug
```

## When NOT to use
If Claws is not installed at all, nothing to report — point to the install docs.
If the issue is just an outdated version, use /claws-update first.
