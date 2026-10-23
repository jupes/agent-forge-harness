import { afterEach, expect, test } from "bun:test";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import type { BdIssue } from "../bd-answers";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
import { seedProjectBeadWriteFixture } from "./project-bead-write-fixture";

const open: TestHearth[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});
async function start() {
  const h = await startTestHearth();
  open.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const now = new Date().toISOString();
  const issue = (id: string, label: string): BdIssue => ({
    id,
    title: id,
    issue_type: "epic",
    priority: 2,
    status: "open",
    labels: [label],
    created_at: now,
    updated_at: now,
  });
  h.bd.issues.set("alpha-epic", issue("alpha-epic", "project:alpha"));
  h.bd.issues.set("beta-epic", issue("beta-epic", "project:beta"));
  h.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stdout: [...h.bd.issues.values()]
            .map((item) => JSON.stringify(item))
            .join("\n"),
          stderr: "",
        }
      : undefined;
  return h;
}
const path = `/projects/${FIXTURE_PROJECT_ID}/beads`;
async function post(
  h: TestHearth,
  tail: string,
  body: unknown,
  authorized = true,
) {
  const response = await fetch(`${h.api}${path}${tail}`, {
    method: "POST",
    headers: h.headers(authorized ? h.hearth.token : undefined),
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
const effects = (h: TestHearth) =>
  h.bd.calls.filter((args) =>
    ["create", "update", "comments", "close"].includes(args[0] ?? ""),
  );

test("project create preserves all reviewed fields, supplies its membership label and confirms actual ancestry", async () => {
  const h = await start();
  const answer = await post(h, "", {
    title: "Light the lantern",
    parent: "alpha-epic",
    priority: "P4",
    description: "Keep it lit.",
    acceptance: "It lights.\nIt stops.",
    labels: ["ui"],
    complexity: "low",
    fileMap: ["scripts/lantern.ts"],
  });
  expect(answer.status).toBe(201);
  expect(answer.body.data).toMatchObject({
    id: "alpha-epic.1",
    action: "create",
    status: "open",
  });
  const made = h.bd.issues.get("alpha-epic.1");
  expect(made).toMatchObject({
    priority: 4,
    acceptance_criteria: "It lights.\nIt stops.",
    description: "Keep it lit.\n\n## Files\nscripts/lantern.ts",
  });
  expect(made?.labels).toEqual(["complexity:low", "project:alpha", "ui"]);
  expect(effects(h)).toHaveLength(1);
  expect(h.bd.calls.filter((args) => args[0] === "export")).toHaveLength(2);
  expect(h.events().map((event) => event.kind)).toEqual([
    "operator.action",
    "bead.transitioned",
  ]);
});

test("project writes refuse foreign or absent parents, foreign labels and archived scope before mutation", async () => {
  const h = await start();
  for (const body of [
    { title: "Make a lantern" },
    { title: "Make a lantern", parent: "beta-epic" },
    { title: "Make a lantern", parent: "alpha-epic", labels: ["project:beta"] },
  ]) {
    expect((await post(h, "", body)).status).toBe(409);
  }
  for (const action of ["claim", "comment", "close"])
    expect(
      (
        await post(
          h,
          `/beta-epic/${action}`,
          action === "comment"
            ? { text: "worklog: Checked." }
            : action === "close"
              ? { reason: "Verified tests passed." }
              : {},
        )
      ).status,
    ).toBe(404);
  const catalog = projectCatalogFixture(h.workspace);
  if (!catalog.projects[0]) throw Error("Missing fixture");
  catalog.projects[0].archived = true;
  writeOwnerOnly(projectCatalogPath(h.home), JSON.stringify(catalog));
  expect((await post(h, "/alpha-epic/claim", {})).status).toBe(409);
  expect(effects(h)).toEqual([]);
});

test("project write authority and close evidence are checked before tracker access; exact claim/comment/close reuse the canonical effects", async () => {
  const h = await start();
  expect((await post(h, "/alpha-epic/claim", {}, false)).status).toBe(403);
  expect((await post(h, "/alpha-epic/close", { reason: " \n " })).status).toBe(
    400,
  );
  expect(h.bd.calls).toEqual([]);
  expect(h.events()).toEqual([]);
  expect((await post(h, "/alpha-epic/claim", {})).status).toBe(200);
  expect(
    (await post(h, "/alpha-epic/comment", { text: "worklog: Verified light." }))
      .status,
  ).toBe(201);
  expect(
    (
      await post(h, "/alpha-epic/close", {
        reason: "Unit and E2E light checks passed.",
      })
    ).status,
  ).toBe(200);
  expect(effects(h).map((args) => args[0])).toEqual([
    "update",
    "comments",
    "close",
  ]);
});

test("an unconfirmed post-create scope is unknown and never sends another create", async () => {
  const h = await start();
  let reads = 0;
  h.bd.answer = (args) => {
    if (args[0] !== "export") return undefined;
    reads++;
    return reads === 1
      ? {
          status: 0,
          stdout: [...h.bd.issues.values()]
            .map((item) => JSON.stringify(item))
            .join("\n"),
          stderr: "",
        }
      : { status: 1, stdout: "", stderr: "Unavailable" };
  };
  const answer = await post(h, "", {
    title: "Make the lantern",
    parent: "alpha-epic",
  });
  expect(answer.status).toBe(504);
  expect(answer.body.error).toContain("alpha-epic.1");
  expect(effects(h)).toHaveLength(1);
});

test("a created child remains Open until its own explicit Proposed move, even under an approved parent", async () => {
  const h = await start();
  seedProjectBeadWriteFixture(h);
  const parent = h.bd.issues.get("alpha-epic");
  if (!parent) throw Error("Missing parent");
  parent.labels?.push("queue:approved", "complexity:high");
  parent.metadata = { queue_state: "approved" };
  const created = await post(h, "", {
    title: "Light a lantern",
    parent: parent.id,
    labels: ["ui"],
    complexity: "low",
  });
  expect(created.status).toBe(201);
  const id = created.body.data.id;
  expect(h.bd.issues.get(id)?.labels).toEqual([
    "complexity:low",
    "project:alpha",
    "ui",
  ]);
  expect(h.bd.issues.get(id)?.metadata).toBeUndefined();
  const proposed = await post(h, `/${id}/propose`, {});
  expect(proposed.status).toBe(200);
  expect(proposed.body.data).toMatchObject({
    id,
    action: "propose",
    from: null,
    to: "proposed",
  });
  expect(h.bd.issues.get(id)?.metadata?.queue_state).toBe("proposed");
  expect(h.bd.issues.get(id)?.labels).not.toContain("queue:approved");
});

test("a new bead under a different scoped epic is unknown even when it remains in the project", async () => {
  const h = await start();
  const catalog = projectCatalogFixture(h.workspace);
  catalog.projects[0]?.workspaces[0]?.epicIds.push("alpha-other");
  writeOwnerOnly(projectCatalogPath(h.home), JSON.stringify(catalog));
  const original = h.bd.issues.get("alpha-epic");
  if (!original) throw Error("Missing parent");
  h.bd.issues.set("alpha-other", {
    ...original,
    id: "alpha-other",
    title: "Other epic",
  });
  h.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stderr: "",
          stdout: [...h.bd.issues.values()]
            .map((item) =>
              JSON.stringify(
                item.id === "alpha-epic.1"
                  ? {
                      ...item,
                      dependencies: [
                        {
                          issue_id: item.id,
                          depends_on_id: "alpha-other",
                          type: "parent-child",
                        },
                      ],
                    }
                  : item,
              ),
            )
            .join("\n"),
        }
      : undefined;
  const answer = await post(h, "", {
    title: "Keep the selected parent",
    parent: "alpha-epic",
  });
  expect(answer.status).toBe(504);
  expect(answer.body.error).toContain("alpha-epic.1");
  expect(effects(h)).toHaveLength(1);
});
