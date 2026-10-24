import { afterEach, expect, test } from "bun:test";
import { projectBeadsPageSchema } from "../../projects/beads-protocol";
import { createProjectStore } from "../../projects/store";
import { startTestHearth, type TestHearth } from "../testing";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});
test("live project bead read is operator protected, scoped and refuses unavailable data or query widening", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const catalog = await createProjectStore(h.home).create(
    {
      slug: "alpha",
      name: "Alpha",
      description: "",
      icon: "A",
      workspaces: [
        {
          root: h.workspace,
          repositories: [h.workspace],
          epicIds: ["alpha-epic"],
        },
      ],
    },
    0,
  );
  const project = catalog.projects[0];
  if (!project) throw Error("Missing project");
  const rows = [
    {
      id: "alpha-epic",
      title: "Alpha",
      issue_type: "epic",
      status: "open",
      priority: 4,
      labels: ["project:alpha"],
      comments: [
        {
          text: "Embedded evidence",
          author: "smith",
          created_at: "2026-10-22T00:00:00Z",
        },
      ],
    },
    {
      id: "private-beta",
      title: "FOREIGN",
      issue_type: "epic",
      status: "open",
      priority: 0,
      labels: ["project:beta"],
    },
  ];
  const commentReads: string[] = [];
  let commentText = "worklog: confirmed in the tracker";
  let commentOverride: unknown;
  h.bd.answer = (args) => {
    if (args[0] === "export")
      return {
        status: 0,
        stdout: rows.map((row) => JSON.stringify(row)).join("\n"),
        stderr: "",
      };
    if (args[0] === "--readonly" && args[1] === "comments") {
      commentReads.push(args[2] ?? "");
      return {
        status: 0,
        stdout: JSON.stringify(
          commentOverride ?? [
            {
              issue_id: args[2],
              text: commentText,
              author: "smith",
              created_at: "2026-10-22T00:00:00Z",
            },
          ],
        ),
        stderr: "",
      };
    }
    return undefined;
  };
  const path = `${h.api}/projects/${project.id}/beads`;
  expect((await fetch(path, { headers: h.headers() })).status).toBe(403);
  const response = await fetch(path, { headers: h.headers(h.hearth.token) });
  expect(response.status).toBe(200);
  const envelope = await response.json();
  expect(envelope.ok).toBe(true);
  const parsed = projectBeadsPageSchema.safeParse(envelope.data);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw Error("Invalid scoped response");
  expect(parsed.data.beads.map((bead) => [bead.id, bead.priority])).toEqual([
    ["alpha-epic", 4],
  ]);
  expect(JSON.stringify(envelope)).not.toContain("FOREIGN");
  expect(
    (
      await fetch(`${path}?beadId=private-beta`, {
        headers: h.headers(h.hearth.token),
      })
    ).status,
  ).toBe(404);
  expect(commentReads).toEqual([]);
  const detail = await fetch(`${path}?beadId=alpha-epic`, {
    headers: h.headers(h.hearth.token),
  });
  const detailed = (await detail.json()).data.beads[0];
  expect(detailed.detailsLoaded).toBe(true);
  expect(detailed.comments).toEqual([
    { body: commentText, author: "smith", createdAt: "2026-10-22T00:00:00Z" },
  ]);
  expect(detailed.commentsComplete).toBe(true);
  expect(commentReads).toEqual(["alpha-epic"]);
  commentText = "worklog: newly added evidence";
  const refreshed = await fetch(`${path}?beadId=alpha-epic`, {
    headers: h.headers(h.hearth.token),
  });
  expect((await refreshed.json()).data.beads[0].comments[0].body).toBe(
    commentText,
  );
  for (const invalid of [
    [
      {
        issue_id: "private-beta",
        text: "FOREIGN-COMMENT",
        author: "smith",
        created_at: "now",
      },
    ],
    { unexpected: "not a comment list" },
    Array.from({ length: 101 }, () => ({
      text: "too many",
      author: "smith",
      created_at: "now",
    })),
  ]) {
    commentOverride = invalid;
    const response = await fetch(`${path}?beadId=alpha-epic`, {
      headers: h.headers(h.hearth.token),
    });
    const answer = await response.json();
    expect(response.status).toBe(200);
    expect(answer.data.beads[0].commentsComplete).toBe(false);
    expect(answer.data.beads[0].comments[0].body).toBe("Embedded evidence");
    expect(answer.data.problems.join(" ")).toContain(
      "live comment history is unavailable",
    );
    expect(JSON.stringify(answer)).not.toContain("FOREIGN-COMMENT");
  }
  commentOverride = undefined;
  h.append({
    kind: "reservation.acquired",
    beadId: "alpha-epic",
    sessionId: "owned",
    payload: { worktree: h.workspace, globs: ["scripts/**"] },
  });
  h.append({
    kind: "reservation.acquired",
    beadId: "private-beta",
    sessionId: "FOREIGN_SESSION",
    payload: { worktree: h.workspace, globs: ["PRIVATE_GLOB/**"] },
  });
  const observations = await fetch(`${path}?beadId=alpha-epic`, {
    headers: h.headers(h.hearth.token),
  });
  const observed = await observations.json();
  expect(observed.data.beads[0].reservations).toHaveLength(1);
  expect(observed.data.beads[0].activity).toHaveLength(1);
  expect(observed.data.beads[0].activity[0].kind).toBe("reservation.acquired");
  expect(JSON.stringify(observed)).not.toContain("PRIVATE_GLOB");
  expect(JSON.stringify(observed)).not.toContain("FOREIGN_SESSION");
  expect(
    (
      await fetch(`${path}?workspace=elsewhere`, {
        headers: h.headers(h.hearth.token),
      })
    ).status,
  ).toBe(400);
  h.bd.answer = (args) =>
    args[0] === "export"
      ? { status: 2, stdout: "", stderr: "unavailable" }
      : undefined;
  expect(
    (await fetch(path, { headers: h.headers(h.hearth.token) })).status,
  ).toBe(503);
});
