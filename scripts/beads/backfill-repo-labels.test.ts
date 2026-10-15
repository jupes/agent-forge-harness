import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BdExportRow } from "../beads-dashboard";
import { backfillRepoLabels, planRepoLabels } from "./backfill-repo-labels";
import type { BdRunner } from "./live-tracker";

const H = "agent-forge-harness";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function row(
  short: string,
  title: string,
  extra: Partial<BdExportRow> & { parent?: string } = {},
): BdExportRow {
  const { parent, ...rest } = extra;
  const id = `${H}-${short}`;
  return {
    _type: "issue",
    id,
    title,
    status: "open",
    created_at: "2026-01-01T00:00:00Z",
    ...(parent
      ? {
          dependencies: [
            {
              issue_id: id,
              depends_on_id: `${H}-${parent}`,
              type: "parent-child",
            },
          ],
        }
      : {}),
    ...rest,
  };
}

const ROWS = [
  row("e10", "API epic"),
  row("e10.1", "Child", { parent: "e10" }),
  row("a1", "[my-frontend] Login"),
  row("a2", "Labelled", { labels: ["repo:my-api"] }),
  row("a3", "[dashboard] Harness work"),
];

/** A scratch checkout with the map and registry under repos/, and optionally the fallback file. */
function checkout(fallbackRows?: BdExportRow[]): string {
  const dir = mkdtempSync(join(tmpdir(), "af-backfill-"));
  dirs.push(dir);
  mkdirSync(join(dir, "repos"));
  mkdirSync(join(dir, ".beads"));
  writeFileSync(
    join(dir, "repos", "repos.json"),
    JSON.stringify({ repos: [{ name: "my-frontend" }] }),
  );
  writeFileSync(
    join(dir, "repos", "issue-repos.json"),
    JSON.stringify({ issues: { [`${H}-e10`]: "my-api" } }),
  );
  if (fallbackRows)
    writeFileSync(
      join(dir, ".beads", "issues.jsonl"),
      `${fallbackRows.map((r) => JSON.stringify(r)).join("\n")}\n`,
    );
  return dir;
}

/** Stands in for `bd`: records every call; never the real tracker. */
function fakeBd(
  answer: (args: string[]) => string | Error = (args) =>
    args[0] === "export"
      ? `${ROWS.map((r) => JSON.stringify(r)).join("\n")}\n`
      : "",
): { run: BdRunner; calls: string[][] } {
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

describe("planRepoLabels", () => {
  test("plans a repo: label for each issue whose repository comes from the map, a title prefix or a parent, and for no other", () => {
    const plan = planRepoLabels(ROWS, {
      knownRepos: ["my-frontend"],
      map: { issues: { [`${H}-e10`]: "my-api" }, titleTags: {} },
    });
    expect(plan.add.map((a) => [a.id, a.repo, a.from])).toEqual([
      [`${H}-e10`, "my-api", "map"],
      [`${H}-e10.1`, "my-api", "parent"],
      [`${H}-a1`, "my-frontend", "title"],
    ]);
    expect(plan.conflicts).toEqual([]);
  });

  test("an issue whose repo: label differs from its own map entry is a conflict and gets no label", () => {
    const plan = planRepoLabels(
      [row("a2", "Labelled", { labels: ["repo:my-api"] })],
      { map: { issues: { [`${H}-a2`]: "docs-site" }, titleTags: {} } },
    );
    expect(plan.add).toEqual([]);
    expect(plan.conflicts).toEqual([
      {
        id: `${H}-a2`,
        title: "Labelled",
        label: "my-api",
        mapped: "docs-site",
      },
    ]);
  });
});

describe("backfillRepoLabels", () => {
  test("by default it reads the tracker once, writes nothing, and lists the bd update commands it would run", async () => {
    const cwd = checkout();
    const bd = fakeBd();

    const result = await backfillRepoLabels({
      cwd,
      runBd: bd.run,
      apply: false,
    });

    expect(bd.calls).toEqual([["export", "--no-memories"]]);
    expect(result.ok).toBe(true);
    expect(result.data?.applied).toEqual([]);
    expect(result.data?.commands).toEqual([
      `bd update ${H}-e10 --add-label repo:my-api`,
      `bd update ${H}-e10.1 --add-label repo:my-api`,
      `bd update ${H}-a1 --add-label repo:my-frontend`,
    ]);
  });

  test("with apply it runs one bd update --add-label per planned issue and nothing else", async () => {
    const cwd = checkout();
    const bd = fakeBd();

    const result = await backfillRepoLabels({
      cwd,
      runBd: bd.run,
      apply: true,
    });

    expect(bd.calls).toEqual([
      ["export", "--no-memories"],
      ["update", `${H}-e10`, "--add-label", "repo:my-api"],
      ["update", `${H}-e10.1`, "--add-label", "repo:my-api"],
      ["update", `${H}-a1`, "--add-label", "repo:my-frontend"],
    ]);
    expect(result.ok).toBe(true);
    expect(result.data?.applied).toEqual([`${H}-e10`, `${H}-e10.1`, `${H}-a1`]);
  });

  test("with apply and only the fallback file to read, it refuses and writes nothing", async () => {
    const cwd = checkout(ROWS);
    const bd = fakeBd((args) =>
      args[0] === "export" ? new Error("bd is not running") : "",
    );

    const result = await backfillRepoLabels({
      cwd,
      runBd: bd.run,
      apply: true,
    });

    expect(bd.calls).toEqual([["export", "--no-memories"]]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("fallback");
  });

  test("with apply and a repository map that is not JSON, it refuses and writes nothing", async () => {
    const cwd = checkout();
    writeFileSync(join(cwd, "repos", "issue-repos.json"), "{ not json");
    const bd = fakeBd();

    const result = await backfillRepoLabels({
      cwd,
      runBd: bd.run,
      apply: true,
    });

    expect(bd.calls).toEqual([["export", "--no-memories"]]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("repos/issue-repos.json is not valid JSON");
  });

  test("a failed update is reported, the rest still run, and the result is not ok", async () => {
    const cwd = checkout();
    const bd = fakeBd((args) => {
      if (args[0] === "export")
        return `${ROWS.map((r) => JSON.stringify(r)).join("\n")}\n`;
      return args[1] === `${H}-e10.1` ? new Error("locked") : "";
    });

    const result = await backfillRepoLabels({
      cwd,
      runBd: bd.run,
      apply: true,
    });

    expect(bd.calls).toHaveLength(4);
    expect(result.ok).toBe(false);
    expect(result.data?.applied).toEqual([`${H}-e10`, `${H}-a1`]);
    expect(result.data?.failed).toEqual([
      { id: `${H}-e10.1`, error: "locked" },
    ]);
  });
});
