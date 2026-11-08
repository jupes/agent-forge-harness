import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type CleanupBrowserOriginal,
  type CleanupBrowserRecord,
  cleanupBrowserInventorySchema,
} from "../../apps/desktop/src/project-worktree-cleanup-client";
import {
  bindCleanupSources,
  type CleanupContextFacts,
  cleanupAuthorityKey,
  cleanupCandidate,
  createCleanupCapabilities,
  createCleanupContextGate,
  createCleanupCoordinator,
  createCleanupLiveTransport,
  createCleanupOwnerRegistry,
  createCleanupPresentationRefresh,
  createCleanupSelectionBinding,
  createCleanupTransport,
  discoverCleanupAuthorities,
  parseCleanupAuthority,
  refreshCleanupHealth,
} from "../../apps/desktop/src/use-project-worktree-cleanup";
import { createOperatorClient } from "../../docs/js/operator";
import { API_PREFIX, OPERATOR_HEADER, TOKEN_ROUTE } from "../hearth/paths";
import type {
  ProjectRepositoryMember,
  ProjectRepositoryRow,
  ProjectWorktreeFact,
} from "../projects/project-repositories-protocol";

import {
  type CleanupReceipt,
  canonicalCleanupRequest,
  cleanupReceiptSchema,
  cleanupRequestSchema,
} from "../projects/worktree-cleanup-protocol";

const limits = { maxBodyBytes: 65536 };
const envelope = (data: unknown) =>
  Response.json({ ok: true, data, error: null });
function transport(
  answer: (url: string, init?: RequestInit) => Promise<Response>,
) {
  return createCleanupTransport(
    createOperatorClient(
      (url, init) =>
        url === TOKEN_ROUTE
          ? Promise.resolve(envelope({ token: "held" }))
          : answer(url, init),
      { sessionKeys: { get: () => null, set: () => undefined } },
    ),
  );
}

test("cleanup transport captures protected adapters, prefixes routes and preserves health spelling/version", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const health = { root: "C:\\Work\\Ä", pid: 7, apiVersion: 999 };
  const client = transport(async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/review")) {
      const body = JSON.stringify({
        ok: true,
        data: { value: "exact" },
        error: null,
      });
      return new Response(body.padEnd(65536, " "));
    }
    return envelope(url.endsWith("/health") ? health : { value: "exact" });
  });
  expect(await client.health()).toEqual(health);
  expect(await client.readReview("/review", limits)).toEqual({
    value: "exact",
  });
  expect(await client.readReceipt("/receipt", limits)).toEqual({
    value: "exact",
  });
  const post = await client.operatorPost(
    "/cleanup",
    { original: true },
    limits,
  );
  expect(await post.json()).toEqual({
    ok: true,
    data: { value: "exact" },
    error: null,
  });
  expect(calls.map((call) => call.url)).toEqual(
    ["/health", "/review", "/receipt", "/cleanup"].map(
      (route) => API_PREFIX + route,
    ),
  );
  expect(
    calls.every(
      (call) => new Headers(call.init?.headers).get(OPERATOR_HEADER) === "held",
    ),
  ).toBe(true);
  expect(calls.at(-1)?.init?.method).toBe("POST");
  expect(calls.at(-1)?.init?.body).toBe('{"original":true}');
});

for (const method of [
  "readReview",
  "readReceipt",
  "operatorPost",
  "health",
] as const) {
  test(
    method +
      " cancels 65537 bytes at the real receiving boundary before whole-body decode",
    async () => {
      let cancelled = 0,
        decoded = 0;
      const client = transport(async () => {
        const response = new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(32768));
              controller.enqueue(new Uint8Array(32768));
              controller.enqueue(new Uint8Array(1));
            },
            cancel() {
              cancelled++;
            },
          }),
        );
        response.text = async () => {
          decoded++;
          return "";
        };
        response.json = async () => {
          decoded++;
          return null;
        };
        response.arrayBuffer = async () => {
          decoded++;
          return new ArrayBuffer(0);
        };
        return response;
      });
      const request =
        method === "health"
          ? client.health()
          : method === "operatorPost"
            ? client.operatorPost("/cleanup", {}, limits)
            : client[method]("/cleanup", limits);
      await expect(request).rejects.toThrow("exceeds its byte limit");
      expect(cancelled).toBe(1);
      expect(decoded).toBe(0);
    },
  );
}

test("cleanup reads reject HTTP failure, nonstrict envelopes, malformed and decoded duplicate JSON", async () => {
  const bodies = [
    '{"ok":false,"data":{},"error":null}',
    '{"ok":true,"data":{}}',
    '{"ok":true,"error":null}',
    '{"ok":true,"data":{},"error":null,"extra":1}',
    '{"ok":true,"data":{},"error":"bad"}',
    "null",
    "{",
    String.raw`{"ok":true,"data":{"x":1,"\u0078":2},"error":null}`,
    String.raw`{"ok":false,"\u006fk":true,"data":{},"error":null}`,
  ];
  for (const raw of bodies) {
    const client = transport(async () => new Response(raw));
    await expect(client.readReview("/review", limits)).rejects.toThrow(
      "could not be verified",
    );
  }
  const refused = transport(async () => new Response("{}", { status: 503 }));
  await expect(refused.readReceipt("/receipt", limits)).rejects.toThrow(
    "was refused",
  );
});

test("cleanup static-copy transport sends no token/read/post request", async () => {
  let calls = 0;
  const client = createCleanupTransport(
    createOperatorClient(
      async () => {
        calls++;
        return envelope(null);
      },
      { staticCopy: true },
    ),
  );
  await expect(client.health()).rejects.toThrow("static copy");
  await expect(client.readReceipt("/receipt", limits)).rejects.toThrow(
    "static copy",
  );
  await expect(client.operatorPost("/cleanup", {}, limits)).rejects.toThrow(
    "static copy",
  );
  expect(calls).toBe(0);
});

test("cleanup capped read retains the real operator timeout and aborts a hanging request", async () => {
  const held: { expire?: () => void; signal: AbortSignal | null | undefined } =
    { signal: undefined };
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const client = createCleanupTransport(
    createOperatorClient(
      async (url, init) => {
        if (url === TOKEN_ROUTE) return envelope({ token: "held" });
        held.signal = init?.signal;
        started();
        return new Promise<Response>(() => undefined);
      },
      {
        sessionKeys: { get: () => null, set: () => undefined },
        timeoutMs: 25,
        timers: {
          set(run) {
            held.expire = run;
            return run;
          },
          clear() {},
        },
      },
    ),
  );
  const request = client.readReview("/review", limits);
  await ready;
  held.expire?.();
  await expect(request).rejects.toThrow("did not answer");
  expect(held.signal?.aborted).toBe(true);
});

test("cleanup health requires independent bounded positive-safe identity while preserving unsupported versions", async () => {
  for (const changed of [
    { pid: 0 },
    { pid: 1.5 },
    { apiVersion: 0 },
    { apiVersion: Number.MAX_SAFE_INTEGER + 1 },
    { root: "" },
    { root: "bad\nroot" },
  ]) {
    const client = transport(async () =>
      envelope({ pid: 1, apiVersion: 1, root: "C:\\Work", ...changed }),
    );
    await expect(client.health()).rejects.toThrow();
  }
});

const origin = "http://127.0.0.1:3000";
test("cleanup authorities preserve exact native spelling and reject noncanonical/foreign/invalid tuples", () => {
  const key = cleanupAuthorityKey(origin, "C:\\Work\\Ä");
  expect(parseCleanupAuthority(key, origin).repository).toBe("C:\\Work\\Ä");
  for (const bad of [
    "null",
    "[]",
    '["http://elsewhere","C:/Work"]',
    '["http://127.0.0.1:3000", "C:/Work"]',
    JSON.stringify([origin, ""]),
    JSON.stringify([origin, "bad\nroot"]),
    JSON.stringify([origin, "x".repeat(1025)]),
    JSON.stringify([origin, "C:/Work", "extra"]),
  ])
    expect(() => parseCleanupAuthority(bad, origin)).toThrow();
  expect(() =>
    parseCleanupAuthority(
      JSON.stringify(["ftp://example", "C:/Work"]),
      "ftp://example",
    ),
  ).toThrow();
  expect(() => cleanupAuthorityKey("null", "C:/Work")).toThrow();
  expect(() => cleanupAuthorityKey(origin + "/", "C:/Work")).toThrow();
  expect(() =>
    cleanupAuthorityKey(
      "https://" + "a".repeat(1100) + ".example",
      "x".repeat(1024),
    ),
  ).toThrow();
});

test("cleanup oversized authority is rejected before JSON parsing", () => {
  const originalParse = JSON.parse;
  const oversized = JSON.stringify([origin, "x".repeat(2049)]);
  let parses = 0,
    rejected = false;
  try {
    JSON.parse = () => {
      parses++;
      throw Error("Oversized input reached parser");
    };
    try {
      parseCleanupAuthority(oversized, origin);
    } catch {
      rejected = true;
    }
  } finally {
    JSON.parse = originalParse;
  }
  expect(rejected).toBe(true);
  expect(parses).toBe(0);
});

const prefix = "agent-forge.project-worktree-cleanup.v1.";
const pair = (root: string) =>
  ["marker", "inventory"].map(
    (suffix) => prefix + cleanupAuthorityKey(origin, root) + "." + suffix,
  );
function keyStorage(keys: string[]) {
  return {
    get length() {
      return keys.length;
    },
    key(index: number) {
      return keys[index] ?? null;
    },
  };
}

test("cleanup discovery counts current empty authority and finite512/8/16 boundaries without writing", () => {
  const current = cleanupAuthorityKey(origin, "C:/Current");
  const seven = Array.from({ length: 7 }, (_, index) =>
    pair("C:/Root" + index),
  ).flat();
  const keys = [
    ...seven,
    ...Array.from({ length: 498 }, (_, index) => "unrelated" + index),
  ];
  const within = discoverCleanupAuthorities(keyStorage(keys), origin, current);
  expect(within.hold).toBeNull();
  expect(within.authorities).toHaveLength(8);
  expect(within.authorities[0]).toEqual({
    key: current,
    origin,
    repository: "C:/Current",
    marker: false,
    inventory: false,
  });
  expect(
    discoverCleanupAuthorities(
      keyStorage([...keys, "overflow"]),
      origin,
      current,
    ).hold,
  ).not.toBeNull();
  const eight = [...seven, ...pair("C:/Eighth")];
  expect(
    discoverCleanupAuthorities(keyStorage(eight), origin, null).hold,
  ).toBeNull();
  expect(
    discoverCleanupAuthorities(keyStorage(eight), origin, current).hold,
  ).not.toBeNull();
  expect(
    discoverCleanupAuthorities(
      keyStorage([...eight, ...pair("C:/Ninth")]),
      origin,
      null,
    ).hold,
  ).not.toBeNull();
});

test("cleanup discovery preserves known/current rows on malformed, partial, duplicate, changing and inaccessible metadata", () => {
  const current = cleanupAuthorityKey(origin, "C:/Current");
  for (const keys of [
    [...pair("C:/Saved"), prefix + "bad.reset"],
    [pair("C:/Saved")[0]!],
    [prefix + '["elsewhere","C:/Other"].marker'],
    ["same", "same"],
  ]) {
    const before = [...keys];
    const result = discoverCleanupAuthorities(
      keyStorage(keys),
      origin,
      current,
    );
    expect(result.hold).not.toBeNull();
    expect(result.authorities[0]?.key).toBe(current);
    expect(keys).toEqual(before);
  }
  let calls = 0;
  const changing = {
    length: 1,
    key: () => (++calls === 1 ? "first" : "changed"),
  };
  expect(
    discoverCleanupAuthorities(changing, origin, current).hold,
  ).not.toBeNull();
  expect(calls).toBe(2);
  const inaccessible = {
    get length(): number {
      throw Error("denied");
    },
    key: () => null,
  };
  expect(
    discoverCleanupAuthorities(inaccessible, origin, current).authorities[0]
      ?.key,
  ).toBe(current);
  expect(
    discoverCleanupAuthorities(inaccessible, origin, current).hold,
  ).not.toBeNull();
});

test("cleanup discovery refuses oversized dedicated keys before regular-expression processing", () => {
  const oversized = prefix + "x".repeat(2049) + ".inventory";
  const originalExec = RegExp.prototype.exec;
  let oversizedRegexCalls = 0;
  let result: ReturnType<typeof discoverCleanupAuthorities> | undefined;
  try {
    RegExp.prototype.exec = function (this: RegExp, input: string) {
      if (
        this.source === "^(.*)\\.(marker|inventory)$" &&
        input.length > 2048 + ".inventory".length
      )
        oversizedRegexCalls++;
      return originalExec.call(this, input);
    };
    result = discoverCleanupAuthorities(keyStorage([oversized]), origin, null);
  } finally {
    RegExp.prototype.exec = originalExec;
  }
  expect(typeof result?.hold).toBe("string");
  expect(oversizedRegexCalls).toBe(0);
});

test("cleanup capabilities capture receivers without I/O and retain exact lock, UUID and UTF8 SHA256 behavior", async () => {
  const observations: unknown[] = [];
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      observations.push(this === storage);
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      observations.push(this === storage);
      values.set(key, value);
    },
  };
  const locks = {
    async request<T>(
      name: string,
      options: LockOptions | LockGrantedCallback<T>,
      callback?: LockGrantedCallback<T>,
    ): Promise<T> {
      observations.push(
        this === locks,
        name,
        typeof options !== "function" && options.signal instanceof AbortSignal,
      );
      return (typeof options === "function" ? options : callback!)(null);
    },
  };
  const subtle = {
    digest(algorithm: AlgorithmIdentifier, data: BufferSource) {
      observations.push(
        this === subtle,
        algorithm,
        new TextDecoder().decode(data),
      );
      return crypto.subtle.digest(algorithm, data);
    },
  };
  const webCrypto = {
    subtle,
    randomUUID(): ReturnType<Crypto["randomUUID"]> {
      observations.push(this === webCrypto);
      return "10000000-0000-4000-8000-000000000001";
    },
  };
  const authority = cleanupAuthorityKey(origin, "C:/Work");
  const capabilities = createCleanupCapabilities(authority, {
    storage: () => storage,
    locks: () => locks,
    crypto: () => webCrypto,
  });
  expect(observations).toEqual([]);
  expect(capabilities.available).toBe(true);
  storage.getItem = () => {
    throw Error("replacement getter");
  };
  locks.request = async () => {
    throw Error("replacement lock");
  };
  webCrypto.randomUUID = () => {
    throw Error("replacement UUID");
  };
  subtle.digest = () => {
    throw Error("replacement digest");
  };
  capabilities.storage.setItem("key", "value");
  expect(capabilities.storage.getItem("key")).toBe("value");
  expect(await capabilities.withLock(async () => "locked")).toBe("locked");
  expect(capabilities.uuid()).toBe("10000000-0000-4000-8000-000000000001");
  expect(await capabilities.hash("é🙂")).toBe(
    "7382f537af6a53054b6a72792df00fa0be0f5d2e8214db9cd6ebbcc3d57d02b9",
  );
  expect(observations).toEqual([
    true,
    true,
    true,
    "agent-forge.project-worktree-cleanup.v1." + authority,
    true,
    true,
    true,
    "SHA-256",
    "é🙂",
  ]);
  expect(capabilities.warning).toBeNull();
});

test("cleanup missing, incomplete and throwing browser capabilities fail closed without fallback", async () => {
  const missing = createCleanupCapabilities("authority", {});
  expect(missing.available).toBe(false);
  expect(missing.warning).toContain("unavailable");
  expect(() => missing.storage.getItem("key")).toThrow();
  expect(() => missing.storage.setItem("key", "value")).toThrow();
  await expect(missing.withLock(async () => "must not run")).rejects.toThrow();
  expect(() => missing.uuid()).toThrow();
  await expect(missing.hash("text")).rejects.toThrow();
  for (const web of [
    { storage: () => ({ getItem: () => null }) },
    {
      storage: () => {
        throw Error("storage denied");
      },
    },
    {
      locks: () => {
        throw Error("locks denied");
      },
    },
    {
      crypto: () => {
        throw Error("crypto denied");
      },
    },
    { crypto: () => ({}) },
  ]) {
    const capabilities = createCleanupCapabilities("authority", web);
    expect(capabilities.available).toBe(false);
    expect(capabilities.warning).not.toBeNull();
  }
});

const contextFacts: CleanupContextFacts = {
  route: "#/projects/project-a/settings",
  routeGeneration: 0,
  projectId: "project-a",
  archived: false,
  catalogRevision: 1,
  catalogSource: {},
  catalogReady: true,
  repositoryKey: "project-a:1",
  repositoryPhase: "ready",
  repositoryData: {
    projectId: "project-a",
    catalogRevision: 1,
    repositories: [],
  },
  repositoryRequestedRevision: 1,
  repositoryResponseRevision: 1,
  connectionPhase: "connected",
  writesAllowed: true,
  connectionBusy: false,
  connectionUnknown: false,
};
const currentHealth = { root: "C:/Work", pid: 1, apiVersion: 1 };

test("cleanup context compares meaningful facts and closes before synchronous invalidation", () => {
  const observed: Array<{ generation: number; open: boolean }> = [];
  let gate!: ReturnType<typeof createCleanupContextGate>;
  gate = createCleanupContextGate(() => {
    observed.push(gate.snapshot());
  });
  expect(gate.adopt(contextFacts)).toBe(true);
  expect(gate.publishHealth(1, currentHealth)).toBe(1);
  expect(gate.writesAvailable()).toBe(true);
  expect(gate.adopt({ ...contextFacts })).toBe(false);
  expect(gate.snapshot().health).toEqual(currentHealth);
  for (const patch of [
    { route: "B" },
    { routeGeneration: 2 },
    { catalogRevision: 2 },
    { catalogSource: {} },
    { repositoryPhase: "loading" as const },
    { repositoryData: { ...contextFacts.repositoryData! } },
    { connectionPhase: "reconnecting" },
    { connectionBusy: true },
    { connectionUnknown: true },
  ]) {
    const before = gate.snapshot().generation;
    gate.adopt({ ...contextFacts, ...patch });
    expect(gate.snapshot().generation).toBeGreaterThan(before);
    expect(gate.publishHealth(before, currentHealth)).toBeNull();
  }
  expect(observed.every((value) => value.open === false)).toBe(true);
  expect(observed.map((value) => value.generation)).toEqual(
    Array.from({ length: observed.length }, (_, index) => index + 1),
  );
});

test("cleanup health drift invalidates old proof but activates its new generation; raw invalidation and unmount reject late tokens", () => {
  const gate = createCleanupContextGate(() => undefined);
  gate.adopt(contextFacts);
  const first = gate.publishHealth(1, currentHealth);
  expect(gate.publishHealth(1, { ...currentHealth })).toBe(first);
  expect(gate.publishHealth(1, { ...currentHealth, pid: 2 })).toBe(2);
  expect(gate.snapshot().health?.pid).toBe(2);
  expect(gate.publishHealth(1, currentHealth)).toBeNull();
  expect(
    gate.publishHealth(2, { ...currentHealth, pid: 2, apiVersion: 999 }),
  ).toBe(3);
  expect(gate.snapshot().open).toBe(true);
  expect(gate.writesAvailable()).toBe(false);
  gate.invalidate();
  expect(gate.publishHealth(3, currentHealth)).toBeNull();
  gate.adopt({ ...contextFacts, route: "B" });
  gate.adopt(contextFacts);
  expect(gate.snapshot().generation).toBe(6);
  gate.deactivate();
  expect(gate.publishHealth(6, currentHealth)).toBeNull();
  expect(gate.snapshot().context).toBeNull();
  expect(gate.writesAvailable()).toBe(false);
});

test("cleanup health refresh cannot reopen obsolete generations and matching failures close the gate", async () => {
  const gate = createCleanupContextGate(() => undefined);
  gate.adopt(contextFacts);
  let answer!: (value: unknown) => void;
  const pending = refreshCleanupHealth(
    gate,
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  gate.invalidate();
  answer(currentHealth);
  expect(await pending).toBeNull();
  expect(gate.snapshot().open).toBe(false);
  expect(
    (await refreshCleanupHealth(gate, async () => currentHealth))?.generation,
  ).toBe(2);
  expect(gate.snapshot().open).toBe(true);
  expect(
    await refreshCleanupHealth(gate, async () => {
      throw Error("health unavailable");
    }),
  ).toBeNull();
  expect(gate.snapshot().open).toBe(false);
  expect(gate.snapshot().generation).toBe(3);
});

for (const outcome of ["success", "failure"] as const) {
  test(
    "older same-generation health " +
      outcome +
      " cannot replace or invalidate newer health",
    async () => {
      const gate = createCleanupContextGate(() => undefined);
      gate.adopt(contextFacts);
      let resolveOld!: (value: unknown) => void;
      let rejectOld!: (error: Error) => void;
      const old = refreshCleanupHealth(
        gate,
        () =>
          new Promise((resolve, reject) => {
            resolveOld = resolve;
            rejectOld = reject;
          }),
      );
      const newer = { ...currentHealth, pid: 2, root: "C:/Other" };
      const accepted = await refreshCleanupHealth(gate, async () => newer);
      const generation = gate.snapshot().generation;
      expect(accepted?.health).toEqual(newer);
      if (outcome === "success") resolveOld(currentHealth);
      else rejectOld(Error("older read failed"));
      expect(await old).toBeNull();
      expect(gate.snapshot().health).toEqual(newer);
      expect(gate.snapshot().generation).toBe(generation);
    },
  );
}

function liveFixture() {
  const behavior = {
    health: { ...currentHealth },
    reads: 0,
    posts: 0,
    allowDispatch: true,
    onRead: (): void => undefined,
  };
  const gate = createCleanupContextGate(() => undefined);
  gate.adopt(contextFacts);
  const client = transport(async (url, init) => {
    if (url.endsWith("/health")) return envelope(behavior.health);
    if (init?.method === "POST") behavior.posts++;
    else {
      behavior.reads++;
      behavior.onRead();
    }
    return envelope({ original: "A" });
  });
  return {
    gate,
    behavior,
    live: createCleanupLiveTransport(
      "C:/Work",
      gate,
      client,
      () => behavior.allowDispatch,
    ),
  };
}

test("cleanup live transport sends one deliberate positive POST and blocks fresh pre-POST PID/root drift", async () => {
  const first = liveFixture();
  expect((await first.live.operatorPost("/cleanup", {}, limits)).ok).toBe(true);
  expect(first.behavior.posts).toBe(1);
  for (const changed of [{ pid: 2 }, { root: "C:/Other" }]) {
    const item = liveFixture();
    item.gate.publishHealth(1, currentHealth);
    Object.assign(item.behavior.health, changed);
    await expect(
      item.live.operatorPost("/cleanup", {}, limits),
    ).rejects.toThrow();
    expect(item.behavior.posts).toBe(0);
    expect(item.gate.snapshot().generation).toBe(2);
  }
  first.behavior.allowDispatch = false;
  await expect(
    first.live.operatorPost("/cleanup", {}, limits),
  ).rejects.toThrow();
  expect(first.behavior.posts).toBe(1);
});

test("cleanup exact receipt survives project navigation, missing project, writes false and unsupported version", async () => {
  const item = liveFixture();
  item.behavior.health.apiVersion = 999;
  item.behavior.allowDispatch = false;
  item.behavior.onRead = () => {
    item.gate.adopt({
      ...contextFacts,
      route: "B",
      projectId: null,
      writesAllowed: false,
    });
  };
  expect(await item.live.readReceipt("/receipt", limits)).toEqual({
    original: "A",
  });
  expect(item.behavior.reads).toBe(1);
  expect(item.gate.snapshot().context?.projectId).toBeNull();
  expect(item.gate.writesAvailable()).toBe(false);
  await expect(item.live.readReview("/review", limits)).rejects.toThrow();
  expect(item.behavior.reads).toBe(1);
});

test("cleanup live reads reject foreign roots before GET and reject observed identity drift after GET", async () => {
  const foreign = liveFixture();
  foreign.behavior.health.root = "C:/Other";
  await expect(foreign.live.readReceipt("/receipt", limits)).rejects.toThrow();
  expect(foreign.behavior.reads).toBe(0);
  for (const method of ["readReview", "readReceipt"] as const) {
    for (const changed of [{ pid: 2 }, { root: "C:/Other" }]) {
      const item = liveFixture();
      item.behavior.onRead = () => {
        Object.assign(item.behavior.health, changed);
      };
      await expect(item.live[method]("/read", limits)).rejects.toThrow();
      expect(item.behavior.reads).toBe(1);
      expect(item.behavior.posts).toBe(0);
      expect(item.gate.snapshot().generation).toBe(2);
    }
  }
});

function registryFixture(
  beforeLock: () => Promise<void> = async () => undefined,
  answer: (url: string, init?: RequestInit) => Promise<Response> = async () =>
    envelope(currentHealth),
) {
  const values = new Map<string, string>();
  let writes = 0,
    notices = 0,
    lockStarts = 0,
    uuidCalls = 0,
    providerReads = 0,
    surfaceCaptures = 0;
  const surface = {
    get length() {
      return values.size;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      writes++;
      values.set(key, value);
    },
  };
  let registry: ReturnType<typeof createCleanupOwnerRegistry> | undefined;
  let selection: ReturnType<typeof createCleanupSelectionBinding> | undefined;
  const lifecycle = { active: true };
  const gate = createCleanupContextGate(() => {
    if (selection) selection.clear();
    else registry?.invalidateInspections();
  });
  gate.adopt(contextFacts);
  gate.publishHealth(1, currentHealth);
  const locks = {
    async request<T>(
      _name: string,
      options: LockOptions | LockGrantedCallback<T>,
      callback?: LockGrantedCallback<T>,
    ): Promise<T> {
      lockStarts++;
      await beforeLock();
      return (typeof options === "function" ? options : callback!)(null);
    },
  };
  const client = transport(answer);
  const binding = createCleanupSelectionBinding({
    origin,
    gate,
    transport: client,
    isActive: () => lifecycle.active,
    registry: () => {
      providerReads++;
      if (!registry) throw Error("Registry was used before construction");
      return registry;
    },
  });
  selection = binding;
  const webCrypto = {
    subtle: crypto.subtle,
    randomUUID: () => {
      uuidCalls++;
      return crypto.randomUUID();
    },
  };
  const web = {
    storage: () => {
      surfaceCaptures++;
      return surface;
    },
    locks: () => locks,
    crypto: () => webCrypto,
  };
  registry = createCleanupOwnerRegistry({
    origin,
    gate,
    transport: { ...client, readReview: binding.readReview },
    web: {
      storage: () => surface,
      locks: () => locks,
      crypto: () => webCrypto,
    },
    currentScope: binding.currentScope,
    canDispatch: binding.canDispatch,
    onChange: () => {
      notices++;
    },
  });
  return {
    values,
    registry,
    gate,
    writes: () => writes,
    notices: () => notices,
    lockStarts: () => lockStarts,
    selection: binding,
    lifecycle,
    uuidCalls: () => uuidCalls,
    providerReads: () => providerReads,
    web,
    surface,
    surfaceCaptures: () => surfaceCaptures,
  };
}

test("cleanup registry restores real owners once per authority and detects both-key loss without replacing A on B", async () => {
  const item = registryFixture();
  await item.registry.restore();
  const original = item.registry.snapshot().authorities[0]!;
  expect(original.view.inventory?.records).toEqual([]);
  expect(item.writes()).toBe(2);
  item.gate.publishHealth(1, { ...currentHealth, root: "C:/B", pid: 2 });
  await item.registry.restore();
  expect(item.registry.snapshot().authorities).toHaveLength(2);
  expect(item.registry.snapshot().authorities[0]?.owner).toBe(original.owner);
  for (const key of pair("C:/Work")) item.values.delete(key);
  const before = item.writes();
  await item.registry.restore();
  const retained = item.registry.snapshot().authorities[0]!;
  expect(retained.view.storageError).toBe(true);
  expect(retained.view.inventory?.records).toEqual([]);
  expect(item.writes()).toBe(before);
  expect(item.registry.snapshot().hold).not.toBeNull();
});

test("cleanup registry holds partial evidence and never initializes an empty current namespace under discovery hold", async () => {
  const item = registryFixture();
  const saved = cleanupAuthorityKey(origin, "C:/Saved");
  item.values.set(
    pair("C:/Saved")[0]!,
    JSON.stringify({ version: 1, authorityKey: saved }),
  );
  await item.registry.restore();
  expect(item.registry.snapshot().hold).not.toBeNull();
  expect(item.registry.snapshot().authorities).toHaveLength(2);
  expect(
    item.registry
      .snapshot()
      .authorities.every((entry) => entry.view.storageError),
  ).toBe(true);
  expect(item.values.size).toBe(1);
  expect(item.writes()).toBe(0);
});

test("cleanup registry retains eight known owners when their keys vanish and refuses a ninth current authority", async () => {
  const item = registryFixture();
  for (let index = 0; index < 8; index++) {
    item.gate.publishHealth(item.gate.snapshot().generation, {
      ...currentHealth,
      root: "C:/Root" + index,
    });
    await item.registry.restore();
  }
  expect(item.registry.snapshot().authorities).toHaveLength(8);
  item.values.clear();
  const before = item.writes();
  item.gate.publishHealth(item.gate.snapshot().generation, {
    ...currentHealth,
    root: "C:/Ninth",
  });
  await item.registry.restore();
  expect(item.registry.snapshot().authorities).toHaveLength(8);
  expect(item.registry.snapshot().hold).toContain("Eight cleanup authorities");
  expect(
    item.registry
      .snapshot()
      .authorities.every((entry) => entry.view.storageError),
  ).toBe(true);
  expect(item.writes()).toBe(before);
});

test("disposed cleanup registry cannot restore or create another authority", async () => {
  const item = registryFixture();
  await item.registry.restore();
  item.registry.dispose();
  const before = {
    writes: item.writes(),
    notices: item.notices(),
    keys: item.registry.snapshot().authorities.map((entry) => entry.key),
  };
  item.gate.publishHealth(item.gate.snapshot().generation, {
    ...currentHealth,
    root: "C:/B",
    pid: 2,
  });
  await item.registry.restore();
  expect({
    writes: item.writes(),
    notices: item.notices(),
    keys: item.registry.snapshot().authorities.map((entry) => entry.key),
  }).toEqual(before);
});

test("disposing an in-flight cleanup restore prevents subsequent owner activation, writes and notification", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const item = registryFixture(async () => {
    if (first) {
      first = false;
      entered();
      await held;
    }
  });
  const saved = cleanupAuthorityKey(origin, "C:/Saved");
  item.values.set(
    pair("C:/Saved")[0]!,
    JSON.stringify({ version: 1, authorityKey: saved }),
  );
  item.values.set(
    pair("C:/Saved")[1]!,
    JSON.stringify({
      version: 1,
      authorityKey: saved,
      records: [],
      activeRequestId: null,
    }),
  );
  const pending = item.registry.restore();
  await started;
  expect(item.lockStarts()).toBe(1);
  item.registry.dispose();
  const before = {
    writes: item.writes(),
    notices: item.notices(),
    locks: item.lockStarts(),
    keys: item.registry.snapshot().authorities.map((entry) => entry.key),
  };
  release();
  await pending;
  expect({
    writes: item.writes(),
    notices: item.notices(),
    locks: item.lockStarts(),
    keys: item.registry.snapshot().authorities.map((entry) => entry.key),
  }).toEqual(before);
});

function seedCleanupOriginal(
  values: Map<string, string>,
  repository = "C:/Work",
) {
  const projectId = "project-10000000-0000-4000-8000-000000000001";
  const request = {
    requestId: "20000000-0000-4000-8000-000000000002",
    repository,
    expectedCatalogRevision: 1,
    expectedRecord: {
      id: "saved",
      path: repository + "/trees/saved",
      branch: "feat/saved",
      beadId: "bead-saved",
      createdAt: "2026-11-06T00:00:00.000Z",
    },
    expectedHead: "a".repeat(40),
  };
  const { requestId, ...reviewRequest } = request;
  const requestHash = createHash("sha256")
    .update(canonicalCleanupRequest(projectId, request))
    .digest("hex");
  const original: CleanupBrowserOriginal = {
    projectId,
    request,
    requestHash,
    review: {
      ...reviewRequest,
      projectId,
      worktreeId: "saved",
      state: "eligible",
      removalAuthorized: false,
      reasons: [],
      asOf: "2026-11-06T00:00:00.000Z",
    },
  };
  const receipt: CleanupReceipt = {
    ...request,
    projectId,
    requestHash,
    state: "confirmed",
    reason: null,
    attemptedAt: "2026-11-06T00:00:01.000Z",
    endedAt: "2026-11-06T00:00:02.000Z",
    audit: {
      eventId: 1,
      ulid: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      ts: "2026-11-06T00:00:00.000Z",
    },
  };
  const authorityKey = cleanupAuthorityKey(origin, "C:/Work");
  values.set(pair("C:/Work")[0]!, JSON.stringify({ version: 1, authorityKey }));
  values.set(
    pair("C:/Work")[1]!,
    JSON.stringify({
      version: 1,
      authorityKey,
      records: [{ original, receipt }],
      activeRequestId: null,
    }),
  );
  return { projectId, requestId, requestHash, authorityKey, receipt, original };
}

test("cleanup registry checks the exact terminal original after active clear with missing project, writes false and version999", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  let saved: ReturnType<typeof seedCleanupOriginal> | undefined;
  const observedHealth = { ...currentHealth, apiVersion: 999 };
  const item = registryFixture(undefined, async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET" });
    return envelope(url.endsWith("/health") ? observedHealth : saved?.receipt);
  });
  saved = seedCleanupOriginal(item.values);
  await item.registry.restore();
  expect(item.registry.snapshot().pending).toBe(false);
  expect(
    item.registry.snapshot().authorities[0]?.view.inventory?.activeRequestId,
  ).toBeNull();
  item.gate.adopt({
    ...contextFacts,
    projectId: null,
    route: "missing",
    writesAllowed: false,
    archived: true,
  });
  item.gate.publishHealth(item.gate.snapshot().generation, observedHealth);
  expect(item.gate.writesAvailable()).toBe(false);
  await item.registry.checkOriginal(saved.authorityKey, saved.requestId);
  const receiptReads = calls.filter((call) =>
    call.url.includes("/settings/worktree-cleanup/"),
  );
  expect(receiptReads).toEqual([
    {
      url:
        API_PREFIX +
        "/projects/" +
        saved.projectId +
        "/settings/worktree-cleanup/" +
        saved.requestId +
        "?requestHash=" +
        saved.requestHash,
      method: "GET",
    },
  ]);
  expect(calls.some((call) => call.method === "POST")).toBe(false);
  expect(
    item.registry.snapshot().authorities[0]?.view.inventory?.records[0],
  ).toEqual({ original: saved.original, receipt: saved.receipt });
  expect(item.registry.snapshot().pending).toBe(false);
});

test("retained cleanup owner starts no protected reads after registry disposal", async () => {
  const calls: string[] = [];
  let saved: ReturnType<typeof seedCleanupOriginal> | undefined;
  const item = registryFixture(undefined, async (url) => {
    calls.push(url);
    return envelope(url.endsWith("/health") ? currentHealth : saved?.receipt);
  });
  saved = seedCleanupOriginal(item.values);
  await item.registry.restore();
  const owner = item.registry.snapshot().authorities[0]!.owner;
  expect(owner.snapshot().inventory?.records[0]?.receipt).toEqual(
    saved.receipt,
  );
  item.registry.dispose();
  const writes = item.writes(),
    notices = item.notices();
  await owner.checkOriginal(saved.requestId);
  expect(owner.snapshot().inventory?.records[0]?.receipt).toEqual(
    saved.receipt,
  );
  expect({ calls, writes: item.writes(), notices: item.notices() }).toEqual({
    calls: [],
    writes,
    notices,
  });
});

test("registry disposal during an already started health read prevents the later receipt GET", async () => {
  const calls: string[] = [];
  let saved: ReturnType<typeof seedCleanupOriginal> | undefined;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let firstHealth = true;
  const item = registryFixture(undefined, async (url) => {
    calls.push(url);
    if (url.endsWith("/health")) {
      if (firstHealth) {
        firstHealth = false;
        entered();
        await held;
      }
      return envelope(currentHealth);
    }
    return envelope(saved?.receipt);
  });
  saved = seedCleanupOriginal(item.values);
  await item.registry.restore();
  const owner = item.registry.snapshot().authorities[0]!.owner;
  const pending = owner.checkOriginal(saved.requestId);
  await started;
  item.registry.dispose();
  const before = { writes: item.writes(), notices: item.notices() };
  release();
  await pending;
  expect(owner.snapshot().inventory?.records[0]?.receipt).toEqual(
    saved.receipt,
  );
  expect(
    calls.filter((url) => url.includes("/settings/worktree-cleanup/")),
  ).toEqual([]);
  expect(calls.filter((url) => url.endsWith("/health"))).toHaveLength(1);
  expect({ writes: item.writes(), notices: item.notices() }).toEqual(before);
});

function candidateFixture() {
  const saved = seedCleanupOriginal(new Map());
  const scope = {
    projectId: saved.projectId,
    repository: "C:/Work",
    worktreeId: "saved",
  };
  const record = saved.original.request.expectedRecord;
  const row: ProjectWorktreeFact = {
    id: record.id,
    path: record.path,
    branch: record.branch,
    createdAt: record.createdAt,
    kind: "trees",
    missing: false,
  };
  const member: ProjectRepositoryMember = {
    access: "served",
    path: scope.repository,
    name: "Harness",
    worktrees: [row],
  };
  const workspace: ProjectRepositoryRow = {
    workspaceRoot: scope.repository,
    repositories: [member],
  };
  const data = {
    projectId: scope.projectId,
    catalogRevision: 1,
    repositories: [workspace],
  };
  const facts: CleanupContextFacts = {
    ...contextFacts,
    projectId: scope.projectId,
    repositoryKey: JSON.stringify([scope.projectId, 1]),
    repositoryData: data,
  };
  return {
    scope,
    row,
    member,
    workspace,
    data,
    facts,
    observedHealth: { ...currentHealth },
  };
}

test("cleanup candidate pins exact cloned native facts and allows read-only inspection without write/archive capability", () => {
  const item = candidateFixture();
  item.facts.writesAllowed = false;
  item.facts.archived = true;
  item.facts.connectionPhase = "stopped";
  item.row.path = "C:\\Work\\trees\\Ä🙂";
  const found = cleanupCandidate(item.facts, item.observedHealth, item.scope);
  expect(found?.row.path).toBe("C:\\Work\\trees\\Ä🙂");
  expect(found?.scope).toEqual(item.scope);
  expect(found?.catalogRevision).toBe(1);
  item.row.path = "changed";
  item.scope.worktreeId = "changed";
  expect(found?.row.path).toBe("C:\\Work\\trees\\Ä🙂");
  expect(found?.scope.worktreeId).toBe("saved");
  expect(Object.isFrozen(found?.row)).toBe(true);
});

test("cleanup candidate rejects stale, foreign, incomplete, ambiguous and unmanaged reported facts", () => {
  const changes: Array<(item: ReturnType<typeof candidateFixture>) => void> = [
    (item) => {
      item.scope.projectId = "other";
    },
    (item) => {
      item.facts.catalogReady = false;
    },
    (item) => {
      item.facts.catalogRevision = 2;
    },
    (item) => {
      item.facts.repositoryPhase = "loading";
    },
    (item) => {
      item.facts.repositoryKey = "wrong";
    },
    (item) => {
      item.facts.repositoryRequestedRevision = 2;
    },
    (item) => {
      item.facts.repositoryResponseRevision = 2;
    },
    (item) => {
      item.data.catalogRevision = 2;
    },
    (item) => {
      item.data.projectId = "other";
    },
    (item) => {
      item.workspace.workspaceRoot = "c:/Work";
    },
    (item) => {
      item.member.path = "c:/Work";
    },
    (item) => {
      item.member.access = "approved";
    },
    (item) => {
      item.workspace.repositories = [
        { access: "unregistered", path: "C:/Work" },
      ];
    },
    (item) => {
      item.row.kind = "claude";
    },
    (item) => {
      item.row.missing = true;
    },
    (item) => {
      item.row.id = "bad/id";
      item.scope.worktreeId = "bad/id";
    },
    (item) => {
      item.row.branch = null;
    },
    (item) => {
      delete item.row.createdAt;
    },
    (item) => {
      item.member.worktrees.push({ ...item.row });
    },
    (item) => {
      item.data.repositories.push({ ...item.workspace });
    },
    (item) => {
      item.observedHealth.apiVersion = 999;
    },
    (item) => {
      item.scope.repository = "c:/Work";
    },
  ];
  for (const change of changes) {
    const item = candidateFixture();
    change(item);
    expect(
      cleanupCandidate(item.facts, item.observedHealth, item.scope),
    ).toBeNull();
  }
});

test("cleanup selection binds the real owner read-only and clears old target proof before async selection", async () => {
  const candidate = candidateFixture(),
    saved = seedCleanupOriginal(new Map());
  const calls: Array<{ url: string; method: string }> = [];
  const item = registryFixture(undefined, async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET" });
    return envelope(
      url.endsWith("/health") ? currentHealth : saved.original.review,
    );
  });
  expect(item.providerReads()).toBe(0);
  expect(calls).toEqual([]);
  item.gate.adopt({ ...candidate.facts, writesAllowed: false, archived: true });
  await item.selection.reviewCandidate(candidate.scope);
  const owner = item.registry.snapshot().authorities[0]!.owner;
  expect(owner.snapshot().inspection.phase).toBe("eligible-review");
  expect(owner.snapshot().inspection.review).toEqual(saved.original.review);
  expect(item.selection.currentScope(saved.authorityKey)).toEqual(
    candidate.scope,
  );
  expect(item.selection.canDispatch(saved.authorityKey)).toBe(false);
  const pending = item.selection.reviewCandidate({
    ...candidate.scope,
    worktreeId: "other",
  });
  expect(owner.snapshot().inspection.phase).toBe("idle");
  await pending;
  expect(owner.snapshot().inspection.phase).not.toBe("eligible-review");
  expect(item.uuidCalls()).toBe(0);
  expect(calls.some((call) => call.method === "POST")).toBe(false);
});

test("cleanup selection rejects fresh eligible catalog/path/branch/creation mismatches before any UUID or POST", async () => {
  const changes: Array<(review: CleanupBrowserOriginal["review"]) => void> = [
    (review) => {
      review.expectedCatalogRevision = 2;
    },
    (review) => {
      review.expectedRecord.path = "C:/Work/trees/changed";
    },
    (review) => {
      review.expectedRecord.branch = "feat/changed";
    },
    (review) => {
      review.expectedRecord.createdAt = "2026-11-06T00:00:01.000Z";
    },
  ];
  for (const change of changes) {
    const candidate = candidateFixture(),
      saved = seedCleanupOriginal(new Map());
    const review = structuredClone(saved.original.review);
    change(review);
    const calls: Array<{ url: string; method: string }> = [];
    const item = registryFixture(undefined, async (url, init) => {
      calls.push({ url, method: init?.method ?? "GET" });
      return envelope(url.endsWith("/health") ? currentHealth : review);
    });
    item.gate.adopt(candidate.facts);
    await item.selection.reviewCandidate(candidate.scope);
    const owner = item.registry.snapshot().authorities[0]!.owner;
    expect(
      calls.some((call) => call.url.includes("/worktree-cleanup-review/")),
    ).toBe(true);
    expect(owner.snapshot().inspection.phase).not.toBe("eligible-review");
    await owner.confirm();
    expect(item.selection.currentScope(saved.authorityKey)).toBeNull();
    expect(item.uuidCalls()).toBe(0);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  }
});

test("cleanup selection ignores an eligible review that completes after same-triple source replacement", async () => {
  const candidate = candidateFixture(),
    saved = seedCleanupOriginal(new Map());
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const item = registryFixture(undefined, async (url, init) => {
    calls.push(init?.method ?? "GET");
    if (url.endsWith("/health")) return envelope(currentHealth);
    entered();
    await held;
    return envelope(saved.original.review);
  });
  item.gate.adopt(candidate.facts);
  const pending = item.selection.reviewCandidate(candidate.scope);
  await started;
  item.gate.adopt({
    ...candidate.facts,
    repositoryData: { ...candidate.data },
  });
  release();
  await pending;
  const owner = item.registry.snapshot().authorities[0]!.owner;
  expect(owner.snapshot().inspection.phase).not.toBe("eligible-review");
  expect(item.selection.currentScope(saved.authorityKey)).toBeNull();
  expect(item.uuidCalls()).toBe(0);
  expect(calls.includes("POST")).toBe(false);
});

test("cleanup review owns the original plain scope argument before waiting for health", async () => {
  const candidate = candidateFixture(),
    saved = seedCleanupOriginal(new Map());
  const other = {
    ...candidate.row,
    id: "other",
    path: "C:/Work/trees/other",
    branch: "feat/other",
    createdAt: "2026-11-05T23:00:00.000Z",
  };
  candidate.member.worktrees.push(other);
  const otherReview: CleanupBrowserOriginal["review"] = {
    ...saved.original.review,
    worktreeId: "other",
    expectedRecord: {
      ...saved.original.review.expectedRecord,
      id: other.id,
      path: other.path,
      branch: other.branch,
      createdAt: other.createdAt,
    },
  };
  const input = { ...candidate.scope },
    expected = { ...candidate.scope };
  const calls: Array<{ url: string; method: string }> = [];
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let firstHealth = true;
  const item = registryFixture(undefined, async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.endsWith("/health")) {
      if (firstHealth) {
        firstHealth = false;
        entered();
        await held;
      }
      return envelope(currentHealth);
    }
    return envelope(
      url.endsWith("/other") ? otherReview : saved.original.review,
    );
  });
  item.gate.adopt(candidate.facts);
  const pending = item.selection.reviewCandidate(input);
  await started;
  input.worktreeId = "other";
  release();
  await pending;
  const owner = item.registry.snapshot().authorities[0]!.owner;
  expect(
    calls
      .filter((call) => call.url.includes("/worktree-cleanup-review/"))
      .map((call) => call.url),
  ).toEqual([
    API_PREFIX +
      "/projects/" +
      saved.projectId +
      "/settings/worktree-cleanup-review/saved",
  ]);
  expect(owner.snapshot().inspection.phase).toBe("eligible-review");
  expect(owner.snapshot().inspection.selection).toEqual(expected);
  expect(item.selection.snapshot().candidate?.scope).toEqual(expected);
  expect(input.worktreeId).toBe("other");
  expect(item.uuidCalls()).toBe(0);
  expect(calls.some((call) => call.method === "POST")).toBe(false);
});

test("cleanup confirmation delegates one original while live dispatch stays available and repeated confirmation consumes no new UUID", async () => {
  const candidate = candidateFixture(),
    saved = seedCleanupOriginal(new Map());
  const observed: Array<{
    dispatch: boolean;
    start: boolean;
    pending: boolean;
  }> = [];
  const holder: { item?: ReturnType<typeof registryFixture> } = {};
  let posts = 0,
    reviews = 0;
  const item = registryFixture(undefined, async (url, init) => {
    if (url.endsWith("/health")) return envelope(currentHealth);
    if (init?.method !== "POST") {
      reviews++;
      return envelope(saved.original.review);
    }
    posts++;
    let body: unknown;
    try {
      body = JSON.parse(String(init.body));
    } catch {
      return new Response("Invalid fake request", { status: 500 });
    }
    const parsed = cleanupRequestSchema.safeParse(body);
    if (!parsed.success || !holder.item)
      return new Response("Invalid fake request", { status: 500 });
    observed.push({
      dispatch: holder.item.selection.canDispatch(saved.authorityKey),
      start: holder.item.selection.snapshot().canConfirm,
      pending: holder.item.registry.snapshot().pending,
    });
    const receipt = cleanupReceiptSchema.parse({
      ...saved.receipt,
      ...parsed.data,
      requestHash: createHash("sha256")
        .update(canonicalCleanupRequest(saved.projectId, parsed.data))
        .digest("hex"),
    });
    return envelope(receipt);
  });
  holder.item = item;
  item.gate.adopt(candidate.facts);
  await item.selection.reviewCandidate(candidate.scope);
  expect(item.selection.snapshot().canConfirm).toBe(true);
  await item.selection.confirmReviewed();
  expect(posts).toBe(1);
  expect(reviews).toBe(2);
  expect(item.uuidCalls()).toBe(1);
  expect(observed).toEqual([{ dispatch: true, start: false, pending: true }]);
  const owner = item.registry.snapshot().authorities[0]!.owner;
  expect(owner.snapshot().inventory?.records[0]?.receipt?.state).toBe(
    "confirmed",
  );
  expect(item.registry.snapshot().pending).toBe(false);
  expect(item.selection.snapshot().canConfirm).toBe(false);
  await item.selection.confirmReviewed();
  expect(posts).toBe(1);
  expect(item.uuidCalls()).toBe(1);
});

test("cleanup confirmation with a fresh changed HEAD consumes the review without UUID allocation or POST", async () => {
  const candidate = candidateFixture(),
    saved = seedCleanupOriginal(new Map());
  let reviews = 0,
    posts = 0;
  const item = registryFixture(undefined, async (url, init) => {
    if (url.endsWith("/health")) return envelope(currentHealth);
    if (init?.method === "POST") posts++;
    reviews++;
    return envelope(
      reviews === 1
        ? saved.original.review
        : { ...saved.original.review, expectedHead: "b".repeat(40) },
    );
  });
  item.gate.adopt(candidate.facts);
  await item.selection.reviewCandidate(candidate.scope);
  expect(item.selection.snapshot().canConfirm).toBe(true);
  await item.selection.confirmReviewed();
  expect(reviews).toBe(2);
  expect(posts).toBe(0);
  expect(item.uuidCalls()).toBe(0);
  expect(item.selection.snapshot().canConfirm).toBe(false);
  expect(
    item.registry.snapshot().authorities[0]?.owner.snapshot().inspection.phase,
  ).toBe("review-changed");
  expect(
    item.registry.snapshot().authorities[0]?.owner.snapshot().inspection.notice,
  ).toBe("Review cleanup again before creating another original.");
});

test("late confirmed cleanup A preserves project B's newer eligible review and original A identity", async () => {
  const first = candidateFixture(),
    second = candidateFixture(),
    saved = seedCleanupOriginal(new Map());
  const projectB = "project-10000000-0000-4000-8000-000000000099";
  second.scope.projectId = projectB;
  second.scope.worktreeId = "other";
  second.facts.projectId = projectB;
  second.facts.route = "#/projects/" + projectB + "/settings";
  second.facts.repositoryKey = JSON.stringify([projectB, 1]);
  second.data.projectId = projectB;
  second.row.id = "other";
  second.row.path = "C:/Work/trees/other";
  second.row.branch = "feat/other";
  const reviewB: CleanupBrowserOriginal["review"] = {
    ...saved.original.review,
    projectId: projectB,
    worktreeId: "other",
    expectedRecord: {
      ...saved.original.review.expectedRecord,
      id: "other",
      path: "C:/Work/trees/other",
      branch: "feat/other",
    },
  };
  const posted: { receipt: CleanupReceipt | null } = { receipt: null };
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let posts = 0,
    bReads = 0;
  const item = registryFixture(undefined, async (url, init) => {
    if (url.endsWith("/health")) return envelope(currentHealth);
    if (init?.method === "POST") {
      posts++;
      entered();
      let body: unknown;
      try {
        body = JSON.parse(String(init.body));
      } catch {
        return new Response("Invalid fake request", { status: 500 });
      }
      const request = cleanupRequestSchema.safeParse(body);
      if (!request.success)
        return new Response("Invalid fake request", { status: 500 });
      posted.receipt = cleanupReceiptSchema.parse({
        ...saved.receipt,
        ...request.data,
        requestHash: createHash("sha256")
          .update(canonicalCleanupRequest(saved.projectId, request.data))
          .digest("hex"),
      });
      await held;
      return envelope(posted.receipt);
    }
    if (url.includes("/settings/worktree-cleanup/"))
      return envelope(
        posted.receipt
          ? {
              ...posted.receipt,
              state: "unknown",
              reason: "The original operation is still in flight.",
              endedAt: null,
            }
          : null,
      );
    if (url.includes("/projects/" + projectB + "/")) {
      bReads++;
      return envelope(reviewB);
    }
    return envelope(saved.original.review);
  });
  item.gate.adopt(first.facts);
  await item.selection.reviewCandidate(first.scope);
  const confirming = item.selection.confirmReviewed();
  await started;
  item.gate.adopt(second.facts);
  await item.selection.reviewCandidate(second.scope);
  const owner = item.registry.snapshot().authorities[0]!.owner;
  expect(bReads).toBe(1);
  expect(owner.snapshot().inspection.phase).toBe("eligible-review");
  expect(owner.snapshot().inspection.selection).toEqual(second.scope);
  expect(item.selection.snapshot().canConfirm).toBe(false);
  expect(item.registry.snapshot().pending).toBe(true);
  release();
  await confirming;
  const receipt = posted.receipt;
  if (!receipt)
    throw Error("The fake server never received cleanup A's original.");
  expect(owner.snapshot().inspection.phase).toBe("eligible-review");
  expect(owner.snapshot().inspection.review).toEqual(reviewB);
  expect(item.selection.snapshot().candidate?.scope).toEqual(second.scope);
  expect(item.selection.snapshot().canConfirm).toBe(true);
  expect(item.registry.snapshot().pending).toBe(false);
  const record = owner.snapshot().inventory?.records[0];
  expect(record?.original.projectId).toBe(saved.projectId);
  expect(record?.original.request.requestId).toBe(receipt.requestId);
  expect(record?.original.requestHash).toBe(receipt.requestHash);
  expect(record?.receipt).toEqual(receipt);
  expect(posts).toBe(1);
  expect(item.uuidCalls()).toBe(1);
});

function refreshRecord(last: string): CleanupBrowserRecord {
  const saved = seedCleanupOriginal(new Map());
  const expectedRecord = {
    ...saved.original.request.expectedRecord,
    id: "saved-" + last,
    path: "C:/Work/trees/saved-" + last,
  };
  const request = {
    ...saved.original.request,
    expectedRecord,
    requestId: "20000000-0000-4000-8000-" + last.padStart(12, "0"),
  };
  const requestHash = createHash("sha256")
    .update(canonicalCleanupRequest(saved.projectId, request))
    .digest("hex");
  return {
    original: {
      ...saved.original,
      request,
      requestHash,
      review: {
        ...saved.original.review,
        worktreeId: expectedRecord.id,
        expectedRecord,
      },
    },
    receipt: { ...saved.receipt, ...request, requestHash },
  };
}
function refreshSnapshot(records: CleanupBrowserRecord[]) {
  const key = cleanupAuthorityKey(origin, "C:/Work");
  const activeRequestId =
    records.find(
      (row) => row.receipt === null || row.receipt.state === "unknown",
    )?.original.request.requestId ?? null;
  return [
    {
      key,
      repository: "C:/Work",
      view: {
        inventory: cleanupBrowserInventorySchema.parse({
          version: 1,
          authorityKey: key,
          records,
          activeRequestId,
        }),
      },
    },
  ];
}

test("cleanup refresh seeds restored history once, then handles first-seen confirmed rows after baseline without render effects or duplicates", async () => {
  const first = refreshRecord("1"),
    second = refreshRecord("2");
  const calls: string[] = [];
  let refresher!: ReturnType<typeof createCleanupPresentationRefresh>;
  refresher = createCleanupPresentationRefresh({
    currentProject: () => first.original.projectId,
    isActive: () => true,
    onChange: () => undefined,
    refreshCatalog: async () => {
      calls.push("catalog");
      refresher.observe(refreshSnapshot([first, second]));
    },
    refreshRepositories: async (id) => {
      calls.push(id);
    },
  });
  refresher.observe(refreshSnapshot([first]));
  await refresher.flush();
  expect(calls).toEqual([]);
  refresher.observe(refreshSnapshot([first, second]));
  refresher.observe(refreshSnapshot([first, second]));
  expect(calls).toEqual([]);
  const pending = refresher.flush();
  expect(refresher.flush()).toBe(pending);
  await pending;
  expect(calls).toEqual(["catalog", first.original.projectId]);
  await refresher.flush();
  expect(calls).toHaveLength(2);
  expect(refresher.snapshot().warning).toBeNull();
});

test("cleanup refresh drains new arrivals during held catalog work and never refreshes B repositories as A's result", async () => {
  const first = refreshRecord("1"),
    second = refreshRecord("2");
  const calls: string[] = [];
  let current: string | null = first.original.projectId,
    entered!: () => void,
    release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let catalogs = 0;
  const refresher = createCleanupPresentationRefresh({
    currentProject: () => current,
    isActive: () => true,
    onChange: () => undefined,
    refreshCatalog: async () => {
      calls.push("catalog");
      if (++catalogs === 1) {
        entered();
        await held;
      }
    },
    refreshRepositories: async (id) => {
      calls.push(id);
    },
  });
  refresher.observe(refreshSnapshot([]));
  refresher.observe(refreshSnapshot([{ ...first, receipt: null }]));
  refresher.observe(refreshSnapshot([first]));
  const pending = refresher.flush();
  await started;
  refresher.observe(refreshSnapshot([first, second]));
  current = "project-10000000-0000-4000-8000-000000000099";
  release();
  await pending;
  expect(calls).toEqual(["catalog", "catalog"]);
  expect(first.receipt?.state).toBe("confirmed");
  expect(second.receipt?.state).toBe("confirmed");
});

test("cleanup refresh failure is sticky, does not retry or mutate receipts, and queued work respects disposal", async () => {
  const record = refreshRecord("1"),
    before = JSON.stringify(record);
  let attempts = 0,
    notices = 0,
    repositories = 0,
    active = true;
  const refresher = createCleanupPresentationRefresh({
    currentProject: () => record.original.projectId,
    isActive: () => active,
    onChange: () => {
      notices++;
    },
    refreshCatalog: async () => {
      attempts++;
      throw Error("refresh failed");
    },
    refreshRepositories: async () => {
      repositories++;
    },
  });
  refresher.observe(refreshSnapshot([]));
  refresher.observe(refreshSnapshot([record]));
  await refresher.flush();
  expect(refresher.snapshot().warning).toContain("receipt is retained");
  await refresher.flush();
  expect(attempts).toBe(1);
  expect(notices).toBe(1);
  expect(repositories).toBe(0);
  expect(JSON.stringify(record)).toBe(before);
  refresher.observe(refreshSnapshot([record, refreshRecord("2")]));
  const queued = refresher.flush();
  active = false;
  await queued;
  expect(attempts).toBe(1);
  expect(notices).toBe(1);
});

test("cleanup coordinator constructs without effects, suppresses render notifications and does not retry failed health on ordinary renders", async () => {
  const candidate = candidateFixture(),
    saved = seedCleanupOriginal(new Map()),
    browser = registryFixture();
  candidate.facts.route =
    "#/projects/" + candidate.scope.projectId + "/settings";
  const source = { status: "live", route: candidate.facts.route };
  const calls: string[] = [];
  let statusReads = 0,
    routeReads = 0,
    notices = 0,
    failHealth = false,
    presentationCalls = 0;
  const model = createCleanupCoordinator({
    origin,
    web: browser.web,
    status: () => {
      statusReads++;
      return source.status;
    },
    routeKey: () => {
      routeReads++;
      return source.route;
    },
    transport: transport(async (url) => {
      calls.push(url);
      return url.endsWith("/health")
        ? failHealth
          ? new Response("Unavailable", { status: 503 })
          : envelope(currentHealth)
        : envelope(saved.original.review);
    }),
    refreshCatalog: async () => {
      presentationCalls++;
    },
    refreshRepositories: async () => {
      presentationCalls++;
    },
  });
  expect({
    statusReads,
    routeReads,
    presentationCalls,
    calls,
    captures: browser.surfaceCaptures(),
    writes: browser.writes(),
    locks: browser.lockStarts(),
  }).toEqual({
    statusReads: 0,
    routeReads: 0,
    presentationCalls: 0,
    calls: [],
    captures: 0,
    writes: 0,
    locks: 0,
  });
  model.subscribe(() => {
    notices++;
  });
  model.adoptContext(candidate.facts);
  expect(notices).toBe(0);
  expect(calls).toEqual([]);
  await model.flush();
  await model.reviewCandidate(candidate.scope);
  expect(model.snapshot().canConfirm).toBe(true);
  const before = { notices, calls: calls.length };
  const changed = { ...candidate.facts, catalogSource: {} };
  model.adoptContext(changed);
  expect(model.snapshot().canConfirm).toBe(false);
  expect(model.snapshot().project?.inspection?.phase).not.toBe(
    "eligible-review",
  );
  expect({ notices, calls: calls.length }).toEqual(before);
  failHealth = true;
  await model.flush();
  const attempts = calls.filter((url) => url.endsWith("/health")).length;
  model.adoptContext({ ...changed });
  model.sourceChanged("status");
  await model.flush();
  await model.flush();
  expect(calls.filter((url) => url.endsWith("/health"))).toHaveLength(attempts);
  await model.refreshRecovery();
  expect(calls.filter((url) => url.endsWith("/health"))).toHaveLength(
    attempts + 1,
  );
  await model.flush();
  expect(calls.filter((url) => url.endsWith("/health"))).toHaveLength(
    attempts + 1,
  );
  expect(presentationCalls).toBe(0);
  model.dispose();
});

test("cleanup coordinator invalidates raw hash changes and closes before late activation can restore or notify", async () => {
  const candidate = candidateFixture(),
    browser = registryFixture();
  const source = { status: "live", route: candidate.facts.route };
  let entered!: () => void,
    release!: () => void,
    notices = 0,
    presentationCalls = 0;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const model = createCleanupCoordinator({
    origin,
    web: browser.web,
    status: () => source.status,
    routeKey: () => source.route,
    transport: transport(async (url) => {
      calls.push(url);
      entered();
      await held;
      return envelope(currentHealth);
    }),
    refreshCatalog: async () => {
      presentationCalls++;
    },
    refreshRepositories: async () => {
      presentationCalls++;
    },
  });
  model.subscribe(() => {
    notices++;
  });
  model.adoptContext(candidate.facts);
  const pending = model.flush();
  await started;
  source.route = "#/other";
  model.sourceChanged("hash");
  source.route = candidate.facts.route;
  model.sourceChanged("hash");
  expect(model.snapshot().canConfirm).toBe(false);
  model.dispose();
  const before = notices;
  release();
  await pending;
  expect(model.snapshot().authorities).toEqual([]);
  expect(model.snapshot().canConfirm).toBe(false);
  expect(browser.surfaceCaptures()).toBe(0);
  expect(browser.lockStarts()).toBe(0);
  expect(browser.writes()).toBe(0);
  expect(notices).toBe(before);
  expect(calls).toHaveLength(1);
  expect(presentationCalls).toBe(0);
});

for (const connection of ["off", "failed-health"] as const) {
  test(
    "cleanup saved originals remain visible at startup with " + connection,
    async () => {
      const candidate = candidateFixture(),
        browser = registryFixture();
      const saved = seedCleanupOriginal(browser.values);
      const metadata = [...browser.values];
      const calls: Array<{ url: string; method: string }> = [];
      let presentation = 0;
      const model = createCleanupCoordinator({
        origin,
        web: browser.web,
        status: () => (connection === "off" ? "off" : "live"),
        routeKey: () => candidate.facts.route,
        transport: transport(async (url, init) => {
          calls.push({ url, method: init?.method ?? "GET" });
          return new Response("Unavailable", { status: 503 });
        }),
        refreshCatalog: async () => {
          presentation++;
        },
        refreshRepositories: async () => {
          presentation++;
        },
      });
      model.adoptContext(candidate.facts);
      await model.flush();
      expect(calls.filter((call) => call.url.endsWith("/health"))).toHaveLength(
        connection === "off" ? 0 : 1,
      );
      expect(calls.some((call) => call.method === "POST")).toBe(false);
      expect(browser.uuidCalls()).toBe(0);
      expect(browser.writes()).toBe(0);
      expect([...browser.values]).toEqual(metadata);
      expect(presentation).toBe(0);
      const originals = model
        .snapshot()
        .authorities.flatMap(
          (authority) =>
            authority.view.inventory?.records.map(
              (record) => record.original,
            ) ?? [],
        );
      expect(originals).toEqual([saved.original]);
      expect(originals[0]?.request.requestId).toBe(saved.requestId);
      expect(model.snapshot().canConfirm).toBe(false);
      model.dispose();
    },
  );
}

test("cleanup coordinator owns adopted caller facts so mutating them cannot launder a changed raw route", async () => {
  const candidate = candidateFixture(),
    saved = seedCleanupOriginal(new Map()),
    browser = registryFixture();
  const input = { ...candidate.facts };
  const source = { route: input.route };
  let posts = 0;
  const model = createCleanupCoordinator({
    origin,
    web: browser.web,
    status: () => "live",
    routeKey: () => source.route,
    transport: transport(async (url, init) => {
      if (url.endsWith("/health")) return envelope(currentHealth);
      if (init?.method === "POST") {
        posts++;
        return new Response("Fake uncertain outcome", { status: 500 });
      }
      return envelope(saved.original.review);
    }),
    refreshCatalog: async () => undefined,
    refreshRepositories: async () => undefined,
  });
  model.adoptContext(input);
  await model.flush();
  await model.reviewCandidate(candidate.scope);
  expect(model.snapshot().canConfirm).toBe(true);
  input.route = "#/projects/project-b/settings";
  source.route = input.route;
  const eligibility = {
    canConfirm: model.snapshot().canConfirm,
    canReview: model.canReview(candidate.scope),
  };
  await model.confirmReviewed();
  expect({ ...eligibility, posts, uuids: browser.uuidCalls() }).toEqual({
    canConfirm: false,
    canReview: false,
    posts: 0,
    uuids: 0,
  });
  expect(model.snapshot().canConfirm).toBe(false);
  model.dispose();
});

test("cleanup source binding filters areas, observes every local key and closes before exactly-once teardown", async () => {
  const candidate = candidateFixture(),
    browser = registryFixture(),
    saved = seedCleanupOriginal(browser.values);
  const source = { status: "live", route: candidate.facts.route };
  const calls: string[] = [];
  const model = createCleanupCoordinator({
    origin,
    web: browser.web,
    status: () => source.status,
    routeKey: () => source.route,
    transport: transport(async (url) => {
      calls.push(url);
      return envelope(
        url.endsWith("/health") ? currentHealth : saved.original.review,
      );
    }),
    refreshCatalog: async () => undefined,
    refreshRepositories: async () => undefined,
  });
  const handlers: {
    status?: () => void;
    hash?: () => void;
    storage?: (event: { storageArea: unknown; key: string | null }) => void;
  } = {};
  const leaves: Array<{ kind: string; repository: string | null }> = [];
  let denied = false,
    areaReads = 0;
  const register = (kind: "status" | "hash", listener: () => void) => {
    handlers[kind] = listener;
    return () => {
      leaves.push({ kind, repository: model.snapshot().repository });
    };
  };
  model.adoptContext(candidate.facts);
  const stop = bindCleanupSources(model, {
    onStatus: (listener) => register("status", listener),
    onHash: (listener) => register("hash", listener),
    onStorage(listener) {
      handlers.storage = listener;
      return () => {
        leaves.push({
          kind: "storage",
          repository: model.snapshot().repository,
        });
      };
    },
    localStorage() {
      areaReads++;
      if (denied) throw Error("Storage access denied");
      return browser.surface;
    },
  });
  expect(Object.keys(handlers).sort()).toEqual(["hash", "status", "storage"]);
  expect(calls).toEqual([]);
  await model.flush();
  await model.reviewCandidate(candidate.scope);
  expect(model.snapshot().canConfirm).toBe(true);
  const sameStatus = calls.length;
  handlers.status?.();
  await model.flush();
  expect(calls).toHaveLength(sameStatus);
  handlers.storage?.({ storageArea: {}, key: "session-key" });
  expect(model.snapshot().canConfirm).toBe(true);
  source.route = "#/other";
  handlers.hash?.();
  source.route = candidate.facts.route;
  handlers.hash?.();
  expect(model.snapshot().canConfirm).toBe(false);
  await model.flush();
  await model.reviewCandidate(candidate.scope);
  expect(model.snapshot().canConfirm).toBe(true);
  browser.values.set("unrelated-preference", "value");
  handlers.storage?.({
    storageArea: browser.surface,
    key: "unrelated-preference",
  });
  expect(model.snapshot().canConfirm).toBe(false);
  await model.flush();
  await model.reviewCandidate(candidate.scope);
  expect(model.snapshot().canConfirm).toBe(true);
  denied = true;
  handlers.storage?.({
    storageArea: browser.surface,
    key: "another-unrelated-key",
  });
  expect(model.snapshot().canConfirm).toBe(false);
  denied = false;
  await model.flush();
  browser.values.clear();
  handlers.storage?.({ storageArea: browser.surface, key: null });
  await model.flush();
  expect(
    model.snapshot().authorities[0]?.view.inventory?.records[0]?.original,
  ).toEqual(saved.original);
  expect(browser.writes()).toBe(0);
  expect(model.snapshot().repository).toBe("C:/Work");
  stop();
  stop();
  expect(leaves).toEqual(
    ["status", "hash", "storage"].map((kind) => ({ kind, repository: null })),
  );
  const before = {
    calls: calls.length,
    areas: areaReads,
    captures: browser.surfaceCaptures(),
  };
  source.status = "off";
  handlers.status?.();
  source.status = "live";
  handlers.status?.();
  handlers.hash?.();
  handlers.storage?.({ storageArea: browser.surface, key: "late" });
  await model.flush();
  expect({
    calls: calls.length,
    areas: areaReads,
    captures: browser.surfaceCaptures(),
  }).toEqual(before);
  expect(model.snapshot().canConfirm).toBe(false);
  expect(
    model.snapshot().authorities[0]?.view.inventory?.records[0]?.original,
  ).toEqual(saved.original);
  expect(browser.uuidCalls()).toBe(0);
});
