import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { obj, str } from "@earendil-works/pi-schema";
import { createSession } from "../../dist/index.js";
import { openNodeSqliteSessionStore } from "../../dist/store/sqlite/node.js";

const [mode, dbPath, sessionId] = process.argv.slice(2);

if (!mode || !dbPath || !sessionId) {
  console.error("Usage: crash-worker.mjs <normal|crash-stream|crash-tool> <dbPath> <sessionId>");
  process.exit(2);
}

const faux = fauxProvider({
  provider: "faux",
  models: [{ id: "faux-1" }],
  tokensPerSecond: mode === "crash-stream" ? 20 : undefined,
});
const models = createModels();
models.setProvider(faux.provider);

const lookupParams = obj({ key: str() });
const lookupTool = {
  name: "lookup",
  label: "Lookup",
  description: "Read-only lookup",
  parameters: lookupParams,
  execute: async (_id, params) => {
    if (mode === "crash-tool") {
      process.stdout.write("READY_TO_KILL\n");
      await new Promise(() => {});
    }
    return {
      content: [{ type: "text", text: `found:${params.key}` }],
      details: { key: params.key },
    };
  },
};

if (mode === "normal") {
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("lookup", { key: "health" }, { id: "tc-1" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Health check returned found:health."),
  ]);
} else if (mode === "crash-stream") {
  faux.setResponses([
    fauxAssistantMessage([
      fauxText(
        "This is a deliberately long streaming response that will stay open until the parent sends SIGKILL to simulate a hard process crash mid-stream.",
      ),
    ]),
  ]);
} else if (mode === "crash-tool") {
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("lookup", { key: "slow" }, { id: "tc-crash" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("never reached"),
  ]);
} else {
  console.error(`Unknown mode: ${mode}`);
  process.exit(2);
}

const store = await openNodeSqliteSessionStore(dbPath);
const session = await createSession({
  sessionId,
  models,
  store,
  model: { provider: "faux", modelId: "faux-1" },
  systemPrompt: "Worker v1",
  tools: [lookupTool],
});

if (mode === "crash-stream") {
  let announced = false;
  session.subscribe((event) => {
    if (!announced && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      announced = true;
      process.stdout.write("READY_TO_KILL\n");
    }
  });
}

await session.prompt(`run:${mode}`);
await store.close();
process.stdout.write("WORKER_DONE\n");
