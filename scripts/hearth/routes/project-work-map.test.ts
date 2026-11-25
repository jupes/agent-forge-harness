import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { projectWorkMapSchema } from "../../projects/project-work-map-protocol";
import { createProjectStore } from "../../projects/store";
import { startTestHearth, type TestHearth } from "../testing";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const hearth of opened.splice(0)) await hearth.close();
});

test("the protected Work Map reads real project memberships across one tracker", async () => {
  const hearth = await startTestHearth();
  opened.push(hearth);
  const store = createProjectStore(hearth.home);
  const create = (name: string, root: string, revision: number) =>
    store.create(
      {
        slug: name.toLowerCase(),
        name,
        description: "PRIVATE PROJECT DESCRIPTION",
        icon: name[0] ?? "A",
        workspaces: [
          {
            root,
            repositories: [root],
            epicIds: [`${name.toLowerCase()}-epic`],
          },
        ],
      },
      revision,
    );
  await create("Alpha", hearth.workspace, 0);
  await create("Beta", hearth.workspace, 1);
  const elsewhere = join(hearth.workspace, "elsewhere");
  mkdirSync(join(elsewhere, ".git"), { recursive: true });
  await create("Elsewhere", elsewhere, 2);
  const rows = [
    {
      id: "alpha-epic",
      title: "Alpha epic",
      issue_type: "epic",
      status: "open",
    },
    { id: "beta-epic", title: "Beta epic", issue_type: "epic", status: "open" },
    {
      id: "alpha-task",
      title: "Alpha task\r\nwith a second line\u0007",
      issue_type: "task",
      status: "open",
      labels: ["project:alpha"],
      description: "PRIVATE BEAD DESCRIPTION",
      dependencies: [
        {
          issue_id: "alpha-task",
          depends_on_id: "alpha-epic",
          type: "parent-child",
        },
        { issue_id: "alpha-task", depends_on_id: "beta-task", type: "blocks" },
      ],
    },
    {
      id: "beta-task",
      title: "Beta task",
      issue_type: "task",
      status: "in_progress",
      labels: ["project:beta"],
      dependencies: [
        {
          issue_id: "beta-task",
          depends_on_id: "beta-epic",
          type: "parent-child",
        },
      ],
    },
    {
      id: "elsewhere-epic",
      title: "PRIVATE FOREIGN EPIC",
      issue_type: "epic",
      status: "open",
    },
  ];
  let reads = 0;
  hearth.bd.answer = (args) => {
    if (args[0] !== "export") return undefined;
    reads++;
    return {
      status: 0,
      stdout: rows.map((row) => JSON.stringify(row)).join("\n"),
      stderr: "",
    };
  };
  const path = `${hearth.api}/projects/work-map`;
  expect((await fetch(path, { headers: hearth.headers() })).status).toBe(403);
  expect(reads).toBe(0);
  const headers = hearth.headers(hearth.hearth.token);
  expect((await fetch(`${path}?workspace=elsewhere`, { headers })).status).toBe(
    400,
  );
  expect(reads).toBe(0);
  const response = await fetch(path, { headers });
  expect(response.status).toBe(200);
  expect(reads).toBe(1);
  const envelope: { data: unknown } = await response.json();
  const data = projectWorkMapSchema.parse(envelope.data);
  expect(data.trackerAvailable).toBe(true);
  expect(
    data.projects.map(
      ({ name, availability }: { name: string; availability: string }) => [
        name,
        availability,
      ],
    ),
  ).toEqual([
    ["Alpha", "available"],
    ["Beta", "available"],
    ["Elsewhere", "unavailable"],
  ]);
  expect(data.epics.map(({ id }: { id: string }) => id)).toEqual([
    "alpha-epic",
    "beta-epic",
  ]);
  expect(
    data.beads.map(({ id, workState }: { id: string; workState: string }) => [
      id,
      workState,
    ]),
  ).toEqual([
    ["alpha-task", "blocked"],
    ["beta-task", "in_progress"],
  ]);
  expect(data.dependencies).toEqual([
    { from: "alpha-task", to: "beta-task", type: "blocks" },
  ]);
  const alpha = data.projects.find((project) => project.name === "Alpha");
  if (!alpha) throw new Error("Missing Alpha project");
  expect(data.beads[0]?.memberships).toEqual([
    { projectId: alpha.id, epicId: "alpha-epic" },
  ]);
  expect(data.beads[0]?.title).toContain("second line");
  expect(data.beads[0]?.title).not.toMatch(/[\p{Cc}\p{Cs}]/u);
  expect(JSON.stringify(data)).not.toContain("PRIVATE");
});
