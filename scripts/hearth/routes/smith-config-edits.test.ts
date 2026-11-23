import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { SmithConfigEditRequest } from "../../../types/smith-config-edit";
import { machineConfigFile } from "../../config/load";
import {
  SMITH_EDIT_JOURNAL_FILES,
  smithEditInputHash,
} from "../../config/smith-edit-journal-protocol";
import {
  smithConfigEditPreviewSchema,
  smithConfigEditReceiptSchema,
} from "../../config/smith-edit-protocol";
import { startTestHearth, type TestHearth } from "../testing";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const hearth of opened.splice(0)) await hearth.close();
});

const smith = {
  name: "claude-master",
  provider: "claude",
  model: "reviewed-edit-model",
  effort: "high",
  enabled: false,
  tags: ["rank:master", "edited"],
};

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

const previewInput = { target: "workspace" as const, name: smith.name, smith };

test("edit routes are fixed, protected, and unknown original reads are inert", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const rows = h.hearth.routes.filter(
    (route) =>
      route.path.startsWith("/config/smiths/edits") ||
      route.path.startsWith("/smiths/edits/"),
  );
  expect(
    rows.map(({ kind, method, path }) => ({ kind, method, path })),
  ).toEqual([
    { kind: "read", method: "GET", path: "/smiths/edits/:requestId" },
    {
      kind: "action",
      method: "POST",
      path: "/config/smiths/edits/preview",
    },
    { kind: "action", method: "POST", path: "/config/smiths/edits" },
  ]);
  expect(rows[0]?.operatorOnly).toBe(true);

  const absentId = randomUUID().toLowerCase(),
    beforeEvents = h.events();
  expect(
    (
      await post(
        h,
        "/config/smiths/edits/preview",
        previewInput,
        h.headers(null),
      )
    ).status,
  ).toBe(403);
  const absent = await fetch(`${h.api}/smiths/edits/${absentId}`, {
    headers: h.headers(h.hearth.token),
  });
  expect(absent.status).toBe(404);
  expect(await absent.json()).toEqual({
    ok: false,
    data: null,
    error: "No saved Smith edit original exists.",
  });
  const unauthenticated = await fetch(`${h.api}/smiths/edits/${absentId}`, {
    headers: h.headers(null),
  });
  expect(unauthenticated.status).toBe(403);
  const query = await fetch(`${h.api}/smiths/edits/${absentId}?ignored=yes`, {
    headers: h.headers(h.hearth.token),
  });
  expect(query.status).toBe(400);
  expect(h.events()).toEqual(beforeEvents);
  expect(existsSync(join(h.home, "smith-edit-journal"))).toBe(false);
  expect(existsSync(join(h.home, "smith-edit-journal", "locks"))).toBe(false);
});

test("audit refusal prevents edit preview and write effects", async () => {
  const h = await startTestHearth({
    api: {
      appendEvent: () => ({ ok: false, error: "fixture audit unavailable" }),
    },
  });
  opened.push(h);
  const preview = await post(h, "/config/smiths/edits/preview", previewInput);
  expect(preview.status).toBe(503);
  const request: SmithConfigEditRequest = {
    requestId: randomUUID().toLowerCase(),
    ...previewInput,
    expectedRevision: {
      version: 1,
      user: "a".repeat(64),
      workspace: "b".repeat(64),
    },
  };
  const response = await post(h, "/config/smiths/edits", request);
  expect(response.status).toBe(503);
  expect(existsSync(join(h.home, "smith-edit-journal"))).toBe(false);
  expect(existsSync(join(h.root, "agent-forge.toml"))).toBe(false);
  expect(h.events(["operator.action"])).toEqual([]);
});

test("edit audit stores only family, target, UUID and input hash; original GET and exact duplicate are read-only", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const previewResponse = await post(
    h,
    "/config/smiths/edits/preview",
    previewInput,
  );
  expect(previewResponse.status).toBe(200);
  const previewEnvelope = await previewResponse.json();
  expect(previewEnvelope.ok).toBe(true);
  expect(
    smithConfigEditPreviewSchema.safeParse(previewEnvelope.data).success,
  ).toBe(true);
  expect(existsSync(join(h.home, "smith-edit-journal"))).toBe(false);

  const request: SmithConfigEditRequest = {
    requestId: randomUUID().toLowerCase(),
    ...previewInput,
    expectedRevision: previewEnvelope.data.expectedRevision,
  };
  const response = await post(h, "/config/smiths/edits", request);
  expect(response.status).toBe(200);
  const receipt = (await response.json()).data;
  expect(smithConfigEditReceiptSchema.safeParse(receipt).success).toBe(true);
  expect(receipt.result.phase).toBe("confirmed");
  expect(receipt.original).toEqual(request);

  const payloads = h.events(["operator.action"]).map((event) => event.payload);
  expect(payloads).toEqual([
    {
      action: "smith.config.edit.preview",
      surface: "api",
      family: "smith-config-edit",
      target: "workspace",
    },
    {
      action: "smith.config.edit",
      surface: "api",
      family: "smith-config-edit",
      target: "workspace",
      requestId: request.requestId,
      inputHash: smithEditInputHash(request),
    },
  ]);
  expect(JSON.stringify(payloads)).not.toContain(JSON.stringify(request));
  expect(JSON.stringify(payloads)).not.toContain("reviewed-edit-model");

  const operation = join(
      h.home,
      "smith-edit-journal",
      "records",
      request.requestId,
    ),
    evidenceNames = readdirSync(operation).sort(),
    evidenceBefore = evidenceNames.map((name) => [
      name,
      readFileSync(join(operation, name)),
    ]),
    configFile = join(h.root, "agent-forge.toml"),
    published = readFileSync(configFile),
    auditCount = h.events(["operator.action"]).length;
  const originalResponse = await fetch(
    `${h.api}/smiths/edits/${request.requestId}`,
    { headers: h.headers(h.hearth.token) },
  );
  expect(originalResponse.status).toBe(200);
  expect((await originalResponse.json()).data).toEqual(receipt);
  expect(readdirSync(operation).sort()).toEqual(evidenceNames);
  expect(
    evidenceNames.map((name) => [name, readFileSync(join(operation, name))]),
  ).toEqual(evidenceBefore);
  expect(readFileSync(configFile)).toEqual(published);
  expect(h.events(["operator.action"])).toHaveLength(auditCount);

  const changed = await post(h, "/config/smiths/edits", {
    ...request,
    smith: { ...request.smith, model: "different-model" },
  });
  expect(changed.status).toBe(409);
  expect((await changed.json()).error).toBe(
    "The request ID belongs to a different saved Smith edit.",
  );
  expect(readFileSync(configFile)).toEqual(published);

  const duplicate = await post(h, "/config/smiths/edits", request);
  expect(duplicate.status).toBe(200);
  expect((await duplicate.json()).data).toEqual(receipt);
  expect(readFileSync(configFile)).toEqual(published);
  expect(
    [...SMITH_EDIT_JOURNAL_FILES].filter((name) =>
      existsSync(join(operation, name)),
    ).length,
  ).toBeGreaterThan(0);
});

test("a change in the unselected paired layer is refused before workspace publication", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const userFile = machineConfigFile({ home: h.configHome });
  mkdirSync(dirname(userFile), { recursive: true });
  const userText = '[smiths.claude-master]\nmodel = "unselected-model"\n';
  writeFileSync(userFile, userText);

  const previewResponse = await post(
    h,
    "/config/smiths/edits/preview",
    previewInput,
  );
  expect(previewResponse.status).toBe(200);
  const previewEnvelope = await previewResponse.json(),
    request: SmithConfigEditRequest = {
      requestId: randomUUID().toLowerCase(),
      ...previewInput,
      expectedRevision: previewEnvelope.data.expectedRevision,
    },
    targetFile = join(h.root, "agent-forge.toml");
  expect(existsSync(targetFile)).toBe(false);
  writeFileSync(userFile, `${userText}# changed after review\n`);

  const response = await post(h, "/config/smiths/edits", request);
  expect(response.status).toBe(409);
  const receipt = (await response.json()).data;
  expect(receipt.result).toMatchObject({
    phase: "refused",
    reason: "stale-revision",
    preview: null,
  });
  expect(existsSync(targetFile)).toBe(false);
});
