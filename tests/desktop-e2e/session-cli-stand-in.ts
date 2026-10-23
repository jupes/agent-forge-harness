/** Compiled only into this suite's fake Claude executable. No model, tools or network. */
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeReportedActivity } from "../../scripts/sessions/fixtures/reported-activity";

export const codingFlags =
  "--print --input-format --output-format --verbose --include-partial-messages --model --effort --permission-mode --permission-prompts --allowedTools --resume --fallback-model --add-dir --max-budget-usd --json-schema";
export async function runCodingFixture(home: string) {
  let mode: unknown = "normal";
  try {
    mode = JSON.parse(
      readFileSync(join(home, "coding-fixture-mode.json"), "utf8"),
    );
  } catch {
    /* Normal unless explicitly changed in the isolated test home. */
  }
  if (
    typeof mode !== "string" ||
    ![
      "normal",
      "hang",
      "provider-error",
      "missing-result",
      "rich",
      "rich-many",
      "rich-hang",
      "rich-timeout",
      "rich-auth-error",
      "rich-rate-limit",
      "rich-crash",
    ].includes(mode)
  )
    throw new Error("Unknown coding browser fixture mode");
  const argv = process.argv.slice(2),
    stdin = await Bun.stdin.text();
  const resume = argv.indexOf("--resume"),
    id = resume >= 0 ? argv[resume + 1] : randomUUID();
  writeFileSync(
    join(home, "coding-fixture-record.json"),
    JSON.stringify({ argv, stdin, id, cwd: process.cwd(), pid: process.pid }),
  );
  appendFileSync(
    join(home, "coding-fixture-starts.jsonl"),
    JSON.stringify({ id, pid: process.pid }) + "\n",
  );
  const emit = (value: Record<string, unknown>) =>
    process.stdout.write(JSON.stringify({ session_id: id, ...value }) + "\n");
  emit({ type: "system", subtype: "init" });
  if (mode.startsWith("rich"))
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
      content_block: { type: "text", text: "Coding reply " },
    },
  });
  emit({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "🌱" },
    },
  });
  if (mode === "rich-many")
    for (let n = 0; n < 121; n++)
      emit({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: `\nPrivate complete export line ${n}`,
          },
        },
      });
  if (mode === "rich-crash") {
    process.stderr.write("Private fixture crash tail");
    process.exitCode = 7;
    return;
  }
  if (mode === "rich-auth-error" || mode === "rich-rate-limit")
    emit({
      type: "assistant",
      uuid: "typed-error",
      error:
        mode === "rich-auth-error" ? "authentication_failed" : "rate_limit",
      message: {
        id: "error",
        model: "<synthetic>",
        content: [{ type: "text", text: "Private typed provider failure" }],
      },
    });
  if (mode === "hang" || mode === "rich-hang" || mode === "rich-timeout") {
    if (mode !== "hang")
      emit({
        type: "assistant",
        uuid: "pending-tool",
        message: {
          id: "pending",
          content: [
            {
              type: "tool_use",
              id: "pending-native-tool",
              name: "Bash",
              input: { command: "inert pending command" },
            },
          ],
        },
      });
    await new Promise(() => {
      setInterval(() => {}, 1000);
    });
  } else if (mode !== "missing-result")
    emit({
      type: "result",
      subtype:
        mode === "provider-error" ||
        mode.endsWith("error") ||
        mode === "rich-rate-limit"
          ? "error_during_execution"
          : "success",
      is_error:
        mode === "provider-error" ||
        mode.endsWith("error") ||
        mode === "rich-rate-limit",
      result:
        mode === "provider-error"
          ? "The fake provider refused this turn."
          : "Coding reply 🌱",
      ...(mode === "rich"
        ? {
            structured_output: {
              result: "Private structured result",
              html: "<script>inert</script>",
            },
            usage: {
              input_tokens: 11,
              output_tokens: 7,
              cache_read_input_tokens: 3,
              cache_creation_input_tokens: 4,
            },
            total_cost_usd: 0.0001,
            duration_ms: 123,
            permission_denials: [
              {
                tool_name: "Bash",
                tool_use_id: "denied-one",
                tool_input: { command: "inert denied command" },
              },
              {
                tool_name: "Bash",
                tool_use_id: "denied-two",
                tool_input: { command: "inert denied command" },
              },
            ],
          }
        : {}),
    });
}
