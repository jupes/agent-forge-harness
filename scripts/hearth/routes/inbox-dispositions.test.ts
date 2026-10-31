import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInboxDispositionStore } from "../../inbox/disposition-store";
import { resolveCheckout } from "../../ledger/workspace";
import { projectCatalogPath } from "../../projects/store";
import { projectCatalogFixture } from "../../projects/testing";
import type { RouteRequest } from "../api";
import { writeOwnerOnly } from "../token";
import { createInboxDispositionRoutes } from "./inbox-dispositions";

const project = "project-a5832fa0-7a21-403b-8184-44892f0d8d86";
const requestId = "77c37127-1c22-4a2a-8e7d-69cc74ff1201";
const original = {
  requestId,
  expectedCatalogRevision: 1,
  workspace: "C:/work/project",
  item: {
    sourceKind: "unknown-bead-write",
    stableItemId: "bead-write:one",
    sourceRevision: "notice-1",
  },
  expectedRevision: 0,
  operation: "done",
};
const request = (
  body?: unknown,
  params: RouteRequest["params"] = { id: project },
): RouteRequest => ({
  params,
  query: new URLSearchParams(),
  headers: {},
  body,
});

test("Inbox rows are protected reads and the three audited actions", () => {
  const routes = createInboxDispositionRoutes("C:/private", "C:/work/project");
  expect(
    [...routes.reads, ...routes.actions].map(
      (row) => `${row.method} ${row.path}`,
    ),
  ).toEqual([
    "GET /projects/:id/inbox-dispositions",
    "GET /projects/:id/inbox-dispositions/requests/:requestId",
    "POST /projects/:id/inbox-dispositions/requests",
    "POST /projects/:id/inbox-dispositions",
    "POST /projects/:id/inbox-dispositions/requests/:requestId/discard",
  ]);
  expect(
    [...routes.reads, ...routes.actions].every((row) => row.operatorOnly),
  ).toBe(true);
  expect(routes.actions.map((row) => row.action)).toEqual([
    "inbox.disposition.reserve",
    "inbox.disposition.set",
    "inbox.disposition.discard",
  ]);
  expect(routes.actions.map((row) => row.rejectDuplicateBodyKeys)).toEqual([
    true,
    true,
    true,
  ]);
  expect(routes.actions.every((row) => row.maxBodyBytes === 4096)).toBe(true);
});

test("route validators reject query drift, malformed IDs, and extra original fields", () => {
  const routes = createInboxDispositionRoutes("C:/private", "C:/work/project");
  const list = routes.reads[0];
  const exact = routes.reads[1];
  const reserve = routes.actions[0];
  const apply = routes.actions[1];
  const discard = routes.actions[2];
  expect(list?.validate(request()).ok).toBe(true);
  expect(
    list?.validate({ ...request(), query: new URLSearchParams("unknown=1") })
      .ok,
  ).toBe(false);
  expect(
    exact?.validate(request(undefined, { id: project, requestId })).ok,
  ).toBe(true);
  expect(
    exact?.validate(
      request(undefined, { id: project, requestId: "not-a-uuid" }),
    ).ok,
  ).toBe(false);
  expect(reserve?.validate(request(original)).ok).toBe(true);
  expect(
    reserve?.validate(request({ ...original, workspace: "C:/foreign" })).ok,
  ).toBe(false);
  expect(
    reserve?.validate(request({ ...original, sourceState: "resolved" })).ok,
  ).toBe(false);
  expect(apply?.validate(request(original)).ok).toBe(true);
  expect(
    discard?.validate(request(original, { id: project, requestId })).ok,
  ).toBe(true);
  expect(
    discard?.validate(request(original, { id: project, requestId: "bad" })).ok,
  ).toBe(false);
});

test("a post-write uncertain reservation is surfaced as a 504 route reply", async () => {
  const home = mkdtempSync(join(tmpdir(), "forge-inbox-route-uncertain-"));
  try {
    const workspace = resolveCheckout(home).workspace;
    writeOwnerOnly(
      projectCatalogPath(home),
      JSON.stringify(projectCatalogFixture(workspace)),
    );
    const stateFile = join(home, "inbox-dispositions", "state.json");
    const routes = createInboxDispositionRoutes(
      home,
      workspace,
      (privateHome) =>
        createInboxDispositionStore(privateHome, {
          afterWrite() {
            rmSync(stateFile, { force: true });
          },
        }),
    );
    const action = routes.actions[0]!;
    const checked = action.validate(request({ ...original, workspace }));
    if (!checked.ok)
      throw new Error("the valid fixture did not reach the route effect");
    const reply = await action.effect(checked.value);
    expect(reply).toMatchObject({
      status: 504,
      error: expect.stringContaining("Read the exact saved request"),
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
