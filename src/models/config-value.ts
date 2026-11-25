import { HarnessError } from "../types.js";

export type ConfigCommandExecutor = (
  command: string,
  signal?: AbortSignal,
) => Promise<string | undefined> | string | undefined;

export interface ConfigValueResolverOptions {
  /** Environment map used for `$VAR` / `${VAR}` interpolation. Defaults to `process.env` when available. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Optional opt-in executor for `"!command"` values.
   * Disabled by default for safety and cross-runtime portability.
   */
  readonly execCommand?: ConfigCommandExecutor;
  readonly signal?: AbortSignal;
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

function defaultEnv(): Readonly<Record<string, string | undefined>> {
  if (typeof globalThis.process !== "undefined" && globalThis.process?.env) {
    return globalThis.process.env;
  }
  return {};
}

type TemplatePart =
  | { readonly type: "literal"; readonly value: string }
  | { readonly type: "env"; readonly name: string };

function parseTemplate(input: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  const pushLiteral = (value: string) => {
    if (!value) return;
    const prev = parts[parts.length - 1];
    if (prev?.type === "literal") {
      parts[parts.length - 1] = { type: "literal", value: prev.value + value };
    } else {
      parts.push({ type: "literal", value });
    }
  };

  let index = 0;
  while (index < input.length) {
    const dollar = input.indexOf("$", index);
    if (dollar < 0) {
      pushLiteral(input.slice(index));
      break;
    }
    pushLiteral(input.slice(index, dollar));
    const next = input[dollar + 1];
    if (next === "$" || next === "!") {
      pushLiteral(next);
      index = dollar + 2;
      continue;
    }
    if (next === "{") {
      const end = input.indexOf("}", dollar + 2);
      if (end > dollar + 2) {
        const name = input.slice(dollar + 2, end);
        if (ENV_NAME_RE.test(name)) {
          parts.push({ type: "env", name });
          index = end + 1;
          continue;
        }
      }
      pushLiteral("$");
      index = dollar + 1;
      continue;
    }
    const match = next ? input.slice(dollar + 1).match(ENV_PREFIX_RE) : null;
    if (match) {
      parts.push({ type: "env", name: match[0] });
      index = dollar + 1 + match[0].length;
      continue;
    }
    pushLiteral("$");
    index = dollar + 1;
  }

  return parts;
}

/**
 * Resolve a configuration value (API key, header value, base URL):
 * - Literal strings pass through unchanged.
 * - `$VAR` and `${VAR}` interpolate from `options.env` (defaulting to `process.env`); `$$` -> `$`, `$!` -> `!`.
 * - Values starting with `"!"` require an explicit opt-in `options.execCommand`.
 */
export async function resolveConfigValue(
  raw: string,
  options: ConfigValueResolverOptions = {},
): Promise<string | undefined> {
  if (raw.startsWith("!")) {
    if (!options.execCommand) {
      throw new HarnessError(
        "INVALID_OPTIONS",
        `Config value ${JSON.stringify(raw)} uses "!command" syntax, which is disabled unless execCommand is explicitly configured.`,
      );
    }
    const output = await options.execCommand(raw.slice(1), options.signal);
    const trimmed = output?.trim();
    return trimmed ? trimmed : undefined;
  }

  const env = options.env ?? defaultEnv();
  const parts = parseTemplate(raw);
  let resolved = "";
  for (const part of parts) {
    if (part.type === "literal") {
      resolved += part.value;
    } else {
      const value = env[part.name];
      if (value === undefined || value === "") {
        return undefined;
      }
      resolved += value;
    }
  }
  return resolved;
}

/** Resolve all values in a headers map, omitting entries whose env references are unset unless `strict` is true. */
export async function resolveConfigHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  options: ConfigValueResolverOptions & { readonly strict?: boolean } = {},
): Promise<Record<string, string> | undefined> {
  if (!headers) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const next = await resolveConfigValue(value, options);
    if (next === undefined) {
      if (options.strict) {
        throw new HarnessError(
          "INVALID_OPTIONS",
          `Failed to resolve header "${key}" from config value ${JSON.stringify(value)}.`,
        );
      }
      continue;
    }
    resolved[key] = next;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}
