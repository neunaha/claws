import * as fs from 'fs';
import * as path from 'path';

const SEGMENT_SIZE_THRESHOLD = 10 * 1024 * 1024; // 10 MB
const SEGMENT_AGE_THRESHOLD_MS = 3600_000;        // 1 hour
const MANIFEST_FLUSH_INTERVAL = 100;              // write manifest every N appends

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

interface SegmentEntry {
  id: string;
  path: string;
  size: number;
  first_ts: string | null;
  last_ts: string | null;
}

interface Manifest {
  stream: string;
  segments: SegmentEntry[];
  current_segment: string;
  current_offset: number;
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
  protected openedAt = 0;
  protected stream: fs.WriteStream | null = null;
  protected degraded = false;
  protected writeError: Error | null = null;
  protected segments: SegmentEntry[] = [];
  private appendCount = 0;
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
    // Crash recovery: try manifest first; fall back to directory scan.
    if (!this.tryRecoverFromManifest()) {
      const maxId = this.scanMaxSegmentId();
      this.segmentId = maxId + 1;
      this.openFreshSegment();
    }
    return Promise.resolve();
  }

  // Attempts to recover writer state from an existing manifest.json.
  // Returns true on success (stream opened, state restored), false otherwise.
  // Recovery rule: trust actual file size over the manifest's current_offset —
  // the manifest may be stale if the process crashed between appends and a flush.
  protected tryRecoverFromManifest(): boolean {
    const manifestPath = path.join(this.streamDir, 'manifest.json');
    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const m = JSON.parse(raw) as Partial<Manifest>;
      if (
        typeof m.current_segment !== 'string' ||
        typeof m.current_offset !== 'number' ||
        !Array.isArray(m.segments)
      ) return false;
      const segEntry = m.segments.find(s => s.id === m.current_segment);
      if (!segEntry) return false;
      const segPath = path.join(this.streamDir, segEntry.path);
      const stat = fs.statSync(segPath); // throws if file missing
      const segId = parseInt(m.current_segment, 10);
      if (isNaN(segId) || segId < 1) return false;

      this.segmentId = segId;
      this.currentSegmentPath = segPath;
      this.segments = m.segments.map(s => ({ ...s }));
      this.currentOffset = stat.size; // trust file, not stale manifest offset
      this.openedAt = Date.now();
      this.stream = fs.createWriteStream(segPath, { flags: 'a' });
      this.stream.on('error', (err) => {
        this.writeError = err;
        this.degraded = true;
      });
      return true;
    } catch {
      return false;
    }
  }

  protected writeManifest(): void {
    if (this.degraded || !this.streamDir) return;
    const manifest: Manifest = {
      stream: 'default',
      segments: this.segments.map(s => ({ ...s })),
      current_segment: this.segmentIdStr(),
      current_offset: this.currentOffset,
    };
    const manifestPath = path.join(this.streamDir, 'manifest.json');
    const tmpPath = `${manifestPath}.tmp`;
    try {
      // Atomic write: temp file in same dir (avoids cross-device rename failures).
      fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      fs.renameSync(tmpPath, manifestPath);
    } catch {
      // Non-fatal: manifest write failure must not crash the writer.
    }
  }

  // Scans the stream directory for the highest 4-digit segment ID prefix.
  // Returns 0 if the directory is empty or contains no matching files.
  protected scanMaxSegmentId(): number {
    try {
      let max = 0;
      for (const entry of fs.readdirSync(this.streamDir)) {
        const m = entry.match(/^(\d{4})-/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n > max) max = n;
        }
      }
      return max;
    } catch {
      return 0;
    }
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
    this.openedAt = Date.now();
    this.stream = fs.createWriteStream(this.currentSegmentPath, { flags: 'a' });
    this.stream.on('error', (err) => {
      this.writeError = err;
      this.degraded = true;
    });
    this.segments.push({
      id: this.segmentIdStr(),
      path: name,
      size: this.currentOffset,
      first_ts: null,
      last_ts: null,
    });
  }

  protected needsRotation(): boolean {
    return (
      this.currentOffset >= SEGMENT_SIZE_THRESHOLD ||
      Date.now() - this.openedAt >= SEGMENT_AGE_THRESHOLD_MS
    );
  }

  protected rotate(): void {
    // Update the closing segment's final size before moving on.
    const closing = this.segments[this.segments.length - 1];
    if (closing) closing.size = this.currentOffset;
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
    this.segmentId++;
    this.currentOffset = 0;
    this.openFreshSegment();
    this.writeManifest();
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

    // Rotate BEFORE writing so the record lands in the new segment.
    if (this.needsRotation()) {
      this.rotate();
    }

    const line = JSON.stringify(record) + '\n';
    const bytes = Buffer.byteLength(line, 'utf8');
    const cursor = `${this.segmentIdStr()}:${this.currentOffset}`;
    this.stream.write(line);
    this.currentOffset += bytes;

    // Update current segment metadata for manifest accuracy.
    const lastSeg = this.segments[this.segments.length - 1];
    if (lastSeg) {
      const ts = (record.ts_server as string | undefined) ?? new Date().toISOString();
      if (!lastSeg.first_ts) lastSeg.first_ts = ts;
      lastSeg.last_ts = ts;
      lastSeg.size = this.currentOffset;
    }

    this.appendCount++;
    if (this.appendCount % MANIFEST_FLUSH_INTERVAL === 0) {
      this.writeManifest();
    }

    return { cursor, sequence: -1 }; // sequence added in commit 4
  }

  close(): Promise<void> {
    this.writeManifest();
    return new Promise<void>((resolve) => {
      if (!this.stream) { resolve(); return; }
      this.stream.end(() => {
        this.stream = null;
        resolve();
      });
    });
  }
}
