import * as fs from 'fs';
import * as path from 'path';

export interface AppendResult {
  cursor: string;
  sequence: number;
}

export interface LogRecord {
  topic?: string;
  from?: string;
  ts_server?: string;
  sequence?: number;
  payload?: unknown;
  [key: string]: unknown;
}

/**
 * Append-only writer for the persistent event log.
 *
 * Stream identification: a single "default" stream per workspace, covering all
 * topics. Per-topic partitioning is deferred to v2 if throughput demands it.
 *
 * Cursor format: "<4-digit-segment-id>:<decimal-byte-offset>", e.g. "0002:1428".
 * Byte offsets allow efficient seeking via fs.createReadStream(path, {start}).
 */
export class EventLogWriter {
  protected streamDir = '';
  protected segmentId = 0;
  protected currentOffset = 0;
  protected currentSegmentPath = '';
  protected stream: fs.WriteStream | null = null;
  protected degraded = false;
  protected writeError: Error | null = null;
  // Serialised append queue — guarantees ordering under concurrent publishes.
  private appendQueue: Promise<void> = Promise.resolve();

  open(workspaceRoot: string): Promise<void> {
    this.streamDir = path.join(workspaceRoot, '.claws', 'events', 'default');
    try {
      fs.mkdirSync(this.streamDir, { recursive: true });
    } catch {
      this.degraded = true;
      return Promise.resolve();
    }
    this.segmentId = 1;
    this.openFreshSegment();
    return Promise.resolve();
  }

  protected makeSegmentName(id: number): string {
    const pad = String(id).padStart(4, '0');
    const iso = new Date().toISOString().slice(0, 13); // "2026-04-28T18"
    return `${pad}-${iso}.jsonl`;
  }

  protected openFreshSegment(): void {
    const name = this.makeSegmentName(this.segmentId);
    this.currentSegmentPath = path.join(this.streamDir, name);
    try {
      this.currentOffset = fs.statSync(this.currentSegmentPath).size;
    } catch {
      this.currentOffset = 0;
    }
    this.stream = fs.createWriteStream(this.currentSegmentPath, { flags: 'a' });
    this.stream.on('error', (err) => {
      this.writeError = err;
      this.degraded = true;
    });
  }

  segmentIdStr(): string {
    return String(this.segmentId).padStart(4, '0');
  }

  currentCursor(): string {
    return `${this.segmentIdStr()}:${this.currentOffset}`;
  }

  append(record: LogRecord): Promise<AppendResult> {
    if (this.degraded || !this.stream) {
      return Promise.resolve({ cursor: '', sequence: -1 });
    }
    const result = this.appendQueue.then(() => this.doAppend(record));
    this.appendQueue = result.then(() => undefined).catch(() => undefined);
    return result;
  }

  protected doAppend(record: LogRecord): AppendResult {
    if (!this.stream) return { cursor: '', sequence: -1 };
    if (this.writeError) throw this.writeError;
    const line = JSON.stringify(record) + '\n';
    const bytes = Buffer.byteLength(line, 'utf8');
    const cursor = `${this.segmentIdStr()}:${this.currentOffset}`;
    this.stream.write(line);
    this.currentOffset += bytes;
    return { cursor, sequence: -1 }; // sequence added in commit 4
  }

  close(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.stream) { resolve(); return; }
      this.stream.end(() => {
        this.stream = null;
        resolve();
      });
    });
  }
}
