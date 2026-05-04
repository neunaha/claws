import { stripAnsi } from './ansi-strip';

export interface CaptureSlice {
  bytes: string;
  offset: number;
  nextOffset: number;
  totalSize: number;
  truncated: boolean;
}

// Per-terminal bookkeeping. `buf` is a single growable Buffer whose first
// `length` bytes are live; anything past `length` is uninitialised capacity.
// `droppedBefore` counts bytes that have been trimmed off the front of the
// stream but still contribute to the absolute byte offset exposed to callers.
interface Entry {
  buf: Buffer;
  length: number;
  droppedBefore: number;
}

const MIN_INITIAL_CAPACITY = 8 * 1024; // 8 KB — tiny writes stay cheap.

export type CaptureAppendCallback = (id: string, chunkBytes: number) => void;

export class CaptureStore {
  private entries = new Map<string, Entry>();
  private maxBytesPerTerminal: number;
  // LH-9: optional sink that fires on every append. Used by ClawsServer to
  // refresh per-worker activity timestamps for the TTL watchdog. Single
  // callback (no list) — server is the only legitimate consumer.
  private onAppend: CaptureAppendCallback | null = null;

  constructor(maxBytesPerTerminal: number) {
    this.maxBytesPerTerminal = maxBytesPerTerminal;
  }

  /** LH-9: Wire an activity sink. Cleared by passing null. */
  setOnAppend(cb: CaptureAppendCallback | null): void {
    this.onAppend = cb;
  }

  append(id: string, chunk: string | Buffer): void {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    // Fire activity sink BEFORE the buffer mutation — cheap and cannot throw
    // (callback-side errors are swallowed) so we never lose activity signal
    // due to a mid-append exception. Zero-byte writes still count as a tick.
    try { this.onAppend?.(id, data.length); } catch { /* sink errors must not break capture */ }
    let entry = this.entries.get(id);
    if (!entry) {
      const initialCap = Math.max(MIN_INITIAL_CAPACITY, Math.min(data.length * 2, this.maxBytesPerTerminal));
      entry = { buf: Buffer.allocUnsafe(Math.max(initialCap, data.length)), length: 0, droppedBefore: 0 };
      this.entries.set(id, entry);
    }
    const needed = entry.length + data.length;
    if (needed > entry.buf.length) {
      // Grow to at least `needed`, capped at (maxBytes * 2) — the "+1 chunk"
      // slack lets one pre-trim append happen without rebuilding twice. We
      // allocate slightly oversized so common-case small writes don't churn.
      const cap = Math.max(
        needed,
        Math.min(entry.buf.length * 2, this.maxBytesPerTerminal * 2),
      );
      const bigger = Buffer.allocUnsafe(cap);
      entry.buf.copy(bigger, 0, 0, entry.length);
      entry.buf = bigger;
    }
    data.copy(entry.buf, entry.length);
    entry.length += data.length;
    this.trim(id);
  }

  private trim(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.length <= this.maxBytesPerTerminal) return;
    const overflow = entry.length - this.maxBytesPerTerminal;
    // Shift live window left by `overflow` bytes. Keep capacity unchanged —
    // no allocations, no GC pressure.
    entry.buf.copy(entry.buf, 0, overflow, entry.length);
    entry.length -= overflow;
    entry.droppedBefore += overflow;
  }

  read(id: string, offset: number | undefined, limit: number, strip: boolean): CaptureSlice {
    const entry = this.entries.get(id);
    if (!entry) {
      return { bytes: '', offset: 0, nextOffset: 0, totalSize: 0, truncated: false };
    }
    const totalSize = entry.droppedBefore + entry.length;
    const effectiveOffset = offset == null
      ? Math.max(entry.droppedBefore, totalSize - limit)
      : Math.max(offset, entry.droppedBefore);
    const startInPresent = effectiveOffset - entry.droppedBefore;
    const endInPresent = Math.min(entry.length, startInPresent + limit);
    const sliceLength = Math.max(0, endInPresent - startInPresent);
    // subarray returns a view into the same underlying ArrayBuffer — zero-copy
    // until we call toString(), which only allocates for the actual slice.
    const view = entry.buf.subarray(startInPresent, startInPresent + sliceLength);
    const text = strip ? stripAnsi(view.toString('utf8')) : view.toString('utf8');
    return {
      bytes: text,
      offset: effectiveOffset,
      nextOffset: effectiveOffset + sliceLength,
      totalSize,
      truncated: totalSize > effectiveOffset + sliceLength,
    };
  }

  clear(id: string): void {
    this.entries.delete(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  setMaxBytesPerTerminal(bytes: number): void {
    this.maxBytesPerTerminal = bytes;
    for (const id of this.entries.keys()) this.trim(id);
  }

  getMaxBytesPerTerminal(): number {
    return this.maxBytesPerTerminal;
  }
}
