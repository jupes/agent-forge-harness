import { afterEach, expect, test } from "bun:test";
import type { BeadsIssue } from "../../../types/beads";
import type { ConversationObject } from "../../../types/conversation";
import type { KeeperReadKind } from "../../../types/keeper";
import { ConversationError } from "../../conversations/error";
import { createProjectStore, projectCatalogPath } from "../../projects/store";
import type { ProjectSources } from "../../projects/summary";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
import { keeperAboutValidator, keeperReadRoute } from "./keeper-read";
import type { ProjectSnapshot } from "./project-summaries";

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

async function keeperVisibilityReadFixture() {
  const h = await startTestHearth();
  open.push(h);
  const catalog = projectCatalogFixture(h.workspace);
  writeOwnerOnly(projectCatalogPath(h.home), JSON.stringify(catalog));
  const source: ProjectSources = {
    workspace: h.workspace,
    asOf: "2026-11-08T00:00:00.000Z",
    issues: [],
    queue: [],
    sessions: [],
    sessionsComplete: true,
    problems: [],
  };
  const deps = {
    root: h.root,
    workspace: h.workspace,
    ledgerPath: h.ledger,
    runBd: h.bd.run,
  };
  return {
    h,
    catalog,
    source,
    deps,
    id: catalog.projects[0]!.id,
    store: createProjectStore(h.home),
  };
}

test("Keeper visibility GET denies all kinds and unavailable canonical projects before loading", async () => {
  const f = await keeperVisibilityReadFixture();
  await f.store.updateKeeperVisibility(
    f.id,
    f.catalog.revision,
    "conversation-only",
  );
  let loads = 0;
  const route = keeperReadRoute(f.h.home, f.deps, async () => {
    loads++;
    return { catalog: f.catalog, source: f.source };
  });
  const kinds: KeeperReadKind[] = [
    "beads",
    "queue",
    "sessions",
    "runs",
    "activity",
  ];
  for (const kind of kinds)
    expect((await route.read({ id: f.id, query: { kind } })).status).toBe(409);
  expect(
    (
      await route.read({
        id: "project-00000000-0000-4000-8000-000000000000",
        query: { kind: "beads" },
      })
    ).status,
  ).toBe(404);
  writeOwnerOnly(projectCatalogPath(f.h.home), "{invalid");
  expect(
    (await route.read({ id: f.id, query: { kind: "beads" } })).status,
  ).toBe(503);
  expect(loads).toBe(0);
});

test("Keeper visibility GET semantically matches canonical projects and fences held policy or revision changes", async () => {
  const f = await keeperVisibilityReadFixture();
  const read = (snapshot: ProjectSnapshot) =>
    keeperReadRoute(f.h.home, f.deps, async () => snapshot).read({
      id: f.id,
      query: { kind: "beads" },
    });
  const normal = await read({ catalog: f.catalog, source: f.source });
  expect(normal.status).toBe(200);
  const { id, ...rest } = f.catalog.projects[0]!;
  const reordered = { ...f.catalog, projects: [{ ...rest, id }] };
  expect(await read({ catalog: reordered, source: f.source })).toEqual(normal);
  let sourceGets = 0;
  const guarded = new Proxy(f.source, {
    get() {
      sourceGets++;
      throw Error("Source traversed before canonical fencing");
    },
  });
  const copied = {
    ...f.catalog,
    projects: [{ ...f.catalog.projects[0]!, name: "Copied mismatch" }],
  };
  expect((await read({ catalog: copied, source: guarded })).status).toBe(409);
  expect(sourceGets).toBe(0);
  for (const change of ["policy", "revision"]) {
    const before = await f.store.updateKeeperVisibility(
      f.id,
      f.store.read().revision,
      "project-metadata",
    );
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loads = 0;
    const route = keeperReadRoute(f.h.home, f.deps, async () => {
      loads++;
      entered();
      await held;
      return { catalog: before, source: guarded };
    });
    const reading = route.read({ id: f.id, query: { kind: "beads" } });
    await started;
    try {
      if (change === "policy")
        await f.store.updateKeeperVisibility(
          f.id,
          before.revision,
          "conversation-only",
        );
      else await f.store.preferences(f.id, before.revision, { pinned: true });
    } finally {
      release();
    }
    expect((await reading).status).toBe(409);
    expect(loads).toBe(1);
    expect(sourceGets).toBe(0);
  }
});

test("Keeper visibility about skips empty lists and denies all reference kinds before loading", async () => {
  const f = await keeperVisibilityReadFixture();
  await f.store.updateKeeperVisibility(
    f.id,
    f.catalog.revision,
    "conversation-only",
  );
  let loads = 0;
  const validate = keeperAboutValidator(f.h.home, f.deps, async () => {
    loads++;
    return { catalog: f.catalog, source: f.source };
  });
  const kinds: ConversationObject["kind"][] = [
    "bead",
    "session",
    "run",
    "event",
  ];
  for (const kind of kinds) {
    const failure = await validate(f.id, [{ kind, id: "missing" }]).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConversationError);
    expect(failure).toMatchObject({ status: 409 });
  }
  await validate(f.id, []);
  await validate("project-00000000-0000-4000-8000-000000000000", []);
  writeOwnerOnly(projectCatalogPath(f.h.home), "{invalid");
  await validate(f.id, []);
  expect(loads).toBe(0);
});

test("Keeper visibility about retains member bead and recorded-event membership", async () => {
  const f = await keeperVisibilityReadFixture();
  f.source.issues = ["alpha-epic", "member", "foreign"].map(
    (id): BeadsIssue => ({
      id,
      title: id,
      type: id === "alpha-epic" ? "epic" : "task",
      status: "open",
      createdAt: f.source.asOf,
      updatedAt: f.source.asOf,
      labels: [id === "foreign" ? "project:beta" : "project:alpha"],
      ...(id === "alpha-epic" ? {} : { parent: "alpha-epic" }),
    }),
  );
  const event = (beadId: string) =>
    String(
      f.h.append({
        kind: "prompt.submitted",
        ts: f.source.asOf,
        beadId,
        payload: { hash: "fixture-hash", length: 1 },
      }),
    );
  const validate = keeperAboutValidator(f.h.home, f.deps, async () => ({
    catalog: f.catalog,
    source: f.source,
  }));
  await validate(f.id, [
    { kind: "bead", id: "member" },
    { kind: "event", id: event("member") },
  ]);
  const foreign: ConversationObject[] = [
    { kind: "bead", id: "foreign" },
    { kind: "event", id: event("foreign") },
  ];
  for (const ref of foreign) {
    const failure = await validate(f.id, [ref]).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConversationError);
    expect(failure).toMatchObject({ status: 404 });
  }
});

test("Keeper visibility about fences held policy and revision changes before source traversal", async () => {
  const f = await keeperVisibilityReadFixture();
  let sourceGets = 0;
  const guarded = new Proxy(f.source, {
    get() {
      sourceGets++;
      throw Error("About source traversed before canonical fencing");
    },
  });
  for (const change of ["policy", "revision"]) {
    const before = await f.store.updateKeeperVisibility(
      f.id,
      f.store.read().revision,
      "project-metadata",
    );
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const validate = keeperAboutValidator(f.h.home, f.deps, async () => {
      entered();
      await held;
      return { catalog: before, source: guarded };
    });
    const reading = validate(f.id, [{ kind: "bead", id: "member" }]).catch(
      (error: unknown) => error,
    );
    await started;
    try {
      if (change === "policy")
        await f.store.updateKeeperVisibility(
          f.id,
          before.revision,
          "conversation-only",
        );
      else await f.store.preferences(f.id, before.revision, { pinned: true });
    } finally {
      release();
    }
    const failure = await reading;
    expect(failure).toBeInstanceOf(ConversationError);
    expect(failure).toMatchObject({ status: 409 });
    expect(sourceGets).toBe(0);
  }
});
