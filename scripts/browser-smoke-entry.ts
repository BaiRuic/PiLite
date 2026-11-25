import * as extensions from "../src/extensions/index.js";
import * as core from "../src/index.js";
import * as models from "../src/models/index.js";
import * as modelsSqlite from "../src/models/sqlite/index.js";
import * as indexeddb from "../src/store/indexeddb.js";
import * as jsonl from "../src/store/jsonl/index.js";
import * as memory from "../src/store/memory.js";
import * as sqlite from "../src/store/sqlite/index.js";

// Keep runtime-neutral public entry points live so the browser smoke build
// catches accidental imports of Node/Bun-only adapters or `node:*` built-ins.
console.log(
  Object.keys(core),
  Object.keys(extensions),
  Object.keys(models),
  Object.keys(modelsSqlite),
  Object.keys(memory),
  Object.keys(indexeddb),
  Object.keys(jsonl),
  Object.keys(sqlite),
);
