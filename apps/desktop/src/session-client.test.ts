import { describe, expect, it } from "bun:test";
import type {
  OwnedSessionStartInput,
  OwnedSessionStartRequest,
} from "../../../types/codex-owned-task";
import type {
  SessionStartIdentityMetadata,
  SessionStartIdentityPage,
} from "../../../types/session-start-identities";
import { createSessionsClient } from "./session-client";
import { sessionStartFormReady } from "./session-composer-owner";
import { sessionStartHash } from "./session-start-identities";
import type { VerifiedSessionIdentityScope } from "./session-start-identity-server";

const baseScope: VerifiedSessionIdentityScope = {
  projectId: "project-00000000-0000-4000-8000-000000000001",
  workspace: "C:/fixture/repository",
  generation: 1,
};
const makePage = (
  scope: VerifiedSessionIdentityScope,
  identities: SessionStartIdentityMetadata[] = [],
): SessionStartIdentityPage => ({
  version: 1,
  scope: {
    family: "owned-session-start",
    projectId: scope.projectId,
    workspace: scope.workspace,
  },
  identities,
});
const makeInput = (prompt = "Start fixture"): OwnedSessionStartInput => ({
  smith: "fixture",
  repository: baseScope.workspace,
  worktree: baseScope.workspace,
  launch: { mode: "chat", model: "sonnet", prompt },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function harness() {
  let currentScope = { ...baseScope };
  let writable = true;
  let nextReserveGate: ReturnType<typeof deferred<void>> | null = null;
  let nextReserveEntered: ReturnType<typeof deferred<void>> | null = null;
  const queuedReads: Array<
    (scope: VerifiedSessionIdentityScope) => Promise<SessionStartIdentityPage>
  > = [];
  const requests: OwnedSessionStartRequest[] = [];
  const posts: string[] = [];
  let requestIds = 0;
  let reserves = 0;
  let lists = 0;
  let client!: ReturnType<typeof createSessionsClient>;
  client = createSessionsClient({
    canWrite: () => writable,
    requestId: () => {
      requestIds += 1;
      return "10000000-0000-4000-8000-" + String(requestIds).padStart(12, "0");
    },
    identityScope: () => currentScope,
    identityServer: {
      async list(scope) {
        lists += 1;
        const queued = queuedReads.shift();
        return queued ? queued(scope) : makePage(scope);
      },
      async reserve(
        scope: VerifiedSessionIdentityScope,
        request: OwnedSessionStartRequest,
      ) {
        reserves += 1;
        requests.push(request);
        const gate = nextReserveGate;
        const entered = nextReserveEntered;
        nextReserveGate = null;
        nextReserveEntered = null;
        if (entered) entered.resolve(undefined);
        if (gate) await gate.promise;
        const requestHash = await sessionStartHash(request);
        return {
          scope: {
            family: "owned-session-start" as const,
            projectId: scope.projectId,
            workspace: scope.workspace,
          },
          identity: {
            version: 1 as const,
            requestId: request.requestId,
            requestHash,
            provider: "claude" as const,
            mode: request.launch.mode,
            state: "reserved" as const,
          },
          request,
          requestHash,
        };
      },
      async retire() {
        throw new Error("retire is outside this Start fixture");
      },
    },
    async list() {
      return [];
    },
    async read() {
      return null;
    },
    async post(_projectId, _sessionId, action) {
      posts.push(action);
      return { state: "refused", message: "fixture response" };
    },
    stream() {
      return () => ({ close() {} });
    },
  });
  return {
    client,
    get currentScope() {
      return currentScope;
    },
    setScope(scope: VerifiedSessionIdentityScope) {
      currentScope = scope;
    },
    setWritable(value: boolean) {
      writable = value;
    },
    queueRead(
      read: (
        scope: VerifiedSessionIdentityScope,
      ) => Promise<SessionStartIdentityPage>,
    ) {
      queuedReads.push(read);
    },
    holdNextReserve() {
      const gate = deferred<void>();
      const entered = deferred<void>();
      nextReserveGate = gate;
      nextReserveEntered = entered;
      return { gate, entered: entered.promise };
    },
    get requestIds() {
      return requestIds;
    },
    get reserves() {
      return reserves;
    },
    get lists() {
      return lists;
    },
    requests,
    posts,
  };
}
async function ready(h: ReturnType<typeof harness>) {
  h.client.project(baseScope.projectId);
  await h.client.refreshIdentities(baseScope.projectId);
}

describe("SessionsClient Start identity reads", () => {
  for (const outcome of ["success", "failure", "retarget"] as const) {
    it(`keeps a verified form activatable during refresh while the owner gates ${outcome} before any reserve`, async () => {
      const h = harness(),
        held = deferred<SessionStartIdentityPage>();
      expect(sessionStartFormReady(h.client.project(baseScope.projectId))).toBe(
        false,
      );
      await ready(h);
      h.queueRead(() => held.promise);
      const reading = h.client.refreshIdentities(baseScope.projectId),
        view = h.client.project(baseScope.projectId);
      expect(view.identityLoading).toBe(true);
      expect(sessionStartFormReady(view)).toBe(true);
      const starting = h.client.start(baseScope.projectId, makeInput());
      await Bun.sleep(0);
      expect(h.reserves).toBe(0);
      expect(h.posts).toEqual([]);
      if (outcome === "retarget") {
        h.setScope({ ...baseScope, generation: 2 });
        h.client.identityScopeChanged();
      }
      if (outcome === "failure")
        held.reject(Error("The refreshed page was unavailable"));
      else held.resolve(makePage(baseScope));
      await reading;
      await starting;
      expect(h.reserves).toBe(outcome === "success" ? 1 : 0);
      expect(h.posts).toEqual(outcome === "success" ? ["start"] : []);
      h.client.dispose();
    });
  }
  it("preserves the uncancelled reentrant Start intent until the actual held current read settles", async () => {
    const h = harness();
    const first = makeInput("captured before the read");
    const held = deferred<SessionStartIdentityPage>();
    let startWork: Promise<void> | undefined;
    await ready(h);
    h.queueRead((scope) => {
      startWork = h.client.start(scope.projectId, first);
      return held.promise;
    });

    const refresh = h.client.refreshIdentities(baseScope.projectId);
    expect(h.client.project(baseScope.projectId).identityLoading).toBe(true);
    expect(h.requestIds).toBe(0);
    expect(h.reserves).toBe(0);
    expect(h.posts).toEqual([]);
    expect(startWork).toBeDefined();
    const duplicate = h.client.start(
      baseScope.projectId,
      makeInput("duplicate"),
    );
    first.launch.prompt = "mutated after Start captured the original input";
    await duplicate;
    expect(h.requestIds).toBe(0);
    expect(h.reserves).toBe(0);

    held.resolve(makePage(h.currentScope));
    await refresh;
    await startWork;
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.launch.prompt).toBe("captured before the read");
    expect(h.requestIds).toBe(1);
    expect(h.reserves).toBe(1);
    expect(h.posts).toEqual(["start"]);
  });

  it("cancels only the waiting intent and lets its successor own the same held read", async () => {
    const h = harness();
    const held = deferred<SessionStartIdentityPage>();
    await ready(h);
    h.queueRead(() => held.promise);
    const refresh = h.client.refreshIdentities(baseScope.projectId);
    const cancelled = h.client.start(baseScope.projectId, makeInput("old"));
    expect(h.client.cancelWaitingStart(baseScope.projectId)).toBe(true);
    const successor = h.client.start(
      baseScope.projectId,
      makeInput("successor"),
    );
    expect(h.requestIds).toBe(0);
    expect(h.reserves).toBe(0);
    expect(h.client.project(baseScope.projectId).starting).toBe(true);
    expect(h.client.project(baseScope.projectId).identityLoading).toBe(true);
    await cancelled;
    expect(h.client.project(baseScope.projectId).starting).toBe(true);
    expect(h.client.project(baseScope.projectId).startIdentityError).toBe("");
    held.resolve(makePage(h.currentScope));
    await refresh;
    await successor;

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.launch.prompt).toBe("successor");
    expect(h.posts).toEqual(["start"]);
    expect(h.client.project(baseScope.projectId).startIdentityError).toBe("");
  });

  it("keeps a same-scope failed pass latched when the queued pass later succeeds", async () => {
    const h = harness();
    const failed = deferred<SessionStartIdentityPage>();
    await ready(h);
    h.queueRead(() => failed.promise);
    const refresh = h.client.refreshIdentities(baseScope.projectId);
    const waiting = h.client.start(baseScope.projectId, makeInput());
    void h.client.refreshIdentities(baseScope.projectId);
    failed.reject(new Error("first pass unavailable"));
    await refresh;
    await waiting;

    expect(h.client.project(baseScope.projectId).identityPage).toEqual(
      makePage(h.currentScope),
    );
    expect(h.client.project(baseScope.projectId).identityLoading).toBe(false);
    expect(h.requestIds).toBe(0);
    expect(h.reserves).toBe(0);
    expect(h.posts).toEqual([]);

    await h.client.start(
      baseScope.projectId,
      makeInput("fresh explicit click"),
    );
    expect(h.requestIds).toBe(1);
    expect(h.reserves).toBe(1);
    expect(h.posts).toEqual(["start"]);
  });

  it("does not resume a captured A scope after an A to B to A generation change", async () => {
    const h = harness();
    const held = deferred<SessionStartIdentityPage>();
    await ready(h);
    h.queueRead(() => held.promise);
    const refresh = h.client.refreshIdentities(baseScope.projectId);
    const oldIntent = h.client.start(
      baseScope.projectId,
      makeInput("old generation"),
    );
    h.setScope({
      projectId: "project-00000000-0000-4000-8000-000000000002",
      workspace: "C:/fixture/other-repository",
      generation: 2,
    });
    h.setScope({ ...baseScope, generation: 3 });
    held.resolve(makePage(baseScope));
    await refresh;
    await oldIntent;

    expect(h.requestIds).toBe(0);
    expect(h.reserves).toBe(0);
    expect(h.posts).toEqual([]);
    await h.client.refreshIdentities(baseScope.projectId);
    await h.client.start(baseScope.projectId, makeInput("new generation"));
    expect(h.requestIds).toBe(1);
    expect(h.reserves).toBe(1);
    expect(h.posts).toEqual(["start"]);
  });

  it("keeps loading true and waits through a fully held second coalesced pass", async () => {
    const h = harness();
    const first = deferred<SessionStartIdentityPage>();
    const second = deferred<SessionStartIdentityPage>();
    const secondStarted = deferred<void>();
    await ready(h);
    h.queueRead(() => first.promise);
    h.queueRead(() => {
      secondStarted.resolve(undefined);
      return second.promise;
    });
    const refresh = h.client.refreshIdentities(baseScope.projectId);
    const waiting = h.client.start(baseScope.projectId, makeInput());
    void h.client.refreshIdentities(baseScope.projectId);
    first.resolve(makePage(h.currentScope));
    await secondStarted.promise;

    expect(h.client.project(baseScope.projectId).identityLoading).toBe(true);
    expect(h.requestIds).toBe(0);
    expect(h.reserves).toBe(0);
    expect(h.posts).toEqual([]);

    second.resolve(makePage(h.currentScope));
    await refresh;
    await waiting;
    expect(h.requestIds).toBe(1);
    expect(h.reserves).toBe(1);
    expect(h.posts).toEqual(["start"]);
  });

  it("waits for a successor read published by the prior read's final notification", async () => {
    const h = harness();
    const first = deferred<SessionStartIdentityPage>();
    const second = deferred<SessionStartIdentityPage>();
    const successorStarted = deferred<void>();
    await ready(h);
    h.queueRead(() => first.promise);
    h.queueRead(() => {
      successorStarted.resolve(undefined);
      return second.promise;
    });
    const refresh = h.client.refreshIdentities(baseScope.projectId);
    let armed = true;
    const unsubscribe = h.client.subscribe(() => {
      if (armed && !h.client.project(baseScope.projectId).identityLoading) {
        armed = false;
        void h.client.refreshIdentities(baseScope.projectId);
      }
    });
    const waiting = h.client.start(baseScope.projectId, makeInput());
    first.resolve(makePage(h.currentScope));
    await successorStarted.promise;
    expect(h.client.project(baseScope.projectId).identityLoading).toBe(true);
    expect(h.requestIds).toBe(0);
    expect(h.reserves).toBe(0);

    second.resolve(makePage(h.currentScope));
    await refresh;
    await waiting;
    unsubscribe();
    expect(h.requestIds).toBe(1);
    expect(h.reserves).toBe(1);
    expect(h.posts).toEqual(["start"]);
  });

  it("rechecks write authority after a held read and allows a fresh authorized click", async () => {
    const h = harness();
    const held = deferred<SessionStartIdentityPage>();
    await ready(h);
    h.queueRead(() => held.promise);
    const refresh = h.client.refreshIdentities(baseScope.projectId);
    const waiting = h.client.start(baseScope.projectId, makeInput());
    h.setWritable(false);
    held.resolve(makePage(h.currentScope));
    await refresh;
    await waiting;
    expect(h.requestIds).toBe(0);
    expect(h.reserves).toBe(0);
    expect(h.posts).toEqual([]);

    h.setWritable(true);
    await h.client.start(baseScope.projectId, makeInput("authorized later"));
    expect(h.requestIds).toBe(1);
    expect(h.reserves).toBe(1);
    expect(h.posts).toEqual(["start"]);
  });

  it("does not create a request id for any server-held identity state", async () => {
    for (const state of ["reserved", "attempted", "not-sent"] as const) {
      const h = harness();
      h.client.project(baseScope.projectId);
      h.queueRead((scope) =>
        Promise.resolve(
          makePage(scope, [
            {
              version: 1,
              requestId: "20000000-0000-4000-8000-000000000001",
              requestHash: "a".repeat(64),
              provider: "claude",
              mode: "chat",
              state,
            },
          ]),
        ),
      );
      await h.client.refreshIdentities(baseScope.projectId);
      await h.client.start(baseScope.projectId, makeInput());
      expect(h.requestIds).toBe(0);
      expect(h.reserves).toBe(0);
      expect(h.posts).toEqual([]);
    }
  });

  it("settles a waiting intent on dispose without aborting or replaying Start", async () => {
    const h = harness();
    const held = deferred<SessionStartIdentityPage>();
    await ready(h);
    h.queueRead(() => held.promise);
    const refresh = h.client.refreshIdentities(baseScope.projectId);
    const waiting = h.client.start(baseScope.projectId, makeInput());
    h.client.dispose();
    await waiting;
    expect(h.requestIds).toBe(0);
    expect(h.reserves).toBe(0);
    expect(h.posts).toEqual([]);
    held.resolve(makePage(h.currentScope));
    await refresh;
    expect(h.requestIds).toBe(0);
    expect(h.reserves).toBe(0);
    expect(h.posts).toEqual([]);
  });

  it("makes cancellation a no-op once the actual reserve call has begun", async () => {
    const h = harness();
    const reserve = h.holdNextReserve();
    await ready(h);
    const startWork = h.client.start(baseScope.projectId, makeInput());
    await reserve.entered;
    expect(h.reserves).toBe(1);
    expect(h.client.cancelWaitingStart(baseScope.projectId)).toBe(false);
    reserve.gate.resolve(undefined);
    await startWork;
    expect(h.reserves).toBe(1);
    expect(h.posts).toEqual(["start"]);
  });
});
