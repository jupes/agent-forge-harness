import { expect, test } from "bun:test";
import { NotSent } from "../../../docs/js/operator";
import {
  usageThresholdIntentSchema,
  usageThresholdPendingSchema,
  usageThresholdRecoverySchema,
} from "../../../types/usage-threshold-intents";
import {
  type UsageThresholdOriginal,
  usageThresholdJson,
  usageThresholdOriginalSchema,
} from "../../../types/usage-threshold-settings";
import {
  ProjectUsageThresholdSettingsOwner,
  type UsageThresholdSettingsDependencies,
} from "./project-usage-threshold-settings-client";

const projectId = "project-00000000-0000-4000-8000-000000000001";
const requestId = "10000000-0000-4000-8000-000000000001";
const workspace = "/workspace";
const instant = "2026-11-11T12:00:00.000Z";
const rule = {
  id: "20000000-0000-4000-8000-000000000001",
  provider: "codex",
  enabled: true,
  selector: {
    kind: "subscription-window",
    unit: "percent",
    source: "provider-cli",
    label: "five-hour window",
    basis: "used",
  },
  comparison: "at-least",
  threshold: 80,
} as const;
const original = usageThresholdOriginalSchema.parse({
  projectId,
  requestId,
  workspace,
  expectedCatalogRevision: 2,
  expectedRevision: 0,
  rules: [rule],
});
async function hash(value: UsageThresholdOriginal): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(usageThresholdJson(value)),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
async function pending(value = original) {
  return usageThresholdPendingSchema.parse({
    original: value,
    originalHash: await hash(value),
    reservedAt: instant,
  });
}
function document(revision = 0) {
  return { projectId, workspace, revision, rules: revision ? [rule] : [] };
}
async function reserved(value = original) {
  return usageThresholdIntentSchema.parse({
    origin: "reservation",
    phase: "reserved",
    ...(await pending(value)),
    discardedAt: null,
    receipt: null,
    document: {
      ...document(value.expectedRevision),
      projectId: value.projectId,
      workspace: value.workspace,
    },
  });
}
function ok(data: unknown, status = 200) {
  return new Response(JSON.stringify({ ok: true, data, error: null }), {
    status,
  });
}
function catalog() {
  return {
    version: 1,
    revision: 2,
    projects: [
      {
        id: projectId,
        slug: "demo",
        name: "Demo",
        description: "",
        icon: "sparkles",
        archived: false,
        pinned: false,
        createdAt: instant,
        updatedAt: instant,
        workspaces: [{ root: workspace, repositories: [], epicIds: [] }],
      },
    ],
  };
}
test("controls use valid complete producer originals, real hashes and legacy receipt semantics", async () => {
  expect(await hash(original)).toBe(
    "8903c93f26a3a9838fb7672396b0e785616eb95f503d9e32a94fa74fd626f0df",
  );
  const recovery = usageThresholdRecoverySchema.parse({
    version: 1,
    complete: true,
    pending: [await pending()],
  });
  expect(recovery.pending[0]?.original).toEqual(original);
  const legacy = usageThresholdIntentSchema.parse({
    origin: "legacy-receipt",
    phase: "applied",
    original,
    originalHash: await hash(original),
    reservedAt: null,
    discardedAt: null,
    receipt: {
      original,
      originalHash: await hash(original),
      outcome: "applied",
      observedRevision: 0,
      resultingRevision: 1,
      settledAt: instant,
      refusalCode: null,
    },
    document: document(1),
  });
  expect(legacy.reservedAt).toBeNull();
  expect(legacy.receipt?.resultingRevision).toBe(1);
});

function fixture(
  options: Pick<UsageThresholdSettingsDependencies, "crypto"> = {},
) {
  const reads: Array<{ url: string; limit: number | undefined }> = [];
  const posts: Array<{
    url: string;
    body: unknown;
    limit: number | undefined;
  }> = [];
  const state: {
    catalog: unknown;
    current: unknown;
    recovery: unknown;
    exact: unknown;
  } = {
    catalog: catalog(),
    current: document(),
    recovery: { version: 1, complete: true, pending: [] },
    exact: null,
  };
  let mint = requestId;
  let readHook: ((url: string) => Promise<Response>) | null = null;
  let postHook: (url: string, body: unknown) => Promise<Response> =
    async () => {
      throw new Error("private transport failure");
    };
  const owner = new ProjectUsageThresholdSettingsOwner(
    { projectId, workspace },
    {
      ...options,
      requestId: () => mint,
      read: async (url, _init, limits) => {
        reads.push({ url, limit: limits?.maxBodyBytes });
        if (readHook) return readHook(url);
        if (url === "/__agent-forge/projects") return ok(state.catalog);
        if (url.endsWith("/recovery")) return ok(state.recovery);
        if (url.includes("/requests/"))
          return state.exact
            ? ok(state.exact)
            : new Response(
                JSON.stringify({
                  ok: false,
                  data: null,
                  error: "private missing",
                }),
                { status: 404 },
              );
        return ok(state.current);
      },
      post: async (url, body, limits) => {
        posts.push({
          url,
          body: structuredClone(body),
          limit: limits?.maxBodyBytes,
        });
        return postHook(url, body);
      },
    },
  );
  return {
    owner,
    state,
    reads,
    posts,
    mint: (value: string) => {
      mint = value;
    },
    onRead: (value: typeof readHook) => {
      readHook = value;
    },
    onPost: (value: typeof postHook) => {
      postHook = value;
    },
  };
}
test("explicit Reserve retains one exact unknown original and never dispatches Apply", async () => {
  const f = fixture();
  await f.owner.refresh();
  expect(f.owner.snapshot().document?.revision).toBe(0);
  expect(f.owner.snapshot().recoveryFresh).toBe(true);
  await f.owner.reserve(original.rules);
  expect(f.posts).toHaveLength(1);
  expect(f.posts[0]?.url).toEndWith("/settings/usage-thresholds/requests");
  expect(f.posts[0]?.body).toEqual({
    requestId,
    workspace,
    expectedCatalogRevision: 2,
    expectedRevision: 0,
    rules: [rule],
  });
  expect(f.owner.snapshot().held?.original).toEqual(original);
  expect(f.owner.snapshot().held?.uncertain).toBe("reserve");
  const permit = f.owner.confirmReview(f.owner.snapshot().review, "apply");
  await f.owner.apply(permit);
  await f.owner.reserve([]);
  expect(f.posts).toHaveLength(1);
});

async function applied(value = original) {
  return {
    receipt: {
      original: value,
      originalHash: await hash(value),
      outcome: "applied",
      observedRevision: value.expectedRevision,
      resultingRevision: value.expectedRevision + 1,
      settledAt: instant,
      refusalCode: null,
    },
    document: {
      projectId: value.projectId,
      workspace: value.workspace,
      revision: value.expectedRevision + 1,
      rules: value.rules,
    },
  };
}
test("recovered reservations require the same checked view and one action-bound permit", async () => {
  const f = fixture();
  f.state.recovery = { version: 1, complete: true, pending: [await pending()] };
  f.state.exact = await reserved();
  await f.owner.refresh();
  expect(f.owner.snapshot().held?.original).toEqual(original);
  expect(f.owner.confirmReview(f.owner.snapshot().review, "apply")).toBeNull();
  await f.owner.check();
  const view = f.owner.snapshot().review;
  expect(view?.original).toEqual(original);
  const permit = f.owner.confirmReview(view, "apply");
  expect(permit).not.toBeNull();
  f.onPost(async () => ok(await applied()));
  await Promise.all([f.owner.apply(permit), f.owner.apply(permit)]);
  expect(f.posts).toHaveLength(1);
  expect(f.posts[0]?.url).toEndWith("/settings/usage-thresholds");
  expect(f.owner.snapshot().held).toBeNull();
  expect(f.owner.snapshot().lastTerminal?.phase).toBe("applied");
});

async function discarded(value = original) {
  return usageThresholdIntentSchema.parse({
    ...(await reserved(value)),
    phase: "discarded",
    discardedAt: instant,
  });
}
async function terminalApplied(value = original) {
  const record = await applied(value);
  return usageThresholdIntentSchema.parse({
    ...(await reserved(value)),
    phase: "applied",
    receipt: record.receipt,
    document: record.document,
  });
}
test("known terminal originals cannot be resurrected by valid pending or reserved observations", async () => {
  for (const source of ["recovery", "exact"]) {
    const f = fixture();
    f.state.exact = await discarded();
    await f.owner.check(requestId);
    expect(f.owner.snapshot().lastTerminal?.phase).toBe("discarded");
    if (source === "recovery") {
      f.state.recovery = {
        version: 1,
        complete: true,
        pending: [await pending()],
      };
      await f.owner.refresh();
    } else {
      f.state.exact = await reserved();
      await f.owner.check(requestId);
    }
    expect(f.owner.snapshot().held).toBeNull();
    expect(f.owner.snapshot().review).toBeNull();
    expect(f.owner.snapshot().lastTerminal?.phase).toBe("discarded");
    expect(
      f.owner.confirmReview(f.owner.snapshot().review, "discard"),
    ).toBeNull();
    expect(f.posts).toHaveLength(0);
  }
});
test("a later schema-valid terminal cannot change an immutable receipt timestamp", async () => {
  const f = fixture();
  f.state.exact = await terminalApplied();
  await f.owner.check(requestId);
  expect(f.owner.snapshot().lastTerminal?.value.receipt?.settledAt).toBe(
    instant,
  );
  const altered = await terminalApplied();
  altered.receipt!.settledAt = "2026-11-11T12:00:00.001Z";
  f.state.exact = usageThresholdIntentSchema.parse(altered);
  await f.owner.check(requestId);
  expect(f.owner.snapshot().lastTerminal?.value.receipt?.settledAt).toBe(
    instant,
  );
  expect(f.owner.snapshot().held).toBeNull();
});

async function reviewedFixture() {
  const f = fixture();
  f.state.recovery = { version: 1, complete: true, pending: [await pending()] };
  f.state.exact = await reserved();
  await f.owner.refresh();
  await f.owner.check();
  expect(f.owner.snapshot().review).not.toBeNull();
  return f;
}
test("unknown Reserve survives absence and needs an exact positive reservation before review", async () => {
  const f = fixture();
  await f.owner.refresh();
  await f.owner.reserve(original.rules);
  await f.owner.refresh();
  await f.owner.check();
  expect(f.owner.snapshot().held?.uncertain).toBe("reserve");
  expect(f.owner.snapshot().review).toBeNull();
  expect(f.posts).toHaveLength(1);
  f.state.exact = await reserved();
  await f.owner.check();
  expect(f.owner.snapshot().held?.phase).toBe("reserved");
  expect(f.owner.snapshot().review).not.toBeNull();
  expect(f.posts).toHaveLength(1);
});
test("reserved reads never settle unknown Apply or Discard, but exact terminal evidence does", async () => {
  for (const action of ["apply", "discard"] as const) {
    const f = await reviewedFixture();
    const permit = f.owner.confirmReview(f.owner.snapshot().review, action);
    await f.owner[action](permit);
    expect(f.owner.snapshot().held?.uncertain).toBe(action);
    await f.owner.check();
    expect(f.owner.snapshot().held?.uncertain).toBe(action);
    expect(f.owner.snapshot().review).toBeNull();
    await f.owner.apply(
      f.owner.confirmReview(f.owner.snapshot().review, "apply"),
    );
    await f.owner.discard(
      f.owner.confirmReview(f.owner.snapshot().review, "discard"),
    );
    expect(f.posts).toHaveLength(1);
    f.state.exact =
      action === "apply" ? await discarded() : await terminalApplied();
    await f.owner.check();
    expect(f.owner.snapshot().held).toBeNull();
    expect(f.owner.snapshot().lastTerminal?.phase).toBe(
      action === "apply" ? "discarded" : "applied",
    );
  }
});
test("known NotSent Reserve has one explicit same-original retry after fresh verification", async () => {
  const f = fixture();
  f.onPost(async () => {
    throw new NotSent("private token failure");
  });
  await f.owner.refresh();
  await f.owner.reserve(original.rules);
  expect(f.owner.snapshot().held?.phase).toBe("not-sent");
  await f.owner.retryReserveNotSent();
  expect(f.posts).toHaveLength(1);
  await f.owner.refresh();
  f.mint("10000000-0000-4000-8000-000000000099");
  f.onPost(async () => ok(await reserved()));
  await f.owner.retryReserveNotSent();
  expect(f.posts).toHaveLength(2);
  expect(f.posts[1]?.body).toEqual(f.posts[0]?.body);
  expect(f.owner.snapshot().held?.phase).toBe("reserved");
  expect(f.owner.snapshot().notice).not.toContain("private token");
});
test("Discard remains exact and revision-neutral when the project is removed", async () => {
  const f = await reviewedFixture();
  f.state.catalog = { version: 1, revision: 3, projects: [] };
  await f.owner.check();
  expect(f.owner.confirmReview(f.owner.snapshot().review, "apply")).toBeNull();
  const permit = f.owner.confirmReview(f.owner.snapshot().review, "discard");
  expect(permit).not.toBeNull();
  f.onPost(async () => ok(await discarded()));
  await f.owner.discard(permit);
  expect(f.posts).toHaveLength(1);
  expect(f.posts[0]?.body).toEqual(original);
  expect(f.owner.snapshot().document?.revision).toBe(0);
  expect(f.owner.snapshot().lastTerminal?.phase).toBe("discarded");
});
test("stale, copied, wrong-owner and wrong-action review proofs cannot dispatch", async () => {
  const f = await reviewedFixture();
  const other = await reviewedFixture();
  const view = f.owner.snapshot().review;
  expect(f.owner.confirmReview(view ? { ...view } : null, "apply")).toBeNull();
  const permit = f.owner.confirmReview(view, "apply");
  await other.owner.apply(permit);
  expect(other.posts).toHaveLength(0);
  const checking = f.owner.check();
  await f.owner.apply(permit);
  await checking;
  expect(f.posts).toHaveLength(0);
  const discardPermit = f.owner.confirmReview(
    f.owner.snapshot().review,
    "discard",
  );
  await f.owner.apply(discardPermit);
  await f.owner.discard(discardPermit);
  expect(f.posts).toHaveLength(0);
  f.owner.invalidateContext();
  expect(f.owner.snapshot().review).toBeNull();
  expect(f.owner.confirmReview(view, "discard")).toBeNull();
});
test("old immutable receipts coexist with newer policy and survive subsequent read failure", async () => {
  const f = fixture();
  f.state.current = document(2);
  f.state.exact = await terminalApplied();
  await f.owner.check(requestId);
  expect(f.owner.snapshot().document?.revision).toBe(2);
  expect(
    f.owner.snapshot().lastTerminal?.value.receipt?.resultingRevision,
  ).toBe(1);
  f.onRead(async () => {
    throw new Error("private read failure");
  });
  await f.owner.refresh();
  expect(f.owner.snapshot().document?.revision).toBe(2);
  expect(f.owner.snapshot().documentFresh).toBe(false);
  expect(f.owner.snapshot().lastTerminal?.phase).toBe("applied");
  expect(f.owner.snapshot().notice).not.toContain("private read");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test("capture precedes digest await and context loss before handoff sends nothing", async () => {
  for (const mode of ["capture", "invalidate", "dispose"] as const) {
    const entered = deferred<void>();
    const release = deferred<void>();
    let pause = false;
    const f = fixture({
      crypto: {
        randomUUID: () => requestId,
        subtle: {
          digest: async (algorithm, data) => {
            if (pause) {
              pause = false;
              entered.resolve(undefined);
              await release.promise;
            }
            return crypto.subtle.digest(algorithm, data);
          },
        },
      },
    });
    await f.owner.refresh();
    f.onPost(async () => ok(await reserved()));
    pause = true;
    const draft = structuredClone(original.rules);
    const sending = f.owner.reserve(draft);
    await entered.promise;
    draft[0]!.threshold = 99;
    if (mode === "invalidate") f.owner.invalidateContext();
    if (mode === "dispose") f.owner.dispose();
    release.resolve(undefined);
    await sending;
    expect(f.owner.snapshot().held?.original).toEqual(original);
    expect(f.posts).toHaveLength(mode === "capture" ? 1 : 0);
    if (mode === "capture") {
      expect(f.posts[0]?.body).toEqual({
        requestId,
        workspace,
        expectedCatalogRevision: 2,
        expectedRevision: 0,
        rules: [rule],
      });
      expect(
        Reflect.set(
          f.owner.snapshot().held!.original.rules[0]!,
          "threshold",
          1,
        ),
      ).toBe(false);
    }
    if (mode === "invalidate")
      expect(f.owner.snapshot().held?.phase).toBe("not-sent");
    expect(Object.isFrozen(f.owner.snapshot())).toBe(true);
  }
});
test("final teardown freezes handed-off Apply uncertainty and ignores late success", async () => {
  const f = await reviewedFixture();
  const entered = deferred<void>();
  const response = deferred<Response>();
  f.onPost(async () => {
    entered.resolve(undefined);
    return response.promise;
  });
  const permit = f.owner.confirmReview(f.owner.snapshot().review, "apply");
  const sending = f.owner.apply(permit);
  await entered.promise;
  const handoff = f.owner.dispose();
  expect(handoff.held?.uncertain).toBe("apply");
  expect(handoff.held?.original).toEqual(original);
  expect(Object.isFrozen(handoff.held?.original.rules)).toBe(true);
  response.resolve(ok(await applied()));
  await sending;
  await f.owner.check(requestId);
  await f.owner.reserve([]);
  await f.owner.apply(permit);
  expect(f.owner.snapshot()).toBe(handoff);
  expect(f.posts).toHaveLength(1);
});
test("a late valid refresh cannot restore freshness after context invalidation", async () => {
  const f = fixture();
  await f.owner.refresh();
  const gates = new Map<string, ReturnType<typeof deferred<Response>>>();
  f.onRead(async (url) => {
    const gate = deferred<Response>();
    gates.set(url, gate);
    return gate.promise;
  });
  const reading = f.owner.refresh();
  expect(gates.size).toBe(3);
  f.owner.invalidateContext();
  for (const [url, gate] of gates)
    gate.resolve(
      ok(
        url === "/__agent-forge/projects"
          ? catalog()
          : url.endsWith("/recovery")
            ? { version: 1, complete: true, pending: [] }
            : document(),
      ),
    );
  await reading;
  expect(f.owner.snapshot().catalog?.fresh).toBe(false);
  expect(f.owner.snapshot().documentFresh).toBe(false);
  expect(f.owner.snapshot().recoveryFresh).toBe(false);
  f.onRead(null);
  await f.owner.refresh();
  expect(f.owner.snapshot().documentFresh).toBe(true);
});
test("private thrown objects and post-response NotSent errors stay fixed unknown outcomes", async () => {
  for (const mode of ["thrown", "response"] as const) {
    const f = fixture();
    await f.owner.refresh();
    f.onPost(async () => {
      if (mode === "thrown")
        throw new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error("private prototype secret");
            },
            get() {
              throw new Error("private getter secret");
            },
          },
        );
      const response = ok(await reserved());
      Object.defineProperty(response, "status", {
        get() {
          throw new NotSent("private response secret");
        },
      });
      return response;
    });
    await f.owner.reserve(original.rules);
    expect(f.owner.snapshot().held?.uncertain).toBe("reserve");
    expect(f.owner.snapshot().notice).not.toContain("private");
    expect(f.posts).toHaveLength(1);
  }
});
test("missing WebCrypto cannot create a new dispatch or invented digest", async () => {
  const f = fixture({ crypto: null });
  await f.owner.refresh();
  await f.owner.reserve(original.rules);
  expect(f.posts).toHaveLength(0);
  expect(f.owner.snapshot().held).toBeNull();
  expect(f.owner.snapshot().documentFresh).toBe(false);
});

test("invalid envelopes, decoded duplicate keys, UTF8, hashes, scope and phases stay unknown", async () => {
  const good = await reserved();
  const foreign = await reserved(
    usageThresholdOriginalSchema.parse({
      ...original,
      workspace: "/elsewhere",
    }),
  );
  const other = await reserved(
    usageThresholdOriginalSchema.parse({
      ...original,
      requestId: "10000000-0000-4000-8000-000000000002",
    }),
  );
  const duplicate = JSON.stringify({
    ok: true,
    data: good,
    error: null,
  }).replace(
    '"ok":true',
    '"ok":true,"' + String.fromCharCode(92) + 'u006fk":true',
  );
  const replies: Array<() => Response> = [
    () => ok({ ...good, originalHash: "a".repeat(64) }),
    () => ok(foreign),
    () => ok(other),
    () => ok({ ...good, phase: "applied" }),
    () =>
      new Response(
        JSON.stringify({ ok: true, data: good, error: null, secret: true }),
      ),
    () => new Response(duplicate),
    () => new Response(new Uint8Array([255])),
    () =>
      new Response(
        JSON.stringify({ ok: false, data: null, error: "private conflict" }),
        { status: 409 },
      ),
  ];
  for (const reply of replies) {
    const f = fixture();
    await f.owner.refresh();
    f.onPost(async () => reply());
    await f.owner.reserve(original.rules);
    expect(f.owner.snapshot().held?.uncertain).toBe("reserve");
    expect(f.owner.snapshot().notice).not.toContain("private");
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]?.limit).toBe(4 * 1024 * 1024 + 64 * 1024);
  }
});
test("a successful-looking Discard reply still requires a terminal phase", async () => {
  const f = await reviewedFixture();
  f.onPost(async () => ok(await reserved()));
  await f.owner.discard(
    f.owner.confirmReview(f.owner.snapshot().review, "discard"),
  );
  expect(f.owner.snapshot().held?.uncertain).toBe("discard");
  await f.owner.check();
  expect(f.owner.snapshot().held?.uncertain).toBe("discard");
  expect(f.owner.snapshot().review).toBeNull();
});
test("a complete valid 409 refusal is terminal evidence and preserves legacy times", async () => {
  const f = fixture();
  const legacy = usageThresholdIntentSchema.parse({
    origin: "legacy-receipt",
    phase: "refused",
    original,
    originalHash: await hash(original),
    reservedAt: null,
    discardedAt: null,
    receipt: {
      original,
      originalHash: await hash(original),
      outcome: "refused",
      observedRevision: 1,
      resultingRevision: 1,
      settledAt: instant,
      refusalCode: "policy-revision-conflict",
    },
    document: document(1),
  });
  await f.owner.refresh();
  f.onPost(async () => ok(legacy, 409));
  await f.owner.reserve(original.rules);
  expect(f.owner.snapshot().held).toBeNull();
  expect(f.owner.snapshot().lastTerminal?.phase).toBe("refused");
  expect(f.owner.snapshot().lastTerminal?.value).toEqual(legacy);
  expect(legacy.reservedAt).toBeNull();
});
test("response receiving bounds cancel before an unbounded body finishes", async () => {
  const f = fixture();
  await f.owner.refresh();
  let canceled = false;
  f.onPost(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 64 * 1024 + 1));
          },
          cancel() {
            canceled = true;
          },
        }),
      ),
  );
  await f.owner.reserve(original.rules);
  expect(canceled).toBe(true);
  expect(f.owner.snapshot().held?.uncertain).toBe("reserve");
  expect(
    f.reads.every(
      (row) =>
        row.limit ===
        (row.url === "/__agent-forge/projects"
          ? 128 * 1024
          : 4 * 1024 * 1024 + 64 * 1024),
    ),
  ).toBe(true);
});
function manyRules(label: string) {
  return Array.from({ length: 100 }, (_, index) => ({
    ...rule,
    id: "20000000-0000-4000-8000-" + String(index + 1).padStart(12, "0"),
    selector: { ...rule.selector, label },
  }));
}
test("original byte bounds are independent of character validation and whole-record bounds", async () => {
  const tooLarge = manyRules("é".repeat(2048));
  const validLarge = usageThresholdOriginalSchema.parse({
    ...original,
    rules: tooLarge,
  });
  expect(
    new TextEncoder().encode(usageThresholdJson(validLarge)).byteLength,
  ).toBeGreaterThan(256 * 1024);
  const refused = fixture();
  await refused.owner.refresh();
  await refused.owner.reserve(tooLarge);
  expect(refused.posts).toHaveLength(0);
  const large = usageThresholdOriginalSchema.parse({
    ...original,
    rules: manyRules("A".repeat(1500)),
  });
  const record = await applied(large);
  expect(
    new TextEncoder().encode(usageThresholdJson(large)).byteLength,
  ).toBeLessThan(256 * 1024);
  expect(
    new TextEncoder().encode(usageThresholdJson(record)).byteLength,
  ).toBeGreaterThan(256 * 1024);
  const f = fixture();
  f.onPost(async (url) =>
    url.endsWith("/requests") ? ok(await reserved(large)) : ok(record),
  );
  await f.owner.refresh();
  await f.owner.reserve(large.rules);
  f.state.exact = await reserved(large);
  await f.owner.check();
  await f.owner.apply(
    f.owner.confirmReview(f.owner.snapshot().review, "apply"),
  );
  expect(f.owner.snapshot().lastTerminal?.phase).toBe("applied");
  expect(f.posts).toHaveLength(2);
});
test("complete recovery rejects duplicate scope, duplicate UUID, missing coverage and bad hashes", async () => {
  const first = await pending();
  const second = await pending(
    usageThresholdOriginalSchema.parse({
      ...original,
      requestId: "10000000-0000-4000-8000-000000000002",
    }),
  );
  const f = fixture();
  f.state.recovery = { version: 1, complete: true, pending: [first] };
  await f.owner.refresh();
  const sameScope = { version: 1, complete: true, pending: [first, second] };
  expect(usageThresholdRecoverySchema.safeParse(sameScope).success).toBe(true);
  for (const bad of [
    sameScope,
    { version: 1, complete: true, pending: [first, first] },
    { version: 1, complete: false, pending: [] },
    {
      version: 1,
      complete: true,
      pending: [{ ...first, originalHash: "b".repeat(64) }],
    },
  ]) {
    f.state.recovery = bad;
    await f.owner.refresh();
    expect(f.owner.snapshot().recoveryFresh).toBe(false);
    expect(f.owner.snapshot().recovery?.pending).toEqual([first]);
    expect(f.owner.snapshot().held?.original).toEqual(original);
    expect(f.posts).toHaveLength(0);
  }
});
test("foreign recovery entries stay descriptive and grant no action authority", async () => {
  const foreign = usageThresholdOriginalSchema.parse({
    ...original,
    projectId: "project-00000000-0000-4000-8000-000000000002",
    workspace: "/foreign",
    requestId: "10000000-0000-4000-8000-000000000002",
  });
  const f = fixture();
  f.state.recovery = {
    version: 1,
    complete: true,
    pending: [await pending(foreign)],
  };
  f.state.exact = await reserved(foreign);
  await f.owner.refresh();
  expect(f.owner.snapshot().held).toBeNull();
  expect(f.owner.snapshot().recovery?.pending[0]?.original.workspace).toBe(
    "/foreign",
  );
  await f.owner.check(foreign.requestId);
  expect(f.owner.snapshot().review).toBeNull();
  expect(f.posts).toHaveLength(0);
});

test("Apply requires the exact current catalog membership and revision", async () => {
  for (const mode of ["newer", "older", "archived", "workspace"] as const) {
    const f = await reviewedFixture();
    const changed = catalog();
    changed.revision = mode === "older" ? 1 : 3;
    if (mode === "archived") changed.projects[0]!.archived = true;
    if (mode === "workspace")
      changed.projects[0]!.workspaces[0]!.root = "/other";
    f.state.catalog = changed;
    await f.owner.check();
    expect(
      f.owner.confirmReview(f.owner.snapshot().review, "apply"),
    ).toBeNull();
    expect(
      f.owner.confirmReview(f.owner.snapshot().review, "discard"),
    ).not.toBeNull();
    expect(f.posts).toHaveLength(0);
  }
});
test("conflicting policy bodies at one revision cannot authorize Apply", async () => {
  const value = usageThresholdOriginalSchema.parse({
    ...original,
    expectedRevision: 1,
  });
  const f = fixture();
  f.state.current = document(1);
  f.state.exact = await reserved(value);
  f.state.recovery = {
    version: 1,
    complete: true,
    pending: [await pending(value)],
  };
  await f.owner.refresh();
  await f.owner.check();
  expect(
    f.owner.confirmReview(f.owner.snapshot().review, "apply"),
  ).not.toBeNull();
  f.state.current = { ...document(1), rules: [{ ...rule, threshold: 70 }] };
  await f.owner.check();
  expect(f.owner.snapshot().documentFresh).toBe(false);
  expect(f.owner.confirmReview(f.owner.snapshot().review, "apply")).toBeNull();
  expect(f.posts).toHaveLength(0);
});
test("complete 256-row recovery is retained when a 257th UUID exceeds the bound", async () => {
  const rows = await Promise.all(
    Array.from({ length: 256 }, (_, index) =>
      pending(
        usageThresholdOriginalSchema.parse({
          ...original,
          workspace: "/foreign-" + index,
          requestId:
            "10000000-0000-4000-8000-" + String(index + 2).padStart(12, "0"),
        }),
      ),
    ),
  );
  const f = fixture();
  f.state.recovery = { version: 1, complete: true, pending: rows };
  await f.owner.refresh();
  expect(f.owner.snapshot().recoveryFresh).toBe(true);
  expect(f.owner.snapshot().recovery?.pending).toHaveLength(256);
  await f.owner.reserve(original.rules);
  expect(f.posts).toHaveLength(0);
  const extra = await pending(
    usageThresholdOriginalSchema.parse({
      ...original,
      workspace: "/foreign-extra",
      requestId: "10000000-0000-4000-8000-000000000999",
    }),
  );
  f.state.recovery = { version: 1, complete: true, pending: [...rows, extra] };
  await f.owner.refresh();
  expect(f.owner.snapshot().recoveryFresh).toBe(false);
  expect(f.owner.snapshot().recovery?.pending).toHaveLength(256);
});
test("the bounded revision digest history refuses further growth without evicting proof", async () => {
  const f = fixture();
  for (let revision = 0; revision <= 257; revision++) {
    f.state.current = document(revision);
    await f.owner.refresh();
  }
  expect(f.owner.snapshot().document?.revision).toBe(256);
  expect(f.owner.snapshot().documentFresh).toBe(false);
  await f.owner.reserve(original.rules);
  expect(f.posts).toHaveLength(0);
});
test("a handed-off Reserve may confirm after invalidation without restoring actionability", async () => {
  const f = fixture();
  await f.owner.refresh();
  const entered = deferred<void>();
  const response = deferred<Response>();
  f.onPost(async () => {
    entered.resolve(undefined);
    return response.promise;
  });
  const sending = f.owner.reserve(original.rules);
  await entered.promise;
  f.owner.invalidateContext();
  response.resolve(ok(await reserved()));
  await sending;
  expect(f.owner.snapshot().held?.phase).toBe("reserved");
  expect(f.owner.snapshot().catalog?.fresh).toBe(false);
  expect(f.owner.snapshot().review).toBeNull();
  await f.owner.apply(
    f.owner.confirmReview(f.owner.snapshot().review, "apply"),
  );
  expect(f.posts).toHaveLength(1);
});
