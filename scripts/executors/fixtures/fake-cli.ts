#!/usr/bin/env bun
/**
 * A stand-in provider CLI for adapter tests. Behaviour comes from the leading
 * `--fake-*` flags the test puts in the adapter's `command` override; every
 * later argument is the adapter's own and is recorded, not interpreted.
 *
 *   --fake-provider claude|codex   which stream dialect to print
 *   --fake-mode ok|tools|garbage|crash|hang|auth|model
 *   --fake-dump <file>             write { cwd, env, argv, stdin } as JSON
 *
 * The line shapes (field names and nesting) follow what the real CLIs printed
 * when they were run by hand on Windows — `claude` 2.1.293 as far as an
 * authentication failure, `codex` 0.160.0 through one shell command — with
 * invented values; no recorded line is copied. Two shapes are not from a
 * recording: the Claude `tool_use` block (the documented stream-json format;
 * that run never got as far as a tool) and a successful Claude `result`.
 *
 *   auth   (claude) the stored sign-in is rejected: an assistant error message,
 *          an error `result`, exit 1
 *   model  (codex)  the provider rejects the model: an `error` item, `error`,
 *          `turn.failed`, exit 1
 */

import { writeFileSync } from "fs";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const provider = flag("--fake-provider") ?? "claude";
const mode = flag("--fake-mode") ?? "ok";
const dump = flag("--fake-dump");

if (argv.includes("--version")) {
  console.log(`fake-${provider} 0.0.1`);
  process.exit(0);
}

const stdin = await new Response(Bun.stdin.stream()).text();
if (dump) {
  writeFileSync(
    dump,
    JSON.stringify({ cwd: process.cwd(), env: process.env, argv, stdin }),
  );
}

const emit = (value: unknown) => console.log(JSON.stringify(value));

function claudeTool(name: string, input: unknown) {
  emit({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t", name, input }] },
    session_id: "fake-1",
  });
}

let codexItems = 0;
/** One shell command the way the stream reports it: started, then completed. */
function codexTool(command: string, exit: number) {
  const item = {
    id: `item_${codexItems++}`,
    type: "command_execution",
    command,
    aggregated_output: "",
  };
  emit({
    type: "item.started",
    item: { ...item, exit_code: null, status: "in_progress" },
  });
  emit({
    type: "item.completed",
    item: { ...item, exit_code: exit, status: "completed" },
  });
}
function codexSays(text: string) {
  emit({
    type: "item.completed",
    item: { id: `item_${codexItems++}`, type: "agent_message", text },
  });
}

if (mode === "hang") {
  setInterval(() => undefined, 1000);
  await new Promise(() => undefined);
}

if (provider === "claude") {
  emit({
    type: "system",
    subtype: "init",
    session_id: "fake-1",
    model: "fake-model",
    permissionMode: "acceptEdits",
  });
  if (mode === "auth") {
    emit({
      type: "assistant",
      message: {
        model: "<synthetic>",
        content: [{ type: "text", text: "not signed in (fake)" }],
      },
      session_id: "fake-1",
      error: "authentication_failed",
    });
    emit({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "not signed in (fake)",
      session_id: "fake-1",
    });
    process.exit(1);
  }
  if (mode === "tools" || mode === "ok") {
    claudeTool("Bash", { command: "bun test SECRET_BODY_MUST_NOT_LEAK" });
    claudeTool("Read", { file_path: "a.ts" });
  }
  if (mode === "garbage") {
    console.log("not json at all");
    console.log('{"type":"mystery"}');
    console.log("{broken");
    claudeTool("Edit", { file_path: "b.ts" });
  }
} else {
  emit({ type: "thread.started", thread_id: "fake-2" });
  if (mode === "model") {
    const message = "the model is not supported (fake)";
    emit({
      type: "item.completed",
      item: { id: "item_0", type: "error", message },
    });
    emit({ type: "turn.started" });
    emit({ type: "error", message });
    emit({ type: "turn.failed", error: { message } });
    process.exit(1);
  }
  emit({ type: "turn.started" });
  if (mode === "tools" || mode === "ok") {
    codexSays("on it");
    codexTool("bun test SECRET_BODY_MUST_NOT_LEAK", 0);
    codexTool("git status", 0);
    codexSays("done");
  }
  if (mode === "garbage") {
    console.log("not json at all");
    console.log('{"type":"mystery"}');
    codexTool("ls", 0);
  }
}

if (mode === "crash") process.exit(3);
emit(
  provider === "claude"
    ? { type: "result" }
    : {
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
);
