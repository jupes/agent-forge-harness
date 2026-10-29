import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type ProjectCheckpointReviewOriginal,
  projectCheckpointReviewCommentText,
  projectCheckpointReviewIntentJson,
  projectCheckpointReviewOriginalSchema,
} from "../../../types/project-checkpoint-reviews";
import { createProjectCheckpointReviewStore } from "../../forge/project-checkpoint-review-store";
import { hashText } from "../../hash-text";
import { createProjectStore, projectCatalogPath } from "../../projects/store";
import { withQueueLock } from "../../scheduler/queue-lock";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
import { createProjectCheckpointReviewRoutes } from "./project-checkpoint-reviews";

const open: TestHearth[] = [];
afterEach(async () => {
  for (const hearth of open.splice(0)) await hearth.close();
});

async function fixture(addAnswer: "record" | "uncertain" = "record") {
  const h = await startTestHearth();
  open.push(h);
  const catalog = await createProjectStore(h.home).create(
    {
      slug: "alpha",
      name: "Alpha",
      description: "",
      icon: "A",
      workspaces: [
        { root: h.workspace, repositories: [h.root], epicIds: ["alpha-epic"] },
      ],
    },
    0,
  );
  const project = catalog.projects[0];
  if (!project) throw Error("Missing review project fixture.");
  mkdirSync(join(h.root, ".tmp", "work", "forge-runs"), { recursive: true });
  const run = {
    schemaVersion: 2,
    slug: "alpha-run",
    feature: "Alpha checkpoint review",
    epic: "alpha-epic",
    phase: "plan",
    completed: ["research", "plan"],
    artifacts: {},
    mode: "gated",
    checkout: h.root,
    updatedAt: "2026-10-29T18:00:00.000Z",
  };
  await Bun.write(
    join(h.root, ".tmp", "work", "forge-runs", "alpha-run.json"),
    JSON.stringify(run),
  );
  const comments: Array<{
    id: string;
    issue_id: string;
    author: string;
    text: string;
    created_at: string;
  }> = [];
  const beadId = "alpha-epic.1";
  let checkpointStatus = "in_progress";
  h.bd.answer = (args) => {
    if (args[0] === "export")
      return {
        status: 0,
        stdout: [
          {
            id: "alpha-epic",
            title: "Alpha",
            status: "open",
            issue_type: "epic",
            labels: ["project:alpha"],
            comment_count: 0,
          },
          {
            id: beadId,
            title: "Checkpoint",
            status: checkpointStatus,
            issue_type: "task",
            labels: ["project:alpha"],
            comment_count: comments.length,
            dependencies: [
              {
                issue_id: beadId,
                depends_on_id: "alpha-epic",
                type: "parent-child",
              },
            ],
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n"),
        stderr: "",
      };
    if (args[0] === "comments" && args[1] === "add") {
      const comment = {
        id: `comment-${comments.length + 1}`,
        issue_id: args[4] ?? "",
        author: "fixture",
        text: args.at(-1) ?? "",
        created_at: "2026-10-29T18:01:00.000Z",
      };
      comments.push(comment);
      return addAnswer === "record"
        ? {
            status: 0,
            stdout: JSON.stringify({
              id: comment.id,
              issue_id: comment.issue_id,
            }),
            stderr: "",
          }
        : {
            status: 1,
            stdout: "",
            stderr: "fixture lost the successful write reply",
          };
    }
    if (args[0] === "--readonly" && args[1] === "show")
      return {
        status: 0,
        stdout: JSON.stringify([
          { id: args[2], comment_count: comments.length },
        ]),
        stderr: "",
      };
    if (args[0] === "--readonly" && args[1] === "comments")
      return { status: 0, stdout: JSON.stringify(comments), stderr: "" };
    return undefined;
  };
  const path = `${h.api}/projects/${project.id}/runs/alpha-run/checkpoints/${beadId}/reviews`;
  const readPath = (requestId: string) => `${path}/${requestId}`;
  return {
    h,
    path,
    readPath,
    projectId: project.id,
    beadId,
    comments,
    run,
    setCheckpointStatus: (status: string) => {
      checkpointStatus = status;
    },
  };
}

async function post(h: TestHearth, path: string, body: unknown) {
  return fetch(path, {
    method: "POST",
    headers: {
      ...h.headers(h.hearth.token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("metadata and protected-original reads refuse a project scope changed during storage", async () => {
  const { h, projectId, beadId, run } = await fixture();
  const scope = {
    projectId,
    workspacePath: h.workspace,
    runSlug: "alpha-run",
    beadId,
  };
  const requestId = randomUUID().toLowerCase();
  const value: ProjectCheckpointReviewOriginal = {
    schemaVersion: 1,
    requestId,
    binding: {
      ...scope,
      checkout: h.root,
      epicId: "alpha-epic",
      runUpdatedAt: run.updatedAt,
      catalogRevision: 1,
      scopeHash: "a".repeat(64),
    },
    decision: "request-changes",
    note: "Private scope-fence sentinel.",
    createdAt: run.updatedAt,
    commentText: "",
    intentHash: "0".repeat(64),
  };
  value.commentText = projectCheckpointReviewCommentText(value);
  value.intentHash = createHash("sha256")
    .update(projectCheckpointReviewIntentJson(value), "utf8")
    .digest("hex");
  const original = projectCheckpointReviewOriginalSchema.parse(value);
  const store = createProjectCheckpointReviewStore({
    home: h.home,
    withQueueLock,
  });
  await store.prepare(original, 901);

  let scopeReads = 0;
  const routes = createProjectCheckpointReviewRoutes({
    home: h.home,
    workspace: h.workspace,
    appendEvent: () => ({ ok: true, id: 902, ulid: "fixture-read-event" }),
    queueLock: withQueueLock,
    runBd: async () => ({ status: 1, stdout: "", stderr: "unused" }),
    resolveAuthority: async () => original.binding,
    readScope: () => {
      scopeReads++;
      return scopeReads % 2 === 1
        ? scope
        : { ...scope, workspacePath: `${scope.workspacePath}-changed` };
    },
  });
  try {
    for (const route of routes.reads) {
      scopeReads = 0;
      const checked = route.validate({
        params: {
          id: projectId,
          slug: scope.runSlug,
          beadId,
          ...(route.path.endsWith("/:requestId") ? { requestId } : {}),
        },
        query: new URLSearchParams(),
        headers: {},
        body: null,
      });
      if (!checked.ok)
        throw new Error("The read route fixture did not validate.");
      const reply = await route.read(checked.value);
      expect(reply.status).toBe(409);
      expect(JSON.stringify(reply)).not.toContain(value.note);
    }
  } finally {
    await routes.close();
  }
});

test("checkpoint review prepare is metadata-only; explicit commit records one exact comment and readback", async () => {
  const { h, path, readPath, beadId, comments, run } = await fixture();
  const requestId = "de6cf716-339a-4657-ad57-0e813a2b6c19";
  const note = "Private checkpoint note sentinel.";
  const preparedResponse = await post(h, path, {
    requestId,
    expectedEpicId: "alpha-epic",
    expectedRunUpdatedAt: run.updatedAt,
    decision: "request-changes",
    note,
  });
  expect(preparedResponse.status).toBe(200);
  const prepared = await preparedResponse.json();
  expect(prepared.data).toMatchObject({ requestId, state: "prepared" });
  expect(JSON.stringify(prepared)).not.toContain(note);
  expect(
    h.bd.calls.some((args) => args[0] === "comments" && args[1] === "add"),
  ).toBe(false);

  const originalResponse = await fetch(readPath(requestId), {
    headers: h.headers(h.hearth.token),
  });
  expect(originalResponse.status).toBe(200);
  const original = await originalResponse.json();
  expect(original.data.original).toMatchObject({
    requestId,
    decision: "request-changes",
    note,
  });
  expect(original.data.original.commentText).toContain(
    `Forge checkpoint review ${requestId}`,
  );

  const commitResponse = await post(h, `${path}/${requestId}/commit`, {
    intentHash: prepared.data.intentHash,
  });
  expect(commitResponse.status).toBe(200);
  const receipt = await commitResponse.json();
  expect(receipt.data).toMatchObject({
    requestId,
    state: "confirmed",
    readback: "found",
  });
  expect(comments).toHaveLength(1);
  expect(comments[0]?.text).toBe(original.data.original.commentText);
  expect(
    h.bd.calls.filter((args) => args[0] === "comments" && args[1] === "add"),
  ).toEqual([
    [
      "comments",
      "add",
      "--json",
      "--",
      beadId,
      original.data.original.commentText,
    ],
  ]);
  expect(
    h.events(["operator.action"]).map((event) => event.payload.action),
  ).toEqual(["checkpoint.review.prepare", "checkpoint.review.commit"]);
  expect(JSON.stringify(h.events(["operator.action"]))).not.toContain(note);
  const commentEvents = h
    .events(["bead.transitioned"])
    .filter(
      (event) =>
        "action" in event.payload && event.payload.action === "comment",
    );
  expect(commentEvents).toHaveLength(1);
  expect(commentEvents[0]).toMatchObject({
    workspace: h.workspace,
    beadId,
    payload: {
      action: "comment",
      hash: hashText(original.data.original.commentText),
      length: original.data.original.commentText.length,
    },
  });
  expect(JSON.stringify(commentEvents)).not.toContain(note);
  const replay = await post(h, `${path}/${requestId}/commit`, {
    intentHash: prepared.data.intentHash,
  });
  expect((await replay.json()).data).toMatchObject({
    state: "confirmed",
    readback: "found",
  });
  expect(comments).toHaveLength(1);
  expect(
    h
      .events(["bead.transitioned"])
      .filter(
        (event) =>
          "action" in event.payload && event.payload.action === "comment",
      ),
  ).toHaveLength(1);

  // Historical reads use current project/workspace routing, not live Run eligibility.
  await Bun.write(
    join(h.root, ".tmp", "work", "forge-runs", "alpha-run.json"),
    "removed",
  );
  const history = await fetch(path, { headers: h.headers(h.hearth.token) });
  expect(history.status).toBe(200);
  expect((await history.json()).data.items).toMatchObject([
    { requestId, state: "confirmed" },
  ]);
  const protectedOriginal = await fetch(readPath(requestId), {
    headers: h.headers(h.hearth.token),
  });
  expect((await protectedOriginal.json()).data.original.note).toBe(note);
});

test("an uncertain comment attempt remains held until a later explicit exact readback", async () => {
  const { h, path, beadId, comments, run } = await fixture("uncertain");
  const requestId = "3828d645-7381-4766-98d2-947ece19533d";
  const prepare = await post(h, path, {
    requestId,
    expectedEpicId: "alpha-epic",
    expectedRunUpdatedAt: run.updatedAt,
    decision: "approve",
    note: "",
  });
  const prepared = await prepare.json();
  const body = `${path}/${requestId}`;
  const first = await post(h, `${body}/commit`, {
    intentHash: prepared.data.intentHash,
  });
  expect((await first.json()).data).toMatchObject({
    state: "unknown",
    readback: "not-checked",
  });
  const retry = await post(h, `${body}/commit`, {
    intentHash: prepared.data.intentHash,
  });
  expect((await retry.json()).data).toMatchObject({ state: "unknown" });
  expect(
    h.bd.calls.filter((args) => args[0] === "comments" && args[1] === "add"),
  ).toHaveLength(1);
  expect(comments).toHaveLength(1);
  const readback = await post(h, `${body}/readback`, {
    intentHash: prepared.data.intentHash,
  });
  expect((await readback.json()).data).toMatchObject({
    state: "confirmed",
    readback: "found",
  });
  expect(
    h.bd.calls.filter((args) => args[0] === "comments" && args[1] === "add"),
  ).toHaveLength(1);
  expect(
    h.bd.calls.some(
      (args) =>
        args[0] === "--readonly" &&
        args[1] === "comments" &&
        args[2] === beadId,
    ),
  ).toBe(true);
});

test("commit rechecks the exact current Run stamp and active leaf before claiming a write", async () => {
  const changedRun = await fixture();
  const requestId = "48232184-f1ec-4c25-840c-175c54a19930";
  const preparedResponse = await post(changedRun.h, changedRun.path, {
    requestId,
    expectedEpicId: "alpha-epic",
    expectedRunUpdatedAt: changedRun.run.updatedAt,
    decision: "approve",
    note: "",
  });
  const prepared = await preparedResponse.json();
  await Bun.write(
    join(changedRun.h.root, ".tmp", "work", "forge-runs", "alpha-run.json"),
    JSON.stringify({
      ...changedRun.run,
      updatedAt: "2026-10-29T18:02:00.000Z",
    }),
  );
  const changed = await post(
    changedRun.h,
    `${changedRun.path}/${requestId}/commit`,
    {
      intentHash: prepared.data.intentHash,
    },
  );
  expect(changed.status).toBe(409);
  expect(
    changedRun.h.bd.calls.some(
      (args) => args[0] === "comments" && args[1] === "add",
    ),
  ).toBe(false);

  const inactive = await fixture();
  const inactiveRequestId = "bed48b4b-5da5-47b5-aab6-9be5fdfb7c40";
  const inactivePrepared = await post(inactive.h, inactive.path, {
    requestId: inactiveRequestId,
    expectedEpicId: "alpha-epic",
    expectedRunUpdatedAt: inactive.run.updatedAt,
    decision: "approve",
    note: "",
  });
  const inactiveMeta = await inactivePrepared.json();
  inactive.setCheckpointStatus("open");
  const inactiveCommit = await post(
    inactive.h,
    `${inactive.path}/${inactiveRequestId}/commit`,
    {
      intentHash: inactiveMeta.data.intentHash,
    },
  );
  expect(inactiveCommit.status).toBe(409);
  expect(
    inactive.h.bd.calls.some(
      (args) => args[0] === "comments" && args[1] === "add",
    ),
  ).toBe(false);
});

test("prepare reads the current catalog after its awaited tracker snapshot", async () => {
  const { h, path } = await fixture();
  const previous = h.bd.answer;
  if (!previous) throw Error("Missing fixture export answer.");
  let entered: () => void = () => {};
  let release: () => void = () => {};
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.bd.answer = (args) =>
    args[0] === "export"
      ? (async () => {
          entered();
          await waiting;
          const result = await previous(args);
          if (!result) throw Error("Missing planted export response.");
          return result;
        })()
      : previous(args);
  const requestId = "8fce9262-f16f-4a33-b20b-9d7c927f22e4";
  const pending = post(h, path, {
    requestId,
    expectedEpicId: "alpha-epic",
    expectedRunUpdatedAt: "2026-10-29T18:00:00.000Z",
    decision: "approve",
    note: "",
  });
  await reading;
  const catalog = createProjectStore(h.home).read();
  const project = catalog.projects.find((row) => row.slug === "alpha");
  if (!project?.workspaces[0]) throw Error("Missing current project scope.");
  project.workspaces[0].epicIds = ["changed-epic"];
  writeOwnerOnly(projectCatalogPath(h.home), JSON.stringify(catalog));
  release();
  expect((await pending).status).toBe(503);
  const metadata = await fetch(path, { headers: h.headers(h.hearth.token) });
  expect(metadata.status).toBe(200);
  expect((await metadata.json()).data).toMatchObject({
    items: [],
    activeRequestId: null,
  });
  expect(
    h.bd.calls.some((args) => args[0] === "comments" && args[1] === "add"),
  ).toBe(false);
});
