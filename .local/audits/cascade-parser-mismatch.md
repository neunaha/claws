# Cascade Parser Mismatch — Root Cause

## Summary

`parseToolIndicators` regex requires `\s+` (≥1 whitespace) between `⏺` and the tool name, but
Claude TUI renders `⏺ToolName(args)` with **zero** whitespace — `⏺Bash(` not `⏺ Bash(` — so the
pattern never matches and `this.toolCount` stays at 0 forever, blocking the READY→WORKING transition.

## Evidence

- Sample pty bytes (stripped): `/tmp/cascade-pty-deep.txt` (62,547 bytes, offsets 64K–128K of terminal 2)
- Ticker `⏺` count in sample: **124**
- RE original `\s+` matches: **0**
- RE fixed `\s*` matches: **5**
- Full 271KB log stats: 149 tickers, orig=2 (both from task-description examples), fixed=7

### Hex proof — no whitespace between `⏺` and `Bash`

Bytes at the tool indicator (offset 673 in deep sample, absolute ~64673):

```
0d 0a 0d  e2 8f ba  42 61 73 68  28 6e 6f 64 65 20
\r \n \r  [  ⏺  ]  B  a  s  h   (  n  o  d  e  (sp)
```

`e2 8f ba` is U+23FA `⏺` (3 UTF-8 bytes), immediately followed by `42 61 73 68` = `Bash`.
No `0x20` (space) or any other whitespace byte between them.

### First 5 ticker contexts (stripped pty)

```
offset ~64673  "\r\n\r⏺Bash(node -e \"                                \rconstnet=require('net');…)\r  ⎿  Waiting…"
offset ~65540  "\r\n\r⏺\r\r\n…✳54\r…Orbiting…"     ← spinner frame
offset ~65779  "\r\n\r⏺\r\r\n…✻\r…✶\r…Orbiting…5"  ← spinner frame
offset ~66546  "\r\n\r⏺\r\r\n…✽\r…Orbiting…\r…✻\r…" ← spinner frame
offset ~66819  "\r\n\r⏺\r\r\n…✶\r…5\r…✻\r…✽\r…"     ← spinner frame
```

Breakdown of 124 `⏺` occurrences (deep sample):
- **Spinner frames** (`⏺` followed by `\r` then animation chars ✳✢✶✽✻·): 104
- **Tool indicators** (`⏺` followed directly by a word char): 19
- Other (assistant text rendering, status lines): 1

Of the 19 "word-char" cases, only 5 are full `⏺ToolName(args)` patterns — the others are status
lines like `⏺Error: Exit code 1`, `⏺(No output)`, `⏺Good - terminal …` (assistant text with
`⏺` as bullet decoration).

## Diagnosis

### What the parser expects vs what it sees

**Parser expectation** (current regex `/⏺\s+([\w]+)\(([^)]*)\)/g`):

The `\s+` requires at least one whitespace character between `⏺` and the tool name. This matches
the documentation format `⏺ Bash(args)` (note the space) used in READMEs and in the task-description
examples that appear verbatim in the pty log.

**What the actual TUI renders**:

The rendered output is `⏺Bash(args)` — the `⏺` bullet is immediately adjacent to the tool name
with no intervening byte. This is consistent across all 5 captured tool-call indicators in the
deep sample. The regex's `\s+` never matches and `toolCount` stays at 0.

**Why the state machine never advances**:

At mcp_server.js:802, the READY→WORKING guard is:
```javascript
if (this.toolCount > 0) {
  detected.push(this._transition('READY', 'WORKING', 'first-tool-call', now));
}
```
`this.toolCount` is incremented only by the `parseToolIndicators` return value. With 0 matches,
`toolCount` stays 0 for the entire worker lifetime regardless of actual Claude activity. Tokens
grow, heartbeats fire, but `current_action` never leaves `READY`.

**Secondary: arg content is garbled**

The args captured by `([^)]*)` contain `\r` cursor-return chars from terminal column wrapping.
Example: `node -e "                                \rconstnet=require('net');…)` — the spaces are
padding to the terminal column width, then `\r` resets the cursor, overwriting with continuation
bytes. This means tool-call argument strings are unusable for display. The tool NAME (`Bash`) is
captured correctly; only the arg content is corrupted. This is a pre-existing limitation of
single-pass ANSI stripping that does not handle cursor-addressing redraws.

## Recommended fix

**File**: `mcp_server.js` line 511

```diff
-  const RE = /⏺\s+([\w]+)\(([^)]*)\)/g;
+  const RE = /⏺\s*([\w]+)\(([^)]*)\)/g;
```

Change `\s+` → `\s*` (zero or more whitespace).

**Why this is safe** — the `\s*` change does not produce false positives:
- Spinner frames: `⏺\r\n✳…` — `\s*` consumes `\r\n`, then tries `[\w]+\(`, but `✳` is not a
  word char → no match ✓
- Status lines: `⏺Error: Exit code 1` — `Error` matches `[\w]+` but no `(` immediately follows → no match ✓
- Assistant text: `⏺Good - terminal id` — `Good` matches `[\w]+` but next char is ` ` not `(` → no match ✓
- Actual tool calls: `⏺Bash(…)` — `\s*`=0, `Bash` matches, `(` matches → match ✓

**Optional follow-up** (does not block the fix):

Strip `\r`-delimited column-wrap artifacts from the captured arg string so `summary` and
`target` fields are human-readable. One approach:

```javascript
// After capturing rawArgs, remove column-wrap padding+overwrite sequences
const cleanArgs = rawArgs.replace(/\s+\r[^\r\n]*/g, '').trim();
```

## Tests to add

1. **Fixture-based regression test** (`extension/test/heartbeat-parsers.test.js`):
   Add a fixture string `"\\r\\n\\r⏺Bash(ls -la)\\r  ⎿  Waiting…"` and assert
   `parseToolIndicators(fixture, 0)` returns `[{ tool: 'Bash', … }]`.

2. **No-space variant explicit test**:
   `parseToolIndicators("⏺Read(/some/file.ts)")` → `[{ tool: 'Read', … }]`

3. **Space variant backward-compat test** (documents format exists in task descriptions):
   `parseToolIndicators("⏺ Bash(echo hi)")` → `[{ tool: 'Bash', … }]`

4. **Spinner non-match test** (regression guard):
   `parseToolIndicators("⏺\\r✳Orbiting…")` → `[]`
