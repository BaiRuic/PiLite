import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const outputPath = join(tmpdir(), "pilite-browser-smoke.js");
const errorLogPath = join(tmpdir(), "pilite-browser-smoke-errors.log");

function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

function findInput(inputs, suffix) {
  return Object.keys(inputs).find((input) => {
    const normalized = normalizePath(input);
    return normalized === suffix || normalized.endsWith(`/${suffix}`);
  });
}

try {
  const browserBuild = await build({
    entryPoints: ["scripts/browser-smoke-entry.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    logLevel: "silent",
    metafile: true,
    outfile: outputPath,
    write: false,
  });

  const inputs = browserBuild.metafile.inputs;
  for (const expectedInput of [
    "src/index.ts",
    "src/session.ts",
    "src/extensions/index.ts",
    "src/models/index.ts",
    "src/models/indexeddb.ts",
    "src/models/sqlite/index.ts",
    "src/store/memory.ts",
    "src/store/indexeddb.ts",
    "src/store/jsonl/index.ts",
    "src/store/jsonl/store.ts",
    "src/store/sqlite/index.ts",
    "src/store/sqlite/store.ts",
  ]) {
    if (!findInput(inputs, expectedInput)) {
      throw new Error(`PiLite browser bundle does not include ${expectedInput}`);
    }
  }

  for (const forbiddenInput of [
    "src/models/node/index.ts",
    "src/models/node/credential-store.ts",
    "src/models/node/models-store.ts",
    "src/models/node/json-file-source.ts",
    "src/models/node/oauth-cli.ts",
    "src/store/jsonl/node.ts",
    "src/store/sqlite/node.ts",
    "src/store/sqlite/bun.ts",
  ]) {
    const adapter = findInput(inputs, forbiddenInput);
    if (adapter) {
      throw new Error(`PiLite browser bundle unexpectedly includes ${adapter}`);
    }
  }

  for (const input of Object.keys(inputs)) {
    const normalized = normalizePath(input);
    if (normalized.startsWith("node:") || normalized.includes("/src/models/node/")) {
      throw new Error(`PiLite browser bundle unexpectedly includes Node-only input ${normalized}`);
    }
  }

  process.exit(0);
} catch (error) {
  let detailedErrors = "";
  if (error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)) {
    detailedErrors = error.errors
      .map((entry) => {
        const location = entry.location
          ? `${entry.location.file}:${entry.location.line}:${entry.location.column}`
          : "";
        return [location, entry.text].filter(Boolean).join(" ");
      })
      .join("\n");
  }

  const baseError = error instanceof Error ? (error.stack ?? error.message) : String(error);
  writeFileSync(errorLogPath, [detailedErrors, baseError].filter(Boolean).join("\n\n"), "utf-8");
  console.error(`Browser smoke check failed. See ${errorLogPath}`);
  if (detailedErrors) {
    console.error(detailedErrors);
  } else {
    console.error(baseError);
  }
  process.exit(1);
}
