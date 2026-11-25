import type {
  CredentialStore,
  ModelsStore,
  ModelsStoreEntry,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import type { SessionStoreContractRunner } from "../store/contract.js";

export type CredentialStoreFactory = (use: (store: CredentialStore) => Promise<void>) => Promise<void>;
export type ModelsStoreFactory = (use: (store: ModelsStore) => Promise<void>) => Promise<void>;

/**
 * Shared contract test suite for any `CredentialStore` backend (Memory, SQLite Node/Bun, File).
 */
export function registerCredentialStoreContract(
  runner: SessionStoreContractRunner,
  name: string,
  withStore: CredentialStoreFactory,
): void {
  const { describe, it, expect } = runner;

  describe(`CredentialStore contract: ${name}`, () => {
    it("reads undefined for missing provider, writes/reads/lists non-secret metadata, and deletes", async () => {
      await withStore(async (store) => {
        expect(await store.read("openai")).toBe(undefined);
        expect(await store.list()).toEqual([]);

        const apiKeyCred = { type: "api_key" as const, key: "sk-secret", env: { ORG: "acme" } };
        const saved = await store.modify("openai", async () => apiKeyCred);
        expect(saved).toEqual(apiKeyCred);
        expect(await store.read("openai")).toEqual(apiKeyCred);

        const oauthCred: OAuthCredential = {
          type: "oauth",
          access: "acc-1",
          refresh: "ref-1",
          expires: 1_800_000_000_000,
        };
        await store.modify("anthropic", async () => oauthCred);

        expect(await store.list()).toEqual([
          { providerId: "anthropic", type: "oauth" },
          { providerId: "openai", type: "api_key" },
        ]);

        // Returning undefined from modify leaves the stored credential intact.
        const unchanged = await store.modify("anthropic", async () => undefined);
        expect(unchanged).toEqual(oauthCred);

        await store.delete("openai");
        expect(await store.read("openai")).toBe(undefined);
        expect(await store.list()).toEqual([{ providerId: "anthropic", type: "oauth" }]);
      });
    });

    it("serializes concurrent modify() calls so rotated OAuth tokens are never lost", async () => {
      await withStore(async (store) => {
        await store.modify("codex", async () => ({
          type: "oauth",
          access: "acc-0",
          refresh: "ref-0",
          expires: 100,
        }));

        const observed: string[] = [];

        const first = store.modify("codex", async (current) => {
          const prev = current as OAuthCredential;
          observed.push(`first:${prev.refresh}`);
          await new Promise((r) => setTimeout(r, 20));
          return { ...prev, access: "acc-1", refresh: "ref-1", expires: 200 };
        });

        const second = store.modify("codex", async (current) => {
          const prev = current as OAuthCredential;
          observed.push(`second:${prev.refresh}`);
          return { ...prev, access: "acc-2", refresh: "ref-2", expires: 300 };
        });

        await Promise.all([first, second]);

        expect(observed).toEqual(["first:ref-0", "second:ref-1"]);
        expect(await store.read("codex")).toEqual({
          type: "oauth",
          access: "acc-2",
          refresh: "ref-2",
          expires: 300,
        });
      });
    });
  });
}

/**
 * Shared contract test suite for any `ModelsStore` backend (Memory, SQLite Node/Bun, File).
 */
export function registerModelsStoreContract(
  runner: SessionStoreContractRunner,
  name: string,
  withStore: ModelsStoreFactory,
): void {
  const { describe, it, expect } = runner;

  describe(`ModelsStore contract: ${name}`, () => {
    it("round-trips catalog entries with metadata, clones defensively, and deletes", async () => {
      await withStore(async (store) => {
        expect(await store.read("my-backend")).toBe(undefined);

        const entry: ModelsStoreEntry = {
          models: [
            {
              id: "model-a",
              name: "Model A",
              api: "openai-completions",
              provider: "my-backend",
              baseUrl: "https://api.example.com/v1",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 16_384,
            },
          ],
          etag: '"v1-abc"',
          lastModified: 1_700_000_000_000,
          checkedAt: 1_700_000_001_000,
        };

        await store.write("my-backend", entry);
        const loaded = await store.read("my-backend");
        expect(loaded).toEqual(entry);

        // Mutating the loaded array must not corrupt stored state.
        (loaded!.models as unknown[]).push({ id: "mutated" });
        const secondLoad = await store.read("my-backend");
        expect(secondLoad?.models.length).toBe(1);

        await store.delete("my-backend");
        expect(await store.read("my-backend")).toBe(undefined);
      });
    });
  });
}
