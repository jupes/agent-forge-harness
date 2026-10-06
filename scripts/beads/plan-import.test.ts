import { describe, expect, test } from "bun:test";
import { commandCenterPlan } from "./command-center-plan";
import {
  type BdClient,
  type BdCreateParams,
  type BdUpdateParams,
  importPlan,
  type PlanSpec,
  renderPlanMarkdown,
  topoOrder,
  validatePlan,
} from "./plan-import";

interface FakeRow {
  id: string;
  title: string;
  parent?: string | undefined;
  type: string;
}

function fakeClient(): BdClient & {
  created: BdCreateParams[];
  updates: Array<{ id: string; params: BdUpdateParams }>;
  deps: string[];
  rows: Map<string, FakeRow>;
} {
  const rows = new Map<string, FakeRow>();
  const deps = new Set<string>();
  let n = 0;
  return {
    created: [],
    updates: [],
    rows,
    get deps() {
      return [...deps];
    },
    findEpicByTitle(title) {
      for (const r of rows.values())
        if (r.type === "epic" && r.title === title) return r.id;
      return null;
    },
    listChildren(parentId) {
      return [...rows.values()].filter((r) => r.parent === parentId);
    },
    create(params) {
      this.created.push(params);
      const id = params.parent ? `${params.parent}.${++n}` : `afh-${++n}`;
      rows.set(id, {
        id,
        title: params.title,
        parent: params.parent,
        type: params.type,
      });
      return id;
    },
    update(id, params) {
      this.updates.push({ id, params });
      const row = rows.get(id);
      if (row) row.title = params.title;
    },
    listDeps(issueId) {
      return [...deps]
        .filter((d) => d.startsWith(`${issueId}<-`))
        .map((d) => ({
          id: d.split("<-")[1] ?? "",
          dependency_type: "blocks",
        }));
    },
    depAdd(blocked, dependsOn) {
      deps.add(`${blocked}<-${dependsOn}`);
    },
  };
}

const tiny: PlanSpec = {
  name: "tiny",
  epicKey: "e",
  issues: [
    {
      key: "e",
      type: "epic",
      priority: 2,
      title: "Epic",
      acceptance: ["done"],
    },
    {
      key: "f",
      parent: "e",
      type: "feature",
      priority: 2,
      title: "F",
      acceptance: ["a"],
    },
    {
      key: "t2",
      parent: "f",
      type: "task",
      priority: 3,
      title: "T2",
      acceptance: ["b"],
      deps: ["t1", "agent-forge-harness-x1y2"],
    },
    {
      key: "t1",
      parent: "f",
      type: "task",
      priority: 2,
      title: "T1",
      acceptance: ["c"],
    },
  ],
};

describe("validatePlan", () => {
  test("the command-center plan is structurally valid", () => {
    expect(validatePlan(commandCenterPlan)).toEqual([]);
  });

  test("every command-center issue has a spec pointer and a parent chain to the epic", () => {
    const byKey = new Map(commandCenterPlan.issues.map((i) => [i.key, i]));
    for (const issue of commandCenterPlan.issues) {
      if (issue.key !== "epic")
        expect(issue.description ?? "").toContain("docs/plans/command-center");
      let cur = issue;
      let hops = 0;
      while (cur.parent) {
        cur = byKey.get(cur.parent) as typeof cur;
        hops += 1;
        expect(hops).toBeLessThan(4);
      }
      expect(cur.key).toBe("epic");
    }
  });

  test("the command-center plan uses forge vocabulary, not Orbit's", () => {
    const text = JSON.stringify(commandCenterPlan);
    expect(text).not.toMatch(/\bcrews?\b/i);
    expect(text).not.toMatch(/\bdrains?\b/i);
  });

  test("rejects unknown deps, missing parents, cycles and empty acceptance", () => {
    const bad: PlanSpec = {
      name: "bad",
      epicKey: "e",
      issues: [
        { key: "e", type: "epic", priority: 2, title: "E", acceptance: ["x"] },
        {
          key: "a",
          parent: "e",
          type: "task",
          priority: 2,
          title: "A",
          acceptance: [],
          deps: ["b", "nope"],
        },
        {
          key: "b",
          parent: "zz",
          type: "task",
          priority: 9 as 2,
          title: "B",
          acceptance: ["y"],
          deps: ["a"],
        },
      ],
    };
    const errors = validatePlan(bad);
    expect(errors.join("\n")).toContain("unknown dep nope");
    expect(errors.join("\n")).toContain("unknown parent zz");
    expect(errors.join("\n")).toContain("priority must be");
    expect(errors.join("\n")).toContain("acceptance criteria required");
    expect(errors.join("\n")).toContain("dependency cycle");
  });
});

describe("topoOrder", () => {
  test("places parents and blockers first", () => {
    const keys = topoOrder(tiny).map((i) => i.key);
    expect(keys.indexOf("e")).toBeLessThan(keys.indexOf("f"));
    expect(keys.indexOf("f")).toBeLessThan(keys.indexOf("t1"));
    expect(keys.indexOf("t1")).toBeLessThan(keys.indexOf("t2"));
  });
});

describe("importPlan", () => {
  test("creates every issue with parent, priority and acceptance bullets, and wires deps", () => {
    const bd = fakeClient();
    const result = importPlan(tiny, bd);
    expect(result.created).toHaveLength(4);
    expect(result.reused).toHaveLength(0);
    expect(result.updated).toHaveLength(0);
    const t2 = bd.created.find((c) => c.title === "T2");
    expect(t2?.parent).toBe(result.ids.f);
    expect(t2?.priority).toBe(3);
    expect(t2?.acceptance).toBe("- [ ] b");
    expect(bd.deps).toEqual([
      `${result.ids.t2}<-${result.ids.t1}`,
      `${result.ids.t2}<-agent-forge-harness-x1y2`,
    ]);
  });

  test("is idempotent: a second run creates nothing, updates nothing, adds no deps", () => {
    const bd = fakeClient();
    const first = importPlan(tiny, bd);
    const second = importPlan(tiny, bd);
    expect(second.created).toEqual([]);
    expect(second.reused.sort()).toEqual(["e", "f", "t1", "t2"]);
    expect(second.depsAdded).toEqual([]);
    expect(second.ids).toEqual(first.ids);
    expect(bd.updates).toEqual([]);
  });

  test("sync pushes edited titles and fields onto issues found through knownIds", () => {
    const bd = fakeClient();
    const first = importPlan(tiny, bd);
    const edited: PlanSpec = {
      ...tiny,
      issues: tiny.issues.map((i) =>
        i.key === "t1"
          ? { ...i, title: "T1 renamed", priority: 1, acceptance: ["c", "d"] }
          : i,
      ),
    };
    const second = importPlan(edited, bd, { knownIds: first.ids, sync: true });
    expect(second.created).toEqual([]);
    expect(second.updated.sort()).toEqual(["e", "f", "t1", "t2"]);
    const t1 = bd.updates.find((u) => u.id === first.ids.t1);
    expect(t1?.params.title).toBe("T1 renamed");
    expect(t1?.params.priority).toBe(1);
    expect(t1?.params.acceptance).toBe("- [ ] c\n- [ ] d");
    expect(bd.rows.get(first.ids.t1 as string)?.title).toBe("T1 renamed");
  });

  test("a renamed issue without knownIds would be created again, which is why ids are persisted", () => {
    const bd = fakeClient();
    importPlan(tiny, bd);
    const edited: PlanSpec = {
      ...tiny,
      issues: tiny.issues.map((i) =>
        i.key === "t1" ? { ...i, title: "T1 renamed" } : i,
      ),
    };
    const second = importPlan(edited, bd);
    expect(second.created).toEqual(["t1"]);
  });

  test("refuses to run when knownIds hold a key the plan no longer has (renamed key)", () => {
    const bd = fakeClient();
    const first = importPlan(tiny, bd);
    const renamed: PlanSpec = {
      ...tiny,
      issues: tiny.issues
        .map((i) => (i.key === "t1" ? { ...i, key: "t1-new" } : i))
        .map((i) =>
          i.key === "t2"
            ? { ...i, deps: ["t1-new", "agent-forge-harness-x1y2"] }
            : i,
        ),
    };
    expect(() =>
      importPlan(renamed, bd, { knownIds: first.ids, sync: true }),
    ).toThrow(/renamed key.*t1/);
    expect(bd.created).toHaveLength(4);
  });

  test("refuses an invalid plan before touching bd", () => {
    const bd = fakeClient();
    expect(() => importPlan({ ...tiny, epicKey: "missing" }, bd)).toThrow(
      /invalid plan/,
    );
    expect(bd.created).toHaveLength(0);
  });
});

describe("renderPlanMarkdown", () => {
  test("lists every key with resolved ids and deps", () => {
    const md = renderPlanMarkdown(tiny, { e: "afh-1", t1: "afh-1.2.1" });
    expect(md).toContain("| `e` | `afh-1` | epic | P2 | Epic | — |");
    expect(md).toContain("afh-1.2.1, agent-forge-harness-x1y2");
    expect(md.split("\n")).toHaveLength(2 + tiny.issues.length);
  });
});
