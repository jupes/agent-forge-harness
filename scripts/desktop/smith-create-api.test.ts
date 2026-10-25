import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createSmithCreateApi } from "../../apps/desktop/src/smith-create-api";
import { NotSent } from "../../docs/js/operator";
import type { SmithConfigCreateRequest } from "../../types/smith-config-create";

const request: SmithConfigCreateRequest = {
  requestId: "18da5c95-3218-439c-a33d-e5662465f505",
  target: "workspace",
  smith: {
    name: "smith-ui-test",
    provider: "codex",
    model: "gpt-example-exact",
    effort: "high",
    enabled: true,
    tags: ["reviewed"],
  },
  expectedRevision: {
    version: 1,
    user: "a".repeat(64),
    workspace: "b".repeat(64),
  },
};

test("Smith create uses the protected preview, create, and actual original receipt paths", async () => {
  const posts: { path: string; body: unknown }[] = [],
    reads: {
      path: string;
      method: string | undefined;
      limit: number | undefined;
    }[] = [];
  const api = createSmithCreateApi({
    post: async (path, body) => {
      posts.push({ path, body });
      return Response.json({ ok: true, data: { accepted: true }, error: null });
    },
    read: async (path, init, limits) => {
      reads.push({
        path,
        method: init?.method,
        limit: limits?.maxBodyBytes,
      });
      return Response.json(
        { ok: false, data: null, error: "not found" },
        { status: 404 },
      );
    },
  });

  await api.preview({ target: request.target, smith: request.smith });
  await api.create(request);
  await api.original(request.requestId);

  expect(posts).toEqual([
    {
      path: "/__agent-forge/config/smiths/preview",
      body: { target: "workspace", smith: request.smith },
    },
    { path: "/__agent-forge/config/smiths/creates", body: request },
  ]);
  expect(reads).toEqual([
    {
      path: `/__agent-forge/smiths/creates/${request.requestId}`,
      method: "GET",
      limit: 65_536,
    },
  ]);
});

test("only strict receipt envelopes from create result statuses are surfaced", async () => {
  let status = 503,
    payload: unknown = { ok: false, data: null, error: "unavailable" };
  const api = createSmithCreateApi({
    post: async () => Response.json(payload, { status }),
    read: async () =>
      Response.json({ ok: false, data: null, error: "missing" }),
  });

  expect(await api.create(request)).toMatchObject({ state: "unknown" });
  status = 200;
  payload = { ok: true, data: { requestId: request.requestId }, error: null };
  expect(await api.create(request)).toMatchObject({
    state: "sent",
    value: { ok: true, data: { requestId: request.requestId }, error: null },
  });
  status = 202;
  expect(await api.create(request)).toMatchObject({ state: "sent" });
  status = 409;
  expect(await api.create(request)).toMatchObject({ state: "sent" });
  status = 404;
  expect(await api.create(request)).toMatchObject({ state: "unknown" });
  status = 403;
  expect(await api.create(request)).toMatchObject({ state: "not-sent" });
  status = 200;
  payload = { ok: true, data: null, unexpected: true };
  expect(await api.create(request)).toMatchObject({ state: "unknown" });

  const tokenRefused = createSmithCreateApi({
    post: async () => {
      throw new NotSent("No operator token");
    },
    read: async () =>
      Response.json({ ok: false, data: null, error: "missing" }),
  });
  expect(await tokenRefused.create(request)).toMatchObject({
    state: "not-sent",
    message: "No operator token",
  });
});

test("the root-owned create client and review form keep a browser-only dependency graph", async () => {
  const result = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "../../apps/desktop/src/use-smith-create.ts"),
      resolve(import.meta.dir, "../../apps/desktop/src/SmithCreateForm.tsx"),
    ],
    target: "browser",
  });
  expect(result.success).toBe(true);
  const bundle = (
    await Promise.all(result.outputs.map((output) => output.text()))
  ).join("\n");
  expect(bundle).not.toMatch(/node:(?:crypto|fs|path|sqlite)/);
  expect(bundle).not.toContain("smith-create-journal");
});
