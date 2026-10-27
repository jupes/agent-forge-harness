/** Native process fixture only: never reads provider credentials or requests a model. */
import { appendFileSync } from "node:fs";
import { codexReportedActivity } from "./reported-activity";

export async function runCodexTaskRuntimeFixture() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--agent-forge-fixture-descendant") {
    await new Promise(() => setInterval(() => {}, 1000));
    return;
  }
  const kind = argv.includes("--version")
    ? "version"
    : argv.includes("--help")
      ? "help"
      : argv.includes("--sync")
        ? "sync"
        : "task";
  const stdin = await Bun.stdin.text();
  const mode = process.env["CODEX_RUNTIME_MODE"] ?? "normal";
  const childPid =
    (kind === "task" && mode === "hang-tree") ||
    (kind === "sync" && mode === "hang-sync") ||
    (kind === "help" && mode === "hang-help")
      ? Bun.spawn([process.execPath, "--agent-forge-fixture-descendant"], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }).pid
      : null;
  const log = process.env["CODEX_RUNTIME_LOG"];
  if (!log) throw new Error("A fixture-owned private log is required.");
  appendFileSync(
    log,
    `${JSON.stringify({
      kind,
      argv,
      stdin,
      cwd: process.cwd(),
      pid: process.pid,
      childPid,
      secretPresent: process.env["TEST_OPERATOR_SECRET"] !== undefined,
      forged:
        process.env["AGENT_FORGE_FORGED"] !== undefined ||
        process.env["FORGE_SLUG"] !== undefined,
      allowed: process.env["TEST_ALLOWED"],
      adapter: process.env["AGENT_FORGE_ADAPTER"],
      smith: process.env["AGENT_FORGE_SMITH"],
      bead: process.env["AGENT_FORGE_BEAD_ID"],
    })}\n`,
  );
  if (kind === "version")
    console.log(
      mode === "changed-version"
        ? "codex-cli 0.164.0"
        : "codex-cli 0.163.0-alpha.10.2",
    );
  else if (kind === "help") {
    if (mode === "hang-help")
      await new Promise(() => {
        setInterval(() => {}, 1000);
      });
    console.log(
      mode === "legacy-help"
        ? "--help"
        : "--json --color --sandbox --model --cd --config",
    );
  } else if (kind === "sync") {
    if (mode === "sync-failure") {
      console.error("SECRET private sync failure");
      process.exitCode = 7;
    }
    if (mode === "hang-sync")
      await new Promise(() => {
        setInterval(() => {}, 1000);
      });
  } else if (kind === "task") {
    const emit = (value: Record<string, unknown>) =>
      console.log(JSON.stringify(value));
    emit({
      type: "thread.started",
      thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53",
    });
    emit({ type: "turn.started" });
    if (mode === "rich")
      for (const packet of codexReportedActivity) emit(packet);
    const reply = {
      type: "item.completed",
      item: {
        id: "reply",
        type: "agent_message",
        text: "Runtime private reply 🌱",
      },
    };
    emit(reply);
    emit(reply);
    if (mode === "flood")
      for (let index = 0; index < 300; index++)
        emit({
          type: "item.completed",
          item: {
            id: `flood_${index}`,
            type: "agent_message",
            text: "private item",
          },
        });
    if (mode === "hang-tree")
      await new Promise(() => {
        setInterval(() => {}, 1000);
      });
    if (mode === "foreign")
      emit({
        type: "thread.started",
        thread_id: "13a72c84-6c9d-438c-9160-6fdd19f92177",
      });
    else if (mode === "malformed")
      console.log("{SECRET malformed private body");
    else if (mode !== "missing-terminal")
      emit({
        type: "turn.completed",
        usage: { input_tokens: 9, output_tokens: 6 },
      });
    if (mode === "overflow-after-result")
      process.stdout.write("x".repeat(1_048_577));
    if (mode === "exit-after-result") process.exitCode = 7;
  }
}
