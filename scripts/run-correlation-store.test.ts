import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { comparableCheckout } from "./forge/runs";
import { resolveCheckout } from "./ledger/workspace";
import { RUN_CORRELATION_ENV, RUN_CORRELATIONS_DIR } from "./run-correlation";
import {
  correlateRun,
  initRunCorrelation,
  loadRunCorrelation,
} from "./run-correlation-store";

const temporary: string[] = [];

/** A scratch checkout (a directory with `.git`) under a path with a space. */
function checkout(name = "check out"): string {
  const root = mkdtempSync(join(tmpdir(), "run correlation test "));
  temporary.push(root);
  const dir = join(root, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const NOW = () => "2026-10-08T12:00:00.000Z";

function init(dir: string, over: Record<string, unknown> = {}) {
  return initRunCorrelation({
    checkout: dir,
    beadsIssueId: "bead-1",
    executionRunId: "run-1",
    now: NOW,
    ...over,
  });
}

/** A correlation file written by hand, wherever the test wants it. */
function plant(file: string, over: Record<string, unknown> = {}): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      executionRunId: "run-1",
      beadsIssueId: "bead-1",
      checkout: "",
      createdAt: NOW(),
      ...over,
    }),
  );
}

describe("initRunCorrelation (the launcher boundary)", () => {
  test("writes one validated file for the run inside the checkout and returns the pointer to hand on", () => {
    const dir = checkout();
    const made = init(dir);
    if (!made.ok) throw new Error(made.error);

    const root = resolveCheckout(dir).worktree;
    expect<unknown>(made.correlation).toEqual({
      schemaVersion: 1,
      executionRunId: "run-1",
      beadsIssueId: "bead-1",
      checkout: root,
      createdAt: NOW(),
    });
    // The pointer is spelled by the checkout's real path, however `dir` was.
    expect(comparableCheckout(made.path)).toBe(
      `${root}/${RUN_CORRELATIONS_DIR}/run-1.json`,
    );
    expect(existsSync(join(dir, RUN_CORRELATIONS_DIR, "run-1.json"))).toBe(
      true,
    );
    expect(JSON.parse(readFileSync(made.path, "utf8"))).toEqual(
      made.correlation,
    );
    expect(made.env).toEqual({ [RUN_CORRELATION_ENV]: made.path });

    // And the gate's loader reads the same ids back through that pointer.
    expect(loadRunCorrelation(made.path, dir)).toEqual({
      ok: true,
      value: made.correlation,
      path: made.path,
    });
  });

  test("mints a run id only when the caller reserved none", () => {
    const dir = checkout();
    const minted = init(dir, {
      executionRunId: undefined,
      mint: () => "01JABCDEFGHJKMNPQRSTVWXYZ0",
    });
    expect(minted.ok && minted.correlation.executionRunId).toBe(
      "01JABCDEFGHJKMNPQRSTVWXYZ0",
    );
    const reserved = init(dir, {
      executionRunId: "upstream-run",
      mint: () => {
        throw new Error("must not mint");
      },
    });
    expect(reserved.ok && reserved.correlation.executionRunId).toBe(
      "upstream-run",
    );
    expect(
      readdirSync(join(dir, RUN_CORRELATIONS_DIR)).sort((a, b) =>
        a.localeCompare(b),
      ),
    ).toEqual(["01JABCDEFGHJKMNPQRSTVWXYZ0.json", "upstream-run.json"]);
  });

  test("a minted id is a valid run id and loads back through its own pointer", () => {
    const dir = checkout();
    const made = init(dir, { executionRunId: undefined });
    if (!made.ok) throw new Error(made.error);
    expect(made.correlation.executionRunId).toMatch(/^[0-9A-Z]{26}$/);
    expect(loadRunCorrelation(made.path, dir)).toEqual({
      ok: true,
      value: made.correlation,
      path: made.path,
    });
  });

  test("a run id with capitals loads back, and its file keeps the id's spelling", () => {
    const dir = checkout();
    const made = init(dir, { executionRunId: "Feature-ABC.v2" });
    if (!made.ok) throw new Error(made.error);
    expect(readdirSync(join(dir, RUN_CORRELATIONS_DIR))).toEqual([
      "Feature-ABC.v2.json",
    ]);
    const loaded = loadRunCorrelation(made.path, dir);
    expect(loaded.ok && loaded.value.executionRunId).toBe("Feature-ABC.v2");
  });

  test("a second init for the same run and bead keeps the first file", () => {
    const dir = checkout();
    const first = init(dir);
    const again = init(dir, { now: () => "2027-01-01T00:00:00.000Z" });
    expect(again.ok && again.correlation.createdAt).toBe(NOW());
    expect(again.ok && first.ok && again.path === first.path).toBe(true);
  });

  test("a run correlated to one bead is not handed to another unless the caller rebinds it", () => {
    const dir = checkout();
    const first = init(dir);
    if (!first.ok) throw new Error(first.error);

    const refused = init(dir, { beadsIssueId: "bead-2" });
    expect(refused).toMatchObject({
      ok: false,
      error: "run run-1 is already correlated to bead-1",
    });
    const kept = loadRunCorrelation(first.path, dir);
    expect(kept.ok && String(kept.value.beadsIssueId)).toBe("bead-1");

    const rebound = init(dir, { beadsIssueId: "bead-2", rebind: true });
    expect(rebound.ok && String(rebound.correlation.beadsIssueId)).toBe(
      "bead-2",
    );
    const now = loadRunCorrelation(first.path, dir);
    expect(now.ok && String(now.value.beadsIssueId)).toBe("bead-2");
  });

  test("refuses hostile ids and writes nothing", () => {
    const dir = checkout();
    for (const over of [
      { beadsIssueId: "--json" },
      { beadsIssueId: "a; echo pwned" },
      { executionRunId: "../../outside" },
      { executionRunId: "a/b" },
    ]) {
      expect(init(dir, over).ok).toBe(false);
    }
    expect(existsSync(join(dir, ".tmp"))).toBe(false);
  });
});

describe("loadRunCorrelation (what the gate accepts through a pointer)", () => {
  test("a pointer relative to the checkout is resolved against it", () => {
    const dir = checkout();
    const made = init(dir);
    const loaded = loadRunCorrelation(
      `${RUN_CORRELATIONS_DIR}/run-1.json`,
      dir,
    );
    expect(loaded.ok && made.ok && loaded.path === made.path).toBe(true);
  });

  test("a missing file, a directory and an empty pointer are refused", () => {
    const dir = checkout();
    init(dir);
    expect(
      loadRunCorrelation(join(dir, RUN_CORRELATIONS_DIR, "nope.json"), dir),
    ).toEqual({ ok: false, error: "the pointer names no readable file" });
    expect(loadRunCorrelation(join(dir, RUN_CORRELATIONS_DIR), dir)).toEqual({
      ok: false,
      error: "the pointer does not name a file",
    });
    expect(loadRunCorrelation("   ", dir)).toEqual({
      ok: false,
      error: "the pointer is empty",
    });
  });

  test("a well-formed file outside the checkout is refused without being trusted", () => {
    const dir = checkout();
    const outside = join(dirname(dir), "elsewhere", "run-1.json");
    plant(outside, { checkout: resolveCheckout(dir).worktree });
    const loaded = loadRunCorrelation(outside, dir);
    expect(loaded.ok).toBe(false);
    expect(!loaded.ok && loaded.error).toContain("outside");
  });

  test("a file inside the checkout but not in the correlations directory is refused", () => {
    const dir = checkout();
    const stray = join(dir, "docs", "run-1.json");
    plant(stray, { checkout: resolveCheckout(dir).worktree });
    const loaded = loadRunCorrelation(stray, dir);
    expect(loaded.ok).toBe(false);
    expect(!loaded.ok && loaded.error).toContain(RUN_CORRELATIONS_DIR);
  });

  test("a file whose name is not the run id it holds is refused", () => {
    const dir = checkout();
    const renamed = join(dir, RUN_CORRELATIONS_DIR, "run-2.json");
    plant(renamed, { checkout: resolveCheckout(dir).worktree });
    const loaded = loadRunCorrelation(renamed, dir);
    expect(loaded.ok).toBe(false);
    expect(!loaded.ok && loaded.error).toContain("run-1");
  });

  test("a correlation copied in from another checkout is refused", () => {
    const here = checkout("here");
    const there = checkout("there");
    const made = init(there);
    if (!made.ok) throw new Error(made.error);
    const copied = join(here, RUN_CORRELATIONS_DIR, "run-1.json");
    mkdirSync(dirname(copied), { recursive: true });
    writeFileSync(copied, readFileSync(made.path));
    const loaded = loadRunCorrelation(copied, here);
    expect(loaded.ok).toBe(false);
    expect(!loaded.ok && loaded.error).toContain("checkout");
  });

  test("a correlations directory that is a link to somewhere outside is refused", () => {
    const dir = checkout();
    const outside = join(dirname(dir), "linked target");
    plant(join(outside, "run-1.json"), {
      checkout: resolveCheckout(dir).worktree,
    });
    mkdirSync(join(dir, ".tmp", "work"), { recursive: true });
    symlinkSync(outside, join(dir, RUN_CORRELATIONS_DIR), "junction");
    const loaded = loadRunCorrelation(
      join(dir, RUN_CORRELATIONS_DIR, "run-1.json"),
      dir,
    );
    expect(loaded.ok).toBe(false);
    expect(!loaded.ok && loaded.error).toContain("outside");
  });

  test("malformed and oversized files are refused by name", () => {
    const dir = checkout();
    const file = join(dir, RUN_CORRELATIONS_DIR, "run-1.json");
    mkdirSync(dirname(file), { recursive: true });

    writeFileSync(file, "{ not json");
    const malformed = loadRunCorrelation(file, dir);
    expect(!malformed.ok && malformed.error).toContain("not valid JSON");

    writeFileSync(file, `{"pad":"${"x".repeat(20_000)}"}`);
    const huge = loadRunCorrelation(file, dir);
    expect(!huge.ok && huge.error).toContain("larger than");
  });
});

describe("where a correlation may be written", () => {
  test("a directory that does not exist is refused, and nothing is created", () => {
    const dir = checkout();
    const missing = join(dir, "no", "such", "dir");
    expect(init(missing)).toEqual({
      ok: false,
      error: "the checkout directory does not exist",
    });
    expect(existsSync(join(dir, "no"))).toBe(false);
    expect(existsSync(join(dir, ".tmp"))).toBe(false);
  });

  test("a directory named as the checkout must be its top level: a directory inside one is refused", () => {
    const dir = checkout();
    const inside = join(dir, "packages", "app");
    mkdirSync(inside, { recursive: true });

    expect(init(inside, { topLevel: true })).toEqual({
      ok: false,
      error: "the directory is not the top level of a checkout",
    });
    // Nothing was written in the checkout it happens to sit in.
    expect(existsSync(join(dir, ".tmp"))).toBe(false);
    expect(existsSync(join(inside, ".tmp"))).toBe(false);

    // Without that demand, a directory inside a checkout stands for the checkout.
    const made = init(inside);
    expect(made.ok && made.correlation.checkout).toBe(
      resolveCheckout(dir).worktree,
    );
    expect(init(dir, { executionRunId: "run-2", topLevel: true }).ok).toBe(
      true,
    );
  });

  test("a refusal because the run is correlated elsewhere says which correlation holds it", () => {
    const dir = checkout();
    init(dir);
    const refused = init(dir, { beadsIssueId: "bead-2" });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && String(refused.held?.beadsIssueId)).toBe("bead-1");
    // Any other refusal names no holder.
    const invalid = init(dir, { beadsIssueId: "bad id!" });
    expect(!invalid.ok && invalid.held).toBeUndefined();
  });
});

describe("correlateRun (what a launcher that keeps run state calls)", () => {
  const run = (dir: string, over: Record<string, unknown> = {}) =>
    correlateRun({ checkout: dir, executionRunId: "run-1", ...over });

  test("reports the pointer, the two ids and the checkout the pointer is relative to", () => {
    const dir = checkout();
    expect(run(dir, { named: "bead-1" })).toEqual({
      correlation: {
        pointer: `${RUN_CORRELATIONS_DIR}/run-1.json`,
        beadsIssueId: "bead-1",
        executionRunId: "run-1",
        checkout: resolveCheckout(dir).worktree,
      },
    });
  });

  test("a run that names no bead gets none, and no note", () => {
    const dir = checkout();
    expect(run(dir)).toEqual({ correlation: null });
    expect(existsSync(join(dir, ".tmp"))).toBe(false);
  });

  test("a stored bead creates a correlation and never replaces one; a named bead rebinds", () => {
    const dir = checkout();
    expect(run(dir, { stored: "bead-1" }).correlation?.beadsIssueId).toBe(
      "bead-1",
    );
    init(dir, { beadsIssueId: "task-9", rebind: true });
    const kept = run(dir, { stored: "bead-1" });
    expect(kept).toMatchObject({ correlation: { beadsIssueId: "task-9" } });
    expect("note" in kept).toBe(false);
    expect(run(dir, { named: "bead-2" }).correlation?.beadsIssueId).toBe(
      "bead-2",
    );
  });

  test("a named bead that is not a Beads id is reported, beside what the run's file still holds", () => {
    const dir = checkout();
    run(dir, { named: "bead-1" });
    expect(run(dir, { named: "bad id!", stored: "bad id!" })).toMatchObject({
      correlation: { beadsIssueId: "bead-1" },
      note: "run correlation not written: beadsIssueId must be a Beads issue id",
    });
  });

  test("a checkout that cannot hold one is reported and nothing is looked up or written", () => {
    const dir = checkout();
    const inside = join(dir, "sub");
    mkdirSync(inside);
    init(dir);
    expect(run(inside, { named: "bead-1", topLevel: true })).toEqual({
      correlation: null,
      note: "run correlation not written: the directory is not the top level of a checkout",
    });
  });
});

describe("the writer and a linked correlations directory", () => {
  /** A checkout whose correlations directory (or a parent of it) links outside. */
  function linked(at: string): { dir: string; outside: string } {
    const dir = checkout();
    const outside = join(dirname(dir), "linked target");
    mkdirSync(outside, { recursive: true });
    const link = join(dir, at);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(outside, link, "junction");
    return { dir, outside };
  }

  test("a link elsewhere inside the same checkout is refused too", () => {
    const dir = checkout();
    const inner = join(dir, "elsewhere");
    mkdirSync(inner);
    mkdirSync(join(dir, ".tmp", "work"), { recursive: true });
    symlinkSync(inner, join(dir, RUN_CORRELATIONS_DIR), "junction");
    expect(init(dir).ok).toBe(false);
    expect(readdirSync(inner)).toEqual([]);
  });

  test("a correlations directory that links outside the checkout is not written through", () => {
    for (const at of [RUN_CORRELATIONS_DIR, ".tmp/work", ".tmp"]) {
      const { dir, outside } = linked(at);
      expect(init(dir)).toEqual({
        ok: false,
        error: `${RUN_CORRELATIONS_DIR} is, or sits under, a link: a correlation is only written in the checkout's own directory`,
      });
      // Nothing was written at the link's target, at any depth.
      expect(
        readdirSync(outside, { recursive: true }).filter((entry) =>
          String(entry).endsWith(".json"),
        ),
      ).toEqual([]);
    }
  });

  test("a file already sitting behind such a link is neither reported as holding the run nor overwritten", () => {
    const { dir, outside } = linked(RUN_CORRELATIONS_DIR);
    const planted = join(outside, "run-1.json");
    plant(planted, { checkout: resolveCheckout(dir).worktree });
    const before = readFileSync(planted, "utf8");

    const refused = init(dir, { beadsIssueId: "bead-2", rebind: true });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.held).toBeUndefined();
    expect(readFileSync(planted, "utf8")).toBe(before);
  });
});
