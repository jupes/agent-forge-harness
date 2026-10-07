#!/usr/bin/env bun
/**
 * A stand-in provider CLI for adapter tests. Behaviour comes from the leading
 * `--fake-*` flags the test puts in the adapter's `command` override; every
 * later argument is the adapter's own and is recorded, not interpreted.
 *
 *   --fake-provider claude|codex   which stream dialect to print
 *   --fake-mode ok|tools|garbage|crash|hang
 *   --fake-dump <file>             write { cwd, env, argv, stdin } as JSON
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
  });
}
function codexTool(command: string, exit: number) {
  emit({
    type: "item.completed",
    item: { type: "command_execution", command, exit_code: exit },
  });
}

if (mode === "hang") {
  setInterval(() => undefined, 1000);
  await new Promise(() => undefined);
}

if (provider === "claude") {
  emit({ type: "system", subtype: "init", session_id: "fake-1" });
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
  if (mode === "tools" || mode === "ok") {
    codexTool("bun test SECRET_BODY_MUST_NOT_LEAK", 0);
    codexTool("git status", 0);
  }
  if (mode === "garbage") {
    console.log("not json at all");
    console.log('{"type":"mystery"}');
    codexTool("ls", 0);
  }
}

if (mode === "crash") process.exit(3);
emit({ type: provider === "claude" ? "result" : "turn.completed" });
