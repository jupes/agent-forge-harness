import { expect, test } from "bun:test";
import {
  createDeepLinkController,
  parseDeepLink,
  resolveDeepLink,
} from "./deep-link";

const project = (
  id: string,
  beads: string[] = [],
  sessions: string[] = [],
) => ({
  id,
  archived: false,
  readable: true,
  beads: { complete: true, ids: beads },
  sessions: { complete: true, ids: sessions },
});
const index = (...projects: ReturnType<typeof project>[]) => ({
  revision: 7,
  projects,
});

test("three URI kinds decode an object identifier exactly once", () => {
  expect(parseDeepLink("agent-forge://project/project%20alpha")).toEqual({
    kind: "project",
    id: "project alpha",
  });
  expect(parseDeepLink("agent-forge://bead/alpha%2Fchild")).toEqual({
    kind: "bead",
    id: "alpha/child",
  });
  expect(parseDeepLink("agent-forge://session/session%252Fone")).toEqual({
    kind: "session",
    id: "session%2Fone",
  });
});

test("invalid links never supply a route, path, command or authority", () => {
  for (const value of [
    null,
    8,
    "",
    "https://project/a",
    "agent-forge://unknown/a",
    "agent-forge://project/",
    "agent-forge://project/a/b",
    "agent-forge://project/a?root=C:/private",
    "agent-forge://project/a#operator=secret",
    "agent-forge://user@project/a",
    "agent-forge://project:80/a",
    "agent-forge://project/%ZZ",
    "agent-forge://project/%00",
    "agent-forge://project/%7F",
    "agent-forge://project/%ED%A0%80",
    "agent-forge://project/..",
    "agent-forge://project/%20",
    "agent-forge://project/" + "a".repeat(257),
    "agent-forge://project/" + "%61".repeat(700),
  ]) {
    expect(parseDeepLink(value)).toBeNull();
  }
});

test("exact canonical membership resolves all three route builders", () => {
  const data = index(
    project("alpha", ["bead/child"], ["session%2Fone"]),
    project("beta"),
  );
  expect(resolveDeepLink({ kind: "project", id: "alpha" }, data)).toEqual({
    state: "ready",
    route: { projectId: "alpha", destination: "overview", selection: null },
  });
  expect(resolveDeepLink({ kind: "bead", id: "bead/child" }, data)).toEqual({
    state: "ready",
    route: {
      projectId: "alpha",
      destination: "beads",
      selection: { kind: "bead", id: "bead/child" },
    },
  });
  expect(
    resolveDeepLink({ kind: "session", id: "session%2Fone" }, data),
  ).toEqual({
    state: "ready",
    route: {
      projectId: "alpha",
      destination: "sessions",
      selection: { kind: "session", id: "session%2Fone" },
    },
  });
});

test("display names and identifier prefixes never establish membership", () => {
  const data = index(project("alpha", ["different-bead"], ["actual-session"]));
  expect(resolveDeepLink({ kind: "bead", id: "alpha-task" }, data)).toEqual({
    state: "blocked",
    reason: "missing",
  });
  expect(resolveDeepLink({ kind: "session", id: "alpha" }, data)).toEqual({
    state: "blocked",
    reason: "missing",
  });
  expect(resolveDeepLink({ kind: "project", id: "Alpha" }, data)).toEqual({
    state: "blocked",
    reason: "missing",
  });
});

test("multiple owning projects require recovery rather than picking the first", () => {
  const data = index(
    project("alpha", ["shared"], ["same-session"]),
    project("beta", ["shared"], ["same-session"]),
  );
  expect(resolveDeepLink({ kind: "bead", id: "shared" }, data)).toEqual({
    state: "blocked",
    reason: "ambiguous",
  });
  expect(
    resolveDeepLink({ kind: "session", id: "same-session" }, data),
  ).toEqual({ state: "blocked", reason: "ambiguous" });
});

test("an incomplete or inaccessible source cannot prove uniqueness or absence", () => {
  for (const kind of ["bead", "session"] as const) {
    const incomplete = project("beta");
    incomplete[kind === "bead" ? "beads" : "sessions"].complete = false;
    const data = index(project("alpha", ["found"], ["found"]), incomplete);
    expect(resolveDeepLink({ kind, id: "found" }, data)).toEqual({
      state: "blocked",
      reason: "unavailable",
    });
    expect(resolveDeepLink({ kind, id: "missing" }, data)).toEqual({
      state: "blocked",
      reason: "unavailable",
    });
    incomplete.readable = false;
    expect(resolveDeepLink({ kind, id: "found" }, data)).toEqual({
      state: "blocked",
      reason: "unavailable",
    });
  }
});

test("archived project and objects stay archived without a preference write", () => {
  const archived = { ...project("old", ["done"], ["saved"]), archived: true };
  const data = index(archived);
  for (const target of [
    { kind: "project", id: "old" },
    { kind: "bead", id: "done" },
    { kind: "session", id: "saved" },
  ] as const) {
    expect(resolveDeepLink(target, data)).toEqual({
      state: "blocked",
      reason: "archived",
    });
  }
  expect(archived.archived).toBe(true);
});

test("malformed, conflicting or oversized indexes remain unavailable", () => {
  const target = { kind: "project", id: "alpha" } as const;
  for (const data of [
    null,
    {},
    { revision: -1, projects: [] },
    index(project("alpha"), project("alpha")),
    index(project("alpha", ["same", "same"])),
    {
      revision: 1,
      projects: Array.from({ length: 101 }, (_, n) => project(String(n))),
    },
    { revision: 1, projects: [{ ...project("alpha"), path: "C:/private" }] },
  ]) {
    expect(resolveDeepLink(target, data)).toEqual({
      state: "blocked",
      reason: "unavailable",
    });
  }
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("cold activation waits for the authorized connection and then navigates only", async () => {
  const routes: unknown[] = [];
  let reads = 0;
  const owner = createDeepLinkController({
    loadIndex: async () => {
      reads++;
      return index(project("alpha"));
    },
    navigate: (route) => routes.push(route),
    changed: () => {},
  });
  await owner.activate("agent-forge://project/alpha");
  expect(owner.state().phase).toBe("waiting");
  expect(reads).toBe(0);
  expect(routes).toEqual([]);
  await owner.setConnected(true);
  expect(reads).toBe(1);
  expect(routes).toEqual([
    { projectId: "alpha", destination: "overview", selection: null },
  ]);
  expect(owner.state().phase).toBe("opened");
  owner.dispose();
});

test("a newer warm activation aborts and fences an older unresolved target", async () => {
  const old = deferred<unknown>();
  const signals: AbortSignal[] = [];
  const routes: unknown[] = [];
  const owner = createDeepLinkController({
    loadIndex: async (signal) => {
      signals.push(signal);
      return signals.length === 1 ? old.promise : index(project("beta"));
    },
    navigate: (route) => routes.push(route),
    changed: () => {},
  });
  await owner.setConnected(true);
  const earlier = owner.activate("agent-forge://project/alpha");
  await owner.activate("agent-forge://project/beta");
  expect(signals[0]?.aborted).toBe(true);
  old.resolve(index(project("alpha")));
  await earlier;
  expect(routes).toEqual([
    { projectId: "beta", destination: "overview", selection: null },
  ]);
  owner.dispose();
});

test("disconnect holds the current request and late data cannot navigate", async () => {
  const response = deferred<unknown>();
  const routes: unknown[] = [];
  let reads = 0;
  const owner = createDeepLinkController({
    loadIndex: async () => {
      reads++;
      return reads === 1 ? response.promise : index(project("alpha"));
    },
    navigate: (route) => routes.push(route),
    changed: () => {},
  });
  await owner.setConnected(true);
  const pending = owner.activate("agent-forge://project/alpha");
  await owner.setConnected(false);
  response.resolve(index(project("alpha")));
  await pending;
  expect(routes).toEqual([]);
  expect(owner.state().phase).toBe("waiting");
  await owner.setConnected(true);
  expect(routes).toHaveLength(1);
  expect(reads).toBe(2);
  owner.dispose();
});

test("failed reads require explicit retry and never claim a missing target", async () => {
  let reads = 0;
  const routes: unknown[] = [];
  const owner = createDeepLinkController({
    loadIndex: async () => {
      if (++reads === 1) throw Error("private path or transport error");
      return index(project("alpha"));
    },
    navigate: (route) => routes.push(route),
    changed: () => {},
  });
  await owner.setConnected(true);
  await owner.activate("agent-forge://project/alpha");
  expect(owner.state()).toEqual({
    phase: "blocked",
    target: { kind: "project", id: "alpha" },
    reason: "unavailable",
  });
  await owner.setConnected(true);
  expect(reads).toBe(1);
  await owner.retry();
  expect(reads).toBe(2);
  expect(routes).toHaveLength(1);
  owner.dispose();
});

test("dismiss and disposal fence pending work and later activations", async () => {
  for (const action of ["dismiss", "dispose"] as const) {
    const response = deferred<unknown>();
    const routes: unknown[] = [];
    const signals: AbortSignal[] = [];
    const owner = createDeepLinkController({
      loadIndex: async (signal) => {
        signals.push(signal);
        return response.promise;
      },
      navigate: (route) => routes.push(route),
      changed: () => {},
    });
    await owner.setConnected(true);
    const pending = owner.activate("agent-forge://project/alpha");
    owner[action]();
    expect(signals[0]?.aborted).toBe(true);
    response.resolve(index(project("alpha")));
    await pending;
    expect(routes).toEqual([]);
    expect(owner.state().phase).toBe("idle");
    if (action === "dispose")
      await owner.activate("agent-forge://project/alpha");
    expect(routes).toEqual([]);
    owner.dispose();
  }
});

test("invalid activation cancels an old target without reading or exposing link text", async () => {
  const response = deferred<unknown>();
  const routes: unknown[] = [];
  let reads = 0;
  const owner = createDeepLinkController({
    loadIndex: async () => {
      reads++;
      return response.promise;
    },
    navigate: (route) => routes.push(route),
    changed: () => {},
  });
  await owner.setConnected(true);
  const pending = owner.activate("agent-forge://project/alpha");
  await owner.activate("agent-forge://project/alpha?operator=private");
  response.resolve(index(project("alpha")));
  await pending;
  expect(reads).toBe(1);
  expect(routes).toEqual([]);
  expect(owner.state()).toEqual({
    phase: "blocked",
    target: null,
    reason: "invalid",
  });
  owner.dispose();
});
