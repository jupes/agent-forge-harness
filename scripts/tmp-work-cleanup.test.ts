import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { BeadsIssue } from "../types/beads";
import type { BdRunner } from "./beads/live-tracker";
import {
  EVALUATIONS_DIR,
  evaluationDir,
  evaluatorVerdictPath,
  sha256Hex,
  writerScratchName,
  writeVerdictOnce,
} from "./eval-verdict-store";
import { appendEvent } from "./ledger/append";
import { closeLedger } from "./ledger/db";
import {
  classifyFile,
  DEFAULT_TTL_DAYS,
  type LedgerDigest,
  ledgerHoldsVerdict,
  runTmpWorkCleanup,
  sweepEvaluations,
} from "./tmp-work-cleanup";

const mkClosed = (id: string): BeadsIssue => ({
  id,
  type: "task",
  title: id,
  status: "closed",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-10T00:00:00Z",
});

const mkOpen = (id: string): BeadsIssue => ({
  ...mkClosed(id),
  status: "open",
});

describe("classifyFile", () => {
  test("skips session-handoff.md", () => {
    const r = classifyFile("session-handoff.md", 100, new Map(), 14);
    expect(r).toBeNull();
  });

  test("skips <EPIC>-interfaces.md", () => {
    const r = classifyFile(
      "agent-forge-harness-c8u-interfaces.md",
      100,
      new Map(),
      14,
    );
    expect(r).toBeNull();
  });

  test("skips unknown prefix", () => {
    const r = classifyFile("random.md", 100, new Map(), 14);
    expect(r).toBeNull();
  });

  test("deletes closed task above TTL", () => {
    const m = new Map<string, BeadsIssue>();
    m.set("agent-forge-harness-jq3", mkClosed("agent-forge-harness-jq3"));
    const r = classifyFile("agent-forge-harness-jq3-verdict.json", 20, m, 14);
    expect(r?.action).toBe("delete");
  });

  test("skips open task even if old", () => {
    const m = new Map<string, BeadsIssue>();
    m.set("agent-forge-harness-jq3", mkOpen("agent-forge-harness-jq3"));
    const r = classifyFile("agent-forge-harness-jq3-alignment.md", 99, m, 14);
    expect(r?.action).toBe("skip");
    expect(r?.reason).toContain("status=open");
  });

  test("skips closed but under TTL", () => {
    const m = new Map<string, BeadsIssue>();
    m.set("agent-forge-harness-jq3", mkClosed("agent-forge-harness-jq3"));
    const r = classifyFile("agent-forge-harness-jq3-plan.md", 5, m, 14);
    expect(r?.action).toBe("skip");
  });
});

// ── Evaluation directories ──────────────────────────────────────────────────

const temporary: string[] = [];

afterEach(() => {
  closeLedger();
  for (const dir of temporary.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A ledger file a child still holds on Windows: the OS temp directory reclaims it.
    }
  }
});

/** A scratch checkout (a directory with `.git`) and a directory beside it. */
function sandbox(): { checkout: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), "tmp cleanup test "));
  temporary.push(root);
  const checkout = join(root, "check out");
  const outside = join(root, "outside");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { checkout, outside };
}

function verdictJson(run: string, bead = "bead-1", summary?: string): string {
  return JSON.stringify({
    schemaVersion: 2,
    beadsIssueId: bead,
    executionRunId: run,
    verdict: "PASS",
    findings: { blocker: 0, high: 0, medium: 0, low: 0 },
    ...(summary !== undefined ? { summary } : {}),
    evaluator: { kind: "human", actorKind: "reviewer" },
  });
}

const DAY_MS = 86_400_000;

/** Write a run's verdict through the real writer and age it `days` days. */
function agedVerdict(
  checkout: string,
  run: string,
  days: number,
  opts: { bead?: string; file?: string; summary?: string } = {},
): { relative: string; sha256: string } {
  // A round's file holds a verdict that names its round.
  const round = /^review-(.+)\.json$/.exec(opts.file ?? "")?.[1];
  const content =
    round === undefined
      ? verdictJson(run, opts.bead, opts.summary)
      : JSON.stringify({
          ...JSON.parse(verdictJson(run, opts.bead, opts.summary)),
          review: round,
        });
  const wrote = writeVerdictOnce({
    checkout,
    executionRunId: run,
    ...(opts.file ? { file: opts.file } : {}),
    content,
  });
  if (!wrote.ok) throw new Error(wrote.error);
  const then = new Date(Date.now() - days * DAY_MS);
  utimesSync(join(checkout, wrote.path), then, then);
  return { relative: wrote.path, sha256: wrote.sha256 };
}

function issues(...list: BeadsIssue[]): Map<string, BeadsIssue> {
  return new Map(list.map((issue) => [issue.id, issue]));
}

/** A ledger that holds exactly these digests. */
function ledger(...held: LedgerDigest[]): (digest: LedgerDigest) => boolean {
  return (digest) =>
    held.some(
      (entry) =>
        entry.sha256 === digest.sha256 &&
        entry.executionRunId === digest.executionRunId,
    );
}

function sweep(
  checkout: string,
  input: {
    issues?: Map<string, BeadsIssue>;
    held?: LedgerDigest[];
    apply?: boolean;
    ttlDays?: number;
  } = {},
) {
  return sweepEvaluations({
    checkout,
    issuesById: input.issues ?? issues(mkClosed("bead-1")),
    ttlDays: input.ttlDays ?? DEFAULT_TTL_DAYS,
    ledgerHolds: ledger(...(input.held ?? [])),
    apply: input.apply ?? false,
    nowMs: Date.now(),
  });
}

describe("sweepEvaluations", () => {
  test("the default retention period is 14 days", () => {
    expect(DEFAULT_TTL_DAYS).toBe(14);
  });

  test("a closed bead's old verdict whose digest the ledger holds is removed, and its directory with it", () => {
    const { checkout } = sandbox();
    const file = agedVerdict(checkout, "run-1", 30);
    const held = [{ sha256: file.sha256, executionRunId: "run-1" }];

    const dry = sweep(checkout, { held });
    expect(dry.candidates).toEqual([
      {
        path: file.relative,
        taskId: "bead-1",
        ageDays: 30,
        action: "delete",
        reason: "closed bead, age 30d ≥ TTL 14d, digest held by the ledger",
      },
    ]);
    expect(dry.deleted).toEqual([]);
    expect(existsSync(join(checkout, file.relative))).toBe(true);

    const applied = sweep(checkout, { held, apply: true });
    expect(applied.deleted).toEqual([file.relative]);
    expect(existsSync(join(checkout, file.relative))).toBe(false);
    expect(existsSync(join(checkout, evaluationDir("run-1") ?? ""))).toBe(
      false,
    );
    // The evaluations directory itself stays.
    expect(existsSync(join(checkout, EVALUATIONS_DIR))).toBe(true);
  });

  test("a verdict whose digest the ledger does not hold is the only copy of that evidence and is kept", () => {
    const { checkout } = sandbox();
    const file = agedVerdict(checkout, "run-1", 30);
    for (const held of [
      [],
      // The same run with other bytes, and the same bytes under another run.
      [{ sha256: sha256Hex("other bytes"), executionRunId: "run-1" }],
      [{ sha256: file.sha256, executionRunId: "run-2" }],
    ]) {
      const applied = sweep(checkout, { held, apply: true });
      expect(applied.candidates).toEqual([
        {
          path: file.relative,
          taskId: "bead-1",
          ageDays: 30,
          action: "skip",
          reason:
            "the ledger holds no verdict.bound with this file's digest for its run",
        },
      ]);
      expect(applied.deleted).toEqual([]);
      expect(existsSync(join(checkout, file.relative))).toBe(true);
    }
  });

  test("an open bead's verdict, a young one and one for a bead Beads does not know are kept", () => {
    const { checkout } = sandbox();
    const open = agedVerdict(checkout, "run-open", 30, { bead: "bead-open" });
    const young = agedVerdict(checkout, "run-young", 3);
    const unknown = agedVerdict(checkout, "run-unknown", 30, {
      bead: "bead-gone",
    });
    const held = [open, young, unknown].map((file, index) => ({
      sha256: file.sha256,
      executionRunId: ["run-open", "run-young", "run-unknown"][index] ?? "",
    }));
    const applied = sweep(checkout, {
      issues: issues(mkClosed("bead-1"), mkOpen("bead-open")),
      held,
      apply: true,
    });
    const reasons = Object.fromEntries(
      applied.candidates.map((candidate) => [candidate.path, candidate]),
    );
    expect(reasons[open.relative]).toMatchObject({
      action: "skip",
      reason: "bead bead-open status=open",
    });
    expect(reasons[young.relative]).toMatchObject({
      action: "skip",
      reason: "age 3d < TTL 14d",
    });
    expect(reasons[unknown.relative]).toMatchObject({
      action: "skip",
      reason: "bead bead-gone not in ledger",
    });
    expect(applied.deleted).toEqual([]);
  });

  test("a review round is swept on its own digest; the directory goes only when it is empty", () => {
    const { checkout } = sandbox();
    const strict = agedVerdict(checkout, "run-1", 30);
    const round = agedVerdict(checkout, "run-1", 30, {
      file: "review-plan-1.json",
      summary: "a round the ledger never recorded",
    });
    // The ledger holds the run's verdict, not the round.
    const first = sweep(checkout, {
      held: [{ sha256: strict.sha256, executionRunId: "run-1" }],
      apply: true,
    });
    expect(first.deleted).toEqual([strict.relative]);
    expect(existsSync(join(checkout, round.relative))).toBe(true);

    // Once the round is held too, it goes, and the now empty directory with it.
    const then = sweep(checkout, {
      held: [{ sha256: round.sha256, executionRunId: "run-1" }],
      apply: true,
    });
    expect(then.deleted).toEqual([round.relative]);
    expect(existsSync(join(checkout, evaluationDir("run-1") ?? ""))).toBe(
      false,
    );

    // A directory that also holds something the sweep does not manage keeps it, and stays.
    const kept = agedVerdict(checkout, "run-2", 30);
    const stray = join(checkout, evaluationDir("run-2") ?? "", "notes.txt");
    writeFileSync(stray, "not a verdict");
    const second = sweep(checkout, {
      held: [{ sha256: kept.sha256, executionRunId: "run-2" }],
      apply: true,
    });
    expect(second.deleted).toEqual([kept.relative]);
    expect(existsSync(stray)).toBe(true);
    expect(readdirSync(join(checkout, evaluationDir("run-2") ?? ""))).toEqual([
      "notes.txt",
    ]);
  });

  test("only a validated file is touched: the wrong directory, the wrong schema, an unmanaged name", () => {
    const { checkout } = sandbox();
    const hex = sha256Hex("some-other-run");
    const misplaced = `${EVALUATIONS_DIR}/${hex}/verdict.json`;
    const legacy = `${evaluationDir("run-legacy")}/verdict.json`;
    const notHex = `${EVALUATIONS_DIR}/run-1/verdict.json`;
    const stray = `${evaluationDir("run-1")}/notes.json`;
    const plant = (relative: string, content: string) => {
      const path = join(checkout, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      const then = new Date(Date.now() - 30 * DAY_MS);
      utimesSync(path, then, then);
    };
    // A good verdict for run-1 sitting in another run's directory.
    plant(misplaced, verdictJson("run-1"));
    plant(
      legacy,
      JSON.stringify({
        schemaVersion: 1,
        taskId: "bead-1",
        verdict: "PASS",
        findings: { blocker: 0, high: 0, medium: 0, low: 0 },
      }),
    );
    plant(notHex, verdictJson("run-1"));
    plant(stray, verdictJson("run-1"));

    const applied = sweep(checkout, {
      // The ledger holds every digest: only validation stands in the way.
      held: [
        { sha256: sha256Hex(verdictJson("run-1")), executionRunId: "run-1" },
      ],
      apply: true,
    });
    expect(applied.deleted).toEqual([]);
    const reasons = Object.fromEntries(
      applied.candidates.map((candidate) => [candidate.path, candidate.reason]),
    );
    expect(reasons[misplaced]).toBe(
      "the verdict names run run-1, which this directory is not the directory of",
    );
    expect(reasons[legacy]).toBe("not a schema 2 verdict");
    // Names the path rule cannot produce are not candidates at all.
    expect(notHex in reasons).toBe(false);
    expect(stray in reasons).toBe(false);
    for (const relative of [misplaced, legacy, notHex, stray]) {
      expect(existsSync(join(checkout, relative))).toBe(true);
    }
  });

  test("nothing is read or removed behind a link", () => {
    // The evaluations directory is a link out of the checkout.
    const escaping = sandbox();
    const planted = join(escaping.outside, sha256Hex("run-1"), "verdict.json");
    mkdirSync(dirname(planted), { recursive: true });
    writeFileSync(planted, verdictJson("run-1"));
    const then = new Date(Date.now() - 30 * DAY_MS);
    utimesSync(planted, then, then);
    mkdirSync(join(escaping.checkout, ".tmp", "work"), { recursive: true });
    symlinkSync(
      escaping.outside,
      join(escaping.checkout, EVALUATIONS_DIR),
      "junction",
    );
    const held = [
      { sha256: sha256Hex(verdictJson("run-1")), executionRunId: "run-1" },
    ];
    const outside = sweep(escaping.checkout, { held, apply: true });
    expect(outside.candidates).toEqual([]);
    expect(outside.deleted).toEqual([]);
    expect(outside.note).toBe(
      `${EVALUATIONS_DIR} is, or sits under, a link: nothing in it is swept`,
    );
    expect(existsSync(planted)).toBe(true);

    // One run's directory is a link to another run's, inside the checkout.
    const inner = sandbox();
    const real = agedVerdict(inner.checkout, "run-0", 30);
    symlinkSync(
      join(inner.checkout, evaluationDir("run-0") ?? ""),
      join(inner.checkout, evaluationDir("run-1") ?? ""),
      "junction",
    );
    const linked = sweep(inner.checkout, { held: [], apply: true });
    expect(linked.deleted).toEqual([]);
    expect(linked.candidates.map((candidate) => candidate.path)).toEqual([
      real.relative,
    ]);
    expect(existsSync(join(inner.checkout, real.relative))).toBe(true);
    expect(
      existsSync(join(inner.checkout, evaluatorVerdictPath("run-1") ?? "")),
    ).toBe(true);
  });

  test("a run's directory is removed only by the sweep that emptied it: an empty one found there is left", () => {
    const { checkout } = sandbox();
    const empty = join(checkout, EVALUATIONS_DIR, sha256Hex("some-run"));
    mkdirSync(empty, { recursive: true });
    expect(sweep(checkout, { apply: true })).toEqual({
      candidates: [],
      deleted: [],
    });
    expect(existsSync(empty)).toBe(true);
  });

  test("it sweeps a checkout from its top level only: from a directory inside one it does nothing and says so", () => {
    const { checkout } = sandbox();
    const file = agedVerdict(checkout, "run-1", 30);
    const nested = join(checkout, "packages", "app");
    mkdirSync(nested, { recursive: true });
    expect(
      sweep(nested, {
        held: [{ sha256: file.sha256, executionRunId: "run-1" }],
        apply: true,
      }),
    ).toEqual({
      candidates: [],
      deleted: [],
      note: "evaluations are swept from the top level of a checkout: this directory is inside one",
    });
    expect(existsSync(join(checkout, file.relative))).toBe(true);
  });

  test("a checkout with no evaluations has nothing to sweep", () => {
    const { checkout } = sandbox();
    expect(sweep(checkout, { apply: true })).toEqual({
      candidates: [],
      deleted: [],
    });
  });

  /** Leave a file as a writer killed part-way leaves its scratch file, `days` days ago. */
  function scratch(
    checkout: string,
    run: string,
    name: string,
    days: number,
    content = verdictJson(run).slice(0, 40),
  ): string {
    const relative = `${evaluationDir(run)}/${name}`;
    const path = join(checkout, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    const then = new Date(Date.now() - days * DAY_MS);
    utimesSync(path, then, then);
    return relative;
  }

  test("a killed writer's old scratch file is removed whatever it holds, and the run's directory with it", () => {
    const { checkout } = sandbox();
    const file = agedVerdict(checkout, "run-1", 30);
    const partial = scratch(
      checkout,
      "run-1",
      writerScratchName("verdict.json", 4242, 30 * DAY_MS),
      30,
    );
    const round = scratch(
      checkout,
      "run-1",
      writerScratchName("review-plan-1.json", 77, 31 * DAY_MS),
      30,
      verdictJson("run-1"),
    );
    const held = [{ sha256: file.sha256, executionRunId: "run-1" }];

    const dry = sweep(checkout, { held });
    const scratchReason =
      "a writer's scratch file, never a verdict itself, age 30d ≥ TTL 14d";
    // In name order, as the sweep reads the directory.
    expect(dry.candidates).toEqual([
      {
        path: round,
        taskId: "",
        ageDays: 30,
        action: "delete",
        reason: scratchReason,
      },
      {
        path: partial,
        taskId: "",
        ageDays: 30,
        action: "delete",
        reason: scratchReason,
      },
      {
        path: file.relative,
        taskId: "bead-1",
        ageDays: 30,
        action: "delete",
        reason: "closed bead, age 30d ≥ TTL 14d, digest held by the ledger",
      },
    ]);
    expect(dry.deleted).toEqual([]);

    const applied = sweep(checkout, { held, apply: true });
    expect(applied.deleted).toEqual([round, partial, file.relative]);
    expect(existsSync(join(checkout, evaluationDir("run-1") ?? ""))).toBe(
      false,
    );
  });

  test("a scratch file is swept on its age alone: an open bead's run loses an old one and keeps a young one", () => {
    const { checkout } = sandbox();
    const kept = agedVerdict(checkout, "run-open", 30, { bead: "bead-open" });
    const old = scratch(
      checkout,
      "run-open",
      writerScratchName("verdict.json", 1, 0),
      30,
    );
    // A writer that started an hour ago may still be about to link it in.
    const young = scratch(
      checkout,
      "run-open",
      writerScratchName("verdict.json", 2, Date.now()),
      0,
    );
    const applied = sweep(checkout, {
      issues: issues(mkOpen("bead-open")),
      held: [{ sha256: kept.sha256, executionRunId: "run-open" }],
      apply: true,
    });
    expect(applied.deleted).toEqual([old]);
    expect(
      applied.candidates.find((candidate) => candidate.path === young),
    ).toEqual({
      path: young,
      taskId: "",
      ageDays: 0,
      action: "skip",
      reason: "a writer's scratch file, age 0d < TTL 14d",
    });
    expect(existsSync(join(checkout, young))).toBe(true);
    expect(existsSync(join(checkout, kept.relative))).toBe(true);
  });

  test("only the writer's own scratch names are scratch files: anything else that looks like one is left", () => {
    const { checkout } = sandbox();
    const lookalikes = [
      ".verdict.json.tmp",
      ".verdict.json.12.tmp",
      ".notes.json.12.k3.tmp",
      ".review-Plan.json.12.k3.tmp",
      "verdict.json.12.k3.tmp",
    ].map((name) => scratch(checkout, "run-1", name, 30));
    // A directory with a scratch file's name is not a file to remove.
    const folder = join(
      checkout,
      evaluationDir("run-1") ?? "",
      writerScratchName("verdict.json", 9, 0),
    );
    mkdirSync(folder);
    const applied = sweep(checkout, { apply: true });
    expect(applied.deleted).toEqual([]);
    expect(applied.candidates).toEqual([]);
    for (const relative of lookalikes) {
      expect(existsSync(join(checkout, relative))).toBe(true);
    }
    expect(existsSync(folder)).toBe(true);
  });
});

describe("ledgerHoldsVerdict (the script's own lookup, scratch ledger)", () => {
  const DIGEST = sha256Hex("the bytes the gate read");

  function ledgerWith(
    run: string,
    payload: Record<string, unknown>,
  ): { path: string } {
    const root = mkdtempSync(join(tmpdir(), "tmp cleanup ledger "));
    temporary.push(root);
    const path = join(root, "ledger.db");
    const stored = appendEvent(
      {
        kind: "verdict.bound",
        workspace: "c:/work/repo",
        beadId: "bead-1",
        runId: run,
        // justification: the payload is the case under test, built by hand.
        payload: payload as { verdict: "pass" },
      },
      { path },
    );
    if (!stored.ok) throw new Error(stored.error);
    return { path };
  }

  const artifact = (sha256: string) => ({
    verdict: "pass",
    verdictArtifact: {
      path: ".tmp/work/evaluations/abc/verdict.json",
      sha256,
      bytes: 312,
      schemaVersion: 2,
    },
  });

  test("holds a digest only when a verdict.bound of that run carries exactly it", () => {
    const { path } = ledgerWith("run-1", artifact(DIGEST));
    const held = (sha256: string, executionRunId: string) =>
      ledgerHoldsVerdict({ sha256, executionRunId }, { path });
    expect(held(DIGEST, "run-1")).toBe(true);
    // The run has a verdict.bound, but for other bytes.
    expect(held(sha256Hex("other bytes"), "run-1")).toBe(false);
    // The bytes are held, but for another run.
    expect(held(DIGEST, "run-2")).toBe(false);
  });

  test("a verdict.bound with no file reference holds nothing", () => {
    const { path } = ledgerWith("run-1", { verdict: "pass" });
    expect(
      ledgerHoldsVerdict({ sha256: DIGEST, executionRunId: "run-1" }, { path }),
    ).toBe(false);
  });

  test("a ledger that cannot be read holds nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "tmp cleanup ledger "));
    temporary.push(root);
    const garbage = join(root, "ledger.db");
    writeFileSync(garbage, "not a database");
    expect(
      ledgerHoldsVerdict(
        { sha256: DIGEST, executionRunId: "run-1" },
        { path: garbage },
      ),
    ).toBe(false);
    // A directory where the ledger file would be.
    expect(
      ledgerHoldsVerdict(
        { sha256: DIGEST, executionRunId: "run-1" },
        { path: root },
      ),
    ).toBe(false);
  });
});

// ── Which tracker decides what is closed ────────────────────────────────────

/** Stands in for `bd`: records every call; never the real tracker. */
function fakeBd(answer: () => string | Error): {
  run: BdRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args) => {
      calls.push(args);
      const out = answer();
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

/** One `bd export` line, in the shape bd prints and `.beads/issues.jsonl` holds. */
function exportRow(id: string, status: string): object {
  return {
    _type: "issue",
    id,
    title: `title of ${id}`,
    status,
    priority: 2,
    issue_type: "task",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-10T00:00:00Z",
  };
}

const jsonl = (rows: object[]): string =>
  `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

function writeIssuesFile(checkout: string, rows: object[]): void {
  mkdirSync(join(checkout, ".beads"), { recursive: true });
  writeFileSync(join(checkout, ".beads", "issues.jsonl"), jsonl(rows));
}

/** A file in the checkout's `.tmp/work`, last written `days` days ago; its path. */
function agedWorkFile(checkout: string, name: string, days: number): string {
  const dir = join(checkout, ".tmp", "work");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "notes\n");
  const then = new Date(Date.now() - days * DAY_MS);
  utimesSync(path, then, then);
  return path;
}

/** A run with `--apply`, and `--allow-fallback` when `opts.allowFallback` says so. */
function cleanupWith(
  checkout: string,
  bd: BdRunner,
  opts: {
    allowFallback?: boolean;
    ledgerHolds?: (digest: LedgerDigest) => boolean;
    warn?: (line: string) => void;
  } = {},
) {
  return runTmpWorkCleanup({
    cwd: checkout,
    runBd: bd,
    apply: true,
    allowFallback: opts.allowFallback ?? false,
    ttlDays: DEFAULT_TTL_DAYS,
    nowMs: Date.now(),
    ledgerHolds: opts.ledgerHolds ?? (() => false),
    warn: opts.warn ?? (() => {}),
  });
}

describe("runTmpWorkCleanup: which tracker says a bead is closed", () => {
  test("with --apply, a work file is kept when the live tracker has its bead open, though .beads/issues.jsonl lists it closed", async () => {
    const { checkout } = sandbox();
    writeIssuesFile(checkout, [exportRow("bead-1", "closed")]);
    const work = agedWorkFile(checkout, "bead-1-plan.md", 30);
    const bd = fakeBd(() => jsonl([exportRow("bead-1", "open")]));

    const result = await cleanupWith(checkout, bd.run);

    expect(existsSync(work)).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.data.deleted).toEqual([]);
    expect(result.data.candidates).toEqual([
      {
        path: work,
        taskId: "bead-1",
        ageDays: 30,
        action: "skip",
        reason: "bead bead-1 status=open",
      },
    ]);
    expect(result.data.source).toEqual({ kind: "tracker" });
    expect(bd.calls).toEqual([["export", "--no-memories"]]);
  });

  test("when bd does not answer, --apply without --allow-fallback removes nothing, neither work files nor verdicts, and the envelope reports a dry run and why", async () => {
    const { checkout } = sandbox();
    writeIssuesFile(checkout, [exportRow("bead-1", "closed")]);
    const work = agedWorkFile(checkout, "bead-1-plan.md", 30);
    const verdict = agedVerdict(checkout, "run-1", 30);
    const bd = fakeBd(() => new Error("spawn bd ENOENT"));
    const warnings: string[] = [];

    const result = await cleanupWith(checkout, bd.run, {
      ledgerHolds: ledger({ sha256: verdict.sha256, executionRunId: "run-1" }),
      warn: (line) => warnings.push(line),
    });

    expect(existsSync(work)).toBe(true);
    expect(existsSync(join(checkout, verdict.relative))).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.data.apply).toBe(false);
    expect(result.data.dryRunReason).toContain(".beads/issues.jsonl");
    expect(result.data.dryRunReason).toContain("--allow-fallback");
    expect(result.data.deleted).toEqual([]);
    expect(result.data.evaluations.deleted).toEqual([]);
    // Listed as a dry run lists them: what a run allowed to use the file would remove.
    expect(result.data.candidates.map((c) => [c.path, c.action])).toEqual([
      [work, "delete"],
    ]);
    expect(result.data.evaluations.candidates.map((c) => c.action)).toEqual([
      "delete",
    ]);
    expect(result.data.source).toMatchObject({
      kind: "file",
      path: ".beads/issues.jsonl",
      reason: "spawn bd ENOENT",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("--allow-fallback");
  });

  test("when bd does not answer, --apply with --allow-fallback deletes by .beads/issues.jsonl, after a warning that says so, and the envelope's source names the file", async () => {
    const { checkout } = sandbox();
    writeIssuesFile(checkout, [exportRow("bead-1", "closed")]);
    const work = agedWorkFile(checkout, "bead-1-plan.md", 30);
    const bd = fakeBd(() => new Error("spawn bd ENOENT"));
    const warnings: { line: string; workFileThere: boolean }[] = [];

    const result = await cleanupWith(checkout, bd.run, {
      allowFallback: true,
      warn: (line) => warnings.push({ line, workFileThere: existsSync(work) }),
    });

    expect(existsSync(work)).toBe(false);
    if (!result.ok) throw new Error(result.error);
    expect(result.data.apply).toBe(true);
    expect(result.data.dryRunReason).toBeUndefined();
    expect(result.data.deleted).toEqual([work]);
    expect(result.data.source).toMatchObject({
      kind: "file",
      path: ".beads/issues.jsonl",
      reason: "spawn bd ENOENT",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.line).toContain(".beads/issues.jsonl");
    expect(warnings[0]?.line).toContain("--allow-fallback");
    expect(warnings[0]?.workFileThere).toBe(true);
  });

  test("when bd does not answer and there is no .beads/issues.jsonl, nothing is swept and the error names bd's failure and the file", async () => {
    const { checkout } = sandbox();
    const work = agedWorkFile(checkout, "bead-1-plan.md", 30);
    const bd = fakeBd(() => new Error("dolt server not running"));

    const result = await cleanupWith(checkout, bd.run);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("dolt server not running");
    expect(result.error).toContain(".beads/issues.jsonl");
    expect(existsSync(work)).toBe(true);
  });
});

describe("tmp:cleanup, spawned with --apply (scratch checkout, scratch ledger)", () => {
  const SCRIPT = join(import.meta.dir, "tmp-work-cleanup.ts");

  async function cleanup(
    checkout: string,
    home: string,
    flags: string[],
  ): Promise<{ exitCode: number; data: Record<string, unknown> }> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (/^(CLAUDE_|AGENT_FORGE_|FORGE_|TTL_DAYS$|PATH$)/i.test(key)) continue;
      env[key] = value;
    }
    env.AGENT_FORGE_HOME = home;
    // An empty PATH directory: no `bd` is found, so the real tracker is never
    // asked and the script falls back to the checkout's own export file.
    const noTools = join(dirname(checkout), "no tools");
    mkdirSync(noTools, { recursive: true });
    env.PATH = noTools;
    const child = Bun.spawn([process.execPath, "run", SCRIPT, ...flags], {
      cwd: checkout,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(child.stdout).text();
    return {
      exitCode: await child.exited,
      data: JSON.parse(stdout).data,
    };
  }

  /**
   * A scratch checkout whose export file lists bead-1 closed, two old verdicts
   * of bead-1, and a scratch ledger that holds the digest of the first only.
   */
  function heldAndUnheld(): {
    checkout: string;
    home: string;
    held: { relative: string };
    unheld: { relative: string };
  } {
    const { checkout } = sandbox();
    const home = join(dirname(checkout), "forge home");
    mkdirSync(home, { recursive: true });
    // With no bd on its PATH, the script takes its issues from the checkout's own export file.
    mkdirSync(join(checkout, ".beads"), { recursive: true });
    writeFileSync(
      join(checkout, ".beads", "issues.jsonl"),
      `${JSON.stringify(mkClosed("bead-1"))}\n`,
    );
    const held = agedVerdict(checkout, "run-held", 30);
    const unheld = agedVerdict(checkout, "run-unheld", 30);
    const stored = appendEvent(
      {
        kind: "verdict.bound",
        workspace: checkout,
        beadId: "bead-1",
        runId: "run-held",
        payload: {
          verdict: "pass",
          verdictArtifact: {
            path: held.relative,
            sha256: held.sha256,
            bytes: 1,
            schemaVersion: 2,
          },
        },
      },
      { path: join(home, "ledger.db") },
    );
    expect(stored.ok).toBe(true);
    closeLedger();
    return { checkout, home, held, unheld };
  }

  test("with --allow-fallback, removes the verdict the ledger holds and keeps the one it does not", async () => {
    const { checkout, home, held, unheld } = heldAndUnheld();

    const swept = await cleanup(checkout, home, [
      "--apply",
      "--allow-fallback",
    ]);
    expect(swept.exitCode).toBe(0);
    expect(swept.data.source).toMatchObject({
      kind: "file",
      path: ".beads/issues.jsonl",
    });
    expect(swept.data.apply).toBe(true);
    expect(swept.data.evaluations).toMatchObject({ deleted: [held.relative] });
    expect(existsSync(join(checkout, held.relative))).toBe(false);
    expect(existsSync(join(checkout, unheld.relative))).toBe(true);
  }, 60_000);

  test("without --allow-fallback, --apply on the export file removes nothing, exits 0 and reports a dry run", async () => {
    const { checkout, home, held, unheld } = heldAndUnheld();

    const swept = await cleanup(checkout, home, ["--apply"]);
    expect(swept.exitCode).toBe(0);
    expect(swept.data.apply).toBe(false);
    expect(swept.data.dryRunReason).toEqual(
      expect.stringContaining("--allow-fallback"),
    );
    expect(swept.data.evaluations).toMatchObject({ deleted: [] });
    expect(existsSync(join(checkout, held.relative))).toBe(true);
    expect(existsSync(join(checkout, unheld.relative))).toBe(true);
  }, 60_000);
});
