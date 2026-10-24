import { afterEach, expect, test } from "bun:test";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";

const open: TestHearth[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

test("the real Keeper reader returns only members, refuses foreign details, and performs no action", async () => {
  const h = await startTestHearth();
  open.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const rows = [
    {
      id: "alpha-epic",
      title: "Alpha",
      issue_type: "epic",
      status: "open",
      labels: ["project:alpha"],
    },
    {
      id: "member",
      title: "Member",
      description: "Private member details",
      issue_type: "task",
      status: "open",
      labels: ["project:alpha"],
      dependencies: [
        {
          issue_id: "member",
          depends_on_id: "alpha-epic",
          type: "parent-child",
        },
      ],
    },
    {
      id: "foreign",
      title: "Foreign private title",
      issue_type: "task",
      status: "open",
      labels: ["project:beta"],
      dependencies: [
        {
          issue_id: "foreign",
          depends_on_id: "alpha-epic",
          type: "parent-child",
        },
      ],
    },
  ];
  h.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stdout: rows.map((row) => JSON.stringify(row)).join("\n"),
          stderr: "",
        }
      : undefined;
  const path = `/projects/${FIXTURE_PROJECT_ID}/keeper/read`;
  const get = (query: string) =>
    fetch(h.api + path + query, { headers: h.headers(null) });
  const index = await get("?kind=beads");
  expect(index.status).toBe(200);
  const data: unknown = await index.json();
  expect(JSON.stringify(data)).not.toContain("foreign");
  const detail = await get("?kind=beads&id=member");
  expect(await detail.text()).toContain("Private member details");
  expect((await get("?kind=beads&id=foreign")).status).toBe(404);
  expect((await get("?kind=start_shift")).status).toBe(400);
  expect((await get("?kind=beads&project=elsewhere")).status).toBe(400);
  expect((await get("?kind=beads&kind=sessions")).status).toBe(400);
  expect(h.events(["operator.action"])).toEqual([]);
  expect(h.bd.calls.every((args) => args[0] === "export")).toBe(true);
});
