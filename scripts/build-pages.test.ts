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
import { join } from "node:path";
import type { BeadsPayload } from "../types/beads";
import type { BdRunner } from "./beads/live-tracker";
import { buildPages } from "./build-pages";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** A checkout with an optional `.beads/issues.jsonl` holding these rows. */
function checkout(fileRows?: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "af-build-pages-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".beads"));
  if (fileRows) {
    writeFileSync(
      join(dir, ".beads", "issues.jsonl"),
      `${fileRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
  }
  return dir;
}

/** Stands in for `bd`: records every call; never the real tracker. */
function fakeBd(answer: (args: string[]) => string | Error): {
  run: BdRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args) => {
      calls.push(args);
      const out = answer(args);
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

/** One `bd export` line, in the shape bd 1.1 prints (comments embedded). */
function exportRow(
  id: string,
  comments: { text: string; created_at: string }[] = [],
  extra: object = {},
): object {
  return {
    _type: "issue",
    id,
    title: `title of ${id}`,
    status: "open",
    priority: 2,
    issue_type: "bug",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-02T00:00:00Z",
    comment_count: comments.length,
    comments: comments.map((c, i) => ({
      id: `${id}-c${i}`,
      issue_id: id,
      author: "jupes",
      text: c.text,
      created_at: c.created_at,
    })),
    ...extra,
  };
}

const jsonl = (rows: object[]): string =>
  `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

const quiet = { log: () => {}, warn: () => {} };

function written(cwd: string): BeadsPayload {
  return JSON.parse(
    readFileSync(join(cwd, "docs", "data", "beads.json"), "utf8"),
  ) as BeadsPayload;
}

describe("buildPages: where the snapshot comes from", () => {
  test("when bd answers, the snapshot holds the tracker's issues, not those of an existing .beads/issues.jsonl", async () => {
    const cwd = checkout([exportRow("stale-1")]);
    const bd = fakeBd(() => jsonl([exportRow("live-1"), exportRow("live-2")]));

    const result = await buildPages({ cwd, runBd: bd.run, ...quiet });

    expect(result.ok).toBe(true);
    const payload = written(cwd);
    expect(payload.issues.map((issue) => issue.id)).toEqual([
      "live-1",
      "live-2",
    ]);
    expect(payload.source).toEqual({ kind: "tracker" });
  });

  test("when bd fails, the snapshot is built from .beads/issues.jsonl, normalized, and the payload says it came from the file", async () => {
    const cwd = checkout([
      exportRow(
        "file-1",
        [
          {
            text: "worklog: from the file",
            created_at: "2026-07-01T00:00:00Z",
          },
        ],
        {
          dependencies: [
            { issue_id: "file-1", depends_on_id: "file-0", type: "blocks" },
          ],
        },
      ),
    ]);
    const bd = fakeBd(() => new Error("spawn bd ENOENT"));
    const warnings: string[] = [];

    const result = await buildPages({
      cwd,
      runBd: bd.run,
      log: () => {},
      warn: (line) => warnings.push(line),
    });

    expect(result.ok).toBe(true);
    const payload = written(cwd);
    expect(payload.issues).toHaveLength(1);
    expect(payload.issues[0]).toMatchObject({
      id: "file-1",
      type: "bug",
      priority: "medium",
      createdAt: "2026-10-01T00:00:00Z",
    });
    expect(payload.comments).toEqual([
      {
        issueId: "file-1",
        author: "jupes",
        body: "worklog: from the file",
        createdAt: "2026-07-01T00:00:00Z",
      },
    ]);
    expect(payload.deps).toEqual([
      { from: "file-1", to: "file-0", type: "blocks" },
    ]);
    expect(payload.source?.kind).toBe("file");
    if (payload.source?.kind !== "file") throw new Error("unreachable");
    expect(payload.source.path).toBe(".beads/issues.jsonl");
    expect(payload.source.reason).toContain("spawn bd ENOENT");
    expect(Number.isNaN(Date.parse(payload.source.modifiedAt))).toBe(false);
    expect(warnings.join("\n")).toContain(".beads/issues.jsonl");
  });

  test("bd output with no issue rows in it is not taken as an answer: the file is used", async () => {
    const cwd = checkout([exportRow("file-1")]);
    const bd = fakeBd(() => "database is locked, try again\n");

    const result = await buildPages({ cwd, runBd: bd.run, ...quiet });

    expect(result.ok).toBe(true);
    const payload = written(cwd);
    expect(payload.issues.map((issue) => issue.id)).toEqual(["file-1"]);
    expect(payload.source?.kind).toBe("file");
  });

  test("when bd fails and there is no file, nothing is written and the error names bd's failure", async () => {
    const cwd = checkout();
    const bd = fakeBd(() => new Error("dolt server not running"));

    const result = await buildPages({ cwd, runBd: bd.run, ...quiet });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("dolt server not running");
    expect(existsSync(join(cwd, "docs", "data", "beads.json"))).toBe(false);
  });

  test("records of another kind in the export are not shown as issues", async () => {
    const cwd = checkout();
    const bd = fakeBd(() =>
      jsonl([
        exportRow("c-1"),
        { _type: "memory", id: "m-1", key: "k", value: "v" },
      ]),
    );

    await buildPages({ cwd, runBd: bd.run, ...quiet });

    expect(written(cwd).issues.map((issue) => issue.id)).toEqual(["c-1"]);
  });
});

describe("buildPages: comments", () => {
  test("takes every issue's comments from the one bd export call and runs bd nothing else", async () => {
    const cwd = checkout();
    const bd = fakeBd(() =>
      jsonl([
        exportRow("a-1", [
          { text: "worklog: one", created_at: "2026-10-03T00:00:00Z" },
          { text: "review: two", created_at: "2026-10-04T00:00:00Z" },
        ]),
        exportRow("a-2"),
        exportRow("a-3", [
          { text: "design: three", created_at: "2026-10-05T00:00:00Z" },
        ]),
      ]),
    );

    await buildPages({ cwd, runBd: bd.run, ...quiet });

    expect(bd.calls).toEqual([["export", "--no-memories"]]);
    expect(
      written(cwd).comments.map((c) => [c.issueId, c.body, c.author]),
    ).toEqual([
      ["a-1", "worklog: one", "jupes"],
      ["a-1", "review: two", "jupes"],
      ["a-3", "design: three", "jupes"],
    ]);
  });

  test("an issue whose comment count is higher than the comments the export carries is warned about, not fetched on its own", async () => {
    const cwd = checkout();
    const bd = fakeBd(() =>
      jsonl([
        exportRow("b-1", [], { comment_count: 2, comments: undefined }),
        exportRow("b-2", [
          { text: "worklog: kept", created_at: "2026-10-03T00:00:00Z" },
        ]),
      ]),
    );
    const warnings: string[] = [];

    await buildPages({
      cwd,
      runBd: bd.run,
      log: () => {},
      warn: (line) => warnings.push(line),
    });

    expect(bd.calls).toEqual([["export", "--no-memories"]]);
    expect(written(cwd).comments.map((c) => c.issueId)).toEqual(["b-2"]);
    expect(warnings.join("\n")).toContain("b-1");
  });
});

describe("buildPages: the Repo column", () => {
  const H = "agent-forge-harness";

  test("each issue's repository follows repos/issue-repos.json and the names registered in repos/repos.json", async () => {
    const cwd = checkout();
    mkdirSync(join(cwd, "repos"));
    writeFileSync(
      join(cwd, "repos", "repos.json"),
      JSON.stringify({ repos: [{ name: "my-frontend" }] }),
    );
    writeFileSync(
      join(cwd, "repos", "issue-repos.json"),
      JSON.stringify({ issues: { [`${H}-e10`]: "my-api" } }),
    );
    const bd = fakeBd(() =>
      jsonl([
        exportRow(`${H}-e10`, [], { title: "API epic" }),
        exportRow(`${H}-e10.1`, [], {
          title: "Child",
          dependencies: [
            {
              issue_id: `${H}-e10.1`,
              depends_on_id: `${H}-e10`,
              type: "parent-child",
            },
          ],
        }),
        exportRow(`${H}-a1`, [], { title: "[my-frontend] Login" }),
        exportRow(`${H}-a2`, [], { title: "[dashboard] Harness work" }),
      ]),
    );

    await buildPages({ cwd, runBd: bd.run, ...quiet });

    expect(written(cwd).issues.map((issue) => [issue.id, issue.repo])).toEqual([
      [`${H}-e10`, "my-api"],
      [`${H}-e10.1`, "my-api"],
      [`${H}-a1`, "my-frontend"],
      [`${H}-a2`, H],
    ]);
  });

  test("a repository map that is not JSON is warned about, and the snapshot is still written", async () => {
    const cwd = checkout();
    mkdirSync(join(cwd, "repos"));
    writeFileSync(join(cwd, "repos", "issue-repos.json"), "{ not json");
    const bd = fakeBd(() => jsonl([exportRow(`${H}-a1`)]));
    const warnings: string[] = [];

    const result = await buildPages({
      cwd,
      runBd: bd.run,
      log: () => {},
      warn: (line) => warnings.push(line),
    });

    expect(result.ok).toBe(true);
    expect(written(cwd).issues.map((issue) => issue.repo)).toEqual([H]);
    expect(warnings.join("\n")).toContain(
      "repos/issue-repos.json is not valid JSON",
    );
  });
});
