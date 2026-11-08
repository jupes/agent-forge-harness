import { expect, test } from "bun:test";
import {
  type CleanupContextFacts,
  cleanupAuthorityKey,
  createCleanupCapabilities,
  createCleanupContextGate,
  createCleanupTransport,
  discoverCleanupAuthorities,
  parseCleanupAuthority,
} from "../../apps/desktop/src/use-project-worktree-cleanup";
import { createOperatorClient } from "../../docs/js/operator";
import { API_PREFIX, OPERATOR_HEADER, TOKEN_ROUTE } from "../hearth/paths";

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
