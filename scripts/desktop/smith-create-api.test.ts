import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createSmithCreateApi } from "../../apps/desktop/src/smith-create-api";
import { smithConfigCreateInputHash } from "../../apps/desktop/src/smith-create-identities";
import {
  smithCreateMetadataScope,
  smithCreateScopeAllowsWrite,
} from "../../apps/desktop/src/smith-create-scope";
import { NotSent } from "../../docs/js/operator";
import type {
  SmithConfigCreateReceipt,
  SmithConfigCreateRequest,
} from "../../types/smith-config-create";

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

const file = "C:\\fixture\\agent-forge.toml";
const preview = {
  version: 1 as const,
  target: request.target,
  file,
  expectedRevision: request.expectedRevision,
  candidate: { sha256: "c".repeat(64), byteLength: 100, created: false },
  review: {
    before: null,
    after: request.smith,
    provenance: {
      provider: file,
      model: file,
      effort: file,
      enabled: file,
      tags: file,
    },
  },
};
async function receipt(
  phase: SmithConfigCreateReceipt["result"]["phase"],
): Promise<SmithConfigCreateReceipt> {
  const result: SmithConfigCreateReceipt["result"] =
    phase === "confirmed"
      ? {
          phase,
          completedAt: "2026-10-25T20:00:00.000Z",
          preview,
          publication: { file, created: false, sha256: "c".repeat(64) },
        }
      : phase === "held"
        ? { phase, stage: "attempted", preview }
        : {
            phase,
            refusedAt: "2026-10-25T20:00:00.000Z",
            reason: "stale-revision",
            preview,
          };
  return {
    version: 1,
    requestId: request.requestId,
    ownerScopeHash: "d".repeat(64),
    inputHash: await smithConfigCreateInputHash(request),
    createdAt: "2026-10-25T19:59:00.000Z",
    original: request,
    result,
  };
}

test("Smith create uses the protected preview, create, and actual original receipt paths", async () => {
  const posts: {
      path: string;
      body: unknown;
      maxBodyBytes: number | undefined;
    }[] = [],
    reads: {
      path: string;
      method: string | undefined;
      limit: number | undefined;
    }[] = [];
  const api = createSmithCreateApi({
    post: async (path, body, limits) => {
      posts.push({ path, body, maxBodyBytes: limits?.maxBodyBytes });
      return Response.json({ ok: true, data: { accepted: true }, error: null });
    },
    read: async (path, init, limits) => {
      reads.push({
        path,
        method: init?.method,
        limit: limits?.maxBodyBytes,
      });
      return Response.json({
        ok: true,
        data: await receipt("confirmed"),
        error: null,
      });
    },
  });

  await api.preview({ target: request.target, smith: request.smith });
  await api.create(request);
  await api.original(request.requestId);

  expect(posts).toEqual([
    {
      path: "/__agent-forge/config/smiths/preview",
      body: { target: "workspace", smith: request.smith },
      maxBodyBytes: 65_536,
    },
    {
      path: "/__agent-forge/config/smiths/creates",
      body: request,
      maxBodyBytes: 65_536,
    },
  ]);
  expect(reads).toEqual([
    {
      path: `/__agent-forge/smiths/creates/${request.requestId}`,
      method: "GET",
      limit: 65_536,
    },
  ]);
});

test("create statuses must match a strict receipt correlated to this exact request", async () => {
  let status = 503,
    payload: unknown = { ok: false, data: null, error: "unavailable" };
  const api = createSmithCreateApi({
    post: async () => Response.json(payload, { status }),
    read: async () =>
      Response.json({ ok: false, data: null, error: "missing" }),
  });

  expect(await api.create(request)).toMatchObject({ state: "unknown" });
  status = 200;
  payload = { ok: true, data: await receipt("confirmed"), error: null };
  expect(await api.create(request)).toMatchObject({
    state: "sent",
    value: { ok: true, data: { requestId: request.requestId }, error: null },
  });
  status = 202;
  payload = { ok: true, data: await receipt("held"), error: null };
  expect(await api.create(request)).toMatchObject({ state: "sent" });
  status = 409;
  payload = { ok: true, data: await receipt("refused"), error: null };
  expect(await api.create(request)).toMatchObject({ state: "sent" });
  status = 202;
  payload = { ok: true, data: await receipt("confirmed"), error: null };
  expect(await api.create(request)).toMatchObject({ state: "unknown" });
  status = 200;
  payload = { ok: true, data: await receipt("refused"), error: null };
  expect(await api.create(request)).toMatchObject({ state: "unknown" });
  status = 200;
  payload = {
    ok: true,
    data: {
      ...(await receipt("confirmed")),
      requestId: "28da5c95-3218-439c-a33d-e5662465f506",
    },
    error: null,
  };
  expect(await api.create(request)).toMatchObject({ state: "unknown" });
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

test("preview and original require HTTP 200 even when an error carries a valid body", async () => {
  const valid = await receipt("confirmed");
  const api = createSmithCreateApi({
    post: async () =>
      Response.json(
        { ok: true, data: { accepted: true }, error: null },
        { status: 503 },
      ),
    read: async () =>
      Response.json({ ok: true, data: valid, error: null }, { status: 404 }),
  });
  await expect(
    api.preview({ target: request.target, smith: request.smith }),
  ).rejects.toThrow();
  await expect(api.original(request.requestId)).rejects.toThrow();
});

test("saved create metadata is scoped to the trusted workspace, not the page URL", () => {
  const first = "C:\\repos\\first-workspace";
  const second = "C:\\repos\\second-workspace";
  expect(smithCreateMetadataScope(first)).toBe(first);
  expect(smithCreateMetadataScope(second)).toBe(second);
  expect(smithCreateMetadataScope(first)).not.toBe(
    smithCreateMetadataScope(second),
  );
  expect(smithCreateMetadataScope(null)).toBeNull();
  expect(smithCreateMetadataScope("x".repeat(513))).toBeNull();
  expect(smithCreateScopeAllowsWrite(true, first, first)).toBe(true);
  expect(smithCreateScopeAllowsWrite(true, second, first)).toBe(false);
  expect(smithCreateScopeAllowsWrite(false, first, first)).toBe(false);
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
