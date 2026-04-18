const ANSI_PATTERN = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-ntqry=><]/g;
const CTRL_PATTERN = /[\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '').replace(CTRL_PATTERN, '');
}
