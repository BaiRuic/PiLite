import {
  sortSessionSummaries,
  summarizeSnapshot,
  type SessionSnapshot,
  type SessionStore,
  type SessionSummary,
} from "../types.js";

/**
 * In-memory `SessionStore` for unit tests and ephemeral sessions.
 * Snapshots are deep-cloned across reads and writes to prevent shared-reference mutations.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly snapshots = new Map<string, SessionSnapshot>();

  async load(sessionId: string): Promise<SessionSnapshot | null> {
    const existing = this.snapshots.get(sessionId);
    return existing ? structuredClone(existing) : null;
  }

  async save(sessionId: string, snapshot: SessionSnapshot): Promise<void> {
    this.snapshots.set(sessionId, structuredClone(snapshot));
  }

  async delete(sessionId: string): Promise<boolean> {
    return this.snapshots.delete(sessionId);
  }

  async list(): Promise<SessionSummary[]> {
    const summaries = [...this.snapshots.values()].map(summarizeSnapshot);
    return sortSessionSummaries(summaries);
  }

  has(sessionId: string): boolean {
    return this.snapshots.has(sessionId);
  }

  get size(): number {
    return this.snapshots.size;
  }
}
