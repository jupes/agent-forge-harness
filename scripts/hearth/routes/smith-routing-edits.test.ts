import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SmithRoutingEditRequest } from "../../../types/smith-routing-edit";
import { machineConfigFile } from "../../config/load";
import {
  smithRoutingEditInputHash,
  smithRoutingEditReceiptSchema,
} from "../../config/smith-routing-edit-journal-protocol";
import {
  SMITH_ROUTING_EDIT_LIMITS,
  smithRoutingEditPreviewSchema,
} from "../../config/smith-routing-edit-protocol";
import { startTestHearth, type TestHearth } from "../testing";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const hearth of opened.splice(0)) await hearth.close();
});

const change = { kind: "default", smith: "claude-apprentice" } as const;
const originalWorkspace =
  '# retained comment\n[workflow]\ndefault_crew = "claude-master" # keep\n[benches]\nlow = ["claude-master:1"]\nmedium = ["claude-apprentice:1"]\n';

function seedWorkspace(h: TestHearth): string {
  const path = join(h.root, "agent-forge.toml");
  writeFileSync(path, originalWorkspace);
  return path;
}

const post = (
  h: TestHearth,
  path: string,
  body: unknown,
  headers = h.headers(h.hearth.token),
) =>
  fetch(`${h.api}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

const previewRequest = { target: "workspace" as const, change };

test("routing edit rows are fixed, protected and missing original reads are inert", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const rows = h.hearth.routes.filter(
    (route) =>
      route.path.startsWith("/config/smiths/routing-edits") ||
      route.path.startsWith("/smiths/routing-edits/"),
  );
  expect(
    rows.map(({ kind, method, path }) => ({ kind, method, path })),
  ).toEqual([
    {
      kind: "read",
      method: "GET",
      path: "/smiths/routing-edits/:requestId",
    },
    {
      kind: "action",
      method: "POST",
      path: "/config/smiths/routing-edits/preview",
    },
    {
      kind: "action",
      method: "POST",
      path: "/config/smiths/routing-edits",
    },
  ]);
  expect(rows[0]?.operatorOnly).toBe(true);

  const absentId = randomUUID().toLowerCase(),
    beforeEvents = h.events();
  expect(
    (
      await post(
        h,
        "/config/smiths/routing-edits/preview",
        previewRequest,
        h.headers(null),
      )
    ).status,
  ).toBe(403);
  const absent = await fetch(`${h.api}/smiths/routing-edits/${absentId}`, {
    headers: h.headers(h.hearth.token),
  });
  expect(absent.status).toBe(404);
  expect(await absent.json()).toEqual({
    ok: false,
    data: null,
    error: "No saved routing edit original exists.",
  });
  const unauthenticated = await fetch(
    `${h.api}/smiths/routing-edits/${absentId}`,
    { headers: h.headers(null) },
  );
  expect(unauthenticated.status).toBe(403);
  const query = await fetch(
    `${h.api}/smiths/routing-edits/${absentId}?ignored=yes`,
    { headers: h.headers(h.hearth.token) },
  );
  expect(query.status).toBe(400);
  expect(h.events()).toEqual(beforeEvents);
  expect(existsSync(join(h.home, "smith-routing-edit-journal"))).toBe(false);
});

test("preview and edit audit only bounded selector metadata; exact duplicate and GET preserve original", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const configFile = seedWorkspace(h),
    before = readFileSync(configFile),
    previewResponse = await post(
      h,
      "/config/smiths/routing-edits/preview",
      previewRequest,
    );
  expect(previewResponse.status).toBe(200);
  const previewEnvelope = await previewResponse.json(),
    preview = smithRoutingEditPreviewSchema.parse(previewEnvelope.data);
  expect(
    Buffer.byteLength(JSON.stringify(previewEnvelope), "utf8"),
  ).toBeLessThanOrEqual(SMITH_ROUTING_EDIT_LIMITS.responseBytes);
  expect(readFileSync(configFile)).toEqual(before);
  expect(existsSync(join(h.home, "smith-routing-edit-journal"))).toBe(false);
  const userFile = machineConfigFile({ home: h.configHome });
  expect(existsSync(userFile)).toBe(false);
  expect(existsSync(join(h.configHome, ".agent-forge"))).toBe(false);

  const request: SmithRoutingEditRequest = {
      requestId: randomUUID().toLowerCase(),
      ...previewRequest,
      expectedRevision: preview.expectedRevision,
    },
    response = await post(h, "/config/smiths/routing-edits", request);
  expect(response.status).toBe(200);
  const responseEnvelope = await response.json(),
    receipt = smithRoutingEditReceiptSchema.parse(responseEnvelope.data);
  expect(
    Buffer.byteLength(JSON.stringify(responseEnvelope), "utf8"),
  ).toBeLessThanOrEqual(SMITH_ROUTING_EDIT_LIMITS.responseBytes);
  expect(receipt.result.phase).toBe("confirmed");
  expect(receipt.original).toEqual(request);

  const payloads = h.events(["operator.action"]).map((event) => event.payload);
  expect(payloads).toEqual([
    {
      action: "smith.config.routing-edit.preview",
      surface: "api",
      family: "smith-routing-edit",
      target: "workspace",
      changeKind: "default",
      selector: "workflow.default_crew",
    },
    {
      action: "smith.config.routing-edit",
      surface: "api",
      family: "smith-routing-edit",
      target: "workspace",
      requestId: request.requestId,
      inputHash: smithRoutingEditInputHash(request),
      changeKind: "default",
      selector: "workflow.default_crew",
    },
  ]);
  expect(JSON.stringify(payloads)).not.toContain("claude-apprentice");
  expect(JSON.stringify(payloads)).not.toContain("claude-master");

  const operation = join(
      h.home,
      "smith-routing-edit-journal",
      "records",
      request.requestId,
    ),
    beforeRecords = readdirSync(operation).sort(),
    published = readFileSync(configFile),
    auditCount = h.events(["operator.action"]).length;
  const originalResponse = await fetch(
    `${h.api}/smiths/routing-edits/${request.requestId}`,
    { headers: h.headers(h.hearth.token) },
  );
  expect(originalResponse.status).toBe(200);
  const originalEnvelope = await originalResponse.json();
  expect(smithRoutingEditReceiptSchema.parse(originalEnvelope.data)).toEqual(
    receipt,
  );
  expect(readFileSync(configFile)).toEqual(published);
  expect(readdirSync(operation).sort()).toEqual(beforeRecords);
  expect(h.events(["operator.action"])).toHaveLength(auditCount);

  writeFileSync(
    configFile,
    '[workflow]\ndefault_crew = "claude-master"\n[benches]\nlow = ["claude-apprentice:1"]\n',
  );
  const externallyChanged = readFileSync(configFile),
    duplicate = await post(h, "/config/smiths/routing-edits", request);
  expect(duplicate.status).toBe(200);
  expect(
    smithRoutingEditReceiptSchema.parse((await duplicate.json()).data),
  ).toEqual(receipt);
  expect(readFileSync(configFile)).toEqual(externallyChanged);
  expect(h.events(["operator.action"])).toHaveLength(auditCount + 1);
});

test("failed audit has no routing journal or config effect", async () => {
  const h = await startTestHearth({
    api: {
      appendEvent: () => ({ ok: false, error: "fixture audit unavailable" }),
    },
  });
  opened.push(h);
  const configFile = seedWorkspace(h),
    before = readFileSync(configFile),
    preview = await post(
      h,
      "/config/smiths/routing-edits/preview",
      previewRequest,
    );
  expect(preview.status).toBe(503);
  const request: SmithRoutingEditRequest = {
    requestId: randomUUID().toLowerCase(),
    ...previewRequest,
    expectedRevision: {
      version: 1,
      user: "a".repeat(64),
      workspace: "b".repeat(64),
    },
  };
  const response = await post(h, "/config/smiths/routing-edits", request);
  expect(response.status).toBe(503);
  expect(existsSync(join(h.home, "smith-routing-edit-journal"))).toBe(false);
  expect(readFileSync(configFile)).toEqual(before);
  expect(h.events(["operator.action"])).toEqual([]);
});

test("a stale paired revision is durably refused and a new reviewed UUID can edit", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const configFile = seedWorkspace(h),
    previewResponse = await post(
      h,
      "/config/smiths/routing-edits/preview",
      previewRequest,
    ),
    preview = smithRoutingEditPreviewSchema.parse(
      (await previewResponse.json()).data,
    ),
    request: SmithRoutingEditRequest = {
      requestId: randomUUID().toLowerCase(),
      ...previewRequest,
      expectedRevision: preview.expectedRevision,
    };
  const userFile = machineConfigFile({ home: h.configHome });
  mkdirSync(join(h.configHome, ".agent-forge"), { recursive: true });
  writeFileSync(userFile, "# unselected paired layer changed\n");
  const beforeTarget = readFileSync(configFile),
    refusedResponse = await post(h, "/config/smiths/routing-edits", request);
  expect(refusedResponse.status).toBe(409);
  const refused = smithRoutingEditReceiptSchema.parse(
    (await refusedResponse.json()).data,
  );
  expect(refused.result).toMatchObject({
    phase: "refused",
    reason: "stale-revision",
  });
  expect(readFileSync(configFile)).toEqual(beforeTarget);
  const saved = await fetch(
    `${h.api}/smiths/routing-edits/${request.requestId}`,
    { headers: h.headers(h.hearth.token) },
  );
  expect(
    smithRoutingEditReceiptSchema.parse((await saved.json()).data),
  ).toEqual(refused);

  const freshResponse = await post(
      h,
      "/config/smiths/routing-edits/preview",
      previewRequest,
    ),
    freshPreview = smithRoutingEditPreviewSchema.parse(
      (await freshResponse.json()).data,
    ),
    freshRequest: SmithRoutingEditRequest = {
      requestId: randomUUID().toLowerCase(),
      ...previewRequest,
      expectedRevision: freshPreview.expectedRevision,
    },
    fresh = await post(h, "/config/smiths/routing-edits", freshRequest);
  expect(fresh.status).toBe(200);
  expect(
    smithRoutingEditReceiptSchema.parse((await fresh.json()).data).result.phase,
  ).toBe("confirmed");
  expect(freshRequest.requestId).not.toBe(request.requestId);
});
