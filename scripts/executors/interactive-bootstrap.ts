import { isAbsolute } from "node:path";
import { isMain } from "../is-main";

export const INTERACTIVE_BOOTSTRAP_FLAG = "--interactive-bootstrap";
export const INTERACTIVE_BOOTSTRAP_PREFIX = "agent-forge-owned-interactive:";
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
    value.timeoutMs > 30 * 60_000 ||
    !("env" in value) ||
    typeof value.env !== "object" ||
    value.env === null ||
    Array.isArray(value.env)
  )
    throw new Error("Invalid private bootstrap input.");
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
    timeoutMs: value.timeoutMs,
  };
}

/** Trusted internal child mode. It runs no provider code before receiving the private ownership grant. */
export async function runInteractiveBootstrap(): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
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
    clearTimeout(deadline);
    child = Bun.spawn(start.command, {
      cwd: start.cwd,
      env: start.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const actual = child;
    deadline = setTimeout(() => {
      actual.kill("SIGKILL");
      process.exit(1);
    }, start.timeoutMs);
    await Bun.stdout.write(`${INTERACTIVE_BOOTSTRAP_PREFIX}${actual.pid}\n`);
    const forward = async (
      stream: ReadableStream<Uint8Array>,
      target: Bun.BunFile,
      cap: number,
    ) => {
      const input = stream.getReader();
      let total = 0;
      try {
        for (;;) {
          const next = await input.read();
          if (next.done) break;
          total += next.value.byteLength;
          if (total > cap) throw new Error("Output bound");
          await target.write(next.value);
        }
      } finally {
        input.releaseLock();
      }
    };
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
    const results = await Promise.all([
      exited,
      inputDone,
      forward(actual.stdout, Bun.stdout, 16_777_216),
      forward(actual.stderr, Bun.stderr, 1_048_576),
    ]);
    process.exitCode = results[0];
  } catch {
    child?.kill("SIGKILL");
    // Never include the envelope, provider environment, prompt or exception body.
    process.stderr.write("The owned interactive process could not complete.\n");
    process.exitCode = 1;
  } finally {
    if (deadline) clearTimeout(deadline);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

if (isMain(import.meta)) await runInteractiveBootstrap();
