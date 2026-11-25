import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";

export interface CliAuthInteractionOptions {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly signal?: AbortSignal;
  /** Automatically open `auth_url` in the system browser. Defaults to `true`. */
  readonly openBrowser?: boolean;
  /** Custom URL opener (overrides the default OS browser opener). */
  readonly openUrl?: (url: string) => void | Promise<void>;
}

/** Best-effort OS browser opener for interactive OAuth flows. */
export function openUrlInBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      const child = spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      return;
    }
    const command = process.platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(command, [url], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // Ignore browser launch failures; the URL is always printed to output.
  }
}

function writeLine(output: Writable, text: string): void {
  output.write(`${text}\n`);
}

function combineSignals(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
  if (a && b) return AbortSignal.any([a, b]);
  return a ?? b;
}

async function readLinePrompt(
  input: Readable,
  output: Writable,
  message: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  signal?.throwIfAborted();
  const rl = createInterface({ input, output, terminal: Boolean((input as NodeJS.ReadStream).isTTY) });
  try {
    return signal ? await rl.question(message, { signal }) : await rl.question(message);
  } finally {
    rl.close();
  }
}

async function readSecretPrompt(
  input: Readable,
  output: Writable,
  message: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const ttyInput = input as NodeJS.ReadStream;
  if (!ttyInput.isTTY || typeof ttyInput.setRawMode !== "function") {
    return readLinePrompt(input, output, message, signal);
  }

  signal?.throwIfAborted();
  output.write(message);

  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    const wasRaw = ttyInput.isRaw;
    ttyInput.setRawMode(true);
    ttyInput.resume();

    const cleanup = () => {
      ttyInput.removeListener("data", onData);
      signal?.removeEventListener("abort", onAbort);
      try {
        ttyInput.setRawMode(Boolean(wasRaw));
      } catch {
        // Ignore raw mode restore errors.
      }
      ttyInput.pause();
    };

    const onAbort = () => {
      cleanup();
      output.write("\n");
      reject(signal?.reason ?? new Error("Login cancelled"));
    };

    const onData = (chunk: Buffer | string) => {
      const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const ch of str) {
        if (ch === "\u0003") {
          cleanup();
          output.write("\n");
          reject(new Error("Login cancelled"));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          output.write("\n");
          resolve(buffer);
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += ch;
      }
    };

    ttyInput.on("data", onData);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Create a lightweight CLI `AuthInteraction` bridge for `models.login()` / `hub.login()`.
 * Works with all built-in `pi-ai` OAuth & API-key login flows using pure `node:readline`.
 */
export function createCliAuthInteraction(options: CliAuthInteractionOptions = {}): AuthInteraction {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const openBrowser = options.openBrowser ?? true;
  const opener = options.openUrl ?? openUrlInBrowser;

  return {
    ...(options.signal ? { signal: options.signal } : {}),
    notify(event: AuthEvent): void {
      switch (event.type) {
        case "auth_url":
          writeLine(output, `Open this URL to sign in:\n  ${event.url}`);
          if (event.instructions) writeLine(output, event.instructions);
          if (openBrowser) {
            void opener(event.url);
          }
          break;
        case "device_code":
          writeLine(output, `Visit ${event.verificationUri} and enter code: ${event.userCode}`);
          if (openBrowser && event.openBrowserOnConfirm !== false) {
            void opener(event.verificationUri);
          }
          break;
        case "info":
          writeLine(output, event.message);
          for (const link of event.links ?? []) {
            writeLine(output, `  ${link.label ? `${link.label}: ` : ""}${link.url}`);
          }
          break;
        case "progress":
          writeLine(output, event.message);
          break;
      }
    },
    async prompt(prompt: AuthPrompt): Promise<string> {
      const effectiveSignal = combineSignals(options.signal, prompt.signal);
      effectiveSignal?.throwIfAborted();

      if (prompt.type === "select") {
        writeLine(output, prompt.message);
        prompt.options.forEach((opt, idx) => {
          const suffix = opt.description ? ` - ${opt.description}` : "";
          writeLine(output, `  ${idx + 1}. ${opt.label}${suffix}`);
        });
        const answer = (
          await readLinePrompt(
            input,
            output,
            `Select [1-${prompt.options.length}] (default 1): `,
            effectiveSignal,
          )
        ).trim();
        if (!answer) {
          return prompt.options[0]?.id ?? "";
        }
        const byIndex = Number(answer);
        if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= prompt.options.length) {
          return prompt.options[byIndex - 1]!.id;
        }
        const byId = prompt.options.find((opt) => opt.id === answer);
        return byId ? byId.id : answer;
      }

      const hint = prompt.placeholder ? ` (${prompt.placeholder})` : "";
      const label = `${prompt.message}${hint}: `;
      if (prompt.type === "secret") {
        return readSecretPrompt(input, output, label, effectiveSignal);
      }
      return readLinePrompt(input, output, label, effectiveSignal);
    },
  };
}
