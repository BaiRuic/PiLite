import { describe, expect, it } from "vitest";
import { InMemorySessionStore } from "../src/store/memory.js";
import { registerSessionStoreContract } from "../src/testing.js";

registerSessionStoreContract({ describe, it, expect }, "InMemorySessionStore", async (use) => {
  await use(new InMemorySessionStore());
});
