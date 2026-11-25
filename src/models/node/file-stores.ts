import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  ModelsStore,
  ModelsStoreEntry,
  ModelsStoreOperationOptions,
} from "@earendil-works/pi-ai";
import { SerialOperationQueue } from "../../store/sqlite/database.js";

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await readFile(filePath, "utf8");
    const trimmed = stripBom(content).trim();
    if (!trimmed) return fallback;
    return JSON.parse(trimmed) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath: string, data: unknown, secureMode: boolean): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  try {
    await writeFile(tempPath, serialized, { encoding: "utf8", ...(secureMode ? { mode: 0o600 } : {}) });
    if (secureMode) {
      await chmod(tempPath, 0o600).catch(() => undefined);
    }
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

type StoredCredentialsMap = Record<string, Credential>;
type StoredModelsMap = Record<string, ModelsStoreEntry>;

/**
 * Atomic JSON-file `CredentialStore` (e.g. `auth.json`) with serialized read-modify-write
 * operations and `0600` file permissions.
 */
export class FileCredentialStore implements CredentialStore {
  private readonly filePath: string;
  private readonly queue = new SerialOperationQueue();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.queue.runAsync(async () => {
      options?.signal?.throwIfAborted();
      const map = await readJsonFile<StoredCredentialsMap>(this.filePath, {});
      options?.signal?.throwIfAborted();
      const found = map[providerId];
      return found ? structuredClone(found) : undefined;
    });
  }

  list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return this.queue.runAsync(async () => {
      options?.signal?.throwIfAborted();
      const map = await readJsonFile<StoredCredentialsMap>(this.filePath, {});
      options?.signal?.throwIfAborted();
      return Object.entries(map)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([providerId, cred]) => ({ providerId, type: cred.type }));
    });
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.queue.runAsync(async () => {
      options?.signal?.throwIfAborted();
      const map = await readJsonFile<StoredCredentialsMap>(this.filePath, {});
      options?.signal?.throwIfAborted();
      const current = map[providerId];
      const next = await fn(current ? structuredClone(current) : undefined);
      if (next === undefined) {
        return current ? structuredClone(current) : undefined;
      }
      map[providerId] = structuredClone(next);
      await writeJsonAtomic(this.filePath, map, true);
      return structuredClone(next);
    });
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.queue.runAsync(async () => {
      options?.signal?.throwIfAborted();
      const map = await readJsonFile<StoredCredentialsMap>(this.filePath, {});
      options?.signal?.throwIfAborted();
      if (!(providerId in map)) return;
      delete map[providerId];
      await writeJsonAtomic(this.filePath, map, true);
    });
  }
}

/**
 * Atomic JSON-file `ModelsStore` (e.g. `models-store.json`) for caching dynamically
 * fetched provider catalogs across restarts.
 */
export class FileModelsStore implements ModelsStore {
  private readonly filePath: string;
  private readonly queue = new SerialOperationQueue();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  read(
    providerId: string,
    options?: ModelsStoreOperationOptions,
  ): Promise<ModelsStoreEntry | undefined> {
    return this.queue.runAsync(async () => {
      options?.signal?.throwIfAborted();
      const map = await readJsonFile<StoredModelsMap>(this.filePath, {});
      options?.signal?.throwIfAborted();
      const found = map[providerId];
      return found ? structuredClone(found) : undefined;
    });
  }

  write(
    providerId: string,
    entry: ModelsStoreEntry,
    options?: ModelsStoreOperationOptions,
  ): Promise<void> {
    return this.queue.runAsync(async () => {
      options?.signal?.throwIfAborted();
      const map = await readJsonFile<StoredModelsMap>(this.filePath, {});
      options?.signal?.throwIfAborted();
      map[providerId] = structuredClone(entry);
      await writeJsonAtomic(this.filePath, map, false);
    });
  }

  delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
    return this.queue.runAsync(async () => {
      options?.signal?.throwIfAborted();
      const map = await readJsonFile<StoredModelsMap>(this.filePath, {});
      options?.signal?.throwIfAborted();
      if (!(providerId in map)) return;
      delete map[providerId];
      await writeJsonAtomic(this.filePath, map, false);
    });
  }
}
