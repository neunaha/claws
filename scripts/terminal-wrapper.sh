#!/bin/bash
# Claws terminal wrapper.
# Exec-replaces itself with script(1) so every byte that flows through the
# pty is logged to CLAWS_TERM_LOG. The Claws extension (or any orchestrator)
# tails that log to read what happened in this terminal — including TUI
# sessions like claude, vim, less, top that are opaque to shell integration.
#
# Set CLAWS_TERM_LOG in the extension's createTerminal env. Fallback
# derives a path from the PID so the wrapper never fails silently.

set -e

if [ -z "${CLAWS_TERM_LOG:-}" ]; then
  CLAWS_TERM_LOG="${PWD}/.claws/terminals/claws-$$.log"
fi

mkdir -p "$(dirname "$CLAWS_TERM_LOG")"
: > "$CLAWS_TERM_LOG"

# Mark ourselves as a wrapped session so any process inside can detect it.
export CLAWS_WRAPPED=1

SHELL_BIN="${SHELL:-/bin/zsh}"

# Do NOT use script's -F flag. -F flushes after every write, which splits
# Ink-based TUI renderers (Claude Code, etc.) into corrupted partial frames.
# Default buffering produces a clean terminal at the cost of ~1-2s log delay.

# Detect BSD (macOS) vs GNU/Linux script(1) — different argument order.
if script --version 2>&1 | grep -qi "util-linux"; then
  # Linux: script -q -c "command" outfile
  exec script -q -c "$SHELL_BIN -il" "$CLAWS_TERM_LOG"
else
  # macOS/BSD: script -q outfile command
  exec script -q "$CLAWS_TERM_LOG" "$SHELL_BIN" -il
fi
