import { expect, test } from "bun:test";
import type { ProjectsHome } from "../../../types/project-summary";
import { createCommandPaletteIndex } from "./command-palette-index";

const home = (count: number): ProjectsHome => ({
  catalog: {
    version: 1,
    revision: 8,
    projects: Array.from({ length: count }, (_, index) => ({
      id: index === 0 ? "project-a5832fa0-7a21-403b-8184-44892f0d8d86" : "project-b5832fa0-7a21-403b-8184-44892f0d8d86",
      slug: index === 0 ? "alpha" : "beta",
      name: index === 0 ? "Alpha" : "Beta",
      description: "",
      icon: "default",
      workspaces: [{ root: "/workspace/shared", repositories: [], epicIds: [] }],
      pinned: false,
      archived: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
  },
  summaries: Array.from({ length: count }, (_, index) => ({
    projectId: index === 0 ? "project-a5832fa0-7a21-403b-8184-44892f0d8d86" : "project-b5832fa0-7a21-403b-8184-44892f0d8d86",
    workspace: "/workspace/shared",
    asOf: "2026-01-01T00:00:00.000Z",
    complete: true,
    problems: [],
    beads: null,
    queue: null,
    needsYou: [],
    sessions: [],
    sessionsComplete: true,
    runs: [],
    lastActivity: null,
  })),
  asOf: "2026-01-01T00:00:00.000Z",
});

const projectIds = [
  "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  "project-b5832fa0-7a21-403b-8184-44892f0d8d86",
] as const;
const beadPage = (projectId: string) => ({
  projectId, workspace: "/workspace/shared", asOf: "2026-10-30T12:00:00.000Z", complete: true, problems: [],
  beads: ["epic", "task"].map((type) => ({
    id: type === "epic" ? `${projectId}-epic` : `${projectId}-checkpoint`,
    title: `${projectId} ${type}`, type, status: type === "epic" ? "open" : "in_progress", priority: 2,
    parent: type === "epic" ? null : `${projectId}-epic`, assignee: null, owner: null,
    labels: [], createdAt: "2026-10-30T12:00:00.000Z", updatedAt: "2026-10-30T12:00:00.000Z", due: null,
    description: "", acceptanceCriteria: "", estimate: null, spent: null, ready: false, blocked: false,
    blockers: [], unavailableBlockers: 0, queue: null, smith: null, comments: [], commentsComplete: true, detailsLoaded: true,
  })),
  dependencies: [],
});
const runPage = (projectId: string, complete: boolean) => {
  const run = {
    slug: "alpha", feature: "Feature row", epic: `${projectId}-epic`, mode: "gated", health: "running",
    phases: [
      { id: "research", state: "active", artifact: "plans/research/alpha.md", artifactMissing: false },
      { id: "plan", state: "locked", artifact: "plans/drafts/alpha.md", artifactMissing: false },
      { id: "implement", state: "locked", artifact: null, artifactMissing: false },
      { id: "ship", state: "locked", artifact: "reports/alpha-ship.md", artifactMissing: false },
    ],
    status: { kind: "phase", phase: "research" }, completedCount: 0, totalPhases: 4, gatePassed: null,
    reviewRounds: 0, latestVerdict: null, updatedAt: "2026-10-30T12:00:00.000Z", complete,
  };
  const source = { version: 1, projectId, workspace: "/workspace/shared", checkout: "/workspace/shared", asOf: "2026-10-30T12:00:00.000Z", coverage: "served-checkout-only", problems: [] };
  return { page: { ...source, runs: [run] }, detail: { ...source, run, reviews: [], gateHistory: [], gateHistoryDays: 30, earlierGateLimit: 10 } };
};
const sessionsPage = (projectId: string) => ({
  projectId, workspace: "/workspace/shared", asOf: "2026-10-30T12:00:00.000Z",
  observations: [{ sessionId: `${projectId}-session`, workspace: "/workspace/shared", kind: "interactive", lastEventAt: "2026-10-30T12:00:00.000Z", beadId: `${projectId}-epic` }],
  observationsComplete: true, ownership: { available: true, records: [], reason: null }, problems: [],
});
const councilHistory = (projectId: string) => ({
  version: 1, projectId, workspace: "/workspace/shared", activeRequestId: null, total: 1, omitted: 0,
  items: [{ requestId: projectId === projectIds[0] ? "9f46f619-9750-4b30-9e86-bf43ebcabc01" : "9f46f619-9750-4b30-9e86-bf43ebcabc02", runId: "alpha", intentHash: "a".repeat(64), state: "completed", phase: "completed", sourceType: "bead", sourceName: "Saved bead result", profileId: "reviewer", profileTitle: "Review", depth: "quick", createdAt: "2026-10-30T12:00:00.000Z", updatedAt: "2026-10-30T12:00:00.000Z" }],
});

test("independent source failures retain read-only project rows and share a three-read bound", async () => {
  let active = 0;
  let maximum = 0;
  const read = async () => {
    active++;
    maximum = Math.max(maximum, active);
    await Promise.resolve();
    active--;
    return null;
  };
  const controller = new AbortController();
  const indexer = createCommandPaletteIndex({
    readBeads: read,
    readSessions: read,
    readRuns: read,
    readCouncil: read,
  });
  const snapshot = await indexer.refresh({
    generation: 1,
    scope: { catalogRevision: 8, routeGeneration: 2, projectId: "project-0", workspace: "/workspace/project-0", writesAllowed: false, nativeAvailable: false },
    home: home(2),
    signal: controller.signal,
    isCurrent: () => true,
  });
  expect(maximum).toBeLessThanOrEqual(3);
  expect(snapshot.rows.filter((row) => row.kind === "project").map((row) => row.label)).toEqual(["Alpha", "Beta"]);
  for (const projectId of ["project-a5832fa0-7a21-403b-8184-44892f0d8d86", "project-b5832fa0-7a21-403b-8184-44892f0d8d86"]) {
    expect(snapshot.sources[`beads:${projectId}`]?.coverage).toBe("unavailable");
    expect(snapshot.sources[`sessions:${projectId}`]?.coverage).toBe("unavailable");
    expect(snapshot.sources[`runs:${projectId}`]?.coverage).toBe("unavailable");
    expect(snapshot.sources[`council:${projectId}`]?.coverage).toBe("unavailable");
  }
  expect(snapshot.rows.some((row) => row.projectId === "project-b5832fa0-7a21-403b-8184-44892f0d8d86" && row.intent?.kind === "navigate" && row.intent.route.projectId === "project-a5832fa0-7a21-403b-8184-44892f0d8d86")).toBe(false);
});

test("valid scoped sources preserve sibling rows, mark incomplete Runs partial, and bind review targets exactly", async () => {
  const indexer = createCommandPaletteIndex({
    readBeads: async (id) => id === projectIds[1] ? { ...beadPage(id), workspace: "/workspace/foreign" } : beadPage(id),
    readSessions: async (id) => { if (id === projectIds[1]) throw Error("one source failed"); return sessionsPage(id); },
    readRuns: async (id) => runPage(id, id === projectIds[0]),
    readCouncil: async (id) => councilHistory(id),
  });
  const controller = new AbortController();
  const snapshot = await indexer.refresh({
    generation: 9,
    scope: { catalogRevision: 8, routeGeneration: 2, projectId: projectIds[0], workspace: "/workspace/shared", writesAllowed: true, nativeAvailable: false },
    home: home(2), signal: controller.signal, isCurrent: () => true,
    selectedRun: { projectId: projectIds[0], slug: "alpha" },
  });
  expect(snapshot.sources[`beads:${projectIds[0]}`]?.coverage).toBe("available");
  expect(snapshot.sources[`beads:${projectIds[1]}`]?.coverage).toBe("unavailable");
  expect(snapshot.sources[`sessions:${projectIds[0]}`]?.coverage).toBe("available");
  expect(snapshot.sources[`sessions:${projectIds[1]}`]?.coverage).toBe("unavailable");
  expect(snapshot.sources[`runs:${projectIds[0]}`]?.coverage).toBe("available");
  expect(snapshot.sources[`runs:${projectIds[1]}`]?.coverage).toBe("partial");
  expect(snapshot.sources[`council:${projectIds[0]}`]?.coverage).toBe("available");
  expect(snapshot.rows.some((row) => row.kind === "session" && row.projectId === projectIds[0] && row.id === `${projectIds[0]}-session`)).toBe(true);
  expect(snapshot.rows.some((row) => row.kind === "run" && row.projectId === projectIds[1] && row.id === "alpha")).toBe(true);
  expect(snapshot.rows.some((row) => row.kind === "bead" && row.projectId === projectIds[1])).toBe(false);
  expect(snapshot.rows.some((row) => row.kind === "review" && row.projectId === projectIds[0] && row.intent?.kind === "review" && row.intent.target.kind === "checkpoint" && row.intent.target.runSlug === "alpha" && row.intent.target.checkpointId === `${projectIds[0]}-checkpoint` && row.intent.target.runUpdatedAt === "2026-10-30T12:00:00.000Z")).toBe(true);
  expect(snapshot.rows.some((row) => row.kind === "review" && row.projectId === projectIds[0] && row.intent?.kind === "navigate" && row.intent.route.destination === "reviews" && row.intent.route.selection?.id === "9f46f619-9750-4b30-9e86-bf43ebcabc01")).toBe(true);
  expect(snapshot.rows.some((row) => row.projectId === projectIds[1] && row.intent?.kind === "navigate" && row.intent.route.projectId === projectIds[0])).toBe(false);
});

test("superseded generation cannot publish a partial snapshot", async () => {
  const controller = new AbortController();
  const indexer = createCommandPaletteIndex({
    readBeads: async () => null,
    readSessions: async () => null,
    readRuns: async () => null,
    readCouncil: async () => null,
  });
  await expect(indexer.refresh({
    generation: 3,
    scope: { catalogRevision: 8, routeGeneration: 4, projectId: null, workspace: null, writesAllowed: true, nativeAvailable: false },
    home: home(1),
    signal: controller.signal,
    isCurrent: () => false,
  })).rejects.toThrow("superseded");
});

test("aborting an in-flight protected source stops later producers and rejects publication", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let laterReads = 0;
  const indexer = createCommandPaletteIndex({
    readBeads: async (_id, signal) => new Promise((_resolve, reject) => {
      started();
      signal.addEventListener("abort", () => reject(Error("read aborted")), { once: true });
    }),
    readSessions: async () => { laterReads++; return null; },
    readRuns: async () => { laterReads++; return null; },
    readCouncil: async () => { laterReads++; return null; },
  });
  const pending = indexer.refresh({
    generation: 10,
    scope: { catalogRevision: 8, routeGeneration: 2, projectId: null, workspace: null, writesAllowed: false, nativeAvailable: false },
    home: home(1), signal: controller.signal, isCurrent: () => true,
  });
  await entered;
  controller.abort();
  await expect(pending).rejects.toThrow("superseded");
  expect(laterReads).toBe(0);
});

test("publishes a verified sibling while the next source remains explicitly loading", async () => {
  let releaseSessions!: (value: unknown) => void;
  const sessionsPending = new Promise<unknown>((resolve) => { releaseSessions = resolve; });
  let sessionsStarted!: () => void;
  const sessionReadStarted = new Promise<void>((resolve) => { sessionsStarted = resolve; });
  const snapshots: import("./command-palette-index").PaletteIndexSnapshot[] = [];
  const indexer = createCommandPaletteIndex({
    readBeads: async () => beadPage(projectIds[0]),
    readSessions: async () => { sessionsStarted(); return sessionsPending; },
    readRuns: async () => null,
    readCouncil: async () => null,
  });
  const controller = new AbortController();
  const pending = indexer.refresh({
    generation: 11,
    scope: { catalogRevision: 8, routeGeneration: 2, projectId: projectIds[0], workspace: "/workspace/shared", writesAllowed: true, nativeAvailable: false },
    home: home(1), signal: controller.signal, isCurrent: () => true,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  await sessionReadStarted;
  const progress = snapshots.find((snapshot) => snapshot.rows.some((row) => row.kind === "bead" && row.projectId === projectIds[0]));
  expect(progress?.sources[`beads:${projectIds[0]}`]?.coverage).toBe("available");
  expect(progress?.sources[`sessions:${projectIds[0]}`]?.coverage).toBe("loading");
  expect(progress?.sources[`runs:${projectIds[0]}`]?.coverage).toBe("loading");
  releaseSessions(sessionsPage(projectIds[0]));
  const final = await pending;
  expect(final.sources[`sessions:${projectIds[0]}`]?.coverage).toBe("available");
});
