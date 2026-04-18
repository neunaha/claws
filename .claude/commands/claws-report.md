---
name: claws-report
description: Generate a diagnostic report for Claws — bundles install logs, system info, extension state, project-local file presence, VS Code extension logs, MCP handshake test, and socket status into a single shareable file. Run when something isn't working and you want to report the issue.
---

# /claws-report

Run this when Claws isn't working as expected. It bundles everything needed to diagnose the problem into a single redacted file.

Run this from the **project root** where you're experiencing the issue:

```bash
bash ~/.claws-src/scripts/report.sh "$(pwd)"
```

## What the report contains

- **System**: OS, Node, npm, git, bash versions
- **Claws source clone**: git HEAD, branch, remote
- **Extension state**: version, main entry, bundle size, node-pty status
- **Editor symlinks**: `~/.vscode/extensions/neunaha.claws-*` presence
- **Project-local files**: `.mcp.json`, `.claws-bin/`, `.claude/`, `CLAUDE.md` presence + size
- **Socket state**: `.claws/claws.sock` live/stale/missing
- **MCP handshake test**: proves the MCP server can be started and responds
- **Shell hook state**: which rc files have the hook installed
- **Latest install log**: last 100 lines of the most recent `/tmp/claws-install-*.log`
- **VS Code extension host logs**: last 50 claws-related entries

## Privacy

The report redacts `$HOME` paths to `$HOME` and strips anything that looks like a 32+ character token. Review it before sharing — it's a plain text file you can edit.

## After the report generates

The file path is printed at the top (e.g. `~/claws-report-20260418-143022.txt`).

**Share it to get help:**
- Open a GitHub issue: https://github.com/neunaha/claws/issues/new
- Attach the file OR paste its contents — both work.

Tell the user the report file path and ask if they want help opening an issue. If they do, help them write a clear title describing what failed.
