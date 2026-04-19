// Strip ANSI escape sequences and most other control bytes from a pty log so
// it can be rendered as plain text. Handles the real-world sequences we see
// from wrapped terminals (shells, vim, claude, ink-based TUIs, etc):
//
//   - CSI (Control Sequence Introducer): ESC [ ... final
//     Covers simple `\x1b[0m`, parameterized `\x1b[?25h`, `\x1b[38;5;123m`,
//     `\x1b[1;31;48;2;255;100;100m`, etc. Parameter bytes 0x30–0x3F,
//     intermediate bytes 0x20–0x2F, final byte 0x40–0x7E.
//
//   - OSC (Operating System Command): ESC ] ... terminator
//     Used for terminal titles, hyperlinks, and iTerm proprietary sequences.
//     Terminator is either BEL (\x07) or ST (ESC \\).
//
//   - DCS (Device Control String): ESC P ... ST
//     Used by sixel graphics, termcap queries, etc.
//
//   - APC / PM / SOS: ESC _ / ESC ^ / ESC X — same terminator as DCS.
//
//   - Single-char ESC sequences: ESC ( B, ESC ) 0, ESC =, ESC >, ESC M …
//     Mostly charset selection and cursor save/restore.
//
// After removing escape sequences we also strip stray C0/C1 control bytes
// (with \t, \n, \r spared — they are meaningful plaintext).

const CSI_PATTERN = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;

// OSC: ESC ] ... (BEL | ESC \). Use a non-greedy match so consecutive
// sequences don't collapse into one. `[\s\S]` because OSC strings can
// technically contain newlines (e.g. tmux pass-through).
const OSC_PATTERN = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;

// DCS / SOS / PM / APC: ESC [P^_X] ... ESC \\.
const DCS_PATTERN = /\x1b[P^_X][\s\S]*?\x1b\\/g;

// Single-char ESC followed by a final byte from 0x20–0x7E (non-CSI/OSC/DCS).
// Examples: `\x1b(B` (G0 = ASCII), `\x1b=` (keypad), `\x1bM` (reverse index).
// Must come AFTER CSI/OSC/DCS so we don't eat their introducers.
const SINGLE_ESC_PATTERN = /\x1b[\x20-\x2f]*[\x30-\x7e]/g;

// Bare ESC (no follow-on byte, e.g. ESC at end of stream) + C0 controls
// except tab/newline/carriage-return, plus DEL.
const CTRL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function stripAnsi(text: string): string {
  if (!text) return text;
  return text
    .replace(OSC_PATTERN, '')
    .replace(DCS_PATTERN, '')
    .replace(CSI_PATTERN, '')
    .replace(SINGLE_ESC_PATTERN, '')
    .replace(CTRL_PATTERN, '');
}
