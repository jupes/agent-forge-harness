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
import {
  EVALUATIONS_DIR,
  evaluationDir,
  evaluatorVerdictPath,
  sha256Hex,
  writeVerdictOnce,
} from "./eval-verdict-store";
import {
  classifyFile,
  DEFAULT_TTL_DAYS,
  type LedgerDigest,
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
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
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
  const content = verdictJson(run, opts.bead, opts.summary);
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
  test("the retention period is the one the task-scoped files have", () => {
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

  test("a checkout with no evaluations has nothing to sweep", () => {
    const { checkout } = sandbox();
    expect(sweep(checkout, { apply: true })).toEqual({
      candidates: [],
      deleted: [],
    });
  });
});
