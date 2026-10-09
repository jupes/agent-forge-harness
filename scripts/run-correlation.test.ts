import { describe, expect, test } from "bun:test";
import {
  correlationPointer,
  createRunCorrelation,
  parseBeadsIssueId,
  parseRunCorrelation,
  RUN_CORRELATIONS_DIR,
  runCorrelationPath,
} from "./run-correlation";

const CHECKOUT = "C:/work/harness/trees/dg40";
const NOW = () => "2026-10-08T12:00:00.000Z";

const BASE = {
  executionRunId: "agent-forge-harness-dg40",
  beadsIssueId: "agent-forge-harness-dg40.9",
  checkout: CHECKOUT,
  now: NOW,
};

describe("parseBeadsIssueId", () => {
  test("accepts the ids Beads mints, child ids included", () => {
    expect(String(parseBeadsIssueId("agent-forge-harness-0xxt"))).toBe(
      "agent-forge-harness-0xxt",
    );
    expect(String(parseBeadsIssueId("  x1gs.2.4 "))).toBe("x1gs.2.4");
  });

  test("rejects anything bd could read as a flag, a path or a second argument", () => {
    for (const hostile of [
      "",
      "   ",
      "--json",
      "-C",
      "a b",
      "a;rm -rf .",
      "a&&b",
      "$(whoami)",
      "`id`",
      "a|b",
      "../../etc/passwd",
      "a/b",
      "a\\b",
      "a\nb",
      'a"b',
      "x".repeat(200),
      42,
      null,
      undefined,
      { id: "a" },
    ]) {
      expect(parseBeadsIssueId(hostile)).toBeNull();
    }
  });
});

describe("createRunCorrelation", () => {
  test("builds a version 1 correlation from a run id, a bead and a checkout", () => {
    expect<unknown>(createRunCorrelation(BASE)).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        executionRunId: "agent-forge-harness-dg40",
        beadsIssueId: "agent-forge-harness-dg40.9",
        checkout: "c:/work/harness/trees/dg40",
        createdAt: "2026-10-08T12:00:00.000Z",
      },
    });
  });

  test("normalizes the ids and the checkout it is given", () => {
    const made = createRunCorrelation({
      ...BASE,
      executionRunId: " agent-forge-harness-dg40 ",
      beadsIssueId: " agent-forge-harness-dg40.9\n",
      checkout: "C:\\work\\harness\\trees\\dg40\\",
    });
    expect(made.ok && made.value.executionRunId).toBe(
      "agent-forge-harness-dg40",
    );
    expect(made.ok && String(made.value.beadsIssueId)).toBe(
      "agent-forge-harness-dg40.9",
    );
    expect(made.ok && made.value.checkout).toBe("c:/work/harness/trees/dg40");
  });

  test("refuses a run id that could not name a run's state file", () => {
    for (const executionRunId of ["", "../escape", "a/b", "a b", "-flag"]) {
      const made = createRunCorrelation({ ...BASE, executionRunId });
      expect(made.ok).toBe(false);
      expect(!made.ok && made.error).toContain("executionRunId");
    }
  });

  test("refuses a bead id that is not a Beads id, and an empty checkout", () => {
    const bead = createRunCorrelation({ ...BASE, beadsIssueId: "--json" });
    expect(!bead.ok && bead.error).toContain("beadsIssueId");
    const checkout = createRunCorrelation({ ...BASE, checkout: "  " });
    expect(!checkout.ok && checkout.error).toContain("checkout");
  });
});

describe("parseRunCorrelation", () => {
  const stored = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      schemaVersion: 1,
      executionRunId: "agent-forge-harness-dg40",
      beadsIssueId: "agent-forge-harness-dg40.9",
      checkout: "c:/work/harness/trees/dg40",
      createdAt: "2026-10-08T12:00:00.000Z",
      ...over,
    });

  test("reads back what createRunCorrelation wrote", () => {
    const made = createRunCorrelation(BASE);
    if (!made.ok) throw new Error(made.error);
    expect(parseRunCorrelation(JSON.stringify(made.value))).toEqual(made);
  });

  test("names the field that is wrong", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ schemaVersion: 2 }, "schemaVersion"],
      [{ schemaVersion: undefined }, "schemaVersion"],
      [{ executionRunId: "../x" }, "executionRunId"],
      [{ executionRunId: 7 }, "executionRunId"],
      [{ beadsIssueId: "a;b" }, "beadsIssueId"],
      [{ beadsIssueId: undefined }, "beadsIssueId"],
      [{ checkout: "" }, "checkout"],
      [{ createdAt: "yesterday" }, "createdAt"],
    ];
    for (const [over, field] of cases) {
      const read = parseRunCorrelation(stored(over));
      expect(read.ok).toBe(false);
      expect(!read.ok && read.error).toContain(field);
    }
  });

  test("says so when the text is not JSON, or is JSON but not an object", () => {
    for (const text of ["", "not json", "{"]) {
      expect(parseRunCorrelation(text)).toEqual({
        ok: false,
        error: "not valid JSON",
      });
    }
    for (const text of ["[]", "null", '"x"', "7"]) {
      expect(parseRunCorrelation(text)).toEqual({
        ok: false,
        error: "root must be an object",
      });
    }
  });

  test("carries only the fields of the contract, whatever else the file holds", () => {
    const read = parseRunCorrelation(
      stored({ hostTaskId: "7", taskId: "host-task", extra: { deep: true } }),
    );
    expect(read.ok && Object.keys(read.value).sort()).toEqual([
      "beadsIssueId",
      "checkout",
      "createdAt",
      "executionRunId",
      "schemaVersion",
    ]);
  });
});

describe("runCorrelationPath", () => {
  test("is one file per run, under the gitignored work directory", () => {
    expect(RUN_CORRELATIONS_DIR).toBe(".tmp/work/run-correlations");
    expect(runCorrelationPath("agent-forge-harness-dg40")).toBe(
      ".tmp/work/run-correlations/agent-forge-harness-dg40.json",
    );
  });

  test("has no path for an id that is not a run id", () => {
    expect(runCorrelationPath("../escape")).toBeNull();
    expect(runCorrelationPath("a/b")).toBeNull();
  });
});

describe("correlationPointer", () => {
  const ENV = { AGENT_FORGE_RUN_CORRELATION: "from/env.json" };

  test("is the --correlation flag in either spelling, else the environment variable", () => {
    expect(correlationPointer(["--correlation", "a/b.json"], {})).toEqual({
      path: "a/b.json",
      source: "flag",
    });
    expect(
      correlationPointer(["TaskCompleted", "--correlation=c.json"], {}),
    ).toEqual({
      path: "c.json",
      source: "flag",
    });
    expect(correlationPointer([], ENV)).toEqual({
      path: "from/env.json",
      source: "env",
    });
  });

  test("the flag wins over the environment", () => {
    expect(correlationPointer(["--correlation", "flag.json"], ENV)).toEqual({
      path: "flag.json",
      source: "flag",
    });
  });

  test("is null when nothing points anywhere", () => {
    expect(correlationPointer([], {})).toBeNull();
    expect(
      correlationPointer([], { AGENT_FORGE_RUN_CORRELATION: "  " }),
    ).toBeNull();
    expect(
      correlationPointer(["TeammateIdle"], { CLAUDE_TASK_ID: "x.json" }),
    ).toBeNull();
  });

  test("a flag given without a path is an empty pointer, not a fall back to the environment", () => {
    expect(correlationPointer(["--correlation"], ENV)).toEqual({
      path: "",
      source: "flag",
    });
    expect(correlationPointer(["--correlation="], ENV)).toEqual({
      path: "",
      source: "flag",
    });
  });
});

describe("correlationPointer and stray whitespace", () => {
  test("a pointer is trimmed, wherever it came from", () => {
    expect(correlationPointer(["--correlation", " a/b.json\n"], {})).toEqual({
      path: "a/b.json",
      source: "flag",
    });
    expect(
      correlationPointer([], { AGENT_FORGE_RUN_CORRELATION: "\tc.json \r\n" }),
    ).toEqual({ path: "c.json", source: "env" });
  });
});
