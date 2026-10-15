/**
 * A bead source through the council's entry points: the engine's first event,
 * the CLI and the MCP tools.
 *
 * No model is called: every run uses the bundled simulated profile or the fake
 * transport. No tracker is read: the CLI and the real service are handed a
 * fake command runner, and the other MCP tool tests stop at a stand-in
 * service. Ledger events go to an array.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { LedgerEventInput } from "../../types/hearth";
import { parseCouncilCliArgs, runCouncilCli } from "./cli";
import { buildContextPackFromParts, contextListing } from "./context";
import { runCouncil } from "./engine";
import { FakeCouncilTransport } from "./fake-transport";
import { createCouncilMcpServer, reviewServiceInput } from "./mcp";
import type { CommandRunner } from "./pr-source";
import {
  assertCouncilInput,
  type CouncilServiceInput,
  type CouncilServiceJob,
  councilBeadId,
  createCouncilService,
} from "./service";
import type { CouncilEvent, CouncilRun } from "./types";
import { loadCouncilProfile } from "./workflow";

const BEAD = "demo-harness-ab12.3";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "council-bead-entry-"));
  roots.push(root);
  mkdirSync(join(root, ".git"));
  return root;
}

/** An invented bead and two comments (and `extra`); any other command fails the test. */
function beadRunner(
  title = "Teach the kiln to report its temperature",
  extra: string[] = [],
): {
  runner: CommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: CommandRunner = async (command) => {
    calls.push(command);
    const line = command.join(" ");
    const answer = (value: unknown) => ({
      exitCode: 0,
      stdout: JSON.stringify(value),
      stderr: "",
    });
    if (line === `bd --readonly show ${BEAD} --json`)
      return answer([
        {
          id: BEAD,
          title,
          description: "The kiln runs blind today.",
          acceptance_criteria: "[ ] The reading is in Celsius.",
          status: "in_progress",
          priority: 2,
          issue_type: "task",
          labels: ["kiln"],
        },
      ]);
    if (line === `bd --readonly comments ${BEAD} --json`)
      return answer([
        {
          issue_id: BEAD,
          text: "worklog: sensor wired.",
          created_at: "2031-01-03T10:00:00Z",
        },
        {
          issue_id: BEAD,
          text: "review: PASS.",
          created_at: "2031-01-05T09:30:00Z",
        },
        ...extra.map((text, index) => ({
          issue_id: BEAD,
          text,
          created_at: `2031-01-06T0${index}:00:00Z`,
        })),
      ]);
    throw new Error(`unexpected command: ${line}`);
  };
  return { runner, calls };
}

/** Whether `text` holds a C0 or C1 control character. */
function hasControl(text: string): boolean {
  return [...text].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}

type Captured = { code: number; stdout: string; stderr: string[] };

async function cli(
  args: string[],
  io: Parameters<typeof runCouncilCli>[1],
): Promise<Captured> {
  let stdout = "";
  const stderr: string[] = [];
  const code = await runCouncilCli(args, {
    readStdin: async () => "",
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr.push(text);
    },
    ...io,
  });
  return { code, stdout, stderr };
}

function envelope<T>(stdout: string): { ok: boolean; data: T; error: string } {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`not a CLI envelope: ${stdout.slice(0, 200)}`);
  }
}

describe("the evidence listing", () => {
  test("a pack of parts lists its parts; a single-item pack lists its one item", async () => {
    const parts = buildContextPackFromParts({
      kind: "bead",
      displayName: "demo",
      locator: "demo",
      parts: [
        { label: "head", chunks: [{ text: "fine" }] },
        { label: "absent", chunks: [], note: "missing, not packed" },
      ],
    });
    expect(contextListing(parts)).toEqual([
      "E1 head: 4 bytes",
      "absent: missing, not packed",
    ]);
    const { buildContextPack } = await import("./context");
    expect(
      contextListing(buildContextPack({ kind: "stdin", text: "hello" })),
    ).toEqual(["E1 stdin source: standard input: 5 bytes"]);
  });

  test("the engine's first event carries the listing, and it is out before the first model request", async () => {
    const context = buildContextPackFromParts({
      kind: "bead",
      displayName: "demo",
      locator: "demo",
      parts: [
        { label: "head", chunks: [{ text: "fine" }] },
        { label: "absent", chunks: [], note: "missing, not packed" },
      ],
    });
    const events: CouncilEvent[] = [];
    const seenAtFirstRequest: string[][] = [];
    const transport = new FakeCouncilTransport({
      delayMs: 0,
      onRequest: () => {
        if (seenAtFirstRequest.length > 0) return;
        seenAtFirstRequest.push(
          events
            .filter((event) => event.type === "run.started")
            .flatMap((event) => event.payload.listing as string[]),
        );
      },
    });
    const result = await runCouncil({
      profile: loadCouncilProfile(resolve("councils/default.json")),
      context,
      resolveTransport: () => transport,
      onEvent: (event) => events.push(event),
    });
    expect(result.ok).toBe(true);
    expect(events[0]?.type).toBe("run.started");
    expect(events[0]?.payload.listing).toEqual([
      "E1 head: 4 bytes",
      "absent: missing, not packed",
    ]);
    expect(seenAtFirstRequest).toEqual([
      ["E1 head: 4 bytes", "absent: missing, not packed"],
    ]);
  });
});

describe("council -- bead <id>", () => {
  test("bead <id> parses as a run whose ledger bead is the source bead", () => {
    const parsed = parseCouncilCliArgs(["bead", BEAD, "--dry-run"]);
    expect(parsed).toEqual({
      ok: true,
      value: {
        kind: "run",
        sourceKind: "bead",
        sourcePath: BEAD,
        beadId: BEAD,
        secretPolicy: "reject",
        dryRun: true,
        json: false,
      },
    });
    expect(parseCouncilCliArgs(["bead", BEAD, "--bead", BEAD]).ok).toBe(true);
  });

  test("a missing or hostile id, and a --bead that names another bead, are refused at parse time", () => {
    for (const args of [
      ["bead"],
      ["bead", "--dry-run"],
      ["bead", "-x"],
      ["bead", "a b"],
      ["bead", "$(id)"],
      ["bead", "../x"],
      ["bead", "x".repeat(122)],
    ])
      expect({ args, parsed: parseCouncilCliArgs(args) }).toEqual({
        args,
        parsed: {
          ok: false,
          error: "bead requires a Beads issue id",
          json: false,
        },
      });
    expect(
      parseCouncilCliArgs(["bead", BEAD, "--bead", "demo-harness-zz9"]),
    ).toEqual({
      ok: false,
      error: "--bead must name the bead under review when the source is a bead",
      json: false,
    });
  });

  test("a dry run of a bead prints every part, calls no model and reserves no run", async () => {
    const cwd = workspace();
    const fake = beadRunner();
    const appended: LedgerEventInput[] = [];
    const io = {
      cwd,
      runCommand: fake.runner,
      appendEvent: (event: LedgerEventInput) => appended.push(event),
      resolveAttach: ({ cwd: workspace }: { cwd: string }) => ({ workspace }),
    };

    const json = await cli(["bead", BEAD, "--dry-run", "--json"], io);
    expect(json.code).toBe(0);
    const data = envelope<{
      dryRun: boolean;
      context: { source: { kind: string; locator: string }; listing: string[] };
    }>(json.stdout).data;
    expect(data.dryRun).toBe(true);
    expect(data.context.source).toMatchObject({ kind: "bead", locator: BEAD });
    expect(data.context.listing.map((line) => line.split(":")[0])).toEqual([
      "E1 acceptance criteria",
      "E2 latest comments",
      "E3 description",
    ]);

    const text = await cli(["bead", BEAD, "--dry-run"], io);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("Evidence:\n  E1 acceptance criteria: ");
    expect(text.stdout).toContain("\n  E2 latest comments: 2 comments, ");
    expect(text.stdout).toContain("No model calls were made.");

    expect(existsSync(join(cwd, "reports"))).toBe(false);
    expect(appended).toEqual([]);
    expect(fake.calls.every((call) => call[1] === "--readonly")).toBe(true);
  });

  test("a full run of a bead with the simulated profile shows the listing before any round starts, keeps the parts as evidence, and records the bead on both ledger events", async () => {
    const cwd = workspace();
    const fake = beadRunner();
    const appended: LedgerEventInput[] = [];
    const ran = await cli(
      ["bead", BEAD, "--run-id", "bead-run", "--runs-dir", "runs"],
      {
        cwd,
        runCommand: fake.runner,
        appendEvent: (event) => appended.push(event),
        resolveAttach: ({ cwd: workspace, beadId }) => ({
          workspace,
          ...(beadId !== undefined ? { beadId } : {}),
        }),
      },
    );
    expect(ran.code).toBe(0);

    const lines = ran.stderr.join("");
    const listed = lines.indexOf("Evidence to be sent:");
    const firstRound = lines.indexOf("round started");
    expect(listed).toBeGreaterThanOrEqual(0);
    expect(firstRound).toBeGreaterThan(listed);
    expect(lines.slice(listed, firstRound)).toContain(
      "\n  E1 acceptance criteria: ",
    );
    expect(lines.slice(listed, firstRound)).toContain("\n  E3 description: ");

    expect(appended.map((event) => event.kind)).toEqual([
      "council.run.started",
      "council.run.finished",
    ]);
    expect(appended.map((event) => event.beadId)).toEqual([BEAD, BEAD]);

    const replay = await cli(
      ["replay", "bead-run", "--runs-dir", "runs", "--json"],
      { cwd },
    );
    const run = envelope<{ run: CouncilRun }>(replay.stdout).data.run;
    expect(run.status).toBe("completed");
    expect(run.context.source).toMatchObject({ kind: "bead", locator: BEAD });
    expect(run.context.evidence?.map((item) => item.id)).toEqual([
      "E1",
      "E2",
      "E3",
    ]);
    expect(run.events[0]?.payload.listing).toEqual(
      run.context.source.metadata?.parts,
    );
  });

  test("in --json mode the listing still goes to stderr and stdout stays one envelope", async () => {
    const cwd = workspace();
    const ran = await cli(
      ["bead", BEAD, "--run-id", "bead-json", "--runs-dir", "runs", "--json"],
      { cwd, runCommand: beadRunner().runner },
    );
    expect(ran.code).toBe(0);
    expect(ran.stderr.join("")).toContain("Evidence to be sent:");
    expect(envelope<{ run: CouncilRun }>(ran.stdout).ok).toBe(true);
  });

  test("a dry run prints no control character a bead's title tried to smuggle in", async () => {
    const esc = "\u001b";
    const ran = await cli(["bead", BEAD, "--dry-run"], {
      cwd: workspace(),
      runCommand: beadRunner(`Kiln ${esc}[8mhidden${esc}[0m\u0007 report`)
        .runner,
    });
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain("Source: demo-harness-ab12.3: Kiln ");
    expect(hasControl(ran.stdout.replaceAll("\n", ""))).toBe(false);
  });

  test("a stdin source prints nothing new on stderr", async () => {
    const cwd = workspace();
    const ran = await cli(["stdin", "--run-id", "plain", "--json"], {
      cwd,
      readStdin: async () => "Review this note.",
    });
    expect(ran.code).toBe(0);
    expect(ran.stderr).toEqual([]);
  });
});

describe("MCP council_start with a bead", () => {
  test("{ kind: 'bead', id } becomes the service's bead input with the bead as ledger bead; the old shape is unchanged; a mix, a gap and a hostile id are refused", () => {
    expect(
      reviewServiceInput({ kind: "bead", id: BEAD, redactSecrets: false }),
    ).toEqual({
      sourceType: "bead",
      source: BEAD,
      beadId: BEAD,
      redactSecrets: false,
    });
    expect(
      reviewServiceInput({
        kind: "bead",
        id: BEAD,
        profile: "councils/default.json",
        maxUsd: 1,
        maxBytes: 5000,
        runId: "r1",
        redactSecrets: true,
      }),
    ).toEqual({
      sourceType: "bead",
      source: BEAD,
      beadId: BEAD,
      profile: "councils/default.json",
      maxUsd: 1,
      maxBytes: 5000,
      runId: "r1",
      redactSecrets: true,
    });
    expect(
      reviewServiceInput({
        sourceType: "text",
        source: "review this",
        redactSecrets: false,
      }),
    ).toEqual({
      sourceType: "text",
      source: "review this",
      redactSecrets: false,
    });

    const refused = 'give either sourceType and source, or kind "bead" and id';
    for (const input of [
      { redactSecrets: false },
      { kind: "bead" as const, redactSecrets: false },
      { id: BEAD, redactSecrets: false },
      { sourceType: "text" as const, redactSecrets: false },
      {
        kind: "bead" as const,
        id: BEAD,
        sourceType: "text" as const,
        source: "x",
        redactSecrets: false,
      },
    ])
      expect(() => reviewServiceInput(input)).toThrow(refused);
    // Called without the schema in front (the tools never do this), the
    // mapping still decides the ledger bead and still knows its four kinds.
    const smuggled = {
      kind: "bead" as const,
      id: BEAD,
      beadId: "demo-harness-zz9",
      redactSecrets: false,
    };
    expect(reviewServiceInput(smuggled).beadId).toBe(BEAD);
    const sideDoor = {
      sourceType: "bead",
      source: "--help",
      redactSecrets: false,
    } as unknown as Parameters<typeof reviewServiceInput>[0];
    expect(() => reviewServiceInput(sideDoor)).toThrow(refused);
    const otherKind = {
      kind: "file",
      id: BEAD,
      redactSecrets: false,
    } as unknown as Parameters<typeof reviewServiceInput>[0];
    expect(() => reviewServiceInput(otherKind)).toThrow(refused);
    for (const id of ["--help", "a b", "$(id)", "../x", "x".repeat(122)])
      expect(() =>
        reviewServiceInput({ kind: "bead", id, redactSecrets: false }),
      ).toThrow("id must be a Beads issue id");
  });

  /** A service that records what it is asked to start and runs nothing. */
  function standIn(job: Partial<CouncilServiceJob> = {}) {
    const started: CouncilServiceInput[] = [];
    const base: CouncilServiceJob = {
      runId: "stand-in",
      status: "running",
      startedAt: "2031-01-06T10:00:00.000Z",
      updatedAt: "2031-01-06T10:00:00.000Z",
      events: [],
      ...job,
    };
    const real = createCouncilService({
      workspaceRoot: workspace(),
      harnessRoot: process.cwd(),
    });
    return {
      started,
      service: {
        ...real,
        start: (input: CouncilServiceInput) => {
          started.push(input);
          return base;
        },
        get: () => base,
      },
    };
  }

  async function connected(
    options: Parameters<typeof createCouncilMcpServer>[0],
  ) {
    const server = createCouncilMcpServer(options);
    const client = new Client({ name: "bead-test", version: "1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await client.connect(clientSide);
    return {
      call: async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        return result.structuredContent as {
          ok: boolean;
          data: Record<string, unknown> | null;
          error: string | null;
        };
      },
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  test("council_start hands the service the bead input, and council_status shows the listing from the run's first event", async () => {
    const stand = standIn({
      events: [
        {
          schemaVersion: 1,
          runId: "stand-in",
          seq: 0,
          at: "2031-01-06T10:00:00.000Z",
          type: "run.started",
          payload: {
            listing: [
              "E1 acceptance criteria: 120 bytes",
              "linked plan plans/drafts/x.md: missing, not packed",
            ],
          },
        },
        {
          schemaVersion: 1,
          runId: "stand-in",
          seq: 1,
          at: "2031-01-06T10:00:01.000Z",
          type: "stage.started",
          payload: { stage: "independent" },
        },
      ],
    });
    const mcp = await connected({ service: stand.service });
    try {
      const startedReply = await mcp.call("council_start", {
        kind: "bead",
        id: BEAD,
      });
      expect(startedReply.ok).toBe(true);
      expect(stand.started).toEqual([
        {
          sourceType: "bead",
          source: BEAD,
          beadId: BEAD,
          redactSecrets: false,
        },
      ]);

      const status = await mcp.call("council_status", { runId: "stand-in" });
      expect(status.data?.listing).toEqual([
        "E1 acceptance criteria: 120 bytes",
        "linked plan plans/drafts/x.md: missing, not packed",
      ]);

      const mixed = await mcp.call("council_start", {
        kind: "bead",
        id: BEAD,
        sourceType: "text",
        source: "x",
      });
      expect(mixed.ok).toBe(false);
      expect(mixed.error).toContain("give either sourceType and source");
      const hostile = await mcp.call("council_start", {
        kind: "bead",
        id: "--help",
      });
      expect(hostile.ok).toBe(false);
      expect(stand.started).toHaveLength(1);
    } finally {
      await mcp.close();
    }
  });

  test("council_start with { kind: 'bead', id } starts a job in the real service that finishes as a review of the bead, with its listing in council_status", async () => {
    const root = workspace();
    const fake = beadRunner();
    const mcp = await connected({
      workspaceRoot: root,
      harnessRoot: process.cwd(),
      runsRoot: join(root, "runs"),
      runCommand: fake.runner,
      resolveTransport: () => () => new FakeCouncilTransport({ delayMs: 0 }),
    });
    try {
      let status = await mcp.call("council_start", {
        kind: "bead",
        id: BEAD,
        runId: "mcp-start-bead",
      });
      expect(status.ok).toBe(true);
      expect(status.data?.runId).toBe("mcp-start-bead");
      for (
        let poll = 0;
        poll < 500 &&
        ["running", "cancelling"].includes(String(status.data?.status));
        poll += 1
      ) {
        await Bun.sleep(10);
        status = await mcp.call("council_status", { runId: "mcp-start-bead" });
      }
      expect(status.data?.status).toBe("completed");
      expect(
        (status.data?.listing as string[]).map((line) => line.split(":")[0]),
      ).toEqual([
        "E1 acceptance criteria",
        "E2 latest comments",
        "E3 description",
      ]);
      expect(fake.calls.map((call) => call.slice(0, 4).join(" "))).toEqual([
        `bd --readonly show ${BEAD}`,
        `bd --readonly comments ${BEAD}`,
      ]);
    } finally {
      await mcp.close();
    }
  });

  test("council_review with { kind: 'bead', id } runs through the real service to a finished review of the bead", async () => {
    const root = workspace();
    const appended: LedgerEventInput[] = [];
    const mcp = await connected({
      workspaceRoot: root,
      harnessRoot: process.cwd(),
      runsRoot: join(root, "runs"),
      runCommand: beadRunner().runner,
      resolveTransport: () => () => new FakeCouncilTransport({ delayMs: 0 }),
      appendEvent: (event) => appended.push(event),
      resolveAttach: ({ cwd, beadId }) => ({
        workspace: cwd,
        ...(beadId !== undefined ? { beadId } : {}),
      }),
    });
    try {
      const reply = await mcp.call("council_review", {
        kind: "bead",
        id: BEAD,
        runId: "mcp-bead",
      });
      expect(reply.ok).toBe(true);
      const run = reply.data?.run as CouncilRun;
      expect(run.status).toBe("completed");
      expect(run.context.source).toMatchObject({ kind: "bead", locator: BEAD });
      expect(run.context.evidence).toHaveLength(3);
      expect(appended.map((event) => event.beadId)).toEqual([BEAD, BEAD]);
      const status = await mcp.call("council_status", { runId: "mcp-bead" });
      expect(
        (status.data?.listing as string[]).map((line) => line.split(":")[0]),
      ).toEqual([
        "E1 acceptance criteria",
        "E2 latest comments",
        "E3 description",
      ]);
    } finally {
      await mcp.close();
    }
  });
});

describe("the council service with a bead source", () => {
  test("the service refuses a bead source whose id is not one, or whose beadId is not exactly the bead under review, before it reserves a run", async () => {
    const root = workspace();
    const fake = beadRunner();
    const service = createCouncilService({
      workspaceRoot: root,
      harnessRoot: process.cwd(),
      runsRoot: join(root, "runs"),
      runCommand: fake.runner,
      resolveTransport: () => () => new FakeCouncilTransport({ delayMs: 0 }),
    });
    try {
      for (const source of ["not a bead id", "--help", "../x", "$(id)"])
        expect(() =>
          service.start({ sourceType: "bead", source, runId: "refused" }),
        ).toThrow("source must be a Beads issue id when the source is a bead");
      for (const beadId of [
        "demo-harness-zz9",
        // The same bead written another way, its child and its parent are not that id.
        ` ${BEAD} `,
        `${BEAD}\n`,
        BEAD.toUpperCase(),
        `${BEAD}.1`,
        BEAD.slice(0, BEAD.lastIndexOf(".")),
        // An invisible character after the id, and a digit in its full-width form.
        `${BEAD}${String.fromCharCode(0x200b)}`,
        BEAD.replace("3", String.fromCharCode(0xff13)),
      ])
        expect(() =>
          service.start({
            sourceType: "bead",
            source: BEAD,
            beadId,
            runId: "refused",
          }),
        ).toThrow(
          "beadId must name the bead under review when the source is a bead",
        );
      expect(fake.calls).toEqual([]);
      expect(existsSync(join(root, "runs", "refused"))).toBe(false);
      // The id is compared with the bead the source names, not with its text.
      expect(() =>
        assertCouncilInput({
          sourceType: "bead",
          source: ` ${BEAD}\n`,
          beadId: BEAD,
        }),
      ).not.toThrow();
      // The other kinds keep taking any bead as the one a review is for.
      expect(() =>
        assertCouncilInput({
          sourceType: "text",
          source: "review this",
          beadId: "demo-harness-zz9",
        }),
      ).not.toThrow();
      expect(
        councilBeadId({ sourceType: "text", source: "review this" }),
      ).toBeUndefined();
      expect(councilBeadId({ sourceType: "bead", source: ` ${BEAD} ` })).toBe(
        BEAD,
      );
    } finally {
      await service.close();
    }
  });

  test("a bead job through the real service packs the bead and is recorded against it, though the caller named no bead for the ledger and wrote the id with space around it", async () => {
    const root = workspace();
    const fake = beadRunner();
    const appended: LedgerEventInput[] = [];
    const service = createCouncilService({
      workspaceRoot: root,
      harnessRoot: process.cwd(),
      runsRoot: join(root, "runs"),
      runCommand: fake.runner,
      resolveTransport: () => () => new FakeCouncilTransport({ delayMs: 0 }),
      appendEvent: (event) => appended.push(event),
      resolveAttach: ({ cwd, beadId }) => ({
        workspace: cwd,
        ...(beadId !== undefined ? { beadId } : {}),
      }),
    });
    try {
      const started = service.start({
        sourceType: "bead",
        source: ` ${BEAD}\n`,
        runId: "job-bead",
      });
      expect(started.status).toBe("running");
      const finished = await service.wait(started.runId);
      expect(finished.status).toBe("completed");
      expect(finished.run?.context.source).toMatchObject({
        kind: "bead",
        locator: BEAD,
      });
      expect(finished.run?.context.evidence?.map((item) => item.id)).toEqual([
        "E1",
        "E2",
        "E3",
      ]);
      expect(appended.map((event) => [event.kind, event.beadId])).toEqual([
        ["council.run.started", BEAD],
        ["council.run.finished", BEAD],
      ]);
      expect(fake.calls.map((call) => call.slice(0, 3).join(" "))).toEqual([
        "bd --readonly show",
        "bd --readonly comments",
      ]);
    } finally {
      await service.close();
    }
  });

  test("a job uses the request as it was checked: a caller's object that changes after start, or answers differently each time it is read, changes neither the bead packed nor the bead credited, whatever kind of object it is", async () => {
    const root = workspace();
    const fake = beadRunner();
    const appended: LedgerEventInput[] = [];
    const service = createCouncilService({
      workspaceRoot: root,
      harnessRoot: process.cwd(),
      runsRoot: join(root, "runs"),
      runCommand: fake.runner,
      resolveTransport: () => () => new FakeCouncilTransport({ delayMs: 0 }),
      appendEvent: (event) => appended.push(event),
      resolveAttach: ({ cwd, beadId }) => ({
        workspace: cwd,
        ...(beadId !== undefined ? { beadId } : {}),
      }),
    });
    try {
      const input: CouncilServiceInput = {
        sourceType: "bead",
        source: BEAD,
        runId: "job-kept",
      };
      const started = service.start(input);
      input.sourceType = "text";
      input.source = "demo-harness-zz9";
      input.beadId = "demo-harness-zz9";
      input.maxBytes = 1;
      const kept = await service.wait(started.runId);
      expect(kept.status).toBe("completed");
      expect(kept.run?.context.source).toMatchObject({
        kind: "bead",
        locator: BEAD,
      });
      expect(kept.run?.context.truncated).toBe(false);

      // A request that is a function carrying the fields is read once too.
      const callable = Object.assign(() => {}, {
        sourceType: "bead",
        source: BEAD,
        runId: "job-callable",
      }) as unknown as CouncilServiceInput;
      const calledJob = service.start(callable);
      callable.source = "demo-harness-zz9";
      callable.beadId = "demo-harness-zz9";
      const called = await service.wait(calledJob.runId);
      expect(called.status).toBe("completed");
      expect(called.run?.context.source).toMatchObject({
        kind: "bead",
        locator: BEAD,
      });

      let reads = 0;
      const shifting = {
        sourceType: "bead",
        runId: "job-read-once",
        get source() {
          reads += 1;
          return reads === 1 ? BEAD : "demo-harness-zz9";
        },
      } as CouncilServiceInput;
      const once = await service.wait(service.start(shifting).runId);
      expect(reads).toBe(1);
      expect(once.status).toBe("completed");
      expect(once.run?.context.source).toMatchObject({
        kind: "bead",
        locator: BEAD,
      });

      // A field the request inherits is read like its own, as it always was:
      // recorded for a text source, and refused for a bead source it does not name.
      const inherited: CouncilServiceInput = Object.assign(
        Object.create({ beadId: "demo-harness-zz9" }),
        { sourceType: "text", source: "review this", runId: "job-inherited" },
      );
      const text = await service.wait(service.start(inherited).runId);
      expect(text.status).toBe("completed");
      expect(() =>
        service.start(
          Object.assign(Object.create({ beadId: "demo-harness-zz9" }), {
            sourceType: "bead",
            source: BEAD,
            runId: "refused",
          }),
        ),
      ).toThrow(
        "beadId must name the bead under review when the source is a bead",
      );

      expect(appended.map((event) => event.beadId)).toEqual([
        BEAD,
        BEAD,
        BEAD,
        BEAD,
        BEAD,
        BEAD,
        "demo-harness-zz9",
        "demo-harness-zz9",
      ]);
      expect(fake.calls.map((call) => call[3])).toEqual([
        BEAD,
        BEAD,
        BEAD,
        BEAD,
        BEAD,
        BEAD,
      ]);
    } finally {
      await service.close();
    }
  });

  test("a preview packs the bead as a run would and lists what it would send, part by part, without reserving a run, calling a model or recording anything", async () => {
    const root = workspace();
    const fake = beadRunner();
    const appended: LedgerEventInput[] = [];
    let modelCalls = 0;
    const service = createCouncilService({
      workspaceRoot: root,
      harnessRoot: process.cwd(),
      runsRoot: join(root, "runs"),
      runCommand: fake.runner,
      resolveTransport: () => () =>
        new FakeCouncilTransport({
          delayMs: 0,
          onRequest: () => {
            modelCalls += 1;
          },
        }),
      appendEvent: (event) => appended.push(event),
      resolveAttach: ({ cwd, beadId }) => ({
        workspace: cwd,
        ...(beadId !== undefined ? { beadId } : {}),
      }),
    });
    try {
      const preview = await service.preview({
        sourceType: "bead",
        source: BEAD,
      });
      expect(preview.source).toEqual({
        kind: "bead",
        displayName: `${BEAD}: Teach the kiln to report its temperature`,
        locator: BEAD,
      });
      expect(preview.listing).toEqual([
        expect.stringMatching(/^E1 acceptance criteria: \d+ bytes$/),
        expect.stringMatching(/^E2 latest comments: 2 comments, \d+ bytes$/),
        expect.stringMatching(/^E3 description: \d+ bytes$/),
      ]);
      expect(preview.truncated).toBe(false);
      expect(preview.redactions).toEqual([]);
      expect(fake.calls.map((call) => call.slice(0, 3).join(" "))).toEqual([
        "bd --readonly show",
        "bd --readonly comments",
      ]);
      // Nothing was started: no run, no model call, no ledger event, no run directory.
      expect(service.list()).toEqual([]);
      expect(modelCalls).toBe(0);
      expect(appended).toEqual([]);
      expect(existsSync(join(root, "runs"))).toBe(false);

      // What a run then sends is what the preview listed.
      const job = await service.wait(
        service.start({ sourceType: "bead", source: BEAD, runId: "after" })
          .runId,
      );
      expect(
        job.events.find((event) => event.type === "run.started")?.payload
          .listing,
      ).toEqual(preview.listing);

      // The byte budget and the secret policy are the preview's too.
      const cut = await service.preview({
        sourceType: "bead",
        source: BEAD,
        maxBytes: 200,
      });
      expect(cut.truncated).toBe(true);
      expect(cut.byteLength).toBeLessThanOrEqual(200);
    } finally {
      await service.close();
    }
  });

  test("a preview refuses what a start refuses, and a secret under the default policy; under redact it counts what it replaced", async () => {
    const root = workspace();
    const key = ["sk", "ant", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
    const leaky = beadRunner(undefined, [`worklog: rotated ${key}`]);
    const service = createCouncilService({
      workspaceRoot: root,
      harnessRoot: process.cwd(),
      runsRoot: join(root, "runs"),
      runCommand: leaky.runner,
    });
    try {
      await expect(
        service.preview({ sourceType: "bead", source: "not a bead id" }),
      ).rejects.toThrow(
        "source must be a Beads issue id when the source is a bead",
      );
      await expect(
        service.preview({
          sourceType: "bead",
          source: BEAD,
          beadId: "demo-harness-zz9",
        }),
      ).rejects.toThrow(
        "beadId must name the bead under review when the source is a bead",
      );
      expect(leaky.calls).toEqual([]);
      await expect(
        service.preview({ sourceType: "bead", source: BEAD }),
      ).rejects.toThrow("potential secrets detected in the comment of");
      const redacted = await service.preview({
        sourceType: "bead",
        source: BEAD,
        redactSecrets: true,
      });
      expect(redacted.redactions).toEqual([
        { kind: "anthropic-api-key", count: 1 },
      ]);
      expect(JSON.stringify(redacted)).not.toContain(key);
    } finally {
      await service.close();
    }
  });

  test("a job keeps the byte budget, the secret policy and the cost ceiling it was started with: the budget cuts the pack, redaction replaces a key the default refuses, and the ceiling is the run's budget", async () => {
    const root = workspace();
    // The simulated profile, with a chair that is estimated to cost 0.50 USD.
    const priced = JSON.parse(
      readFileSync(resolve("councils/default.json"), "utf8"),
    ) as { id: string; chair: { estimatedCostUsd: number } };
    priced.id = "priced-review";
    priced.chair.estimatedCostUsd = 0.5;
    writeFileSync(join(root, "priced.json"), JSON.stringify(priced));
    // Shaped like a provider key; it opens nothing.
    const key = ["sk", "ant", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
    const clean = beadRunner();
    const leaky = beadRunner(undefined, [`worklog: rotated ${key}`]);
    const appended: LedgerEventInput[] = [];
    const service = (runner: CommandRunner) =>
      createCouncilService({
        workspaceRoot: root,
        harnessRoot: process.cwd(),
        runsRoot: join(root, "runs"),
        runCommand: runner,
        resolveTransport: () => () => new FakeCouncilTransport({ delayMs: 0 }),
        appendEvent: (event) => appended.push(event),
        resolveAttach: ({ cwd, beadId }) => ({
          workspace: cwd,
          ...(beadId !== undefined ? { beadId } : {}),
        }),
      });
    const plain = service(clean.runner);
    const secret = service(leaky.runner);
    try {
      const whole = await plain.wait(
        plain.start({ sourceType: "bead", source: BEAD, runId: "whole" }).runId,
      );
      expect(whole.run?.context.truncated).toBe(false);
      const budgeted = await plain.wait(
        plain.start({
          sourceType: "bead",
          source: BEAD,
          runId: "budgeted",
          maxBytes: 200,
        }).runId,
      );
      expect(budgeted.status).toBe("completed");
      expect(budgeted.run?.context.truncated).toBe(true);
      expect(budgeted.run?.context.byteLength).toBeLessThanOrEqual(200);

      const refused = await secret.wait(
        secret.start({ sourceType: "bead", source: BEAD, runId: "refused" })
          .runId,
      );
      expect(refused.status).toBe("failed");
      expect(refused.error).toContain("potential secrets detected");
      const redacted = await secret.wait(
        secret.start({
          sourceType: "bead",
          source: BEAD,
          runId: "redacted",
          redactSecrets: true,
        }).runId,
      );
      expect(redacted.status).toBe("completed");
      expect(redacted.run?.context.redactions).toEqual([
        { kind: "anthropic-api-key", count: 1 },
      ]);
      expect(JSON.stringify(redacted.run)).not.toContain(key);

      const over = await plain.wait(
        plain.start({
          sourceType: "bead",
          source: BEAD,
          runId: "over-ceiling",
          profile: "priced.json",
          maxUsd: 0.25,
        }).runId,
      );
      expect(over.status).toBe("failed");
      expect(over.run?.error).toBe(
        "estimated cost $0.5000 exceeds budget $0.2500",
      );
      const within = await plain.wait(
        plain.start({
          sourceType: "bead",
          source: BEAD,
          runId: "within-ceiling",
          profile: "priced.json",
        }).runId,
      );
      expect(within.status).toBe("completed");
      // The ceiling a run was given is the budget its start records.
      const budgets = appended
        .filter((event) => event.kind === "council.run.started")
        .map((event) => [
          event.payload.councilRunId,
          (event.payload as { budgetUsd?: number }).budgetUsd,
        ]);
      expect(budgets).toEqual([
        ["whole", 1],
        ["budgeted", 1],
        ["redacted", 1],
        ["over-ceiling", 0.25],
        ["within-ceiling", 1],
      ]);
    } finally {
      await plain.close();
      await secret.close();
    }
  });
});
