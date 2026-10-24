import { appendFileSync, existsSync, readFileSync } from "node:fs";

export async function runGeminiTaskRuntimeFixture() {
  const argv = process.argv.slice(2);
  if (argv.includes("--helper")) {
    await new Promise(() => setInterval(() => {}, 1000));
    return;
  }
  const log = process.env["GEMINI_RUNTIME_LOG"];
  let control: { version?: string; help?: string; mode?: string } = {};
  try {
    if (log && existsSync(`${log}.control`))
      control = JSON.parse(readFileSync(`${log}.control`, "utf8"));
  } catch {
    throw Error("Invalid inert fixture control");
  }
  const mode = control.mode ?? process.env["GEMINI_RUNTIME_MODE"] ?? "normal";
  const record = (value: Record<string, unknown>) => {
    if (log) appendFileSync(log, `${JSON.stringify(value)}\n`);
  };
  if (argv.includes("--version")) {
    record({ kind: "version" });
    console.log(control.version ?? "0.65.0");
    return;
  }
  if (argv.includes("--help")) {
    record({ kind: "help" });
    if (mode === "hold-help") await Bun.sleep(400);
    console.log(
      control.help ??
        "--output-format --model --approval-mode --sandbox --policy --include-directories",
    );
    return;
  }
  const stdin = await Bun.stdin.text();
  const childPid = ["hang-tree", "normal-orphan"].includes(mode)
    ? Bun.spawn([process.execPath, "--helper"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: process.env,
      }).pid
    : null;
  record({
    kind: "task",
    argv,
    stdin,
    cwd: process.cwd(),
    pid: process.pid,
    childPid,
    allowed: process.env["TEST_ALLOWED"],
    secretPresent: !!process.env["TEST_OPERATOR_SECRET"],
    forged: !!process.env["AGENT_FORGE_FORGED"],
    preload:
      !!process.env["NODE_OPTIONS"] ||
      !!process.env["BUN_OPTIONS"] ||
      !!process.env["NODE_PATH"],
    adapter: process.env["AGENT_FORGE_ADAPTER"],
    smith: process.env["AGENT_FORGE_SMITH"],
  });
  const timestamp = "2026-10-23T08:00:00.000Z";
  const emit = (event: Record<string, unknown>) =>
    console.log(JSON.stringify({ timestamp, ...event }));
  emit({
    type: "init",
    session_id: "0199a213-81c0-7800-8aa1-bbab2a035a53",
    model: "auto-gemini-example",
  });
  if (mode === "markdown") {
    emit({
      type: "message",
      role: "user",
      content: "USER ECHO MUST STAY ABSENT",
    });
    for (const content of [
      "**Read",
      "able**\n\n```ts\nconst answer = ",
      "42;\n```\n\n[Safe link](https://example.com) [Blocked](javascript:alert)\n\n<img src=x onerror=alert(1)>",
    ])
      emit({ type: "message", role: "assistant", content, delta: true });
    if (!log) throw Error("The held Markdown fixture needs its private log");
    const deadline = Date.now() + 25_000;
    while (!existsSync(`${log}.markdown-release`)) {
      if (Date.now() >= deadline)
        throw Error("The held Markdown fixture was not released");
      await Bun.sleep(10);
    }
    emit({
      type: "tool_use",
      tool_id: "markdown-tool",
      tool_name: "read_file",
      parameters: { path: "PRIVATE_REPORTED_PATH" },
    });
    emit({
      type: "tool_result",
      tool_id: "markdown-tool",
      status: "success",
      output: "PRIVATE_TOOL_TEXT",
    });
    emit({
      type: "message",
      role: "assistant",
      content: "**Separate complete report**",
      delta: false,
    });
    emit({
      type: "message",
      role: "assistant",
      content: "Separate delta after complete.",
      delta: true,
    });
  } else
    emit({
      type: "message",
      role: "assistant",
      content: "Private reply 🌱",
      delta: true,
    });
  if (mode === "hang-tree") {
    await new Promise(() => setInterval(() => {}, 1000));
    return;
  }
  if (mode === "malformed") {
    console.log("{invalid private packet");
    return;
  }
  if (mode === "missing-result") return;
  if (mode === "overflow") {
    console.log("x".repeat(1_048_577));
    return;
  }
  if (mode === "provider-error")
    emit({
      type: "error",
      severity: "error",
      message: "Synthetic authentication refusal",
    });
  if (mode.startsWith("flood"))
    for (let n = 0; n < (mode === "flood-200" ? 200 : 300); n++)
      emit({
        type: "message",
        role: "assistant",
        content: `frame ${n}`,
        delta: true,
      });
  if (mode === "denied") {
    emit({
      type: "tool_use",
      tool_id: "denied-tool",
      tool_name: "run_shell_command",
      parameters: { command: "DO_NOT_EXECUTE" },
    });
    emit({
      type: "tool_result",
      tool_id: "denied-tool",
      status: "error",
      error: { type: "policy_violation", message: "Synthetic policy refusal" },
    });
  }
  emit({
    type: "result",
    status: "success",
    stats: {
      total_tokens: 26,
      input_tokens: 23,
      output_tokens: 3,
      cached: 7,
      input: 16,
      duration_ms: 1200,
      tool_calls: mode === "denied" ? 1 : 0,
      models: {
        "gemini-actual-example": {
          total_tokens: 26,
          input_tokens: 23,
          output_tokens: 3,
          cached: 7,
          input: 16,
        },
      },
    },
  });
  if (mode === "normal-orphan") process.exit(0);
  if (mode === "exit-9") {
    process.stderr.write("Synthetic native stderr\n");
    process.exit(9);
  }
}
