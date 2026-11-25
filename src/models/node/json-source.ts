import { readFile } from "node:fs/promises";
import { HarnessError } from "../../types.js";
import type { LocalModelsConfig, LocalModelSource } from "../local.js";

export interface JsonFileModelSourceOptions {
  /** Label for diagnostics (defaults to the file path). */
  readonly name?: string;
  /** When `true`, throws if the file does not exist. Defaults to `false` (returns `{ providers: {} }`). */
  readonly required?: boolean;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Strip `//` line comments and `/* ... *\/` block comments outside JSON string literals. */
function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    const next = input[i + 1];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") {
        i += 1;
      }
      if (i < input.length) out += "\n";
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        if (input[i] === "\n") out += "\n";
        i += 1;
      }
      i += 1;
      continue;
    }

    out += ch;
  }

  return out;
}

function validateParsedConfig(parsed: unknown, filePath: string): LocalModelsConfig {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HarnessError(
      "INVALID_OPTIONS",
      `Local models config "${filePath}" must be a JSON object with a "providers" map.`,
    );
  }
  const record = parsed as Record<string, unknown>;
  if (record.providers === undefined) {
    return { providers: {} };
  }
  if (
    typeof record.providers !== "object" ||
    record.providers === null ||
    Array.isArray(record.providers)
  ) {
    throw new HarnessError(
      "INVALID_OPTIONS",
      `Local models config "${filePath}": "providers" must be an object keyed by provider ID.`,
    );
  }
  return { providers: record.providers as LocalModelsConfig["providers"] };
}

/**
 * Create a `LocalModelSource` backed by a JSON/JSONC file (such as `models.json`).
 */
export function createJsonFileModelSource(
  filePath: string,
  options: JsonFileModelSourceOptions = {},
): LocalModelSource {
  return {
    name: options.name ?? filePath,
    async load(signal?: AbortSignal): Promise<LocalModelsConfig> {
      signal?.throwIfAborted();
      let raw: string;
      try {
        raw = await readFile(filePath, { encoding: "utf8", signal });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT" && !options.required) {
          return { providers: {} };
        }
        throw error;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(stripJsonComments(stripBom(raw)));
      } catch (error) {
        throw new HarnessError(
          "INVALID_OPTIONS",
          `Failed to parse local models config "${filePath}": ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }

      return validateParsedConfig(parsed, filePath);
    },
  };
}
