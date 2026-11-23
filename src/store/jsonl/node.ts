import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, truncate, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { JsonlFileSystem } from "./filesystem.js";
import { JsonlSessionStore, type JsonlSessionStoreOptions } from "./store.js";

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

/**
 * `JsonlFileSystem` implementation backed by `node:fs/promises`.
 * Compatible with both Node.js and Bun runtimes.
 */
export class NodeJsonlFileSystem implements JsonlFileSystem {
  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async readFile(path: string): Promise<string | null> {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        return null;
      }
      throw error;
    }
  }

  async appendFile(path: string, content: string, options?: { readonly fsync?: boolean }): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "a");
    try {
      await handle.writeFile(content, "utf8");
      if (options?.fsync) {
        await handle.sync();
      }
    } finally {
      await handle.close();
    }
  }

  async writeFileAtomic(path: string, content: string, options?: { readonly fsync?: boolean }): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.tmp-${randomUUID()}`;
    const handle = await open(tempPath, "wx");
    try {
      await handle.writeFile(content, "utf8");
      if (options?.fsync) {
        await handle.sync();
      }
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    await handle.close();

    try {
      await rename(tempPath, path);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async truncate(path: string, byteLength: number): Promise<void> {
    await truncate(path, byteLength);
  }

  async listFiles(directory: string): Promise<string[]> {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    } catch (error) {
      if (isEnoent(error)) {
        return [];
      }
      throw error;
    }
  }

  async remove(path: string): Promise<boolean> {
    try {
      await unlink(path);
      return true;
    } catch (error) {
      if (isEnoent(error)) {
        return false;
      }
      throw error;
    }
  }
}

/** Open or create a JSONL session store backed by the local filesystem (Node.js & Bun). */
export async function openNodeJsonlSessionStore(
  directory: string,
  options: JsonlSessionStoreOptions = {},
): Promise<JsonlSessionStore> {
  return JsonlSessionStore.open(directory, new NodeJsonlFileSystem(), options);
}

export {
  JsonlCorruptionError,
  JsonlSessionStore,
  JsonlStorageReadOnlyError,
  type JsonlSessionStoreOptions,
} from "./store.js";
