import {
  sortSessionSummaries,
  summarizeSnapshot,
  type SessionSnapshot,
  type SessionStore,
  type SessionSummary,
} from "../../types.js";
import { SerialOperationQueue } from "../sqlite/database.js";
import type { JsonlFileSystem } from "./filesystem.js";

const JSONL_FORMAT_VERSION = 1 as const;
const DEFAULT_COMPACT_AFTER_LINES = 100;

interface JsonlSnapshotRecord {
  readonly format: typeof JSONL_FORMAT_VERSION;
  readonly type: "snapshot";
  readonly snapshot: SessionSnapshot;
}

export interface JsonlSessionStoreOptions {
  /** Flush file data to disk on every append / atomic rewrite. Defaults to `false`. */
  readonly fsync?: boolean;
  /**
   * Open without writing: `load()` skips any torn final line in memory without truncating
   * the file, and `save()` / `compact()` reject with `JsonlStorageReadOnlyError`.
   */
  readonly readOnly?: boolean;
  /**
   * Automatically compact a session file to a single snapshot line once it reaches this
   * many lines. Pass `0` to disable automatic compaction. Defaults to `100`.
   */
  readonly compactAfterLines?: number;
}

export class JsonlStorageReadOnlyError extends Error {
  constructor() {
    super("JSONL session store is open read-only");
    this.name = "JsonlStorageReadOnlyError";
  }
}

export class JsonlCorruptionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "JsonlCorruptionError";
  }
}

function encodeSessionFileName(sessionId: string): string {
  if (!sessionId || sessionId.trim().length === 0) {
    throw new Error("sessionId must be a non-empty string");
  }
  // Percent-encode anything outside `[A-Za-z0-9._-]` and avoid `.` / `..` segments.
  const encoded = sessionId.replace(/[^A-Za-z0-9_-]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
  return `${encoded}.jsonl`;
}

function joinPath(directory: string, fileName: string): string {
  const trimmed = directory.replace(/[\\/]+$/, "");
  return `${trimmed}/${fileName}`;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function isSnapshotRecord(value: unknown): value is JsonlSnapshotRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.format === JSONL_FORMAT_VERSION &&
    candidate.type === "snapshot" &&
    typeof candidate.snapshot === "object" &&
    candidate.snapshot !== null &&
    !Array.isArray(candidate.snapshot)
  );
}

interface ParsedJsonlFile {
  readonly latestSnapshot: SessionSnapshot | null;
  readonly validLineCount: number;
  readonly validByteLength: number;
  readonly hasTornTail: boolean;
}

function parseJsonlContent(content: string, filePath: string): ParsedJsonlFile {
  if (content.length === 0) {
    return { latestSnapshot: null, validLineCount: 0, validByteLength: 0, hasTornTail: false };
  }

  let latestSnapshot: SessionSnapshot | null = null;
  let validLineCount = 0;
  let validByteLength = 0;
  let hasTornTail = false;

  let offset = 0;
  while (offset < content.length) {
    const newlineIndex = content.indexOf("\n", offset);
    const isFinalLine = newlineIndex === -1;
    const rawLine = isFinalLine ? content.slice(offset) : content.slice(offset, newlineIndex + 1);
    const trimmed = rawLine.trim();

    if (trimmed.length === 0) {
      if (!isFinalLine) {
        validByteLength += utf8ByteLength(rawLine);
      }
      offset = isFinalLine ? content.length : newlineIndex + 1;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      if (isFinalLine) {
        hasTornTail = true;
        break;
      }
      throw new JsonlCorruptionError(`Corrupt JSONL record in ${filePath}`, error);
    }

    if (!isSnapshotRecord(parsed)) {
      if (isFinalLine) {
        hasTornTail = true;
        break;
      }
      throw new JsonlCorruptionError(`Unexpected JSONL record shape in ${filePath}`);
    }

    latestSnapshot = parsed.snapshot;
    validLineCount += 1;
    validByteLength += utf8ByteLength(rawLine);
    offset = isFinalLine ? content.length : newlineIndex + 1;
  }

  return { latestSnapshot, validLineCount, validByteLength, hasTornTail };
}

function serializeRecord(snapshot: SessionSnapshot): string {
  const record: JsonlSnapshotRecord = {
    format: JSONL_FORMAT_VERSION,
    type: "snapshot",
    snapshot,
  };
  return `${JSON.stringify(record)}\n`;
}

/**
 * Runtime-agnostic append-only JSONL implementation of `SessionStore`.
 *
 * Each session lives in `<directory>/<encodedSessionId>.jsonl`, one JSON snapshot
 * record per line. A crash-truncated final line (torn line) is automatically skipped
 * (and truncated in writable mode), preserving the last committed snapshot.
 */
export class JsonlSessionStore implements SessionStore {
  private readonly directory: string;
  private readonly fs: JsonlFileSystem;
  private readonly fsync: boolean;
  private readonly readOnly: boolean;
  private readonly compactAfterLines: number;
  private readonly queues = new Map<string, SerialOperationQueue>();
  private readonly lineCounts = new Map<string, number>();
  private directoryReady = false;
  private closed = false;

  private constructor(
    directory: string,
    fs: JsonlFileSystem,
    options: JsonlSessionStoreOptions,
  ) {
    const compactAfterLines = options.compactAfterLines ?? DEFAULT_COMPACT_AFTER_LINES;
    if (!Number.isSafeInteger(compactAfterLines) || compactAfterLines < 0) {
      throw new Error(`compactAfterLines must be a non-negative integer, got: ${String(compactAfterLines)}`);
    }
    this.directory = directory;
    this.fs = fs;
    this.fsync = options.fsync === true;
    this.readOnly = options.readOnly === true;
    this.compactAfterLines = compactAfterLines;
  }

  static async open(
    directory: string,
    fs: JsonlFileSystem,
    options: JsonlSessionStoreOptions = {},
  ): Promise<JsonlSessionStore> {
    const store = new JsonlSessionStore(directory, fs, options);
    if (!store.readOnly) {
      await fs.mkdir(directory);
      store.directoryReady = true;
    }
    return store;
  }

  async load(sessionId: string): Promise<SessionSnapshot | null> {
    this.assertOpen();
    return this.queueFor(sessionId).runAsync(async () => {
      this.assertOpen();
      const filePath = this.sessionFilePath(sessionId);
      const content = await this.fs.readFile(filePath);
      if (content === null) {
        return null;
      }

      const parsed = parseJsonlContent(content, filePath);
      if (parsed.hasTornTail && !this.readOnly) {
        await this.fs.truncate(filePath, parsed.validByteLength);
      }
      this.lineCounts.set(sessionId, parsed.validLineCount);
      return parsed.latestSnapshot ? structuredClone(parsed.latestSnapshot) : null;
    });
  }

  async save(sessionId: string, snapshot: SessionSnapshot): Promise<void> {
    this.assertOpen();
    if (this.readOnly) {
      throw new JsonlStorageReadOnlyError();
    }
    const copy = structuredClone(snapshot);
    return this.queueFor(sessionId).runAsync(async () => {
      this.assertOpen();
      if (!this.directoryReady) {
        await this.fs.mkdir(this.directory);
        this.directoryReady = true;
      }

      const filePath = this.sessionFilePath(sessionId);
      let currentLines = this.lineCounts.get(sessionId);
      if (currentLines === undefined) {
        const existing = await this.fs.readFile(filePath);
        if (existing === null) {
          currentLines = 0;
        } else {
          const parsed = parseJsonlContent(existing, filePath);
          if (parsed.hasTornTail) {
            await this.fs.truncate(filePath, parsed.validByteLength);
          }
          currentLines = parsed.validLineCount;
        }
      }

      const line = serializeRecord(copy);
      const nextLines = currentLines + 1;
      if (this.compactAfterLines > 0 && nextLines >= this.compactAfterLines) {
        await this.fs.writeFileAtomic(filePath, line, { fsync: this.fsync });
        this.lineCounts.set(sessionId, 1);
      } else {
        await this.fs.appendFile(filePath, line, { fsync: this.fsync });
        this.lineCounts.set(sessionId, nextLines);
      }
    });
  }

  /** Atomically rewrite a session's JSONL file down to its single latest snapshot line. */
  async compact(sessionId: string): Promise<boolean> {
    this.assertOpen();
    if (this.readOnly) {
      throw new JsonlStorageReadOnlyError();
    }
    return this.queueFor(sessionId).runAsync(async () => {
      this.assertOpen();
      const filePath = this.sessionFilePath(sessionId);
      const content = await this.fs.readFile(filePath);
      if (content === null) {
        return false;
      }
      const parsed = parseJsonlContent(content, filePath);
      if (parsed.latestSnapshot === null) {
        return false;
      }
      await this.fs.writeFileAtomic(filePath, serializeRecord(parsed.latestSnapshot), { fsync: this.fsync });
      this.lineCounts.set(sessionId, 1);
      return true;
    });
  }

  async delete(sessionId: string): Promise<boolean> {
    this.assertOpen();
    if (this.readOnly) {
      throw new JsonlStorageReadOnlyError();
    }
    return this.queueFor(sessionId).runAsync(async () => {
      this.assertOpen();
      const filePath = this.sessionFilePath(sessionId);
      const removed = await this.fs.remove(filePath);
      this.lineCounts.delete(sessionId);
      return removed;
    });
  }

  async list(): Promise<SessionSummary[]> {
    this.assertOpen();
    const files = await this.fs.listFiles(this.directory);
    const summaries: SessionSummary[] = [];
    for (const fileName of files) {
      if (!fileName.endsWith(".jsonl")) continue;
      const filePath = joinPath(this.directory, fileName);
      const content = await this.fs.readFile(filePath);
      if (content === null) continue;
      const parsed = parseJsonlContent(content, filePath);
      if (parsed.latestSnapshot !== null) {
        summaries.push(summarizeSnapshot(parsed.latestSnapshot));
      }
    }
    return sortSessionSummaries(summaries);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.queues.clear();
    this.lineCounts.clear();
  }

  private queueFor(sessionId: string): SerialOperationQueue {
    let queue = this.queues.get(sessionId);
    if (!queue) {
      queue = new SerialOperationQueue();
      this.queues.set(sessionId, queue);
    }
    return queue;
  }

  private sessionFilePath(sessionId: string): string {
    return joinPath(this.directory, encodeSessionFileName(sessionId));
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("JsonlSessionStore is closed");
    }
  }
}
