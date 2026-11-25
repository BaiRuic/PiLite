import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { createApiBackendProvider, createModelHub } from "../src/models/index.js";
import {
  type CredentialCodec,
  IndexedDbCredentialStore,
  IndexedDbModelsStore,
  openIndexedDbModelStores,
} from "../src/models/indexeddb.js";
import { registerCredentialStoreContract, registerModelsStoreContract } from "../src/testing.js";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function createWebCryptoAesGcmCodec(): Promise<{ codec: CredentialCodec; decryptCalls: () => number }> {
  const key = await globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let decryptCount = 0;

  const codec: CredentialCodec = {
    async encrypt(plaintext: string): Promise<string> {
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await globalThis.crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        encoder.encode(plaintext),
      );
      return JSON.stringify({
        iv: toBase64(iv),
        ct: toBase64(new Uint8Array(encrypted)),
      });
    },
    async decrypt(ciphertext: string): Promise<string> {
      decryptCount += 1;
      const parsed = JSON.parse(ciphertext) as { iv: string; ct: string };
      const decrypted = await globalThis.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64(parsed.iv) },
        key,
        fromBase64(parsed.ct),
      );
      return decoder.decode(decrypted);
    },
  };

  return { codec, decryptCalls: () => decryptCount };
}

registerCredentialStoreContract(
  { describe, it, expect },
  "IndexedDbCredentialStore (fake-indexeddb, plain)",
  async (use) => {
    const factory = new IDBFactory();
    const store = await IndexedDbCredentialStore.open("pilite-creds-plain", { indexedDB: factory });
    try {
      await use(store);
    } finally {
      await store.close();
    }
  },
);

registerCredentialStoreContract(
  { describe, it, expect },
  "IndexedDbCredentialStore (fake-indexeddb, Web Crypto AES-GCM codec)",
  async (use) => {
    const factory = new IDBFactory();
    const { codec } = await createWebCryptoAesGcmCodec();
    const store = await IndexedDbCredentialStore.open("pilite-creds-enc", {
      indexedDB: factory,
      codec,
    });
    try {
      await use(store);
    } finally {
      await store.close();
    }
  },
);

registerModelsStoreContract(
  { describe, it, expect },
  "IndexedDbModelsStore (fake-indexeddb)",
  async (use) => {
    const factory = new IDBFactory();
    const store = await IndexedDbModelsStore.open("pilite-models-contract", { indexedDB: factory });
    try {
      await use(store);
    } finally {
      await store.close();
    }
  },
);

describe("IndexedDbCredentialStore & IndexedDbModelsStore (codec, shared DB, lifecycle)", () => {
  it("encrypts stored credential payloads at rest and never calls decrypt() during list()", async () => {
    const factory = new IDBFactory();
    const { codec, decryptCalls } = await createWebCryptoAesGcmCodec();

    const store = await IndexedDbCredentialStore.open("enc-check", {
      indexedDB: factory,
      codec,
    });
    try {
      await store.modify("openai", async () => ({
        type: "api_key",
        key: "sk-super-secret-token",
      }));

      // Inspect the raw IndexedDB object store to prove the secret is encrypted at rest.
      const rawRecord = await new Promise<{ providerId: string; type: string; payload: string }>(
        (resolve, reject) => {
          const openReq = factory.open("enc-check", 1);
          openReq.addEventListener("error", () => reject(openReq.error));
          openReq.addEventListener("success", () => {
            const db = openReq.result;
            const tx = db.transaction("harness_credentials", "readonly");
            const getReq = tx.objectStore("harness_credentials").get("openai");
            getReq.addEventListener("error", () => reject(getReq.error));
            getReq.addEventListener("success", () => {
              const result = getReq.result as { providerId: string; type: string; payload: string };
              db.close();
              resolve(result);
            });
          });
        },
      );

      expect(rawRecord.type).toBe("api_key");
      expect(rawRecord.payload).not.toContain("sk-super-secret-token");

      const decryptBeforeList = decryptCalls();
      expect(await store.list()).toEqual([{ providerId: "openai", type: "api_key" }]);
      expect(decryptCalls()).toBe(decryptBeforeList);

      expect(await store.read("openai")).toEqual({
        type: "api_key",
        key: "sk-super-secret-token",
      });
      expect(decryptCalls()).toBe(decryptBeforeList + 1);
    } finally {
      await store.close();
    }
  });

  it("shares one IndexedDB database via openIndexedDbModelStores, persists across reopen, and integrates with ModelHub", async () => {
    const factory = new IDBFactory();
    const { codec } = await createWebCryptoAesGcmCodec();

    const stores1 = await openIndexedDbModelStores("shared-app-models", {
      indexedDB: factory,
      codec,
    });
    try {
      await stores1.credentials.modify("my-backend", async () => ({
        type: "api_key",
        key: "jwt-token-1",
      }));
      await stores1.modelsStore.write("my-backend", {
        models: [
          {
            id: "hosted-1",
            name: "Hosted 1",
            api: "openai-completions",
            provider: "my-backend",
            baseUrl: "https://api.example.com/v1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 64_000,
            maxTokens: 4_096,
          },
        ],
        checkedAt: 1_700_000_000_000,
      });
    } finally {
      await stores1.close();
    }

    // Reopen on the same factory and verify both stores + ModelHub work seamlessly.
    const stores2 = await openIndexedDbModelStores("shared-app-models", {
      indexedDB: factory,
      codec,
    });
    try {
      expect(await stores2.credentials.read("my-backend")).toEqual({
        type: "api_key",
        key: "jwt-token-1",
      });
      expect((await stores2.modelsStore.read("my-backend"))?.models.map((m) => m.id)).toEqual(["hosted-1"]);

      // Reopen with ModelHub to verify offline catalog restore + encrypted credential auth.
      const backend = createApiBackendProvider({
        id: "my-backend",
        name: "My Backend",
        baseUrl: "https://api.example.com/v1",
        getAuth: ({ credential }) => (credential ? { apiKey: credential.key } : undefined),
      });
      const hub = createModelHub({
        credentials: stores2.credentials,
        modelsStore: stores2.modelsStore,
        providers: [backend],
      });
      await hub.init({ allowNetwork: false });
      expect(hub.getModel("my-backend", "hosted-1")?.name).toBe("Hosted 1");
      expect((await hub.getAuth("my-backend"))?.auth.apiKey).toBe("jwt-token-1");
      await hub.logout("my-backend");
      expect(await stores2.credentials.read("my-backend")).toBeUndefined();
    } finally {
      await stores2.close();
    }
  });

  it("honors AbortSignal, validates options, and rejects operations after close", async () => {
    const factory = new IDBFactory();
    await expect(IndexedDbCredentialStore.open("  ", { indexedDB: factory })).rejects.toThrow(/non-empty/i);
    await expect(
      IndexedDbCredentialStore.open("valid", { indexedDB: factory, credentialsStoreName: "" }),
    ).rejects.toThrow(/non-empty/i);
    await expect(
      IndexedDbModelsStore.open("valid", { indexedDB: factory, modelsStoreName: " " }),
    ).rejects.toThrow(/non-empty/i);
    await expect(
      openIndexedDbModelStores("valid", {
        indexedDB: factory,
        credentialsStoreName: "same",
        modelsStoreName: "same",
      }),
    ).rejects.toThrow(/distinct/i);

    const bundle = await openIndexedDbModelStores("abort-close-test", { indexedDB: factory });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(bundle.credentials.read("openai", { signal: controller.signal })).rejects.toThrow(
      /cancelled/i,
    );
    await expect(bundle.modelsStore.read("openai", { signal: controller.signal })).rejects.toThrow(
      /cancelled/i,
    );

    await bundle.close();
    await bundle.close(); // idempotent
    await expect(bundle.credentials.read("openai")).rejects.toThrow(/closed/i);
    await expect(bundle.modelsStore.read("openai")).rejects.toThrow(/closed/i);
  });
});
