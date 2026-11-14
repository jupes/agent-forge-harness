import { expect, test } from "bun:test";
import { createOperatorClient } from "../../../docs/js/operator";
import { TOKEN_ROUTE } from "../../../scripts/hearth/paths";
import {
  type UsageThresholdOriginal,
  usageThresholdJson,
} from "../../../types/usage-threshold-settings";
import { ProjectUsageThresholdSettingsOwner } from "./project-usage-threshold-settings-client";
import {
  createUsageThresholdSettingsController,
  type UsageSettingsContext,
} from "./project-usage-threshold-settings-controller";

const projectId = "project-00000000-0000-4000-8000-000000000001",
  workspace = "/workspace",
  at = "2026-11-11T00:00:00.000Z";
function context(): UsageSettingsContext {
  return {
    connected: true,
    writesAllowed: true,
    homeCurrent: true,
    projectId,
    workspace,
    routeKey: "settings:A",
    active: true,
    home: {
      catalog: {
        version: 1,
        revision: 1,
        projects: [
          {
            id: projectId,
            slug: "alpha",
            name: "Alpha",
            description: "",
            icon: "hammer",
            pinned: false,
            archived: false,
            createdAt: at,
            updatedAt: at,
            workspaces: [{ root: workspace, repositories: [], epicIds: [] }],
          },
        ],
      },
      summaries: [],
      asOf: at,
    },
  };
}
const reply = (data: unknown) => Response.json({ ok: true, data, error: null });
function transport(current: () => UsageSettingsContext) {
  return (read: () => boolean, write: () => boolean) => ({
    read: async (url: string) => {
      if (!read()) throw Error("Scope unavailable");
      return reply(
        url.endsWith("/projects")
          ? current().home?.catalog
          : url.endsWith("/recovery")
            ? { version: 1, complete: true, pending: [] }
            : { projectId, workspace, revision: 0, rules: [] },
      );
    },
    post: async () => {
      expect(write()).toBe(true);
      throw Error("Unknown write result");
    },
  });
}
test("root selects one real immutable-scope owner and navigation retains that exact owner", async () => {
  let current = context();
  const fixture = new ProjectUsageThresholdSettingsOwner(
    { projectId, workspace },
    { read: async () => reply(null), post: async () => reply(null) },
  );
  expect(fixture.snapshot().held).toBeNull();
  const registry = createUsageThresholdSettingsController({
    current: () => current,
    client: transport(() => current),
  });
  const owner = registry.select(projectId, workspace);
  expect(owner).toBeInstanceOf(ProjectUsageThresholdSettingsOwner);
  current = {
    ...current,
    projectId: null,
    active: false,
    routeKey: "providers",
  };
  expect(registry.select(projectId, workspace)).toBe(owner);
});

test("unknown Reserve stays in the same retained owner and a saved callback cannot write after leaving", async () => {
  let current = context(),
    calls = 0;
  const fixtureClient = transport(() => current);
  const registry = createUsageThresholdSettingsController({
    current: () => current,
    client: (read, write) => ({
      ...fixtureClient(read, write),
      post: async () => {
        calls++;
        throw Error("Lost reply");
      },
    }),
  });
  const owner = registry.select(projectId, workspace);
  if (!owner) throw Error("Missing owned fixture scope");
  await owner.refresh();
  await owner.reserve([]);
  const original = owner.snapshot().held?.original;
  expect(owner.snapshot().held?.phase).toBe("unknown");
  expect(calls).toBe(1);
  current = { ...current, active: false, routeKey: "providers" };
  registry.sync();
  await owner.reserve([]);
  await owner.retryReserveNotSent();
  expect(calls).toBe(1);
  expect(owner.snapshot().held?.original).toEqual(original);
  current = { ...current, active: true, routeKey: "settings:A" };
  registry.sync();
  expect(registry.select(projectId, workspace)).toBe(owner);
  expect(owner.snapshot().held?.phase).toBe("unknown");
  registry.close();
  expect(owner.snapshot().disposed).toBe(true);
  expect(owner.snapshot().held?.original).toEqual(original);
});
test("a route epoch change while the real SDK waits for readiness sends zero POSTs", async () => {
  let current = context(),
    pause = false,
    entered = false,
    posts = 0;
  let release!: () => void, markEntered!: () => void;
  const waiting = new Promise<void>((done) => {
    release = done;
  });
  const readyEntered = new Promise<void>((done) => {
    markEntered = done;
  });
  const registry = createUsageThresholdSettingsController({
    current: () => current,
    client: (read, write) =>
      createOperatorClient(
        async (url, init) => {
          if (init?.method === "POST") {
            posts++;
            return reply(null);
          }
          if (url === TOKEN_ROUTE) return reply({ token: "fixture-token" });
          if (!read()) throw Error("Revoked");
          return reply(
            url.endsWith("/projects")
              ? current.home?.catalog
              : url.endsWith("/recovery")
                ? { version: 1, complete: true, pending: [] }
                : { projectId, workspace, revision: 0, rules: [] },
          );
        },
        {
          staticCopy: false,
          ready: async () => {
            if (pause) {
              entered = true;
              markEntered();
              await waiting;
            }
          },
          sessionKeys: { get: () => null, set() {} },
          postProblem: () => (write() ? null : "Scope revoked"),
        },
      ),
  });
  const owner = registry.select(projectId, workspace);
  if (!owner) throw Error("Missing scope");
  await owner.refresh();
  expect(owner.snapshot().documentFresh).toBe(true);
  pause = true;
  const attempt = owner.reserve([]);
  await readyEntered;
  expect(entered).toBe(true);
  current = { ...current, active: false, routeKey: "B" };
  registry.sync();
  current = { ...current, active: true, routeKey: "settings:A" };
  registry.sync();
  release();
  await attempt;
  expect(posts).toBe(0);
  expect(owner.snapshot().held?.phase).toBe("not-sent");
});
test("fresh one-shot review permits obey live grant and exact Discard survives catalog removal", async () => {
  let current = context(),
    calls = 0,
    original: UsageThresholdOriginal | null = null,
    originalHash = "",
    phase = "reserved";
  const document = { projectId, workspace, revision: 0, rules: [] };
  const intent = () => ({
    origin: "reservation",
    phase,
    original,
    originalHash,
    reservedAt: at,
    discardedAt: phase === "discarded" ? at : null,
    receipt: null,
    document,
  });
  const registry = createUsageThresholdSettingsController({
    current: () => current,
    client: (read, write) => ({
      read: async (url) => {
        expect(read()).toBe(true);
        return reply(
          url.endsWith("/projects")
            ? current.home?.catalog
            : url.endsWith("/recovery")
              ? { version: 1, complete: true, pending: [] }
              : url.endsWith("/reservation")
                ? intent()
                : document,
        );
      },
      post: async (url, body) => {
        expect(write()).toBe(true);
        calls++;
        if (url.endsWith("/requests")) {
          original = {
            ...(body as Omit<UsageThresholdOriginal, "projectId">),
            projectId,
          };
          const digest = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(usageThresholdJson(original)),
          );
          originalHash = Array.from(new Uint8Array(digest), (b) =>
            b.toString(16).padStart(2, "0"),
          ).join("");
        } else phase = "discarded";
        return reply(intent());
      },
    }),
  });
  const owner = registry.select(projectId, workspace);
  if (!owner) throw Error("Missing scope");
  await owner.refresh();
  await owner.reserve([]);
  await owner.check();
  const permit = owner.confirmReview(owner.snapshot().review, "apply");
  expect(permit).not.toBeNull();
  current = { ...current, writesAllowed: false };
  registry.sync();
  await owner.apply(permit);
  expect(calls).toBe(1);
  expect(owner.confirmReview(owner.snapshot().review, "apply")).toBeNull();
  current = {
    ...current,
    writesAllowed: true,
    home: {
      ...current.home!,
      catalog: { ...current.home!.catalog, revision: 2, projects: [] },
    },
  };
  registry.sync();
  expect(registry.retained(projectId)[0]?.owner).toBe(owner);
  current = { ...current, home: null, homeCurrent: false };
  registry.sync();
  expect(
    registry.select("project-00000000-0000-4000-8000-000000000002", workspace),
  ).toBeNull();
  await owner.check();
  const discard = owner.confirmReview(owner.snapshot().review, "discard");
  expect(discard).not.toBeNull();
  await owner.discard(discard);
  await owner.discard(discard);
  expect(calls).toBe(2);
  expect(owner.snapshot().lastTerminal?.phase).toBe("discarded");
});
test("disconnect never rebinds old originals to a new private home after reconnect", async () => {
  let current = context();
  const registry = createUsageThresholdSettingsController({
    current: () => current,
    client: transport(() => current),
  });
  const owner = registry.select(projectId, workspace);
  if (!owner) throw Error("Missing scope");
  await owner.refresh();
  current = { ...current, connected: false, writesAllowed: false };
  registry.sync();
  current = context();
  registry.sync();
  expect(registry.select(projectId, workspace)).toBe(owner);
  expect(registry.canWrite(owner)).toBe(false);
  expect(registry.notice()).toContain("continuity");
  expect(owner.snapshot().documentFresh).toBe(false);
});
test("retained scopes stop at 64 without evicting any existing owner", () => {
  let current = context();
  const registry = createUsageThresholdSettingsController({
    current: () => current,
    client: transport(() => current),
  });
  const first = registry.select(projectId, workspace);
  for (let i = 2; i <= 65; i++) {
    const id = "project-00000000-0000-4000-8000-" + String(i).padStart(12, "0");
    current = {
      ...current,
      projectId: id,
      routeKey: id,
      home: {
        ...current.home!,
        catalog: {
          ...current.home!.catalog,
          projects: [{ ...current.home!.catalog.projects[0]!, id }],
        },
      },
    };
    const owner = registry.select(id, workspace);
    expect(Boolean(owner)).toBe(i <= 64);
  }
  expect(registry.select(projectId, workspace)).toBe(first);
});

test("all retained owners revoke before a first owner's observer can reuse a later owner's permit", async () => {
  const other = "project-00000000-0000-4000-8000-000000000002";
  let current = context(),
    calls = 0,
    original: UsageThresholdOriginal | null = null,
    originalHash = "",
    attempted = false;
  current.home!.catalog.projects.push({
    ...current.home!.catalog.projects[0]!,
    id: other,
    slug: "beta",
  });
  const document = { projectId: other, workspace, revision: 0, rules: [] };
  const intent = () => ({
    origin: "reservation",
    phase: "reserved",
    original,
    originalHash,
    reservedAt: at,
    discardedAt: null,
    receipt: null,
    document,
  });
  const registry = createUsageThresholdSettingsController({
    current: () => current,
    client: (read, write) => ({
      read: async (url) => {
        expect(read()).toBe(true);
        return reply(
          url.endsWith("/projects")
            ? current.home?.catalog
            : url.endsWith("/recovery")
              ? { version: 1, complete: true, pending: [] }
              : url.endsWith("/reservation")
                ? intent()
                : document,
        );
      },
      post: async (_url, body) => {
        expect(write()).toBe(true);
        calls++;
        original = {
          ...(body as Omit<UsageThresholdOriginal, "projectId">),
          projectId: other,
        };
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(usageThresholdJson(original)),
        );
        originalHash = Array.from(new Uint8Array(digest), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
        return reply(intent());
      },
    }),
  });
  const first = registry.select(projectId, workspace);
  current = { ...current, projectId: other, routeKey: "settings:B" };
  const later = registry.select(other, workspace);
  if (!first || !later) throw Error("Missing two valid scopes");
  await later.refresh();
  await later.reserve([]);
  await later.check();
  const permit = later.confirmReview(later.snapshot().review, "discard");
  expect(permit).not.toBeNull();
  let attempt: Promise<void> | null = null;
  first.subscribe(() => {
    if (!attempted) {
      attempted = true;
      attempt = later.discard(permit);
    }
  });
  current = { ...current, home: { ...current.home! } };
  registry.sync();
  if (attempt) await attempt;
  expect(attempted).toBe(true);
  expect(calls).toBe(1);
  expect(later.snapshot().review).toBeNull();
});
