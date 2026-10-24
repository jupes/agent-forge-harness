/** Hermetic provider stand-in: it invokes the real readonly MCP child, never a model. */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { briefSnapshotSchema } from "../brief-protocol";
import { keeperProposalMessageSchema } from "../proposal-protocol";
import { KEEPER_RESULT_SCHEMA } from "../protocol";

const args = process.argv.slice(2);
const mode = process.env["KEEPER_FIXTURE_MODE"] ?? "normal";
if (args.includes("--version")) {
  process.stdout.write("2.1.296 (Claude Code fixture)\n");
} else if (args.includes("--help")) {
  process.stdout.write(
    mode === "legacy"
      ? "--print --output-format\n"
      : "--print --input-format --output-format --verbose --include-partial-messages --model --effort --permission-mode --permission-prompts --tools --allowedTools --restricted --strict-mcp-config --mcp-config --setting-sources --settings --disable-slash-commands --no-chrome --append-system-prompt --resume\n",
  );
} else {
  const prompt = await Bun.stdin.text();
  let reply = "Scoped reply 🌱";
  if (mode.startsWith("brief")) {
    let message: unknown;
    try {
      const raw: unknown = JSON.parse(prompt);
      message =
        raw && typeof raw === "object" && "message" in raw ? raw.message : null;
    } catch {
      throw new Error("Invalid brief fixture prompt");
    }
    if (typeof message !== "string")
      throw new Error("Missing brief fixture message");
    let raw: unknown;
    try {
      raw = JSON.parse(message.split("Snapshot:\n")[1] ?? "null");
    } catch {
      throw new Error("Invalid brief snapshot fixture");
    }
    const snapshot = briefSnapshotSchema.parse(raw);
    const section = (kind: "moving" | "waiting" | "stuck") =>
      snapshot.facts
        .flatMap((fact, index) =>
          fact.section === kind
            ? [{ text: `${fact.title} · ${fact.state}`, facts: [index] }]
            : [],
        )
        .slice(0, 4);
    reply =
      mode === "brief-malformed"
        ? "Not a structured brief"
        : JSON.stringify({
            summary: `${snapshot.projectName}: ${snapshot.facts.length} recorded facts as of ${snapshot.asOf}`,
            moving: section("moving"),
            waiting: section("waiting"),
            stuck: section("stuck"),
          });
  }
  const recordFile = process.env["KEEPER_FIXTURE_RECORD"];
  const arg = (flag: string) => args[args.indexOf(flag) + 1];
  let reader: StdioClientTransport | undefined;
  let client: Client | undefined;
  const id =
    arg("--resume") && args.includes("--resume")
      ? arg("--resume")
      : randomUUID();
  const emit = (packet: Record<string, unknown>) =>
    process.stdout.write(JSON.stringify({ session_id: id, ...packet }) + "\n");
  const stream = (event: Record<string, unknown>) =>
    emit({ type: "stream_event", event });
  try {
    const raw: unknown = JSON.parse(arg("--mcp-config") ?? "null");
    if (typeof raw !== "object" || raw === null || !("mcpServers" in raw))
      throw new Error("missing config");
    const config = raw.mcpServers;
    if (typeof config !== "object" || config === null || !("keeper" in config))
      throw new Error("missing reader");
    const keeper = config.keeper;
    if (
      typeof keeper !== "object" ||
      keeper === null ||
      !("command" in keeper) ||
      !("args" in keeper) ||
      typeof keeper.command !== "string" ||
      !Array.isArray(keeper.args) ||
      keeper.args.some((value) => typeof value !== "string")
    )
      throw new Error("invalid reader");
    reader = new StdioClientTransport({
      command: keeper.command,
      args: keeper.args,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      stderr: "pipe",
    });
    client = new Client({ name: "keeper-fake-provider", version: "0" });
    await client.connect(reader);
    const tools = (await client.listTools()).tools.map(
      (tool) => `mcp__keeper__${tool.name}`,
    );
    if (recordFile)
      writeFileSync(
        recordFile,
        JSON.stringify({
          args,
          prompt,
          home: process.env["AGENT_FORGE_HOME"],
          adapter: process.env["AGENT_FORGE_ADAPTER"],
          operatorSecretPresent:
            process.env["TEST_OPERATOR_SECRET"] !== undefined,
          readerPid: reader.pid,
          tools,
        }),
      );
    emit({
      type: "system",
      subtype: "init",
      tools: mode === "bad-tool" ? [...tools, "Bash"] : tools,
    });
    stream({
      type: "message_start",
      message: { id: "read-message", model: "fixture-observed-model" },
    });
    stream({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "read-1",
        name: "mcp__keeper__read_project",
        input: {},
      },
    });
    emit({
      type: "assistant",
      message: {
        id: "read-message",
        model: "fixture-observed-model",
        content: [
          {
            type: "tool_use",
            id: "read-1",
            name: "mcp__keeper__read_project",
            input: { kind: "beads" },
          },
        ],
      },
    });
    const answer = await client.callTool({
      name: "read_project",
      arguments: { kind: "beads" },
    });
    if (mode === "proposals") {
      const block = answer.content.find((item) => item.type === "text");
      if (!block || block.type !== "text")
        throw new Error("Missing scoped proposal fixture read");
      let envelope: unknown;
      try {
        envelope = JSON.parse(block.text);
      } catch {
        throw new Error("Invalid scoped proposal fixture read");
      }
      if (!envelope || typeof envelope !== "object" || !("data" in envelope))
        throw new Error("Missing project records");
      const scoped = KEEPER_RESULT_SCHEMA.parse(envelope.data);
      const beadId = scoped.records[0]?.id;
      if (!beadId) throw new Error("No scoped proposal fixture bead");
      reply = JSON.stringify(
        keeperProposalMessageSchema.parse({
          kind: "keeper.proposals.v1",
          message:
            "Seven suggestions from the scoped fixture read. Review before any change.",
          proposals: [
            {
              title: "Approve scoped beads",
              detail: "Only your checked beads will be approved.",
              action: {
                kind: "approve-beads",
                beadIds: scoped.records.map((item) => item.id).slice(0, 2),
              },
            },
            {
              title: "Review a session",
              detail: "The session composer will check availability.",
              action: {
                kind: "start-session",
                provider: "claude",
                smith: "fixture-smith",
                beadId,
                repository:
                  scoped.scope.repositories[0] ?? scoped.scope.workspace,
                worktree: "new",
                prompt: "Implement the reviewed bead",
              },
            },
            {
              title: "Review a shift",
              detail: "An attended review is required.",
              action: {
                kind: "start-shift",
                durationMinutes: 15,
                concurrency: 1,
                beadLimit: 1,
                spendLimitUsd: 1,
              },
            },
            {
              title: "Review council input",
              detail: "Review this question first.",
              action: {
                kind: "send-to-council",
                beadId,
                profile: "architecture",
                question: "Does this fit the settled contract?",
              },
            },
            {
              title: "Create a scoped follow-up",
              detail: "Create one proposed child bead.",
              action: {
                kind: "create-beads",
                beads: [
                  {
                    title: "Keeper fixture child",
                    type: "task",
                    priority: 2,
                    parentId: beadId,
                    description: "A reviewed browser fixture child.",
                  },
                ],
              },
            },
            {
              title: "Manage scoped work",
              detail: "Pause after owner approval.",
              action: {
                kind: "manage-bead",
                beadId,
                operation: { kind: "pause" },
              },
            },
            {
              title: "Record a scoped decision",
              detail: "Save reviewed design wording.",
              action: {
                kind: "record-decision",
                beadId,
                decision: "Use the shared project reader.",
              },
            },
          ],
        }),
      );
    }
    emit({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "read-1",
            content: answer.content,
            is_error: answer.isError === true,
          },
        ],
      },
    });
    stream({
      type: "message_start",
      message: { id: "reply-message", model: "fixture-observed-model" },
    });
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    // Split in the middle of a UTF-8 sequence to exercise the actual pipe decoder.
    const line = Buffer.from(
      JSON.stringify({
        session_id: id,
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: reply },
        },
      }) + "\n",
    );
    const split = reply.includes("🌱")
      ? line.indexOf(Buffer.from("🌱")) + 1
      : Math.floor(line.length / 2);
    await Bun.write(Bun.stdout, line.subarray(0, split));
    await Bun.write(Bun.stdout, line.subarray(split));
    if (mode === "hang") await new Promise(() => {});
    if (mode === "overflow") {
      await Bun.write(Bun.stdout, "x".repeat(1_100_000));
      await new Promise(() => {});
    }
    const complete = {
      type: "assistant",
      message: {
        id: "reply-message",
        model: "fixture-observed-model",
        content: [{ type: "text", text: reply }],
      },
    };
    emit(complete);
    emit(complete);
    stream({ type: "content_block_stop", index: 0 });
    if (mode === "bad-identity")
      emit({ type: "system", subtype: "status", session_id: randomUUID() });
    if (mode !== "missing-terminal")
      emit({
        type: "result",
        subtype: mode === "brief-failed" ? "error_during_execution" : "success",
        is_error: mode === "brief-failed",
      });
  } finally {
    await client?.close();
  }
}
