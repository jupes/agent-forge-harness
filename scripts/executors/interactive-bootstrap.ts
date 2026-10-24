import { isAbsolute } from "node:path";
import { interactiveLifetimeMs } from "./interactive-lifetime";

export const INTERACTIVE_BOOTSTRAP_FLAG = "--interactive-bootstrap";
export const INTERACTIVE_BOOTSTRAP_CONTROL = "agent-forge-owned-interactive";
export const INTERACTIVE_BOOTSTRAP_TERMINAL =
  "agent-forge-owned-interactive-terminal";
export const INTERACTIVE_BOOTSTRAP_ACK = "agent-forge-owned-interactive-ack";
export const INTERACTIVE_CONTROL_TIMEOUT_MS = 1000;
export const INTERACTIVE_START_MAX_BYTES = 131_072;

function startEnvelope(value: unknown): {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== 1 ||
    !("command" in value) ||
    !Array.isArray(value.command) ||
    !value.command.length ||
    value.command.length > 32 ||
    !value.command.every(
      (word): word is string =>
        typeof word === "string" && word.length <= 8192 && !word.includes("\0"),
    ) ||
    !isAbsolute(value.command[0] ?? "") ||
    !("cwd" in value) ||
    typeof value.cwd !== "string" ||
    value.cwd.length > 1024 ||
    !isAbsolute(value.cwd) ||
    value.cwd.includes("\0") ||
    !("timeoutMs" in value) ||
    typeof value.timeoutMs !== "number" ||
    !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs < 1 ||
    ("lifetime" in value &&
      value.lifetime !== "shift-attempt" &&
      value.lifetime !== "shift-engine") ||
    !("env" in value) ||
    typeof value.env !== "object" ||
    value.env === null ||
    Array.isArray(value.env)
  )
    throw new Error("Invalid private bootstrap input.");
  const timeoutMs = interactiveLifetimeMs(
    value.timeoutMs,
    "lifetime" in value && value.lifetime === "shift-attempt"
      ? "shift-attempt"
      : "lifetime" in value && value.lifetime === "shift-engine"
        ? "shift-engine"
        : undefined,
  );
  const env: Record<string, string> = {};
  for (const [name, item] of Object.entries(value.env)) {
    if (
      !name ||
      name.length > 128 ||
      /[=\0]/.test(name) ||
      typeof item !== "string" ||
      item.includes("\0") ||
      item.length > 32768 ||
      Object.keys(env).length >= 128
    )
      throw new Error("Invalid private bootstrap environment.");
    env[name] = item;
  }
  return {
    command: value.command,
    cwd: value.cwd,
    env,
    timeoutMs,
  };
}

/** Trusted internal child mode. It runs no provider code before receiving the private ownership grant. */
export async function runInteractiveBootstrap(): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  let child: Bun.Subprocess<"pipe", "inherit", "inherit"> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = setTimeout(
    () => process.exit(1),
    5000,
  );
  try {
    let first = new Uint8Array(0),
      remainder = new Uint8Array(0);
    for (;;) {
      const read = await reader.read();
      if (read.done) throw new Error("Missing ownership grant.");
      const newline = read.value.indexOf(10),
        prefix = newline < 0 ? read.value : read.value.subarray(0, newline);
      if (first.byteLength + prefix.byteLength > INTERACTIVE_START_MAX_BYTES)
        throw new Error("Ownership grant exceeds its bound.");
      const next = new Uint8Array(first.byteLength + prefix.byteLength);
      next.set(first);
      next.set(prefix, first.byteLength);
      first = next;
      if (newline >= 0) {
        remainder = read.value.subarray(newline + 1);
        break;
      }
    }
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(first));
    } catch {
      throw new Error("Invalid ownership grant.");
    }
    const start = startEnvelope(raw);
    if (typeof process.send !== "function")
      throw new Error("Missing private ownership channel.");
    clearTimeout(deadline);
    child = Bun.spawn(start.command, {
      cwd: start.cwd,
      env: start.env,
      stdin: "pipe",
      stdout: "inherit",
      stderr: "inherit",
    });
    const actual = child;
    let timedOut = false;
    deadline = setTimeout(() => {
      timedOut = true;
      actual.kill("SIGKILL");
    }, start.timeoutMs);
    process.send({
      kind: INTERACTIVE_BOOTSTRAP_CONTROL,
      version: 1,
      pid: actual.pid,
    });
    const stdin = (async () => {
      let total = remainder.byteLength;
      if (remainder.byteLength) await actual.stdin.write(remainder);
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > 16_777_216) throw new Error("Input bound");
        await actual.stdin.write(next.value);
        await actual.stdin.flush();
      }
      await actual.stdin.end();
    })();
    // A provider may exit without consuming more input; cancellation closes only this owned proxy.
    const exited = actual.exited.then(async (code) => {
      await reader.cancel().catch(() => undefined);
      return code;
    });
    const inputDone = stdin.catch((error: unknown) => {
      if (actual.exitCode === null) throw error;
    });
    const results = await Promise.all([exited, inputDone]);
    clearTimeout(deadline);
    // This fixed private receipt precedes wrapper exit. The provider has no IPC
    // capability; acknowledgement proves the owner received the terminal fact.
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        process.off("message", receive);
        if (error) reject(error);
        else resolve();
      };
      const receive = (value: unknown) => {
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.keys(value).length !== 3 ||
          !("kind" in value) ||
          value.kind !== INTERACTIVE_BOOTSTRAP_ACK ||
          !("version" in value) ||
          value.version !== 1 ||
          !("pid" in value) ||
          value.pid !== actual.pid
        )
          finish(new Error("Invalid private terminal acknowledgement."));
        else finish();
      };
      const timer = setTimeout(
        () => finish(new Error("Missing private terminal acknowledgement.")),
        INTERACTIVE_CONTROL_TIMEOUT_MS,
      );
      process.on("message", receive);
      try {
        process.send?.({
          kind: INTERACTIVE_BOOTSTRAP_TERMINAL,
          version: 1,
          pid: actual.pid,
          timedOut,
        });
      } catch {
        finish(new Error("Private terminal acknowledgement failed."));
      }
    });
    process.exitCode = timedOut ? 1 : results[0];
  } catch {
    child?.kill("SIGKILL");
    // Never include the envelope, provider environment, prompt or exception body.
    process.stderr.write("The owned interactive process could not complete.\n");
    process.exitCode = 1;
  } finally {
    if (deadline) clearTimeout(deadline);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    process.disconnect?.();
  }
}
