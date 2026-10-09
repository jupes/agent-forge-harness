/**
 * The evaluator verdict on disk: where a run's verdict lives, written once and
 * read once. Real files in a scratch checkout; the racing writers are real
 * processes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
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
import {
  EVALUATIONS_DIR,
  evaluationDir,
  evaluatorVerdictPath,
  MAX_VERDICT_BYTES,
  readVerdictOnce,
  reviewVerdictFile,
  writeVerdictOnce,
} from "./eval-verdict-store";
import { resolveCheckout } from "./ledger/workspace";

const STORE = join(import.meta.dir, "eval-verdict-store.ts");

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A scratch checkout (a directory with `.git`) under a path with a space, and a directory beside it. */
function sandbox(): { checkout: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), "verdict store test "));
  temporary.push(root);
  const checkout = join(root, "check out");
  const outside = join(root, "outside");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { checkout, outside };
}

const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

/** A schema 2 verdict's bytes for `run`: the only content the writer files. */
function body(run: string, summary?: string): string {
  return `${JSON.stringify({
    schemaVersion: 2,
    beadsIssueId: "bead-1",
    executionRunId: run,
    verdict: "PASS",
    findings: { blocker: 0, high: 0, medium: 0, low: 0 },
    ...(summary !== undefined ? { summary } : {}),
    evaluator: { kind: "human", actorKind: "reviewer" },
  })}\n`;
}

const BODY = body("run-1");

describe("evaluatorVerdictPath", () => {
  test("is .tmp/work/evaluations/<sha256 of the run id>/verdict.json", () => {
    expect(evaluatorVerdictPath("run-1")).toBe(
      `.tmp/work/evaluations/${sha256("run-1")}/verdict.json`,
    );
    expect(evaluationDir("run-1")).toBe(
      `${EVALUATIONS_DIR}/${sha256("run-1")}`,
    );
  });

  test("run ids that differ only in case, as on a case-insensitive disk, have different paths", () => {
    expect(evaluatorVerdictPath("Run-1")).not.toBe(
      evaluatorVerdictPath("run-1"),
    );
  });

  test("an id that cannot name a run has no path", () => {
    for (const id of ["", "../run-1", "a/b", "a\\b", "run 1", ".."]) {
      expect(evaluatorVerdictPath(id)).toBeNull();
      expect(evaluationDir(id)).toBeNull();
    }
  });
});

describe("writeVerdictOnce", () => {
  test("creates the run's verdict at its declared path and reports the bytes it wrote", () => {
    const { checkout } = sandbox();
    const wrote = writeVerdictOnce({
      checkout,
      executionRunId: "run-1",
      content: BODY,
    });
    expect(wrote).toEqual({
      ok: true,
      path: evaluatorVerdictPath("run-1") ?? "",
      sha256: sha256(BODY),
      bytes: Buffer.byteLength(BODY),
    });
    expect(
      readFileSync(join(checkout, evaluatorVerdictPath("run-1") ?? ""), "utf8"),
    ).toBe(BODY);
  });

  test("a second write for the same run fails, says so, and leaves the first file as it was", () => {
    const { checkout } = sandbox();
    writeVerdictOnce({ checkout, executionRunId: "run-1", content: BODY });
    const again = writeVerdictOnce({
      checkout,
      executionRunId: "run-1",
      content: body("run-1", "a second opinion"),
    });
    expect(again).toEqual({
      ok: false,
      exists: true,
      error: `a verdict already exists at ${evaluatorVerdictPath("run-1")}: it is written once and never replaced`,
    });
    expect(
      readFileSync(join(checkout, evaluatorVerdictPath("run-1") ?? ""), "utf8"),
    ).toBe(BODY);
  });

  test("two runs of one bead, and the review rounds of one run, each have a file of their own", () => {
    const { checkout } = sandbox();
    const first = writeVerdictOnce({
      checkout,
      executionRunId: "run-1",
      content: BODY,
    });
    const retried = writeVerdictOnce({
      checkout,
      executionRunId: "run-2",
      content: body("run-2"),
    });
    const round = writeVerdictOnce({
      checkout,
      executionRunId: "run-1",
      file: reviewVerdictFile("plan-2") ?? "",
      content: BODY,
    });
    expect([first.ok, retried.ok, round.ok]).toEqual([true, true, true]);
    if (first.ok && retried.ok && round.ok) {
      expect(retried.path).not.toBe(first.path);
      expect(round.path).toBe(`${evaluationDir("run-1")}/review-plan-2.json`);
    }
    // A round is written once too.
    expect(
      writeVerdictOnce({
        checkout,
        executionRunId: "run-1",
        file: reviewVerdictFile("plan-2") ?? "",
        content: BODY,
      }),
    ).toMatchObject({ ok: false, exists: true });
  });

  test("of several writers racing for one run, exactly one creates the file", async () => {
    const { checkout } = sandbox();
    const script = `
      import { writeVerdictOnce } from ${JSON.stringify(STORE)};
      const wrote = writeVerdictOnce({
        checkout: ${JSON.stringify(checkout)},
        executionRunId: "run-1",
        content: JSON.stringify({
          schemaVersion: 2,
          beadsIssueId: "bead-1",
          executionRunId: "run-1",
          verdict: "PASS",
          findings: { blocker: 0, high: 0, medium: 0, low: 0 },
          summary: process.argv[2],
          evaluator: { kind: "human", actorKind: "reviewer" },
        }),
      });
      console.log(JSON.stringify({ writer: process.argv[2], ...wrote }));
    `;
    const racer = join(dirname(checkout), "racer.ts");
    writeFileSync(racer, script);
    const results = await Promise.all(
      ["a", "b", "c", "d", "e", "f"].map(async (writer) => {
        const child = Bun.spawn([process.execPath, "run", racer, writer], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = await new Response(child.stdout).text();
        await child.exited;
        return JSON.parse(out) as {
          writer: string;
          ok: boolean;
          exists?: boolean;
        };
      }),
    );
    const winners = results.filter((result) => result.ok);
    expect(winners).toHaveLength(1);
    expect(results.filter((result) => result.exists === true)).toHaveLength(5);
    // The file holds the winner's bytes, whole, and nothing else is left behind.
    expect(
      JSON.parse(
        readFileSync(
          join(checkout, evaluatorVerdictPath("run-1") ?? ""),
          "utf8",
        ),
      ).summary,
    ).toBe(winners[0]?.writer);
    expect(readdirSync(join(checkout, evaluationDir("run-1") ?? ""))).toEqual([
      "verdict.json",
    ]);
  }, 60_000);

  test("refuses when the evaluations directory, or anything above or below it, is a link", () => {
    const linkedMessage = `${EVALUATIONS_DIR} is, or sits under or holds, a link: a verdict is only written in the checkout's own directory`;

    // The evaluations directory leads outside the checkout.
    const escaping = sandbox();
    mkdirSync(join(escaping.checkout, ".tmp", "work"), { recursive: true });
    symlinkSync(
      escaping.outside,
      join(escaping.checkout, EVALUATIONS_DIR),
      "junction",
    );
    expect(
      writeVerdictOnce({
        checkout: escaping.checkout,
        executionRunId: "run-1",
        content: BODY,
      }),
    ).toEqual({ ok: false, error: linkedMessage });
    expect(existsSync(join(escaping.outside, sha256("run-1")))).toBe(false);

    // A parent of it is a link.
    const parent = sandbox();
    symlinkSync(parent.outside, join(parent.checkout, ".tmp"), "junction");
    expect(
      writeVerdictOnce({
        checkout: parent.checkout,
        executionRunId: "run-1",
        content: BODY,
      }),
    ).toEqual({ ok: false, error: linkedMessage });
    expect(existsSync(join(parent.outside, "work"))).toBe(false);

    // The run's own directory is a link to another run's, inside the checkout.
    const inner = sandbox();
    writeVerdictOnce({
      checkout: inner.checkout,
      executionRunId: "run-0",
      content: body("run-0"),
    });
    symlinkSync(
      join(inner.checkout, evaluationDir("run-0") ?? ""),
      join(inner.checkout, evaluationDir("run-1") ?? ""),
      "junction",
    );
    expect(
      writeVerdictOnce({
        checkout: inner.checkout,
        executionRunId: "run-1",
        file: reviewVerdictFile("plan-1") ?? "",
        content: BODY,
      }),
    ).toEqual({ ok: false, error: linkedMessage });
  });

  test("refuses content over the size the reader accepts, and a file name it does not manage", () => {
    const { checkout } = sandbox();
    expect(
      writeVerdictOnce({
        checkout,
        executionRunId: "run-1",
        content: "x".repeat(MAX_VERDICT_BYTES + 1),
      }),
    ).toEqual({
      ok: false,
      error: `the verdict is larger than ${MAX_VERDICT_BYTES} bytes`,
    });
    for (const file of [
      "../verdict.json",
      "notes.txt",
      "review-.json",
      "review-A.json",
      "sub/verdict.json",
      "",
    ]) {
      expect(
        writeVerdictOnce({
          checkout,
          executionRunId: "run-1",
          file,
          content: BODY,
        }),
      ).toEqual({
        ok: false,
        error: "the file is not a verdict file of an evaluation directory",
      });
    }
    expect(existsSync(join(checkout, ".tmp"))).toBe(false);
    expect(
      writeVerdictOnce({
        checkout,
        executionRunId: "../run-1",
        content: BODY,
      }),
    ).toEqual({ ok: false, error: "executionRunId must be a Forge run id" });
  });

  test("files only a schema 2 verdict for that run, and anything else leaves the run's place free", () => {
    const { checkout } = sandbox();
    const cases: Array<[string, string]> = [
      ["", "invalid JSON"],
      ["   \n", "invalid JSON"],
      ["not json at all", "invalid JSON"],
      [
        JSON.stringify({
          schemaVersion: 1,
          taskId: "bead-1",
          verdict: "PASS",
          findings: { blocker: 0, high: 0, medium: 0, low: 0 },
        }),
        "the verdict is schema 1 (legacy): it names no run and no evaluator",
      ],
      [
        body("some-other-run"),
        'verdict executionRunId "some-other-run" is not this run ("run-1")',
      ],
    ];
    for (const [content, reason] of cases) {
      expect(
        writeVerdictOnce({ checkout, executionRunId: "run-1", content }),
      ).toEqual({
        ok: false,
        error: `the content is not a schema 2 verdict for this run: ${reason}`,
      });
    }
    expect(existsSync(join(checkout, ".tmp"))).toBe(false);
    // The run's one place is still free for its verdict.
    expect(
      writeVerdictOnce({ checkout, executionRunId: "run-1", content: BODY }).ok,
    ).toBe(true);
  });

  test("the file is whole or absent: what a killed writer leaves behind does not block the run", () => {
    const { checkout } = sandbox();
    const dir = join(checkout, evaluationDir("run-1") ?? "");
    mkdirSync(dir, { recursive: true });
    // Half a verdict in a writer's scratch file, as a kill mid-write leaves it.
    writeFileSync(join(dir, ".verdict.json.4242.tmp"), BODY.slice(0, 40));

    const wrote = writeVerdictOnce({
      checkout,
      executionRunId: "run-1",
      content: BODY,
    });
    expect(wrote.ok).toBe(true);
    expect(readFileSync(join(dir, "verdict.json"), "utf8")).toBe(BODY);
    // This call's own scratch file is gone; the stranger's is not its to remove.
    expect(readdirSync(dir).sort()).toEqual([
      ".verdict.json.4242.tmp",
      "verdict.json",
    ]);
  });

  test("says what is in the way when it is not a verdict", () => {
    // A directory where the verdict file goes.
    const blocked = sandbox();
    const place = join(blocked.checkout, evaluatorVerdictPath("run-1") ?? "");
    mkdirSync(place, { recursive: true });
    expect(
      writeVerdictOnce({
        checkout: blocked.checkout,
        executionRunId: "run-1",
        content: BODY,
      }),
    ).toEqual({
      ok: false,
      error: `${evaluatorVerdictPath("run-1")} is in the way and is not a regular file`,
    });

    // A file where the run's directory goes.
    const flat = sandbox();
    mkdirSync(join(flat.checkout, EVALUATIONS_DIR), { recursive: true });
    writeFileSync(join(flat.checkout, evaluationDir("run-1") ?? ""), "x");
    const wrote = writeVerdictOnce({
      checkout: flat.checkout,
      executionRunId: "run-1",
      content: BODY,
    });
    expect(wrote.ok).toBe(false);
    if (!wrote.ok) {
      expect(wrote.error).toStartWith(
        `could not create ${evaluationDir("run-1")}:`,
      );
      expect("exists" in wrote).toBe(false);
    }
  });

  test("writes only at the top level of a checkout it is given: not a directory that is missing, not one inside it", () => {
    const { checkout } = sandbox();
    expect(
      writeVerdictOnce({
        checkout: join(checkout, "nowhere"),
        executionRunId: "run-1",
        content: BODY,
      }),
    ).toEqual({ ok: false, error: "the checkout directory does not exist" });

    const nested = join(checkout, "packages", "app");
    mkdirSync(nested, { recursive: true });
    expect(
      writeVerdictOnce({
        checkout: nested,
        executionRunId: "run-1",
        content: BODY,
      }),
    ).toEqual({
      ok: false,
      error: "the directory is not the top level of a checkout",
    });
    // Nothing went to the enclosing checkout either.
    expect(existsSync(join(checkout, ".tmp"))).toBe(false);
    expect(existsSync(join(nested, ".tmp"))).toBe(false);
  });

  test("the review file of a label, and nothing for a label that is not one", () => {
    expect(reviewVerdictFile("plan-2")).toBe("review-plan-2.json");
    for (const label of ["", "Plan", "a/b", "..", "-x", "x".repeat(41)]) {
      expect(reviewVerdictFile(label)).toBeNull();
    }
  });
});

describe("readVerdictOnce", () => {
  test("returns the bytes at the run's declared path with their SHA-256 and length", () => {
    const { checkout } = sandbox();
    writeVerdictOnce({ checkout, executionRunId: "run-1", content: BODY });
    const read = readVerdictOnce({ checkout, executionRunId: "run-1" });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.path).toBe(evaluatorVerdictPath("run-1") ?? "");
      expect(read.buffer.toString("utf8")).toBe(BODY);
      expect(read.sha256).toBe(sha256(BODY));
      expect(read.bytes).toBe(Buffer.byteLength(BODY));
    }
  });

  test("a run with no verdict is reported as missing, even when another run of the bead has one", () => {
    const { checkout } = sandbox();
    writeVerdictOnce({ checkout, executionRunId: "run-1", content: BODY });
    expect(readVerdictOnce({ checkout, executionRunId: "run-2" })).toEqual({
      ok: false,
      missing: true,
      error: `no evaluator verdict at ${evaluatorVerdictPath("run-2")}`,
    });
  });

  test("refuses a path that is, or sits under, a link, wherever the link leads", () => {
    const linked = (run: string) => ({
      ok: false,
      error: `${evaluatorVerdictPath(run)} is, or sits under, a link: a verdict is only read from the checkout's own directory`,
    });

    // The evaluations directory is a link to a directory outside the checkout
    // that holds a perfectly good verdict at the same relative place.
    const escaping = sandbox();
    const planted = join(escaping.outside, sha256("run-1"), "verdict.json");
    mkdirSync(dirname(planted), { recursive: true });
    writeFileSync(planted, BODY);
    mkdirSync(join(escaping.checkout, ".tmp", "work"), { recursive: true });
    symlinkSync(
      escaping.outside,
      join(escaping.checkout, EVALUATIONS_DIR),
      "junction",
    );
    expect<unknown>(
      readVerdictOnce({ checkout: escaping.checkout, executionRunId: "run-1" }),
    ).toEqual(linked("run-1"));

    // The run's directory is a link to another run's, inside the checkout.
    const inner = sandbox();
    writeVerdictOnce({
      checkout: inner.checkout,
      executionRunId: "run-0",
      content: body("run-0"),
    });
    symlinkSync(
      join(inner.checkout, evaluationDir("run-0") ?? ""),
      join(inner.checkout, evaluationDir("run-1") ?? ""),
      "junction",
    );
    expect<unknown>(
      readVerdictOnce({ checkout: inner.checkout, executionRunId: "run-1" }),
    ).toEqual(linked("run-1"));

    // The file itself is a link to another file. Creating one needs a
    // privilege a Windows account may not have: then this case is not run.
    const file = sandbox();
    writeVerdictOnce({
      checkout: file.checkout,
      executionRunId: "run-0",
      content: body("run-0"),
    });
    const target = join(file.checkout, evaluatorVerdictPath("run-0") ?? "");
    const link = join(file.checkout, evaluatorVerdictPath("run-1") ?? "");
    mkdirSync(dirname(link), { recursive: true });
    let made = true;
    try {
      symlinkSync(target, link, "file");
    } catch {
      made = false;
    }
    if (made) {
      expect<unknown>(
        readVerdictOnce({ checkout: file.checkout, executionRunId: "run-1" }),
      ).toEqual(linked("run-1"));
    }
  });

  test("refuses a file over the size bound, and a directory where the file should be", () => {
    const { checkout } = sandbox();
    const path = join(checkout, evaluatorVerdictPath("run-1") ?? "");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "x".repeat(MAX_VERDICT_BYTES + 1));
    expect<unknown>(
      readVerdictOnce({ checkout, executionRunId: "run-1" }),
    ).toEqual({
      ok: false,
      error: `${evaluatorVerdictPath("run-1")} is larger than ${MAX_VERDICT_BYTES} bytes`,
    });

    const other = join(checkout, evaluatorVerdictPath("run-2") ?? "");
    mkdirSync(other, { recursive: true });
    expect<unknown>(
      readVerdictOnce({ checkout, executionRunId: "run-2" }),
    ).toEqual({
      ok: false,
      error: `${evaluatorVerdictPath("run-2")} is not a regular file`,
    });
  });

  test("reads from the checkout it is given, found from any directory inside it", () => {
    const { checkout } = sandbox();
    writeVerdictOnce({ checkout, executionRunId: "run-1", content: BODY });
    const nested = join(checkout, "scripts", "deep");
    mkdirSync(nested, { recursive: true });
    expect(resolveCheckout(nested).worktree).toBe(
      resolveCheckout(checkout).worktree,
    );
    expect(
      readVerdictOnce({ checkout: nested, executionRunId: "run-1" }).ok,
    ).toBe(true);
  });
});
