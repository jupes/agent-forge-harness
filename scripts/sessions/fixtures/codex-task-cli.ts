/** Hermetic native process fixture: no provider, account, model or credential access. */
import { writeFileSync } from "node:fs";
import { isMain } from "../../is-main";

if (isMain(import.meta)) {
  const argv = process.argv.slice(2);
  const stdin = await Bun.stdin.text();
  const capture = process.env["CODEX_TASK_FIXTURE_CAPTURE"];
  if (!capture) throw new Error("A test-owned capture path is required.");
  writeFileSync(
    capture,
    JSON.stringify({
      argv,
      stdin,
      cwd: process.cwd(),
      secretPresent: process.env["TEST_OPERATOR_SECRET"] !== undefined,
    }),
  );
  const emit = (value: Record<string, unknown>) =>
    console.log(JSON.stringify(value));
  emit({
    type: "thread.started",
    thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53",
  });
  emit({ type: "turn.started" });
  emit({
    type: "item.updated",
    item: { id: "reply", type: "agent_message", text: "Fixture private" },
  });
  emit({
    type: "item.completed",
    item: {
      id: "tool",
      type: "command_execution",
      command: "echo fixture",
      aggregated_output: "private tool body",
      status: "completed",
      exit_code: 0,
    },
  });
  const reply = {
    type: "item.completed",
    item: {
      id: "reply",
      type: "agent_message",
      text: "Fixture private reply 🌱",
    },
  };
  emit(reply);
  emit(reply);
  emit({
    type: "turn.completed",
    usage: { input_tokens: 9, output_tokens: 6 },
  });
  if (process.env["CODEX_TASK_FIXTURE_MODE"] === "exit-after-result")
    process.exitCode = 7;
}
