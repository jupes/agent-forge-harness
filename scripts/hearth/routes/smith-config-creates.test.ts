import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SmithConfigCreateRequest } from "../../../types/smith-config-create";
import { agentForgeHome } from "../../agent-forge-home";
import { SMITH_CREATE_JOURNAL_FILES } from "../../config/smith-create-journal-protocol";
import {
  smithConfigCreateReceiptSchema,
  smithConfigPreviewSchema,
} from "../../config/smith-create-protocol";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const hearth of opened.splice(0)) await hearth.close();
});

const smith = {
  name: "route-smith",
  provider: "custom",
  model: "reviewed-model",
  effort: "high",
  enabled: true,
  tags: ["reviewed"],
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

test("Smith create route inventory is fixed and unauthorized or malformed requests have no effects", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const smithRows = h.hearth.routes.filter(
    (route) =>
      route.path.startsWith("/config/smiths/") ||
      route.path.startsWith("/smiths/creates/"),
  );
  expect(
    smithRows.map(({ kind, method, path }) => ({ kind, method, path })),
  ).toEqual([
    { kind: "read", method: "GET", path: "/smiths/creates/:requestId" },
    { kind: "action", method: "POST", path: "/config/smiths/preview" },
    { kind: "action", method: "POST", path: "/config/smiths/creates" },
  ]);
  expect(
    smithRows.find((route) => route.path.startsWith("/smiths/creates/"))
      ?.operatorOnly,
  ).toBe(true);

  const preview = { target: "workspace", smith };
  const create = {
    requestId: randomUUID(),
    ...preview,
    expectedRevision: {
      version: 1,
      user: "a".repeat(64),
      workspace: "b".repeat(64),
    },
  };
  for (const path of ["/config/smiths/preview", "/config/smiths/creates"]) {
    expect(
      (
        await post(
          h,
          path,
          path.endsWith("preview") ? preview : create,
          h.headers(null),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post(
          h,
          `${path}?extra=1`,
          path.endsWith("preview") ? preview : create,
        )
      ).status,
    ).toBe(400);
  }
  const missing = await fetch(`${h.api}/smiths/creates/${randomUUID()}`, {
    headers: h.headers(null),
  });
  expect(missing.status).toBe(403);
  expect(h.events()).toEqual([]);
  expect(existsSync(join(h.home, "smith-create-journal"))).toBe(false);
  expect(existsSync(join(h.root, "agent-forge.toml"))).toBe(false);
});

test("a post-confirmation lost response, changed-body collision and exact retry preserve the original", async () => {
  let loseCreateReply = true;
  const h = await startTestHearth({
    api: {
      decorate: (routes) =>
        routes.map((route) =>
          route.kind !== "action" || route.path !== "/config/smiths/creates"
            ? route
            : {
                ...route,
                async effect(input, context) {
                  const reply = await route.effect(input, context);
                  if (!loseCreateReply) return reply;
                  loseCreateReply = false;
                  return {
                    status: 503,
                    error: "Simulated response loss after durable completion.",
                  };
                },
              },
        ),
    },
  });
  opened.push(h);
  const ambientJournal = join(agentForgeHome(), "smith-create-journal"),
    ambientJournalExisted = existsSync(ambientJournal);
  const previewResponse = await post(h, "/config/smiths/preview", {
    target: "workspace",
    smith,
  });
  expect(previewResponse.status).toBe(200);
  const previewEnvelope = await previewResponse.json();
  expect(previewEnvelope.ok).toBe(true);
  expect(smithConfigPreviewSchema.safeParse(previewEnvelope.data).success).toBe(
    true,
  );
  expect(existsSync(join(h.home, "smith-create-journal"))).toBe(false);
  expect(existsSync(join(h.root, "agent-forge.toml"))).toBe(false);

  const input: SmithConfigCreateRequest = {
    requestId: randomUUID(),
    target: "workspace",
    smith,
    expectedRevision: previewEnvelope.data.expectedRevision,
  };
  const firstResponse = await post(h, "/config/smiths/creates", input);
  expect(firstResponse.status).toBe(503);
  expect((await firstResponse.json()).error).toContain("response loss");
  expect(h.events(["operator.action"]).map((event) => event.payload)).toEqual([
    { action: "smith.config.preview", surface: "api", target: "workspace" },
    { action: "smith.config.create", surface: "api", target: "workspace" },
  ]);

  const originalResponse = await fetch(
    `${h.api}/smiths/creates/${input.requestId}`,
    { headers: h.headers(h.hearth.token) },
  );
  expect(originalResponse.status).toBe(200);
  const first = (await originalResponse.json()).data;
  expect(smithConfigCreateReceiptSchema.safeParse(first).success).toBe(true);
  expect(first.result.phase).toBe("confirmed");
  expect(first.original).toEqual(input);
  expect(JSON.stringify(h.events())).not.toContain(JSON.stringify(input));

  const configFile = join(h.root, "agent-forge.toml");
  const published = readFileSync(configFile, "utf8");
  const changedBody = await post(h, "/config/smiths/creates", {
    ...input,
    smith: { ...input.smith, model: "different-model" },
  });
  expect(changedBody.status).toBe(409);
  expect((await changedBody.json()).error).toBe(
    "The request ID belongs to a different saved Smith create.",
  );
  expect(readFileSync(configFile, "utf8")).toBe(published);

  const duplicateResponse = await post(h, "/config/smiths/creates", input);
  expect(duplicateResponse.status).toBe(200);
  expect((await duplicateResponse.json()).data).toEqual(first);
  expect(readFileSync(configFile, "utf8")).toBe(published);

  // The journal belongs to the explicitly captured Hearth profile, not an
  // ambient Agent Forge home. Records are immutable and bounded by the adapter.
  const operationDir = join(
    h.home,
    "smith-create-journal",
    "records",
    input.requestId,
  );
  expect(existsSync(operationDir)).toBe(true);
  expect(
    [...SMITH_CREATE_JOURNAL_FILES].some((name) =>
      existsSync(join(operationDir, name)),
    ),
  ).toBe(true);
  expect(existsSync(ambientJournal)).toBe(ambientJournalExisted);
});

test("original GET treats missing and corrupt records as inert held reads", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const absentId = randomUUID();
  const absent = await fetch(`${h.api}/smiths/creates/${absentId}`, {
    headers: h.headers(h.hearth.token),
  });
  expect(absent.status).toBe(404);
  expect(existsSync(join(h.home, "smith-create-journal"))).toBe(false);

  const corruptId = randomUUID();
  const corruptDir = join(h.home, "smith-create-journal", "records", corruptId);
  mkdirSync(corruptDir, { recursive: true });
  const corruptPath = join(corruptDir, "intent.json");
  writeOwnerOnly(corruptPath, "{corrupt-record");
  const before = readFileSync(corruptPath);
  const rejectedQuery = await fetch(
    `${h.api}/smiths/creates/${corruptId}?ignored=yes`,
    { headers: h.headers(h.hearth.token) },
  );
  expect(rejectedQuery.status).toBe(400);
  expect(readFileSync(corruptPath)).toEqual(before);

  const held = await fetch(`${h.api}/smiths/creates/${corruptId}`, {
    headers: h.headers(h.hearth.token),
  });
  expect(held.status).toBe(503);
  expect(readFileSync(corruptPath)).toEqual(before);
  expect(existsSync(join(h.home, "smith-create-journal", "locks"))).toBe(false);
});

test("audit refusal prevents preview and create service effects", async () => {
  const h = await startTestHearth({
    api: {
      appendEvent: () => ({ ok: false, error: "fixture audit unavailable" }),
    },
  });
  opened.push(h);
  const preview = await post(h, "/config/smiths/preview", {
    target: "workspace",
    smith,
  });
  expect(preview.status).toBe(503);
  const create = await post(h, "/config/smiths/creates", {
    requestId: randomUUID(),
    target: "workspace",
    smith,
    expectedRevision: {
      version: 1,
      user: "a".repeat(64),
      workspace: "b".repeat(64),
    },
  });
  expect(create.status).toBe(503);
  expect(existsSync(join(h.home, "smith-create-journal"))).toBe(false);
  expect(existsSync(join(h.root, "agent-forge.toml"))).toBe(false);
});

test("unusable captured selectors hold Smith routes without blocking Hearth startup", async () => {
  const h = await startTestHearth({
    api: { configHome: import.meta.path },
  });
  opened.push(h);
  const unrelated = await fetch(`${h.api}/projects`, {
    headers: h.headers(h.hearth.token),
  });
  expect(unrelated.status).toBe(200);
  const response = await fetch(`${h.api}/smiths/creates/${randomUUID()}`, {
    headers: h.headers(h.hearth.token),
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    ok: false,
    data: null,
    error: "The saved Smith create original is unavailable.",
  });
  expect(existsSync(join(h.home, "smith-create-journal"))).toBe(false);
});
