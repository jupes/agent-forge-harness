/**
 * Council runs in the ledger.
 *
 * Every run here is driven by the fake transport: no model is called. Events
 * go to a ledger the test creates, through an appender the test injects — the
 * same seam the Bun entry points fill with the real ledger.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { LedgerEvent, LedgerEventInput } from "../../types/hearth";
import { type ImportGraph, importGraph } from "../import-graph";
import { closeLedger } from "../ledger/db";
import { writeSessionMirror } from "../ledger/identity";
import { PAYLOAD_KEYS } from "../ledger/payload-allowlist";
import { queryEvents } from "../ledger/query";
import { setSessionModel } from "../ledger/session-models";
import { parseCouncilCliArgs, runCouncilCli } from "./cli";
import { FakeCouncilTransport } from "./fake-transport";
import {
  councilFinished,
  councilLedgerEvent,
  councilOutcome,
  councilStarted,
} from "./ledger-events";
import { councilLedger } from "./ledger-wiring";
import { createCouncilService } from "./service";
import type { AggregatedFinding, ChairOutput, CouncilRun } from "./types";
import {
  executeCouncilReview,
  loadCouncilProfile,
  prepareCouncilContext,
} from "./workflow";

const temporary: string[] = [];

interface Box {
  /** A scratch checkout the review runs in. */
  cwd: string;
  runsRoot: string;
  /** The test's own ledger file. */
  path: string;
}

function sandbox(): Box {
  const root = mkdtempSync(join(tmpdir(), "council ledger test "));
  temporary.push(root);
  const cwd = join(root, "check out");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  writeFileSync(
    join(cwd, "review.md"),
    "Verify the rollout plan and its evidence.\n",
  );
  return {
    cwd,
    runsRoot: join(root, "runs"),
    path: join(root, "forge home", "ledger.db"),
  };
}

afterEach(() => {
  closeLedger();
  for (const dir of temporary.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A ledger file still held open on Windows: the OS temp directory reclaims it.
    }
  }
});

const COUNCIL_KINDS = ["council.run.started", "council.run.finished"] as const;
const profile = () => loadCouncilProfile(resolve("councils/default.json"));

function councilEvents(path: string): LedgerEvent[] {
  return existsSync(path)
    ? queryEvents({ kinds: [...COUNCIL_KINDS] }, { path })
    : [];
}

async function context(box: Box) {
  return prepareCouncilContext({
    kind: "file",
    source: "review.md",
    workspaceRoot: box.cwd,
    secretPolicy: "reject",
  });
}

/** Run the CLI in-process with captured output. */
async function cli(
  box: Box,
  args: string[],
  overrides: Parameters<typeof runCouncilCli>[1] = {},
): Promise<{ code: number; stdout: string }> {
  let stdout = "";
  const code = await runCouncilCli(args, {
    cwd: box.cwd,
    readStdin: async () => "Review this plan and its evidence",
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => {},
    ...overrides,
  });
  return { code, stdout };
}

describe("council outcome", () => {
  const finding = (severity: AggregatedFinding["severity"]) =>
    // justification: the mapping reads only the severity of a finding.
    ({ severity }) as AggregatedFinding;
  const chair = (verdict: ChairOutput["verdict"]) =>
    // justification: the mapping reads only the chair's verdict and summary.
    ({ verdict, summary: "the chair's summary" }) as ChairOutput;
  const run = (
    status: CouncilRun["status"],
    extra: Partial<Pick<CouncilRun, "chair" | "aggregatedFindings">> = {},
  ) => ({ status, aggregatedFindings: [], accountedCostUsd: 0.25, ...extra });

  test("outcome mapping", () => {
    const cases: Array<[ReturnType<typeof run>, string]> = [
      [run("cancelled", { chair: chair("pass") }), "cancelled"],
      [run("failed", { chair: chair("pass") }), "unreadable"],
      [run("completed", { chair: chair("pass") }), "pass"],
      [run("completed", { chair: chair("needs_changes") }), "fail"],
      [
        run("completed", { chair: chair("insufficient_evidence") }),
        "unreadable",
      ],
      [run("completed"), "pass"],
      [
        run("completed", {
          aggregatedFindings: [finding("medium"), finding("low")],
        }),
        "pass",
      ],
      [run("completed", { aggregatedFindings: [finding("high")] }), "fail"],
      [run("completed", { aggregatedFindings: [finding("blocker")] }), "fail"],
    ];
    for (const [input, expected] of cases)
      expect<string>(councilOutcome(input)).toBe(expected);
  });

  test("a finished event carries the cost and the chair's summary; one with no run is unreadable", () => {
    expect(
      councilFinished("c-1", run("completed", { chair: chair("pass") })),
    ).toEqual({
      kind: "council.run.finished",
      payload: {
        councilRunId: "c-1",
        outcome: "pass",
        costUsd: 0.25,
        summary: "the chair's summary",
      },
    });
    expect(councilFinished("c-1", null)).toEqual({
      kind: "council.run.finished",
      payload: { councilRunId: "c-1", outcome: "unreadable" },
    });
  });

  test("an event with no known bead, run, session or executor leaves those keys out", () => {
    const event = councilLedgerEvent(
      { workspace: "c:/work/repo" },
      councilStarted("c-1", "default-review", 1),
    );
    expect(event).toEqual({
      kind: "council.run.started",
      workspace: "c:/work/repo",
      payload: { councilRunId: "c-1", profile: "default-review", budgetUsd: 1 },
    });
  });
});

describe("executeCouncilReview with an injected appender (fake transport, scratch ledger)", () => {
  test("a fake-transport council run produces a started and a finished event carrying the bead and the cost", async () => {
    const box = sandbox();
    const selected = profile();
    const { result } = await executeCouncilReview({
      profile: selected,
      context: await context(box),
      runId: "c-1",
      runsRoot: box.runsRoot,
      resolveTransport: () => new FakeCouncilTransport({ costUsd: 0.01 }),
      ...councilSeam(box),
      attach: { workspace: box.cwd, beadId: "b-1", runId: "forge-run" },
    });
    expect(result.ok).toBe(true);

    const events = councilEvents(box.path);
    expect(events.map((e) => e.kind)).toEqual([...COUNCIL_KINDS]);
    const [started, finished] = events;
    for (const event of events) {
      expect(event.beadId).toBe("b-1");
      expect(event.runId).toBe("forge-run");
    }
    expect(started?.payload).toEqual({
      councilRunId: "c-1",
      profile: selected.id,
      budgetUsd: selected.maxEstimatedUsd,
    });
    expect(result.run.accountedCostUsd).toBeGreaterThan(0);
    // The fake chair asks for changes when there are findings.
    expect(finished?.payload).toEqual({
      councilRunId: "c-1",
      outcome: "fail",
      costUsd: result.run.accountedCostUsd,
      summary: "The fake council completed a deterministic review.",
    });
  });

  test("a cancelled run finishes as cancelled", async () => {
    const box = sandbox();
    const controller = new AbortController();
    controller.abort();
    const { result } = await executeCouncilReview({
      profile: profile(),
      context: await context(box),
      runId: "c-1",
      runsRoot: box.runsRoot,
      signal: controller.signal,
      resolveTransport: () => new FakeCouncilTransport(),
      ...councilSeam(box),
      attach: { workspace: box.cwd },
    });
    expect(result.run.status).toBe("cancelled");
    const events = councilEvents(box.path);
    expect(events.map((e) => e.kind)).toEqual([...COUNCIL_KINDS]);
    expect(events[1]?.payload).toMatchObject({
      councilRunId: "c-1",
      outcome: "cancelled",
    });
  });

  test("a run whose artifacts cannot be written still records a finished event", async () => {
    const box = sandbox();
    const fake = new FakeCouncilTransport({
      onRequest: (request) => {
        if (request.stage === "chair")
          writeFileSync(join(box.runsRoot, "c-1", "report.md"), "in the way");
      },
    });
    await expect(
      executeCouncilReview({
        profile: profile(),
        context: await context(box),
        runId: "c-1",
        runsRoot: box.runsRoot,
        resolveTransport: () => fake,
        ...councilSeam(box),
        attach: { workspace: box.cwd, beadId: "b-1" },
      }),
    ).rejects.toThrow("already exists");

    const events = councilEvents(box.path);
    expect(events.map((e) => e.kind)).toEqual([...COUNCIL_KINDS]);
    // The review itself completed; only saving it failed.
    expect(events[1]?.payload).toMatchObject({ outcome: "fail" });
    expect(events[1]?.beadId).toBe("b-1");
  });

  test("a run that throws before producing a result records one finished event, as unreadable", async () => {
    const box = sandbox();
    await expect(
      executeCouncilReview({
        profile: profile(),
        context: await context(box),
        runId: "c-1",
        runsRoot: box.runsRoot,
        resolveTransport: () => new FakeCouncilTransport(),
        now: () => {
          throw new Error("clock failed");
        },
        ...councilSeam(box),
        attach: { workspace: box.cwd },
      }),
    ).rejects.toThrow("clock failed");

    const events = councilEvents(box.path);
    expect(events.map((e) => e.kind)).toEqual([...COUNCIL_KINDS]);
    expect(events[1]?.payload).toEqual({
      councilRunId: "c-1",
      outcome: "unreadable",
    });
  });

  test("a run refused before it starts (its id is taken) records nothing", async () => {
    const box = sandbox();
    mkdirSync(join(box.runsRoot, "c-1"), { recursive: true });
    await expect(
      executeCouncilReview({
        profile: profile(),
        context: await context(box),
        runId: "c-1",
        runsRoot: box.runsRoot,
        resolveTransport: () => new FakeCouncilTransport(),
        ...councilSeam(box),
        attach: { workspace: box.cwd },
      }),
    ).rejects.toThrow("already exists");
    expect(councilEvents(box.path)).toEqual([]);
  });

  test("an appender that throws does not fail the review", async () => {
    const box = sandbox();
    const { result } = await executeCouncilReview({
      profile: profile(),
      context: await context(box),
      runId: "c-1",
      runsRoot: box.runsRoot,
      resolveTransport: () => new FakeCouncilTransport(),
      appendEvent: () => {
        throw new Error("ledger offline");
      },
      attach: { workspace: box.cwd },
    });
    expect(result.ok).toBe(true);
  });

  test("no seat output or finding text reaches the ledger", async () => {
    const box = sandbox();
    await executeCouncilReview({
      profile: profile(),
      context: await context(box),
      runId: "c-1",
      runsRoot: box.runsRoot,
      resolveTransport: () => new FakeCouncilTransport(),
      ...councilSeam(box),
      attach: { workspace: box.cwd, beadId: "b-1" },
    });
    const events = councilEvents(box.path);
    expect(events).toHaveLength(2);
    for (const event of events) {
      const allowed = PAYLOAD_KEYS[event.kind];
      for (const key of Object.keys(event.payload))
        expect(allowed).toContain(key);
    }
    // Strings the fake seats and their findings produce, and the reviewed text.
    closeLedger();
    const stored = ledgerBytes(box.path);
    expect(stored).toContain("deterministic review");
    for (const text of [
      "avoidable rework",
      "Review concern from",
      "grounded in supplied evidence",
      "rollout plan",
    ])
      expect(stored).not.toContain(text);
  });

  test("a council run with no appender injected records nothing and still completes", async () => {
    const box = sandbox();
    const before = queryEvents({ kinds: [...COUNCIL_KINDS] }).length;
    const { result } = await executeCouncilReview({
      profile: profile(),
      context: await context(box),
      runId: "c-1",
      runsRoot: box.runsRoot,
      resolveTransport: () => new FakeCouncilTransport(),
      attach: { workspace: box.cwd, beadId: "b-1" },
    });
    expect(result.ok).toBe(true);
    expect(existsSync(box.path)).toBe(false);
    // Nor did it reach the test process's default ledger (a temp home).
    expect(queryEvents({ kinds: [...COUNCIL_KINDS] })).toHaveLength(before);
  });
});

describe("the council CLI (in-process, fake-transport default profile, scratch ledger)", () => {
  test("--bead is parsed for a run, needs a value, and is not a replay option", () => {
    const parsed = parseCouncilCliArgs(["stdin", "--bead", "b-9"]);
    expect(
      parsed.ok && parsed.value.kind === "run" && parsed.value.beadId,
    ).toBe("b-9");
    expect(parseCouncilCliArgs(["stdin", "--bead"])).toMatchObject({
      ok: false,
      error: "--bead needs a value",
    });
    expect(parseCouncilCliArgs(["replay", "r1", "--bead", "b"]).ok).toBe(false);
  });

  test("a CLI run with --bead records started and finished for that bead in the injected ledger", async () => {
    const box = sandbox();
    const ran = await cli(
      box,
      ["stdin", "--bead", "b-9", "--run-id", "c-cli", "--json"],
      councilLedger({}, { path: box.path }),
    );
    expect(ran.code).toBe(0);
    const events = councilEvents(box.path);
    expect(events.map((e) => e.kind)).toEqual([...COUNCIL_KINDS]);
    for (const event of events) {
      expect(event.beadId).toBe("b-9");
      expect(event.payload).toMatchObject({ councilRunId: "c-cli" });
      // No session works in this scratch checkout: nothing is invented.
      expect(event.sessionId).toBeUndefined();
      expect(event.executor).toBeUndefined();
    }
  });

  test("without --bead the bead comes from AGENT_FORGE_BEAD_ID, and the run from FORGE_SLUG", async () => {
    const box = sandbox();
    await cli(
      box,
      ["stdin", "--run-id", "c-cli", "--json"],
      councilLedger(
        { AGENT_FORGE_BEAD_ID: "b-env", FORGE_SLUG: "slug-env" },
        { path: box.path },
      ),
    );
    const events = councilEvents(box.path);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.beadId).toBe("b-env");
      expect(event.runId).toBe("slug-env");
    }
  });

  test("council events carry the invoking session's executor", async () => {
    const box = sandbox();
    writeSessionMirror(box.cwd, "s-live");
    setSessionModel(
      { sessionId: "s-live", provider: "claude", model: "m-live" },
      { path: box.path },
    );
    await cli(
      box,
      ["stdin", "--bead", "b-9", "--run-id", "c-cli", "--json"],
      councilLedger({}, { path: box.path }),
    );
    const events = councilEvents(box.path);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.sessionId).toBe("s-live");
      expect(event.executor).toEqual({
        provider: "claude",
        model: "m-live",
        sessionId: "s-live",
      });
    }
  });

  test("the CLI dry run records nothing", async () => {
    const box = sandbox();
    const appended: LedgerEventInput[] = [];
    const real = councilLedger({}, { path: box.path });
    const ran = await cli(
      box,
      ["stdin", "--dry-run", "--bead", "b-9", "--json"],
      {
        ...real,
        appendEvent: (event) => {
          appended.push(event);
          return real.appendEvent(event);
        },
      },
    );
    expect(ran.code).toBe(0);
    expect(JSON.parse(ran.stdout)).toMatchObject({ data: { dryRun: true } });
    expect(appended).toEqual([]);
    expect(councilEvents(box.path)).toEqual([]);
  });

  test("a CLI run with no ledger injected records nothing", async () => {
    const box = sandbox();
    const before = queryEvents({ kinds: [...COUNCIL_KINDS] }).length;
    const ran = await cli(box, ["stdin", "--bead", "b-9", "--json"]);
    expect(ran.code).toBe(0);
    expect(queryEvents({ kinds: [...COUNCIL_KINDS] })).toHaveLength(before);
  });
});

describe("the council service (fake transport, scratch ledger)", () => {
  test("a job started with a bead records started and finished for it when the ledger is injected", async () => {
    const box = sandbox();
    const service = createCouncilService({
      workspaceRoot: box.cwd,
      runsRoot: box.runsRoot,
      ...councilLedger({}, { path: box.path }),
    });
    try {
      const job = service.start({
        sourceType: "text",
        source: "Review this plan",
        runId: "c-job",
        beadId: "b-2",
      });
      expect((await service.wait(job.runId)).status).toBe("completed");
    } finally {
      await service.close();
    }
    const events = councilEvents(box.path);
    expect(events.map((e) => e.kind)).toEqual([...COUNCIL_KINDS]);
    for (const event of events) {
      expect(event.beadId).toBe("b-2");
      expect(event.payload).toMatchObject({ councilRunId: "c-job" });
    }
  });

  test("a service with no ledger injected records nothing; a bead id that is not a string is refused", async () => {
    const box = sandbox();
    const before = queryEvents({ kinds: [...COUNCIL_KINDS] }).length;
    const service = createCouncilService({
      workspaceRoot: box.cwd,
      runsRoot: box.runsRoot,
    });
    try {
      const job = service.start({
        sourceType: "text",
        source: "Review this plan",
        beadId: "b-2",
      });
      expect((await service.wait(job.runId)).status).toBe("completed");
      expect(() =>
        service.start({
          sourceType: "text",
          source: "Review this plan",
          // justification: a caller outside TypeScript can send any JSON value.
          beadId: 7 as unknown as string,
        }),
      ).toThrow("beadId");
    } finally {
      await service.close();
    }
    expect(queryEvents({ kinds: [...COUNCIL_KINDS] })).toHaveLength(before);
  });
});

describe("the import boundary (source scan)", () => {
  const COUNCIL = import.meta.dir;
  const REPO = resolve(COUNCIL, "..", "..");
  const at = (...parts: string[]): string =>
    join(REPO, ...parts).replaceAll("\\", "/");

  const reachable = importGraph;

  /** What the graph holds that only Bun can load, or that is the ledger. */
  function ledgerReach(graph: ImportGraph): string[] {
    return [
      ...graph.files.filter((file) => file.includes("/scripts/ledger/")),
      ...graph.files.filter((file) => file.endsWith("/ledger-wiring.ts")),
      ...graph.bare.filter((name) => name.startsWith("bun:")),
    ];
  }

  /** The module scripts the dashboard's pages load: what Vite bundles. */
  function browserEntries(): string[] {
    const docs = join(REPO, "docs");
    return readdirSync(docs)
      .filter((name) => name.endsWith(".html"))
      .flatMap((name) =>
        [
          ...readFileSync(join(docs, name), "utf8").matchAll(
            /<script\s+type="module"\s+src="([^"]+)"/g,
          ),
        ].map((match) => join(docs, match[1] ?? "")),
      );
  }

  test("nothing Vite loads under Node reaches the ledger or a bun: module", () => {
    // The dashboard config is the only thing Vite runs under Node; everything
    // it loads is whatever that file imports. The hearth it starts is a
    // separate Bun process, named by path and never imported.
    const graph = reachable(join(REPO, "vite.dashboard.config.ts"));
    // The walk really followed the chain this guards.
    for (const name of [
      "vite-plugin.ts",
      "supervisor.ts",
      "lock.ts",
      "home.ts",
    ])
      expect(graph.files).toContain(at("scripts", "hearth", name));
    expect(graph.files).toContain(at("scripts", "agent-forge-home.ts"));
    expect(graph.files).not.toContain(at("scripts", "hearth", "server.ts"));
    expect(ledgerReach(graph)).toEqual([]);
  });

  test("nothing the dashboard bundles for the browser reaches the ledger or a bun: module", () => {
    const entries = browserEntries();
    expect(entries.map((file) => file.replaceAll("\\", "/")).sort()).toEqual([
      at("docs", "js", "app.tsx"),
      at("docs", "js", "council.tsx"),
    ]);
    const graph = reachable(...entries);
    // The walk really crossed from the pages into `scripts/`.
    expect(graph.files).toContain(at("scripts", "forge", "runs.ts"));
    expect(graph.files).toContain(at("scripts", "council", "discussion.ts"));
    expect(ledgerReach(graph)).toEqual([]);
  });

  test("the council service and workflow reach the ledger only through what a caller hands them", () => {
    // Not a Node constraint any more — the hearth that serves these runs under
    // Bun — but the seam: the service appends through an injected function,
    // so a host that injects nothing loads no ledger and writes none.
    const graph = reachable(join(COUNCIL, "service.ts"));
    for (const name of ["workflow.ts", "ledger-events.ts"])
      expect(graph.files).toContain(at("scripts", "council", name));
    expect(ledgerReach(graph)).toEqual([]);
  });

  test("the scan sees a ledger import where there is one", () => {
    const graph = reachable(join(COUNCIL, "ledger-wiring.ts"));
    expect(
      graph.files.some((file) => file.endsWith("/scripts/ledger/db.ts")),
    ).toBe(true);
    expect(graph.bare).toContain("bun:sqlite");
    expect(ledgerReach(graph)).toEqual(
      expect.arrayContaining([
        at("scripts", "ledger", "db.ts"),
        at("scripts", "council", "ledger-wiring.ts"),
        "bun:sqlite",
      ]),
    );
  });

  test("the CLI and MCP entry points load the ledger only through a dynamic import", () => {
    for (const name of ["cli.ts", "mcp.ts"]) {
      const source = readFileSync(join(COUNCIL, name), "utf8");
      expect(source.includes('await import("./ledger-wiring")')).toBe(true);
      expect(source).not.toMatch(/from\s+["']\.\/ledger-wiring["']/);
      expect(source).not.toMatch(/from\s+["']\.\.\/ledger\//);
    }
  });

  test("the hearth loads the council ledger wiring only where it runs as a command, so a hearth built in a test records no council run", () => {
    const source = readFileSync(
      join(REPO, "scripts", "hearth", "server.ts"),
      "utf8",
    );
    expect(source.includes('await import("../council/ledger-wiring")')).toBe(
      true,
    );
    expect(source).not.toMatch(/from\s+["']\.\.\/council\/ledger-wiring["']/);
    // The dashboard's helper for posting actions is bundled for the browser:
    // it reaches the hearth's constants and nothing of the ledger.
    const helper = reachable(join(REPO, "docs", "js", "operator.ts"));
    expect(helper.files).toContain(at("scripts", "hearth", "paths.ts"));
    expect(ledgerReach(helper)).toEqual([]);
    expect(helper.bare).toEqual([]);
  });
});

/** The appender half of the seam, bound to the box's ledger. */
function councilSeam(
  box: Box,
): Pick<ReturnType<typeof councilLedger>, "appendEvent"> {
  return { appendEvent: councilLedger({}, { path: box.path }).appendEvent };
}

/** Everything SQLite has on disk for a ledger: the file and its write-ahead log. */
function ledgerBytes(path: string): string {
  return [path, `${path}-wal`]
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, "latin1"))
    .join("");
}
