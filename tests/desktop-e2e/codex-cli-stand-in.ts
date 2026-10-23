/** Compiled only into the isolated desktop suite. No model, account, tools or network. */
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export async function runCodexStandIn() {
  const argv = process.argv.slice(2);
  if (argv.includes("--fixture-child")) {
    await new Promise(() => {
      setInterval(() => {}, 1000);
    });
    return;
  }
  // The production runtime deliberately strips AGENT_FORGE_HOME. This fixture
  // derives only its own compiled location, never the operator's home.
  const bin = dirname(process.execPath),
    parent = dirname(bin);
  if (basename(bin) !== "bin" || basename(parent) !== "bd-stand-in")
    throw Error(
      "The native Codex fixture must run in its isolated bin directory.",
    );
  const home = resolve(parent, "..");
  const kind = argv.includes("--version")
    ? "version"
    : argv.includes("--help")
      ? "help"
      : argv.includes("--sync")
        ? "sync"
        : "task";
  const stdin = await Bun.stdin.text();
  let mode: unknown = "normal";
  try {
    mode = JSON.parse(
      readFileSync(join(home, "codex-fixture-mode.json"), "utf8"),
    );
  } catch {
    /* Explicit fixture mode is optional. */
  }
  if (!["normal", "hang", "provider-error"].includes(String(mode)))
    throw Error("Unknown isolated Codex fixture mode.");
  const id = randomUUID();
  const childPid =
    kind === "task" && mode === "hang"
      ? Bun.spawn([process.execPath, "--fixture-child"], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }).pid
      : null;
  appendFileSync(
    join(home, "codex-fixture-calls.jsonl"),
    JSON.stringify({
      kind,
      argv,
      stdin,
      cwd: process.cwd(),
      id,
      pid: process.pid,
      childPid,
    }) + "\n",
  );
  if (kind === "version") console.log("codex-cli 0.163.0-alpha.10.2");
  else if (kind === "help")
    console.log("--json --color --sandbox --model --cd --config");
  else if (kind === "task") {
    const emit = (value: Record<string, unknown>) =>
      console.log(JSON.stringify(value));
    emit({ type: "thread.started", thread_id: id });
    emit({ type: "turn.started" });
    const reply = {
      type: "item.completed",
      item: { id: "reply", type: "agent_message", text: "Codex Task reply 🌱" },
    };
    emit(reply);
    emit(reply);
    if (mode === "hang")
      await new Promise(() => {
        setInterval(() => {}, 1000);
      });
    else if (mode === "provider-error")
      emit({
        type: "turn.failed",
        error: { message: "Private fixture failure" },
      });
    else
      emit({
        type: "turn.completed",
        usage: { input_tokens: 9, output_tokens: 6 },
      });
  }
}
// Dedicated compiled fixture entry, like keeper-cli-stand-in.ts. Bun's virtual
// compiled module path cannot be canonicalized by the source-CLI entry check.
await runCodexStandIn();
