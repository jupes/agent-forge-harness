import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createProjectRunsClient } from "../../apps/desktop/src/project-runs-client";
import type {
  ProjectRunArtifact,
  ProjectRunDetail,
  ProjectRunRow,
  ProjectRunsPage,
} from "../../types/project-runs";

const projectId = "project-015821b4-4b38-4bf3-9326-71ce9c09ff46";
const foreign = "project-f05a117f-8d19-4906-80f0-75d72835f3e8";
const at = "2026-10-23T12:00:00.000Z";
function row(slug = "alpha-run"): ProjectRunRow {
  return {
    slug,
    feature: slug,
    epic: "alpha-epic",
    mode: "gated",
    health: "running",
    phases: [
      {
        id: "research",
        state: "complete",
        artifact: null,
        artifactMissing: false,
      },
      { id: "plan", state: "active", artifact: null, artifactMissing: false },
      {
        id: "implement",
        state: "locked",
        artifact: null,
        artifactMissing: false,
      },
      { id: "ship", state: "locked", artifact: null, artifactMissing: false },
    ],
    status: { kind: "phase", phase: "plan" },
    completedCount: 1,
    totalPhases: 4,
    gatePassed: null,
    reviewRounds: 0,
    latestVerdict: null,
    updatedAt: at,
    complete: false,
  };
}
function page(slugs = ["alpha-run", "second-run"]): ProjectRunsPage {
  return {
    version: 1,
    projectId,
    workspace: "/workspace",
    checkout: "/checkout",
    asOf: at,
    coverage: "served-checkout-only",
    problems: [],
    runs: slugs.map(row),
  };
}
function detail(slug = "alpha-run"): ProjectRunDetail {
  const { runs: _, ...source } = page();
  return {
    ...source,
    run: row(slug),
    reviews: [],
    gateHistory: [],
    gateHistoryDays: 30,
    earlierGateLimit: 10,
  };
}
function held<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve: (value: T) => resolve(value),
  };
}
const settle = async () => {
  await Bun.sleep(0);
  await Bun.sleep(0);
};

test("initial detail waits for protected membership and a selected run change aborts and fences the older answer", async () => {
  const list = held<unknown>(),
    first = held<unknown>();
  const calls: { slug: string; signal: AbortSignal }[] = [];
  const client = createProjectRunsClient({
    projectId,
    workspace: null,
    list: () => list.promise,
    detail: (slug, signal) => {
      calls.push({ slug, signal });
      return slug === "alpha-run"
        ? first.promise
        : Promise.resolve(detail(slug));
    },
  });
  client.select("alpha-run");
  const load = client.refresh();
  expect(calls).toEqual([]);
  list.resolve(page());
  await load;
  await settle();
  expect(calls.map((call) => call.slug)).toEqual(["alpha-run"]);
  client.select("second-run");
  expect(client.get().detail).toBeNull();
  expect(calls[0]?.signal.aborted).toBe(true);
  await settle();
  first.resolve(detail());
  await settle();
  expect(client.get().detail?.run.slug).toBe("second-run");
  client.dispose();
});

test("a membership refresh fences an old detail, removes a vanished run, and cannot accept a foreign workspace or checkout", async () => {
  let listing = page();
  const old = held<unknown>();
  const client = createProjectRunsClient({
    projectId,
    workspace: "/workspace",
    list: async () => listing,
    detail: () => old.promise,
  });
  await client.refresh();
  client.select("alpha-run");
  listing = page(["second-run"]);
  await client.refresh();
  old.resolve(detail());
  await settle();
  expect(client.get()).toMatchObject({
    selectedSlug: "alpha-run",
    detail: null,
    detailLoading: false,
  });
  expect(client.get().detailError).toContain(
    "not in this project's current run list",
  );
  for (const changed of [
    { workspace: "/foreign" },
    { checkout: "/foreign" },
    { projectId: foreign },
  ]) {
    listing = { ...page(), ...changed };
    await client.refresh();
    expect(client.get().error).toContain("project and served checkout");
    expect(client.get().page?.runs.map((run) => run.slug)).toEqual([
      "second-run",
    ]);
  }
  client.dispose();
});

test("failed background reads retain labelled last-good rows and detail, without accepting mismatched or malformed replacements", async () => {
  let fail = false;
  let selected: unknown = detail();
  const client = createProjectRunsClient({
    projectId,
    workspace: "/workspace",
    list: async () => {
      if (fail) throw Error("Membership unavailable");
      return page();
    },
    detail: async () => selected,
  });
  await client.refresh();
  client.select("alpha-run");
  await settle();
  const before = client.get().detail;
  for (selected of [
    detail("second-run"),
    { ...detail(), workspace: "/foreign" },
    { ...detail(), checkout: "/foreign" },
    { ...detail(), unexpected: true },
  ]) {
    await client.refreshDetail();
    expect(client.get().detail).toBe(before);
    expect(client.get().detailStale).toBe(true);
    expect(client.get().detailError).not.toBe("");
  }
  fail = true;
  const reading = client.refresh();
  expect(client.get().page?.runs.length).toBe(2);
  expect(client.get().detail).toBe(before);
  await reading;
  expect(client.get()).toMatchObject({
    loading: false,
    error: "Membership unavailable",
    detailStale: true,
  });
  client.dispose();
});

test("disposal settles ignored readers and prevents a late scope from painting; a never-resolving read has the existing 45-second bound", async () => {
  const timers = new Map<number, () => void>();
  let id = 0,
    requested = 0,
    paints = 0;
  const old = held<unknown>();
  const client = createProjectRunsClient({
    projectId,
    workspace: null,
    list: () => old.promise,
    detail: async () => detail(),
    timers: {
      set: (callback, delay) => {
        requested = delay;
        timers.set(++id, callback);
        return id;
      },
      clear: (key) => {
        if (typeof key === "number") timers.delete(key);
      },
    },
  });
  client.subscribe(() => {
    paints++;
  });
  const read = client.refresh();
  expect(requested).toBe(45_000);
  for (const callback of timers.values()) callback();
  await read;
  expect(client.get().error).toContain("45 seconds");
  expect(timers.size).toBe(0);
  const pending = client.refresh();
  client.dispose();
  const ended = paints;
  await pending;
  old.resolve(page());
  await settle();
  expect(paints).toBe(ended);
  expect(client.get().page).toBeNull();
  expect(timers.size).toBe(0);
});

test("artifact reads require a completed canonical phase, verify the full body and fence a late response after selection changes", async () => {
  const text = "# Frozen body\n\n<script>must stay text</script>\n";
  const trusted = { ...detail() };
  trusted.run.phases[0] = {
    id: "research",
    state: "complete",
    artifact: "plans/research/alpha-run.md",
    artifactMissing: false,
  };
  let result: ProjectRunArtifact = {
    version: trusted.version,
    projectId: trusted.projectId,
    workspace: trusted.workspace,
    checkout: trusted.checkout,
    asOf: trusted.asOf,
    coverage: trusted.coverage,
    problems: trusted.problems,
    slug: "alpha-run",
    kind: "research",
    artifact: "plans/research/alpha-run.md",
    bytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
    content: text,
  };
  let listing = page();
  let reads = 0;
  const verified = createProjectRunsClient({
    projectId,
    workspace: "/workspace",
    list: async () => listing,
    detail: async () => trusted,
    artifact: async () => {
      reads++;
      return result;
    },
  });
  await verified.refresh();
  verified.select("alpha-run");
  await settle();
  await verified.openArtifact("plan");
  expect(reads).toBe(0);
  await verified.openArtifact("research");
  expect(reads).toBe(1);
  expect(verified.get().artifact?.content).toBe(text);
  expect(verified.get().artifactError).toBe("");

  const planPending = held<unknown>();
  const planDetail = detail();
  planDetail.run.phases[0] = {
    id: "research",
    state: "complete",
    artifact: "plans/research/alpha-run.md",
    artifactMissing: false,
  };
  planDetail.run.phases[1] = {
    id: "plan",
    state: "complete",
    artifact: "plans/drafts/alpha-run.md",
    artifactMissing: false,
  };
  let currentDetail = trusted;
  const crossKind = createProjectRunsClient({
    projectId,
    workspace: "/workspace",
    list: async () => page(),
    detail: async () => currentDetail,
    artifact: async (_slug, kind) =>
      kind === "plan" ? planPending.promise : result,
  });
  await crossKind.refresh();
  crossKind.select("alpha-run");
  await settle();
  await crossKind.openArtifact("research");
  expect(crossKind.get().artifact?.content).toBe(text);
  currentDetail = planDetail;
  await crossKind.refreshDetail();
  expect(crossKind.get().artifactStale).toBe(true);
  const pendingPlan = crossKind.openArtifact("plan");
  expect(crossKind.get().artifactKind).toBe("plan");
  expect(crossKind.get().artifact).toBeNull();
  planPending.resolve({});
  await pendingPlan;
  expect(crossKind.get().artifact).toBeNull();
  expect(crossKind.get().artifactError).not.toBe("");
  crossKind.dispose();

  result = {
    ...result,
    sha256: "0".repeat(64),
  };
  await verified.openArtifact("research");
  expect(verified.get().artifact?.content).toBe(text);
  expect(verified.get().artifactStale).toBe(true);
  expect(verified.get().artifactError).toContain("integrity check");
  result = {
    ...result,
    workspace: "/foreign",
    sha256: createHash("sha256").update(text).digest("hex"),
  };
  await verified.openArtifact("research");
  expect(verified.get().artifact?.content).toBe(text);
  expect(verified.get().artifactError).toContain("verified project");
  expect(verified.get().artifactStale).toBe(true);
  listing = page(["second-run"]);
  await verified.refresh();
  expect(verified.get().artifact).toBeNull();
  verified.dispose();

  const race = held<unknown>();
  const late = createProjectRunsClient({
    projectId,
    workspace: "/workspace",
    list: async () => page(),
    detail: async (slug) => {
      const answer = detail(slug);
      if (slug === "alpha-run")
        answer.run.phases[0] = {
          id: "research",
          state: "complete",
          artifact: "plans/research/alpha-run.md",
          artifactMissing: false,
        };
      return answer;
    },
    artifact: () => race.promise,
  });
  await late.refresh();
  late.select("alpha-run");
  await settle();
  const pending = late.openArtifact("research");
  late.select("second-run");
  race.resolve(result);
  await pending;
  await settle();
  expect(late.get().artifact).toBeNull();
  late.dispose();
});
