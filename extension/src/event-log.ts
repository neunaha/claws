import * as fs from 'fs';
import * as path from 'path';
import { matchTopic } from './topic-utils';

const SEGMENT_SIZE_THRESHOLD = 10 * 1024 * 1024; // 10 MB
const SEGMENT_AGE_THRESHOLD_MS = 3600_000;        // 1 hour
const MANIFEST_FLUSH_INTERVAL = 100;              // write manifest every N appends

// ── Cross-cutting cursor contract ─────────────────────────────────────────────
// Cursor format: "<4-digit-segment-id>:<decimal-byte-offset>", e.g. "0002:1428".
// Segment ID is zero-padded to 4 digits. Byte offset is a decimal integer.
// Consumers seek to exactly this offset via fs.createReadStream(path, {start}).
// This contract is shared with w3 (reader) and w4 (retention/observability).

export function formatCursor(segmentId: number, offset: number): string {
  return `${String(segmentId).padStart(4, '0')}:${offset}`;
}

export function parseCursor(cursor: string): { segmentId: number; offset: number } | null {
  const m = cursor.match(/^(\d{4}):(\d+)$/);
  if (!m) return null;
  return { segmentId: parseInt(m[1], 10), offset: parseInt(m[2], 10) };
}

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
  sequence_counter?: number;
}

export interface EventLogWriterOptions {
  /** Override the size rotation threshold (bytes). Default: 10 MB. */
  sizeThreshold?: number;
  /** Override the age rotation threshold (ms). Default: 1 hour. */
  ageThresholdMs?: number;
}

/**
 * Append-only writer for the persistent event log.
 *
 * Stream identification: a single "default" stream per workspace, covering all
 * topics. Per-topic partitioning is deferred to v2 if throughput demands it.
 *
 * Cursor format: "<4-digit-segment-id>:<decimal-byte-offset>", e.g. "0002:1428".
 * Byte offsets allow efficient seeking via fs.createReadStream(path, {start}).
 *
 * Writes are synchronous (fs.writeSync) so segment files are immediately visible
 * on disk after each append, which simplifies crash recovery and testing.
 */
const COMPACT_SIZE_THRESHOLD = 1024; // segments < 1 KB are candidates for merging

export class EventLogWriter {
  protected streamDir = '';
  protected segmentId = 0;
  protected currentOffset = 0;
  protected currentSegmentPath = '';
  protected openedAt = 0;
  protected fd: number | null = null;
  protected fdDeferred = false;  // true when segment path is set but fs.openSync not yet called
  protected degraded = false;
  protected segments: SegmentEntry[] = [];
  private appendCount = 0;
  // Per-stream sequence counter. Monotonically increasing across rotations.
  // Persisted in manifest.json; on recovery, restored to last_value+1 (one gap
  // per restart, detectable, never re-issues a sequence).
  // Safe up to Number.MAX_SAFE_INTEGER ≈ 285 years at 1 000 events/s.
  private sequenceCounter = 0;
  // Serialised append queue — guarantees ordering under concurrent publishes.
  private appendQueue: Promise<void> = Promise.resolve();
  private readonly sizeThreshold: number;
  private readonly ageThresholdMs: number;
  // Per-segment topic index: accumulated in memory, flushed to .idx on close/rotate.
  private idxEntries: Array<{ topic: string; offset: number }> = [];

  constructor(opts?: EventLogWriterOptions) {
    this.sizeThreshold = opts?.sizeThreshold ?? SEGMENT_SIZE_THRESHOLD;
    this.ageThresholdMs = opts?.ageThresholdMs ?? SEGMENT_AGE_THRESHOLD_MS;
  }

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
  // Returns true on success (fd opened, state restored), false otherwise.
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
      const segId = parseInt(m.current_segment, 10);
      if (isNaN(segId) || segId < 1) return false;

      this.segmentId = segId;
      this.currentSegmentPath = segPath;
      this.segments = m.segments.map(s => ({ ...s }));
      this.openedAt = Date.now();

      // File may not exist yet when the segment was opened lazily and no events
      // arrived before the process restarted. Treat it as a deferred segment.
      let statSize = 0;
      let fileExists = true;
      try {
        statSize = fs.statSync(segPath).size;
      } catch {
        fileExists = false;
      }

      if (fileExists) {
        this.currentOffset = statSize; // trust file, not stale manifest offset
        this.fd = fs.openSync(segPath, 'a');
        this.fdDeferred = false;
      } else {
        this.currentOffset = 0;
        this.fd = null;
        this.fdDeferred = true;
      }
      // Restore sequence counter with +1 so the last issued sequence before crash
      // is never re-issued. Cost: one detectable gap per restart — acceptable.
      if (typeof m.sequence_counter === 'number' && m.sequence_counter >= 0) {
        this.sequenceCounter = m.sequence_counter + 1;
      }
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
      sequence_counter: this.sequenceCounter,
    };
    const manifestPath = path.join(this.streamDir, 'manifest.json');
    const tmpPath = `${manifestPath}.tmp`;
    try {
      // F7: fsync before rename — mirrors M-29/M-43 pattern; manifest survives
      // power-cut or SIGKILL after write but before kernel page-cache flush.
      const fd = fs.openSync(tmpPath, 'w');
      try {
        fs.writeSync(fd, JSON.stringify(manifest, null, 2) + '\n');
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
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
    // Defer fs.openSync until the first doAppend call — file only created when
    // an event actually arrives, so activation produces no empty .jsonl files.
    this.fd = null;
    this.fdDeferred = true;
    this.currentOffset = 0;
    this.openedAt = Date.now();
    this.segments.push({
      id: this.segmentIdStr(),
      path: name,
      size: 0,
      first_ts: null,
      last_ts: null,
    });
  }

  protected needsRotation(): boolean {
    return (
      this.currentOffset >= this.sizeThreshold ||
      Date.now() - this.openedAt >= this.ageThresholdMs
    );
  }

  private idxPath(): string {
    return this.currentSegmentPath.replace(/\.jsonl$/, '.idx');
  }

  private flushIdx(): void {
    if (!this.idxEntries.length || !this.currentSegmentPath) return;
    const content = this.idxEntries.map(e => `${e.topic}\t${e.offset}`).join('\n') + '\n';
    const tmpPath = this.idxPath() + '.tmp';
    try {
      fs.writeFileSync(tmpPath, content, 'utf8');
      fs.renameSync(tmpPath, this.idxPath());
    } catch { /* non-fatal: idx loss is recoverable */ }
  }

  protected rotate(): void {
    // Update the closing segment's final size before moving on.
    const closing = this.segments[this.segments.length - 1];
    if (closing) closing.size = this.currentOffset;
    // Flush idx for the closing segment before releasing the fd.
    this.flushIdx();
    this.idxEntries = [];
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
    }
    this.fdDeferred = false;
    this.segmentId++;
    this.currentOffset = 0;
    this.openFreshSegment(); // sets fdDeferred = true for the new segment
    // Eager open: rotation only fires inside doAppend (never at startup), so the
    // lazy guarantee (no empty .jsonl at activation) does not apply here.
    try {
      this.fd = fs.openSync(this.currentSegmentPath, 'a');
      this.currentOffset = fs.fstatSync(this.fd).size;
      this.fdDeferred = false;
    } catch {
      this.degraded = true;
    }
    this.writeManifest();
  }

  segmentIdStr(): string {
    return String(this.segmentId).padStart(4, '0');
  }

  currentCursor(): string {
    return formatCursor(this.segmentId, this.currentOffset);
  }

  get isDegraded(): boolean { return this.degraded; }

  append(record: LogRecord): Promise<AppendResult> {
    if (this.degraded || (this.fd === null && !this.fdDeferred)) {
      return Promise.resolve({ cursor: '', sequence: -1 });
    }
    const result = this.appendQueue.then(() => this.doAppend(record));
    this.appendQueue = result.then(() => undefined).catch(() => undefined);
    return result;
  }

  protected doAppend(record: LogRecord): AppendResult {
    // Lazy open: materialise the segment file on first write.
    if (this.fd === null && !this.degraded && this.fdDeferred) {
      try {
        this.fd = fs.openSync(this.currentSegmentPath, 'a');
        this.currentOffset = fs.fstatSync(this.fd).size;
        this.fdDeferred = false;
      } catch {
        this.degraded = true;
        return { cursor: '', sequence: -1 };
      }
    }

    if (this.fd === null) return { cursor: '', sequence: -1 };

    // Rotate BEFORE writing so the record lands in the new segment.
    if (this.needsRotation()) {
      this.rotate();
    }

    // After rotation, check if we're in degraded mode (rotate can set it).
    if (this.degraded || this.fd === null) return { cursor: '', sequence: -1 };

    // Stamp sequence and ts_server onto the stored record (immutable enrichment).
    const seq = this.sequenceCounter++;
    const ts = (record.ts_server as string | undefined) ?? new Date().toISOString();
    const enriched: LogRecord = { ...record, ts_server: ts, sequence: seq };

    const line = JSON.stringify(enriched) + '\n';
    const buf = Buffer.from(line, 'utf8');
    const cursor = formatCursor(this.segmentId, this.currentOffset);
    const lineOffset = this.currentOffset; // byte position of this record's start

    try {
      fs.writeSync(this.fd, buf);
    } catch (err) {
      this.degraded = true;
      throw err;
    }
    this.currentOffset += buf.length;

    // Track topic + offset for the per-segment .idx file.
    const idxTopic = typeof enriched.topic === 'string' ? enriched.topic : '';
    this.idxEntries.push({ topic: idxTopic, offset: lineOffset });

    // Update current segment metadata for manifest accuracy.
    const lastSeg = this.segments[this.segments.length - 1];
    if (lastSeg) {
      if (!lastSeg.first_ts) lastSeg.first_ts = ts;
      lastSeg.last_ts = ts;
      lastSeg.size = this.currentOffset;
    }

    this.appendCount++;
    if (this.appendCount % MANIFEST_FLUSH_INTERVAL === 0) {
      this.writeManifest();
    }

    return { cursor, sequence: seq };
  }

  close(): Promise<void> {
    this.flushIdx();
    this.idxEntries = [];
    this.writeManifest();
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
    }
    return Promise.resolve();
  }

  /**
   * Delete segments whose file mtime is older than `retentionDays` days.
   * Closes the open fd if the active segment is among those deleted, then
   * re-opens a fresh (deferred) segment so the writer remains usable.
   * Serialised through the append queue to avoid races with concurrent appends.
   */
  runRetention(retentionDays: number): Promise<void> {
    const p = this.appendQueue.then(() => this._doRetention(retentionDays));
    this.appendQueue = p.then(() => undefined).catch(() => undefined);
    return p;
  }

  private _doRetention(retentionDays: number): void {
    if (this.degraded || !this.streamDir) return;
    const cutoffMs = Date.now() - retentionDays * 86_400_000;
    const toDelete: Set<string> = new Set();

    for (const seg of this.segments) {
      const filePath = path.join(this.streamDir, seg.path);
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
      } catch {
        toDelete.add(seg.id);
        continue;
      }
      if (mtimeMs < cutoffMs) {
        // If this is the active segment, close the fd before unlinking.
        if (seg.id === this.segmentIdStr() && this.fd !== null) {
          this.flushIdx();
          this.idxEntries = [];
          try { fs.closeSync(this.fd); } catch { /* ignore */ }
          this.fd = null;
          this.fdDeferred = false;
        }
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
        const idxFilePath = filePath.replace(/\.jsonl$/, '.idx');
        try { fs.unlinkSync(idxFilePath); } catch { /* ignore */ }
        toDelete.add(seg.id);
      }
    }

    if (toDelete.size === 0) return;

    const deletedCurrent = toDelete.has(this.segmentIdStr());
    this.segments = this.segments.filter(s => !toDelete.has(s.id));

    if (deletedCurrent) {
      // Re-initialise writer with a fresh deferred segment so appends can resume.
      this.segmentId++;
      this.openFreshSegment();
    }
    this.writeManifest();
  }

  /**
   * Merge all non-current segments smaller than 1 KB into a single segment.
   * If the active segment is also small, it is included in the merge.
   * Preserves event sequence ordering. Writes an .idx file for the merged segment.
   * Serialised through the append queue.
   */
  compact(): Promise<void> {
    const p = this.appendQueue.then(() => this._doCompact());
    this.appendQueue = p.then(() => undefined).catch(() => undefined);
    return p;
  }

  private _doCompact(): void {
    if (this.degraded || !this.streamDir) return;

    const smallSegs = this.segments
      .filter(s => s.size < COMPACT_SIZE_THRESHOLD)
      .sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));

    if (smallSegs.length < 2) return;

    const chunks: Buffer[] = [];
    for (const seg of smallSegs) {
      const filePath = path.join(this.streamDir, seg.path);
      try { chunks.push(fs.readFileSync(filePath)); } catch { /* skip missing */ }
    }
    if (chunks.length < 2) return;

    const merged = Buffer.concat(chunks);
    const firstSeg = smallSegs[0];
    const mergedPath = path.join(this.streamDir, firstSeg.path);

    // Close active fd if the current segment is part of the merge.
    const currentInMerge = smallSegs.some(s => s.id === this.segmentIdStr());
    if (currentInMerge && this.fd !== null) {
      this.flushIdx();
      this.idxEntries = [];
      try { fs.closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
      this.fdDeferred = false;
    }

    // Write merged content atomically.
    const tmpPath = mergedPath + '.tmp';
    try {
      fs.writeFileSync(tmpPath, merged);
      fs.renameSync(tmpPath, mergedPath);
    } catch {
      return;
    }

    // Remove source files (all except firstSeg).
    const smallIds = new Set(smallSegs.map(s => s.id));
    for (const seg of smallSegs.slice(1)) {
      const filePath = path.join(this.streamDir, seg.path);
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      const idxFilePath = filePath.replace(/\.jsonl$/, '.idx');
      try { fs.unlinkSync(idxFilePath); } catch { /* ignore */ }
    }
    // Remove old idx for firstSeg (will be rebuilt from merged content).
    try { fs.unlinkSync(mergedPath.replace(/\.jsonl$/, '.idx')); } catch { /* ignore */ }

    // Update manifest.
    const mergedEntry: SegmentEntry = {
      id: firstSeg.id,
      path: firstSeg.path,
      size: merged.length,
      first_ts: firstSeg.first_ts,
      last_ts: smallSegs[smallSegs.length - 1].last_ts,
    };
    this.segments = this.segments
      .filter(s => !smallIds.has(s.id))
      .concat(mergedEntry)
      .sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));

    // Point the writer at the merged segment.
    this.segmentId = parseInt(firstSeg.id, 10);
    this.currentSegmentPath = mergedPath;
    this.currentOffset = merged.length;
    try {
      this.fd = fs.openSync(mergedPath, 'a');
      this.fdDeferred = false;
    } catch {
      this.degraded = true;
    }

    // Rebuild .idx from merged content.
    this._rebuildIdxForPath(mergedPath);

    this.writeManifest();
  }

  private _rebuildIdxForPath(segPath: string): void {
    try {
      const buf = fs.readFileSync(segPath);
      const lines = buf.toString('utf8').split('\n');
      let byteOffset = 0;
      const entries: string[] = [];
      for (const line of lines) {
        if (line.trim()) {
          try {
            const rec = JSON.parse(line) as LogRecord;
            const topic = typeof rec.topic === 'string' ? rec.topic : '';
            entries.push(`${topic}\t${byteOffset}`);
          } catch { /* skip malformed */ }
        }
        byteOffset += Buffer.byteLength(line, 'utf8') + 1; // +1 for \n
      }
      if (entries.length === 0) return;
      const idxContent = entries.join('\n') + '\n';
      const idxFilePath = segPath.replace(/\.jsonl$/, '.idx');
      const tmpPath = idxFilePath + '.tmp';
      fs.writeFileSync(tmpPath, idxContent, 'utf8');
      fs.renameSync(tmpPath, idxFilePath);
    } catch { /* non-fatal */ }
  }
}

export class EventLogReader {
  private readonly streamDir: string;

  constructor(workspaceRoot: string) {
    this.streamDir = path.join(workspaceRoot, '.claws', 'events', 'default');
  }

  async *scanFrom(cursor: string, topicPattern: string): AsyncIterable<LogRecord> {
    const parsed = parseCursor(cursor);
    if (!parsed) return;
    const { segmentId, offset } = parsed;
    const segments = this.listSegments();
    const relevant = segments
      .filter(s => s.id >= segmentId)
      .sort((a, b) => a.id - b.id);
    for (const seg of relevant) {
      const startOffset = seg.id === segmentId ? offset : 0;
      yield* this.readSegmentFrom(seg.filePath, startOffset, topicPattern);
    }
  }

  private listSegments(): Array<{ id: number; filePath: string }> {
    try {
      const raw = fs.readFileSync(path.join(this.streamDir, 'manifest.json'), 'utf8');
      const m = JSON.parse(raw) as { segments?: Array<{ id: string; path: string }> };
      if (Array.isArray(m.segments)) {
        return m.segments
          .map(s => ({ id: parseInt(s.id, 10), filePath: path.join(this.streamDir, s.path) }))
          .filter(s => !isNaN(s.id));
      }
    } catch { /* fall through */ }
    try {
      return fs.readdirSync(this.streamDir)
        .filter(n => /^\d{4}-.*\.jsonl$/.test(n))
        .map(n => ({ id: parseInt(n.slice(0, 4), 10), filePath: path.join(this.streamDir, n) }))
        .filter(s => !isNaN(s.id));
    } catch {
      return [];
    }
  }

  private async *readSegmentFrom(
    filePath: string,
    startOffset: number,
    topicPattern: string,
  ): AsyncGenerator<LogRecord> {
    let data: Buffer;
    try {
      const stat = fs.statSync(filePath);
      const size = stat.size - startOffset;
      if (size <= 0) return;
      const fd = fs.openSync(filePath, 'r');
      try {
        data = Buffer.alloc(size);
        fs.readSync(fd, data, 0, size, startOffset);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    for (const line of data.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as LogRecord;
        if (typeof record.topic === 'string' && matchTopic(record.topic, topicPattern)) {
          yield record;
        }
      } catch { /* skip malformed lines */ }
    }
  }
}
