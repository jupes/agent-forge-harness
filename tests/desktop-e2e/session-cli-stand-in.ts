/** Compiled only into this suite's fake Claude executable. No model, tools or network. */
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
    mode !== "normal" &&
    mode !== "hang" &&
    mode !== "provider-error" &&
    mode !== "missing-result"
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
  if (mode === "hang")
    await new Promise(() => {
      setInterval(() => {}, 1000);
    });
  else if (mode !== "missing-result")
    emit({
      type: "result",
      subtype: mode === "provider-error" ? "error_during_execution" : "success",
      is_error: mode === "provider-error",
      result:
        mode === "provider-error"
          ? "The fake provider refused this turn."
          : "Coding reply 🌱",
    });
}
