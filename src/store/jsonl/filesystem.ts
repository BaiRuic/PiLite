/**
 * Minimal portable filesystem facade used by `JsonlSessionStore`.
 *
 * Keeps the portable JSONL core free of `node:*` imports so hosts can supply
 * Node, Bun, or custom virtual filesystem implementations.
 */
export interface JsonlFileSystem {
  /** Ensure a directory (and its parents) exists. */
  mkdir(path: string): Promise<void>;
  /** Read a UTF-8 file, returning `null` when it does not exist. */
  readFile(path: string): Promise<string | null>;
  /** Append UTF-8 text to a file, creating it if missing. */
  appendFile(path: string, content: string, options?: { readonly fsync?: boolean }): Promise<void>;
  /** Atomically replace a file's contents (write temp file + rename). */
  writeFileAtomic(path: string, content: string, options?: { readonly fsync?: boolean }): Promise<void>;
  /** Truncate an existing file to `byteLength` bytes (used to drop torn tail lines). */
  truncate(path: string, byteLength: number): Promise<void>;
  /** List file names directly inside `directory` (returns `[]` if directory does not exist). */
  listFiles(directory: string): Promise<string[]>;
  /** Remove a file if it exists, returning `true` when deleted and `false` when absent. */
  remove(path: string): Promise<boolean>;
}
