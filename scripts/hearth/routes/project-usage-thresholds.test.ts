import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { LedgerEventInput } from "../../../types/hearth";
import {
  type UsageThresholdRecord,
  usageThresholdDocumentSchema,
  usageThresholdJson,
  usageThresholdRecordSchema,
} from "../../../types/usage-threshold-settings";
import { appendEvent } from "../../ledger/append";
import { closeLedger } from "../../ledger/db";
import { queryEvents } from "../../ledger/query";
import { workspaceKey } from "../../projects/scope";
import { createProjectStore, projectCatalogPath } from "../../projects/store";
import { projectCatalogFixture } from "../../projects/testing";
import {
  createUsageThresholdStore,
  UsageThresholdError,
  usageThresholdRequestSchema,
} from "../../projects/usage-threshold-store";
import {
  type ActionRoute,
  createOperatorApi,
  type OperatorApiDeps,
} from "../api";
import { API_PREFIX, OPERATOR_HEADER } from "../paths";
import { writeOwnerOnly } from "../token";
import { createUsageThresholdRoutes } from "./project-usage-thresholds";

const fixtures: Array<{ home: string; server: Server }> = [];
const requestId = "bb000000-0000-4000-8000-000000000001";
afterEach(async () => {
  for (const { home, server } of fixtures.splice(0)) {
    await new Promise<void>((done, reject) => {
      server.close((error) => (error ? reject(error) : done()));
      server.closeAllConnections();
    });
    const target = realpathSync(home);
    if (
      dirname(target) !== realpathSync(tmpdir()) ||
      !basename(target).startsWith("forge-usage-api-")
    )
      throw Error("Unsafe owned fixture cleanup");
    rmSync(target, { recursive: true, force: true });
  }
});

async function fixture(
  options: {
    storeFactory?: Parameters<typeof createUsageThresholdRoutes>[2];
    append?: OperatorApiDeps["appendEvent"];
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "forge-usage-api-"));
  const workspace = workspaceKey(home);
  writeOwnerOnly(
    projectCatalogPath(home),
    JSON.stringify(projectCatalogFixture(workspace)),
  );
  const project = createProjectStore(home).read().projects[0];
  if (!project) throw Error("Invalid project fixture");
  const request = usageThresholdRequestSchema.parse({
    requestId,
    workspace,
    expectedCatalogRevision: 1,
    expectedRevision: 0,
    rules: [],
  });
  const token = "a".repeat(64);
  const events: LedgerEventInput[] = [];
  const control: ActionRoute<null> = {
    kind: "action",
    method: "POST",
    path: "/control",
    action: "fixture.control",
    validate: () => ({ ok: true, value: null }),
    subject: () => ({}),
    effect: () => ({ status: 200, data: { controlled: true } }),
  };
  const routes = createUsageThresholdRoutes(
    home,
    workspace,
    options.storeFactory,
  );
  const api = createOperatorApi(
    {
      workspace,
      expectedToken: () => token,
      appendEvent(event) {
        events.push(structuredClone(event));
        if (options.append) return options.append(event);
        return { ok: true, id: events.length, ulid: "fixture" };
      },
    },
    [control, ...routes.reads, ...routes.actions],
  );
  const server = createServer((req, res) => {
    void api.handle(req, res, () => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ ok: false, data: null, error: "Missing route" }),
      );
    });
  });
  fixtures.push({ home, server });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No owned port");
  const origin = `http://127.0.0.1:${address.port}`;
  const base = `/projects/${project.id}/settings/usage-thresholds`;
  async function send(
    path: string,
    body?: unknown,
    override: { headers?: Record<string, string>; raw?: string } = {},
  ) {
    const response = await fetch(origin + API_PREFIX + path, {
      method: body === undefined && override.raw === undefined ? "GET" : "POST",
      headers: {
        Origin: origin,
        [OPERATOR_HEADER]: token,
        "content-type": "application/json",
        ...override.headers,
      },
      ...(body === undefined && override.raw === undefined
        ? {}
        : { body: override.raw ?? JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    });
    const answer: unknown = await response.json();
    return { status: response.status, body: answer };
  }
  return {
    home,
    workspace,
    projectId: project.id,
    base,
    request,
    send,
    events,
    store: createUsageThresholdStore(home, workspace),
    routes,
  };
}

test("the owned loopback API control accepts the actual canonical project and explicit request", async () => {
  const f = await fixture();
  expect(usageThresholdRequestSchema.parse(f.request)).toEqual(f.request);
  expect(await f.send("/control", {})).toEqual({
    status: 200,
    body: { ok: true, data: { controlled: true }, error: null },
  });
  expect(f.events.map((event) => event.kind)).toEqual(["operator.action"]);
});

test("an authenticated policy save is audited and returns the persisted exact original", async () => {
  const f = await fixture();
  const reply = await f.send(f.base, f.request);
  expect(reply.status).toBe(200);
  expect(reply.body).toMatchObject({
    ok: true,
    data: {
      document: { projectId: f.projectId, workspace: f.workspace, revision: 1 },
      receipt: {
        original: { ...f.request, projectId: f.projectId },
        outcome: "applied",
      },
    },
    error: null,
  });
  expect(f.events).toHaveLength(1);
  expect(
    existsSync(join(f.home, "usage-threshold-settings", "state.json")),
  ).toBe(true);
});

test("a protected current read reports a genuine uninitialized empty policy without publishing it", async () => {
  const f = await fixture();
  expect(await f.send(f.base)).toEqual({
    status: 200,
    body: {
      ok: true,
      data: {
        projectId: f.projectId,
        workspace: f.workspace,
        revision: 0,
        rules: [],
      },
      error: null,
    },
  });
  expect(f.events).toEqual([]);
  expect(existsSync(join(f.home, "usage-threshold-settings"))).toBe(false);
});

test("the protected exact-original read is read-only and survives catalog removal", async () => {
  const f = await fixture();
  expect((await f.send(f.base, f.request)).status).toBe(200);
  const file = join(f.home, "usage-threshold-settings", "state.json");
  const before = readFileSync(file);
  const saved = f.store.original(f.projectId, requestId);
  writeOwnerOnly(
    projectCatalogPath(f.home),
    JSON.stringify({
      ...createProjectStore(f.home).read(),
      revision: 2,
      projects: [],
    }),
  );
  expect(await f.send(`${f.base}/requests/${requestId}`)).toEqual({
    status: 200,
    body: { ok: true, data: saved, error: null },
  });
  expect(
    (await f.send(`${f.base}/requests/bb000000-0000-4000-8000-000000000099`))
      .status,
  ).toBe(404);
  expect(readFileSync(file)).toEqual(before);
  expect(f.events).toHaveLength(1);
});

const nextId = (n: number) =>
  "bb000000-0000-4000-8000-" + n.toString(16).padStart(12, "0");
const rule = {
  id: "aa000000-0000-4000-8000-000000000001",
  provider: "claude",
  enabled: true,
  selector: {
    kind: "subscription-window",
    unit: "percent",
    source: "provider-cli",
    label: "private report window",
    basis: "used",
  },
  comparison: "at-least",
  threshold: 80,
} as const;

test("the real audit ledger retains the fixed usage family and drops arbitrary families and private rules", async () => {
  let auditFile: string | undefined;
  const f = await fixture({
    append(event) {
      if (!auditFile)
        return { ok: false, error: "Owned audit fixture not ready" };
      return appendEvent(event, { path: auditFile });
    },
  });
  const ownedLedger = join(f.home, "api-audit.db");
  auditFile = ownedLedger;
  try {
    const metadata = {
      action: "usage.thresholds.set",
      surface: "api" as const,
      target: f.projectId,
      requestId: nextId(99),
    };
    const unapproved = {
      kind: "operator.action" as const,
      workspace: f.workspace,
      payload: {
        ...metadata,
        family: "usage-threshold-settings-extra",
        rules: [rule],
        label: rule.selector.label,
      },
    };
    const control = appendEvent(unapproved, { path: ownedLedger });
    expect(control.ok).toBe(true);
    if (!control.ok || !("id" in control))
      throw Error("Missing owned audit row");
    expect(queryEvents({}, { path: ownedLedger })[0]?.payload).toEqual(
      metadata,
    );
    expect((await f.send(f.base, { ...f.request, rules: [rule] })).status).toBe(
      200,
    );
    const rows = queryEvents({ afterId: control.id }, { path: ownedLedger });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({
      ...metadata,
      requestId,
      family: "usage-threshold-settings",
    });
    expect(
      JSON.stringify(queryEvents({}, { path: ownedLedger })),
    ).not.toContain(rule.selector.label);
  } finally {
    closeLedger(ownedLedger);
  }
});

test("persisted CAS refusals have complete data and replay preserves old receipts beside the newer policy", async () => {
  const f = await fixture();
  const first = { ...f.request, rules: [rule] };
  expect((await f.send(f.base, first)).status).toBe(200);
  const refused = { ...f.request, requestId: nextId(2) };
  const refusal = await f.send(f.base, refused);
  expect(refusal).toMatchObject({
    status: 409,
    body: {
      ok: true,
      error: null,
      data: {
        receipt: {
          outcome: "refused",
          resultingRevision: 1,
          refusalCode: "policy-revision-conflict",
        },
        document: { revision: 1, rules: [rule] },
      },
    },
  });
  expect(
    (
      await f.send(f.base, {
        ...f.request,
        requestId: nextId(3),
        expectedRevision: 1,
      })
    ).status,
  ).toBe(200);
  const replay = await f.send(f.base, first);
  expect(replay).toEqual({
    status: 200,
    body: {
      ok: true,
      data: f.store.original(f.projectId, requestId),
      error: null,
    },
  });
  expect(replay.body).toMatchObject({
    data: {
      receipt: { resultingRevision: 1, original: first },
      document: { revision: 2, rules: [] },
    },
  });
  expect((await f.send(f.base, { ...first, rules: [] })).status).toBe(409);
  expect(f.store.read(f.projectId).revision).toBe(2);
  expect(await f.send(`${f.base}/requests/${nextId(2)}`)).toEqual({
    status: 200,
    body: {
      ok: true,
      data: f.store.original(f.projectId, nextId(2)),
      error: null,
    },
  });
});

test("origin, token and strict path/body/query bounds refuse before audit or store construction", async () => {
  let constructed = 0;
  const f = await fixture({
    storeFactory: (home, workspace) => {
      constructed++;
      return createUsageThresholdStore(home, workspace);
    },
  });
  const paths = [f.base, `${f.base}/requests/${requestId}`];
  for (const path of paths) {
    expect(
      (await f.send(path, undefined, { headers: { [OPERATOR_HEADER]: "" } }))
        .status,
    ).toBe(403);
    expect(
      (
        await f.send(path, undefined, {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect((await f.send(path + "?root=foreign")).status).toBe(400);
  }
  for (const headers of [
    { [OPERATOR_HEADER]: "wrong" },
    { Origin: "" },
    { Origin: "http://127.0.0.1:1" },
  ])
    expect((await f.send(f.base, f.request, { headers })).status).toBe(403);
  const bodies = [
    { ...f.request, workspace: f.workspace + "/foreign" },
    { ...f.request, projectId: f.projectId },
    { ...f.request, expectedRevision: -1 },
    { ...f.request, rules: [{ ...rule, threshold: 101 }] },
    { ...f.request, rules: [rule, rule] },
    { ...f.request, requestId: requestId.toUpperCase() },
  ];
  for (const body of bodies)
    expect((await f.send(f.base, body)).status).toBe(400);
  expect((await f.send(f.base + "?workspace=foreign", f.request)).status).toBe(
    400,
  );
  expect(
    (await f.send(f.base.replace(f.projectId, "project-bad"), f.request))
      .status,
  ).toBe(400);
  expect((await f.send(`${f.base}/requests/not-a-uuid`)).status).toBe(400);
  const raw = JSON.stringify(f.request);
  expect(
    (
      await f.send(f.base, undefined, {
        raw: raw.slice(0, -1) + ',"expectedRevision":0}',
      })
    ).status,
  ).toBe(400);
  expect(
    await f.send(f.base, undefined, {
      raw: '{"padding":"' + "x".repeat(256 * 1024) + '"}',
    }),
  ).toEqual({
    status: 400,
    body: { ok: false, data: null, error: "Request body exceeds 262144 bytes" },
  });
  expect(constructed).toBe(0);
  expect(f.events).toEqual([]);
  expect(existsSync(join(f.home, "usage-threshold-settings"))).toBe(false);
});

test("audit refusal prevents policy effects and successful audit records metadata before publication", async () => {
  let constructed = 0;
  const denied = await fixture({
    append: () => ({ ok: false, error: "fixture ledger refused" }),
    storeFactory: (home, workspace) => {
      constructed++;
      return createUsageThresholdStore(home, workspace);
    },
  });
  expect((await denied.send(denied.base, denied.request)).status).toBe(503);
  expect(constructed).toBe(0);
  expect(existsSync(join(denied.home, "usage-threshold-settings"))).toBe(false);
  const f = await fixture({
    append: (event) => {
      expect(event).toMatchObject({
        kind: "operator.action",
        payload: { action: "usage.thresholds.set" },
      });
      expect(
        existsSync(join(f.home, "usage-threshold-settings", "state.json")),
      ).toBe(false);
      return { ok: true, id: 9, ulid: "fixture" };
    },
  });
  expect((await f.send(f.base, { ...f.request, rules: [rule] })).status).toBe(
    200,
  );
  expect(f.events[0]?.payload).toEqual({
    action: "usage.thresholds.set",
    surface: "api",
    target: f.projectId,
    family: "usage-threshold-settings",
    requestId,
  });
  expect(JSON.stringify(f.events)).not.toContain(rule.selector.label);
});

test("an uncertain save stays unknown until the exact retained original is read without redispatch", async () => {
  let publications = 0;
  const f = await fixture({
    storeFactory: (home, workspace) =>
      createUsageThresholdStore(home, workspace, {
        afterWrite() {
          publications++;
          throw Error("private filesystem detail");
        },
      }),
  });
  expect(await f.send(f.base, f.request)).toEqual({
    status: 504,
    body: {
      ok: false,
      data: null,
      error:
        "Usage threshold settings may have changed. Check the exact saved original before continuing.",
    },
  });
  const settled = f.store.original(f.projectId, requestId);
  expect(settled.receipt.outcome).toBe("applied");
  expect(await f.send(`${f.base}/requests/${requestId}`)).toEqual({
    status: 200,
    body: { ok: true, data: settled, error: null },
  });
  expect(publications).toBe(1);
  expect(f.events).toHaveLength(1);
});

test("shared records reject contradictions while allowing a newer current document beside an old receipt", async () => {
  const f = await fixture();
  const saved = await f.store.write(f.projectId, {
    ...f.request,
    rules: [rule],
  });
  expect(usageThresholdRecordSchema.parse(saved)).toEqual(saved);
  expect(
    usageThresholdDocumentSchema.safeParse({ ...saved.document, revision: 0 })
      .success,
  ).toBe(false);
  for (const changed of [
    { ...saved, extra: true },
    { ...saved, document: { ...saved.document, rules: [] } },
    {
      ...saved,
      document: { ...saved.document, workspace: f.workspace + "/foreign" },
    },
    { ...saved, receipt: { ...saved.receipt, resultingRevision: 2 } },
    {
      ...saved,
      receipt: {
        ...saved.receipt,
        original: { ...saved.receipt.original, extra: true },
      },
    },
  ])
    expect(usageThresholdRecordSchema.safeParse(changed).success).toBe(false);
  const next = await f.store.write(f.projectId, {
    ...f.request,
    requestId: nextId(2),
    expectedRevision: 1,
  });
  expect(
    usageThresholdRecordSchema.parse({ ...saved, document: next.document })
      .document.revision,
  ).toBe(2);
  expect(usageThresholdJson({ z: [1, { b: 2, a: 3 }], a: 0 })).toBe(
    '{"a":0,"z":[1,{"a":3,"b":2}]}',
  );
});

test("thrown private values and hostile accessors cannot select response text or status", async () => {
  let getters = 0;
  const hostile = new UsageThresholdError(
    400,
    "private code",
    "private message",
  );
  Object.defineProperties(hostile, {
    status: {
      get() {
        getters++;
        return 400;
      },
    },
    message: {
      get() {
        getters++;
        throw Error("private getter");
      },
    },
    code: {
      get() {
        getters++;
        throw Error("private getter");
      },
    },
  });
  const known = new UsageThresholdError(409, "private code", "private message");
  Object.defineProperties(known, {
    message: {
      get() {
        getters++;
        throw Error("private getter");
      },
    },
    code: {
      get() {
        getters++;
        throw Error("private getter");
      },
    },
  });
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw Error("private prototype");
      },
    },
  );
  for (const [error, readStatus, writeStatus] of [
    [new Error("private path detail"), 503, 504],
    [hostile, 503, 504],
    [known, 409, 409],
    [{ status: 400, message: "private raw object" }, 503, 504],
    [proxy, 503, 504],
  ] as const) {
    const f = await fixture({
      storeFactory: () => ({
        read() {
          throw error;
        },
        original() {
          throw error;
        },
        async write() {
          throw error;
        },
      }),
    });
    for (const path of [f.base, `${f.base}/requests/${requestId}`]) {
      const answer = await f.send(path);
      expect(answer.status).toBe(readStatus);
      expect(JSON.stringify(answer)).not.toContain("private");
    }
    const answer = await f.send(f.base, f.request);
    expect(answer.status).toBe(writeStatus);
    expect(JSON.stringify(answer)).not.toContain("private");
  }
  expect(getters).toBe(0);
});

function rehash(record: UsageThresholdRecord): UsageThresholdRecord {
  record.receipt.originalHash = createHash("sha256")
    .update(usageThresholdJson(record.receipt.original))
    .digest("hex");
  return record;
}
test("a malformed or mismatched post-publication result remains unknown and exact recovery does not write", async () => {
  const changes: Array<(record: UsageThresholdRecord) => UsageThresholdRecord> =
    [
      (record) => ({
        ...record,
        receipt: { ...record.receipt, originalHash: "0".repeat(64) },
      }),
      (record) => ({
        ...record,
        document: { ...record.document, revision: 0 },
      }),
      (record) =>
        rehash({
          ...record,
          receipt: {
            ...record.receipt,
            original: { ...record.receipt.original, requestId: nextId(99) },
          },
        }),
      (record) =>
        rehash({
          ...record,
          document: { ...record.document, rules: [rule] },
          receipt: {
            ...record.receipt,
            original: { ...record.receipt.original, rules: [rule] },
          },
        }),
    ];
  for (const change of changes) {
    let writes = 0;
    const f = await fixture({
      storeFactory: (home, workspace) => {
        const actual = createUsageThresholdStore(home, workspace);
        return {
          ...actual,
          async write(id, request) {
            writes++;
            return change(structuredClone(await actual.write(id, request)));
          },
        };
      },
    });
    expect((await f.send(f.base, f.request)).status).toBe(504);
    const expected = f.store.original(f.projectId, requestId);
    const bytes = readFileSync(
      join(f.home, "usage-threshold-settings", "state.json"),
    );
    expect(await f.send(`${f.base}/requests/${requestId}`)).toEqual({
      status: 200,
      body: { ok: true, data: expected, error: null },
    });
    expect(
      readFileSync(join(f.home, "usage-threshold-settings", "state.json")),
    ).toEqual(bytes);
    expect(writes).toBe(1);
    expect(f.events).toHaveLength(1);
  }
});

test("private reads reject valid-shaped foreign scope and a false canonical original digest", async () => {
  const f = await fixture({
    storeFactory: (home, workspace) => {
      const actual = createUsageThresholdStore(home, workspace);
      return {
        ...actual,
        read(id) {
          return { ...actual.read(id), workspace: workspace + "/foreign" };
        },
        original(id, uuid) {
          const saved = actual.original(id, uuid);
          return {
            ...saved,
            receipt: { ...saved.receipt, originalHash: "0".repeat(64) },
          };
        },
      };
    },
  });
  await f.store.write(f.projectId, f.request);
  expect((await f.send(f.base)).status).toBe(503);
  expect((await f.send(`${f.base}/requests/${requestId}`)).status).toBe(503);
  expect(f.events).toEqual([]);
});

test("validated originals are captured before a later asynchronous admission can observe caller mutation", async () => {
  let entered!: () => void;
  let release!: () => void;
  const admission = new Promise<void>((done) => {
    entered = done;
  });
  const hold = new Promise<void>((done) => {
    release = done;
  });
  const f = await fixture({
    storeFactory: (home, workspace) =>
      createUsageThresholdStore(home, workspace, {
        async beforeAdmission() {
          entered();
          await hold;
        },
      }),
  });
  const raw = usageThresholdRequestSchema.parse({
    ...f.request,
    rules: [rule],
  });
  const action = f.routes.actions[0];
  const validated = action.validate({
    params: { id: f.projectId },
    headers: {},
    query: new URLSearchParams(),
    body: raw,
  });
  if (!validated.ok) throw Error("Invalid schema-valid original fixture");
  const pending = action.effect(validated.value);
  await admission;
  try {
    raw.workspace += "/foreign";
    raw.expectedRevision = 99;
    raw.rules[0]!.threshold = 1;
    expect(Object.isFrozen(validated.value.request.rules[0])).toBe(true);
  } finally {
    release();
  }
  const result = await pending;
  expect(result.status).toBe(200);
  expect(result).toMatchObject({
    data: {
      receipt: {
        original: {
          workspace: f.workspace,
          expectedRevision: 0,
          rules: [rule],
        },
      },
    },
  });
});

test("a known-status getter in a returned result cannot turn a published save into a conflict", async () => {
  let writes = 0;
  const f = await fixture({
    storeFactory: (home, workspace) => {
      const actual = createUsageThresholdStore(home, workspace);
      return {
        ...actual,
        async write(id, request) {
          writes++;
          const result = structuredClone(await actual.write(id, request));
          Object.defineProperty(result, "receipt", {
            get() {
              throw new UsageThresholdError(409, "private", "private");
            },
          });
          return result;
        },
      };
    },
  });
  expect((await f.send(f.base, f.request)).status).toBe(504);
  const saved = f.store.original(f.projectId, requestId);
  expect(saved.receipt.outcome).toBe("applied");
  expect(await f.send(`${f.base}/requests/${requestId}`)).toEqual({
    status: 200,
    body: { ok: true, data: saved, error: null },
  });
  expect(writes).toBe(1);
});

test("known-status getters in invalid read results always produce fixed unavailable responses", async () => {
  const f = await fixture({
    storeFactory: (home, workspace) => {
      const actual = createUsageThresholdStore(home, workspace);
      return {
        ...actual,
        read(id) {
          const result = structuredClone(actual.read(id));
          Object.defineProperty(result, "workspace", {
            get() {
              throw new UsageThresholdError(400, "private", "private");
            },
          });
          return result;
        },
        original(id, uuid) {
          const result = structuredClone(actual.original(id, uuid));
          Object.defineProperty(result, "receipt", {
            get() {
              throw new UsageThresholdError(409, "private", "private");
            },
          });
          return result;
        },
      };
    },
  });
  await f.store.write(f.projectId, f.request);
  for (const path of [f.base, `${f.base}/requests/${requestId}`])
    expect(await f.send(path)).toEqual({
      status: 503,
      body: {
        ok: false,
        data: null,
        error: "Private usage threshold settings are unavailable.",
      },
    });
  expect(f.events).toEqual([]);
});
