import { stripAnsi } from './ansi-strip';

export interface CaptureSlice {
  bytes: string;
  offset: number;
  nextOffset: number;
  totalSize: number;
  truncated: boolean;
}

export class CaptureStore {
  private buffers = new Map<string, Buffer[]>();
  private totals = new Map<string, number>();
  private offsets = new Map<string, number>();
  private maxBytesPerTerminal: number;

  constructor(maxBytesPerTerminal: number) {
    this.maxBytesPerTerminal = maxBytesPerTerminal;
  }

  append(id: string, chunk: string | Buffer): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    if (!this.buffers.has(id)) {
      this.buffers.set(id, []);
      this.totals.set(id, 0);
      this.offsets.set(id, 0);
    }
    const list = this.buffers.get(id)!;
    list.push(buf);
    this.totals.set(id, (this.totals.get(id) ?? 0) + buf.length);
    this.trim(id);
  }

  private trim(id: string): void {
    const list = this.buffers.get(id);
    if (!list) return;
    let total = this.totals.get(id) ?? 0;
    while (total > this.maxBytesPerTerminal && list.length > 1) {
      const dropped = list.shift()!;
      total -= dropped.length;
      this.offsets.set(id, (this.offsets.get(id) ?? 0) + dropped.length);
    }
    this.totals.set(id, total);
  }

  read(id: string, offset: number | undefined, limit: number, strip: boolean): CaptureSlice {
    const list = this.buffers.get(id) ?? [];
    const dropped = this.offsets.get(id) ?? 0;
    const present = Buffer.concat(list);
    const totalSize = dropped + present.length;

    const effectiveOffset = offset == null
      ? Math.max(dropped, totalSize - limit)
      : Math.max(offset, dropped);
    const startInPresent = effectiveOffset - dropped;
    const slice = present.subarray(startInPresent, startInPresent + limit);
    const text = strip ? stripAnsi(slice.toString('utf8')) : slice.toString('utf8');

    return {
      bytes: text,
      offset: effectiveOffset,
      nextOffset: effectiveOffset + slice.length,
      totalSize,
      truncated: totalSize > effectiveOffset + slice.length,
    };
  }

  clear(id: string): void {
    this.buffers.delete(id);
    this.totals.delete(id);
    this.offsets.delete(id);
  }

  has(id: string): boolean {
    return this.buffers.has(id);
  }
}
