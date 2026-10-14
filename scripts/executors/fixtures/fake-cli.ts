#!/usr/bin/env bun
/**
 * A stand-in provider CLI for adapter tests. Behaviour comes from the leading
 * `--fake-*` flags the test puts in the adapter's `command` override; every
 * later argument is the adapter's own and is recorded, not interpreted.
 *
 *   --fake-provider claude|codex   which stream dialect to print
 *   --fake-mode ok|tools|garbage|crash|hang|hang-tree|auth|model|no-tool-host|no-tools|stderr
 *   --fake-dump <file>             write { cwd, env, argv, stdin, pid } as JSON
 *   --fake-session-id <id>         the session id the stream reports (Claude:
 *                                  `session_id` on every line; Codex:
 *                                  `thread_id` on `thread.started`). Default:
 *                                  a new UUID per run, as the real CLIs mint
 *   --fake-no-id                   the stream reports no session id at all
 *   --fake-model <id>              (claude) the model each assistant message
 *                                  of a tool call names, as a response does
 *                                  (`message.model`). Default: none
 *   --fake-attach <file>           once the line with the id is out, wait (up
 *                                  to 2 s) for the checkout this process runs
 *                                  in to mirror that id (any mirror, with
 *                                  --fake-no-id), then write what a script run
 *                                  here attaches to (`resolveAttach` with this
 *                                  process's environment) as JSON. The model
 *                                  cache it reads is a ledger file beside
 *                                  <file>
 *
 * The line shapes (field names and nesting) follow what the real CLIs printed
 * when each binary was run directly on Windows — `claude` 2.1.293 as far as
 * an authentication failure, `codex` 0.159.0 for a rejected model and for a
 * copy with no tool host, `codex` 0.160.0 through one shell command. Each
 * line carries a subset of the real fields; the discriminating values
 * (`authentication_failed`, `is_error`, `command_execution`, the `error` item
 * type, the statuses) and the field names of the session ids and of the usage
 * objects are the real ones, while ids, text and counts are invented, and no
 * recorded line is copied. Four shapes are not from a recording: the Claude
 * `tool_use` block (the documented stream-json format; that run never got as
 * far as a tool), a successful Claude `result` (it carries the same `usage`
 * and `total_cost_usd` fields as the recorded failed one), a run that ends
 * without calling a tool and reports nothing wrong (`no-tools`), and a
 * failure told only on stderr (`stderr`).
 *
 *   auth          (claude) the stored sign-in is rejected: an assistant error
 *                 message, an error `result` (all-zero usage), exit 1
 *   model         (codex)  the provider rejects the model: an `error` item,
 *                 `error`, `turn.failed`, exit 1
 *   no-tool-host  (codex)  the helper that runs tools is missing: an `error`
 *                 item, an agent message saying the task was not done,
 *                 `turn.completed`, exit 0
 *   no-tools      the stream's first and last lines and no tool, exit 0
 *   stderr        one line on stderr and nothing on stdout, exit 2
 *   hang-tree     start a child of its own that hangs, print its pid as one
 *                 line (`{ "childPid": <n> }`), then hang. On Windows the
 *                 child is started detached, elsewhere it stays in this
 *                 process's group. On Windows (Bun 1.3.10) a fake the
 *                 harness supervised did not outlive the harness even with
 *                 its exit hook removed, and a detached child of that fake
 *                 did (`supervisor.test.ts`)
 */

import { existsSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import {
  readSessionMirror,
  resolveAttach,
  SESSION_MIRROR_FILE,
} from "../../ledger/identity";
import { resolveCheckout } from "../../ledger/workspace";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const provider = flag("--fake-provider") ?? "claude";
const mode = flag("--fake-mode") ?? "ok";
const dump = flag("--fake-dump");
const attach = flag("--fake-attach");
const responseModel = flag("--fake-model");
const sessionId = argv.includes("--fake-no-id")
  ? undefined
  : (flag("--fake-session-id") ?? crypto.randomUUID());

if (argv.includes("--version")) {
  console.log(`fake-${provider} 0.0.1`);
  process.exit(0);
}

const stdin = await new Response(Bun.stdin.stream()).text();
if (dump) {
  writeFileSync(
    dump,
    JSON.stringify({
      cwd: process.cwd(),
      env: process.env,
      argv,
      stdin,
      pid: process.pid,
    }),
  );
}

const emit = (value: unknown) => console.log(JSON.stringify(value));

/** A Claude line: every one the real CLI printed carried the session id. */
const claudeLine = (value: Record<string, unknown>) =>
  sessionId === undefined ? value : { ...value, session_id: sessionId };

/** What a script launched from this session attaches to, once it is mirrored. */
async function recordAttach(): Promise<void> {
  if (!attach) return;
  const checkout = resolveCheckout(process.cwd()).worktree;
  // A mirror may be there before the run: wait for this session's own id.
  const mirrored = () =>
    sessionId === undefined
      ? existsSync(join(checkout, SESSION_MIRROR_FILE))
      : readSessionMirror(checkout) === sessionId;
  // Well inside a test's own 5 s, so a missing mirror fails an assertion.
  const deadline = Date.now() + 2000;
  while (!mirrored() && Date.now() < deadline) await Bun.sleep(20);
  const attached = resolveAttach({
    cwd: process.cwd(),
    env: process.env,
    path: join(dirname(attach), "attach-ledger.db"),
  });
  writeFileSync(attach, JSON.stringify(attached));
}

function claudeTool(name: string, input: unknown) {
  emit(
    claudeLine({
      type: "assistant",
      message: {
        ...(responseModel !== undefined ? { model: responseModel } : {}),
        content: [{ type: "tool_use", id: "t", name, input }],
      },
    }),
  );
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

if (mode === "hang-tree") {
  const child = Bun.spawn(
    [process.execPath, import.meta.path, "--fake-mode", "hang"],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      ...(process.platform === "win32" ? { detached: true } : {}),
    },
  );
  emit({ childPid: child.pid });
  setInterval(() => undefined, 1000);
  await new Promise(() => undefined);
}

if (mode === "stderr") {
  console.error("the stream could not be started (fake)");
  process.exit(2);
}

if (provider === "claude") {
  emit(
    claudeLine({
      type: "system",
      subtype: "init",
      model: "fake-model",
      permissionMode: "acceptEdits",
    }),
  );
  await recordAttach();
  if (mode === "auth") {
    emit(
      claudeLine({
        type: "assistant",
        message: {
          model: "<synthetic>",
          content: [{ type: "text", text: "not signed in (fake)" }],
        },
        error: "authentication_failed",
      }),
    );
    emit(
      claudeLine({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "not signed in (fake)",
        total_cost_usd: 0,
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
          server_tool_use: { web_search_requests: 0 },
        },
      }),
    );
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
  emit(
    sessionId === undefined
      ? { type: "thread.started" }
      : { type: "thread.started", thread_id: sessionId },
  );
  await recordAttach();
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
  if (mode === "no-tool-host") {
    emit({
      type: "item.completed",
      item: {
        id: `item_${codexItems++}`,
        type: "error",
        message: "the tool host was not found, so no command can run (fake)",
      },
    });
    codexSays("I could not create the file (fake)");
  }
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
    ? claudeLine({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done (fake)",
        total_cost_usd: 0.0125,
        usage: {
          input_tokens: 12,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 4000,
          output_tokens: 56,
          server_tool_use: { web_search_requests: 0 },
          service_tier: "standard",
        },
      })
    : {
        type: "turn.completed",
        usage: {
          input_tokens: 2400,
          cached_input_tokens: 1800,
          cache_write_input_tokens: 5,
          output_tokens: 90,
          reasoning_output_tokens: 40,
        },
      },
);
