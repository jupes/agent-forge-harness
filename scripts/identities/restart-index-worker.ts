import { existsSync, writeFileSync } from "node:fs";
import type { RestartIdentityInput } from "./restart-index";
import { createRestartIdentityJournal } from "./restart-index";

type Operation = "attempt" | "retire";

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("barrier-timeout");
    await Bun.sleep(5);
  }
}

async function run(): Promise<void> {
  const [operation, profile, rawInput, readyPath, releasePath] =
    process.argv.slice(2);
  if (
    (operation !== "attempt" && operation !== "retire") ||
    profile === undefined ||
    rawInput === undefined
  )
    throw new Error("invalid-worker-arguments");

  const input = JSON.parse(rawInput) as RestartIdentityInput;
  if (readyPath !== undefined) {
    if (releasePath === undefined) throw new Error("invalid-barrier-arguments");
    writeFileSync(readyPath, "ready", { flag: "wx" });
    await waitFor(releasePath);
  }

  const journal = createRestartIdentityJournal(profile);
  if (operation === "attempt") {
    const result = await journal.beginAttempt(input);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        operation,
        state: result.row.state,
        mayDispatch: result.mayDispatch,
      })}\n`,
    );
  } else {
    const row = await journal.retireReserved(input);
    process.stdout.write(
      `${JSON.stringify({ ok: true, operation, state: row.state })}\n`,
    );
  }
}

try {
  await run();
} catch (error) {
  const kind =
    typeof error === "object" && error !== null && "kind" in error
      ? String(error.kind)
      : error instanceof Error && error.message === "barrier-timeout"
        ? "barrier-timeout"
        : "unexpected";
  process.stdout.write(`${JSON.stringify({ ok: false, kind })}\n`);
  process.exitCode = 0;
}
