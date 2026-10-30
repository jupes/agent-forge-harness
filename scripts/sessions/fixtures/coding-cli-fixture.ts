/** No model or network access: a stand-in for the coding CLI's actual pipes. */

import { randomUUID } from "node:crypto";
import { writeWhole } from "../../executors/fixtures/write-whole";
import { claudeReportedActivity } from "./reported-activity";

export async function runCodingCliFixture() {
  const argv = process.argv.slice(2);
  const mode = process.env["CODING_FIXTURE_MODE"] ?? "normal";
  if (argv.length === 1 && argv[0] === "--fixture-stop-helper") {
    if (mode === "stop-helper-smoke") {
      console.log("fixture-stop-helper-smoke");
      return;
    }
    if (mode === "stop-helper") {
      await new Promise<void>(() => {
        setInterval(() => {}, 1000);
      });
      return;
    }
    throw new Error("Invalid coding fixture stop-helper entry");
  }
  const flags =
    "--print --input-format --output-format --verbose --include-partial-messages --model --effort --permission-mode --permission-prompts --allowedTools --resume --fallback-model --add-dir --max-budget-usd --json-schema";
  if (argv.includes("--version")) console.log("2.1.296 (Claude Code fixture)");
  else if (argv.includes("--help"))
    console.log(mode === "legacy" ? "--print" : flags);
  else {
    const stdin = await Bun.stdin.text();
    const index = argv.indexOf("--resume");
    const id =
      mode === "foreign"
        ? "a02b7361-efc4-4fe0-88dc-9ca7f96fe277"
        : index >= 0
          ? argv[index + 1]
          : randomUUID();
    let childPid: number | null = null;
    let helperSmoke:
      | { exitCode: number; marker: string }
      | undefined;
    if (mode === "hang-tree" || mode === "helper-smoke") {
      const helperMode =
        mode === "hang-tree" ? "stop-helper" : "stop-helper-smoke";
      const helper = Bun.spawn(
        [process.execPath, "--fixture-stop-helper"],
        {
          env: {
            ...process.env,
            CODING_FIXTURE_MODE: helperMode,
            CODING_FIXTURE_RECORD: undefined,
          },
          stdin: "ignore",
          stdout: mode === "helper-smoke" ? "pipe" : "ignore",
          stderr: "ignore",
          ...(mode === "helper-smoke"
            ? { timeout: 5000, maxBuffer: 4 * 1024 }
            : {}),
        },
      );
      childPid = helper.pid;
      if (mode === "helper-smoke") {
        const [exitCode, output] = await Promise.all([
          helper.exited,
          new Response(helper.stdout).text(),
        ]);
        helperSmoke = {
          exitCode,
          marker:
            output === "fixture-stop-helper-smoke\n"
              ? "fixture-stop-helper-smoke"
              : "invalid-helper-output",
        };
      }
    }
    const record = process.env["CODING_FIXTURE_RECORD"];
    if (record)
      writeWhole(
        record,
        JSON.stringify({
          argv,
          stdin,
          cwd: process.cwd(),
          pid: process.pid,
          childPid,
          ...(helperSmoke ? { helperSmoke } : {}),
          operatorSecret: process.env["TEST_OPERATOR_SECRET"] !== undefined,
          forged:
            process.env["AGENT_FORGE_FORGED"] !== undefined ||
            process.env["FORGE_SLUG"] !== undefined,
          adapter: process.env["AGENT_FORGE_ADAPTER"],
          smith: process.env["AGENT_FORGE_SMITH"],
          bead: process.env["AGENT_FORGE_BEAD_ID"],
        }),
      );
    const emit = (value: Record<string, unknown>) =>
      console.log(JSON.stringify({ session_id: id, ...value }));
    emit({
      type: "system",
      subtype: "init",
      ...(mode === "rich" ? { apiKeySource: "none" } : {}),
    });
    if (mode === "rich")
      for (const packet of claudeReportedActivity) emit(packet);
    emit({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { id: "reply", model: "fixture-served-model" },
      },
    });
    emit({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "Coding " },
      },
    });
    emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "reply 🌱" },
      },
    });
    const full = {
      type: "assistant",
      uuid: "full-reply",
      message: {
        id: "reply",
        model: "fixture-served-model",
        content: [{ type: "text", text: "Coding reply 🌱!" }],
      },
    };
    emit(full);
    emit(full);
    emit({
      type: "assistant",
      parent_tool_use_id: "subagent",
      message: {
        id: "sub",
        content: [{ type: "text", text: "Subordinate private body" }],
      },
    });
    if (mode === "hang-tree")
      await new Promise(() => {
        setInterval(() => {}, 1000);
      });
    else if (mode === "malformed") console.log("{malformed");
    else if (mode === "overflow") process.stdout.write("x".repeat(1_048_577));
    else if (mode !== "missing-result")
      emit({
        type: "result",
        subtype:
          mode === "provider-error" ? "error_during_execution" : "success",
        is_error: mode === "provider-error",
        result: "Private fixture result",
        ...(mode === "rich"
          ? {
              uuid: "final",
              structured_output: { actual: "Private structured result" },
              usage: {
                input_tokens: 20,
                output_tokens: 5,
                cache_read_input_tokens: 12,
                cache_creation_input_tokens: 3,
              },
              total_cost_usd: 0.5,
            }
          : {}),
      });
    if (mode === "exit-after-result") process.exitCode = 7;
  }
}
