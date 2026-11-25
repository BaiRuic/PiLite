import {
  HarnessError,
  sortSessionSummaries,
  type SessionListPage,
  type SessionListQuery,
  type SessionSummary,
} from "../types.js";

export interface DecodedSessionCursor {
  readonly updatedAt: number;
  readonly sessionId: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeBase64Url(input: string): string {
  const bytes = textEncoder.encode(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(input: string): string {
  if (!input || !/^[A-Za-z0-9_-]+$/.test(input)) {
    throw new Error("Invalid base64url characters");
  }
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (input.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return textDecoder.decode(bytes);
}

export function validateSessionListQuery(query: SessionListQuery | undefined): void {
  if (!query) return;
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1)) {
    throw new HarnessError(
      "INVALID_OPTIONS",
      `SessionListQuery.limit must be a positive safe integer, got: ${String(query.limit)}`,
    );
  }
}

export function encodeSessionCursor(summary: Pick<SessionSummary, "updatedAt" | "sessionId">): string {
  const payload = JSON.stringify({ updatedAt: summary.updatedAt, sessionId: summary.sessionId });
  return encodeBase64Url(payload);
}

export function decodeSessionCursor(cursor: string): DecodedSessionCursor {
  try {
    const json = decodeBase64Url(cursor);
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as Record<string, unknown>).updatedAt !== "number" ||
      !Number.isFinite((parsed as Record<string, unknown>).updatedAt) ||
      typeof (parsed as Record<string, unknown>).sessionId !== "string"
    ) {
      throw new Error("Malformed cursor payload");
    }
    return {
      updatedAt: (parsed as { updatedAt: number }).updatedAt,
      sessionId: (parsed as { sessionId: string }).sessionId,
    };
  } catch (error) {
    throw new HarnessError("INVALID_OPTIONS", `Invalid session list cursor: ${JSON.stringify(cursor)}`, {
      cause: error,
    });
  }
}

/**
 * Filter, sort (`updatedAt DESC, sessionId ASC`), and keyset-paginate summaries in memory.
 * Shared by Memory, JSONL, and IndexedDB stores so all backends exhibit identical semantics.
 */
export function filterAndPaginateSummaries(
  summaries: SessionSummary[],
  query: SessionListQuery = {},
): SessionListPage {
  validateSessionListQuery(query);
  const decodedCursor = query.cursor !== undefined ? decodeSessionCursor(query.cursor) : undefined;

  const filtered = summaries.filter((item) => {
    if (query.parentSessionId !== undefined && item.parentSessionId !== query.parentSessionId) {
      return false;
    }
    if (query.status !== undefined && item.status !== query.status) {
      return false;
    }
    if (decodedCursor !== undefined) {
      if (item.updatedAt > decodedCursor.updatedAt) return false;
      if (item.updatedAt === decodedCursor.updatedAt && item.sessionId <= decodedCursor.sessionId) {
        return false;
      }
    }
    return true;
  });

  const sorted = sortSessionSummaries(filtered);
  if (query.limit === undefined || sorted.length <= query.limit) {
    return { items: sorted };
  }

  const items = sorted.slice(0, query.limit);
  const last = items[items.length - 1]!;
  return {
    items,
    nextCursor: encodeSessionCursor(last),
  };
}
