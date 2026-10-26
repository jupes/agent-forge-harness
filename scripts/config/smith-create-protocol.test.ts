import { expect, test } from "bun:test";
import { join } from "node:path";
import type {
  SmithConfigCreateReceipt,
  SmithConfigCreateResult,
  SmithConfigPreview,
} from "../../types/smith-config-create";
import {
  canonicalSmithConfigCreateRequest,
  SMITH_CONFIG_CREATE_LIMITS,
  smithConfigCreateReceiptSchema,
  smithConfigCreateRequestSchema,
  smithConfigPreviewRequestSchema,
  smithConfigPreviewSchema,
} from "./smith-create-protocol";

const smith = {
  name: "complete.coding 🌱",
  provider: "future-provider",
  model: "exact configured model",
  effort: "custom effort",
  enabled: false,
  tags: ["", "  exact tag  "],
};
const request = {
  requestId: "e630e793-e617-4c93-bdaf-b1e30ba706e5",
  target: "workspace" as const,
  smith,
  expectedRevision: {
    version: 1 as const,
    user: "a".repeat(64),
    workspace: "b".repeat(64),
  },
};

test("complete domain requests preserve configured values without inferring provider support", () => {
  expect(
    smithConfigPreviewRequestSchema.parse({ target: "user", smith }),
  ).toEqual({ target: "user", smith });
  expect(smithConfigCreateRequestSchema.parse(request)).toEqual(request);
});

test("own names, complete fields and paired revision identities are required", () => {
  for (const name of [
    "constructor",
    "__proto__",
    "toString",
    "",
    "n".repeat(129),
  ])
    expect(
      smithConfigCreateRequestSchema.safeParse({
        ...request,
        smith: { ...smith, name },
      }).success,
    ).toBe(false);
  for (const replacement of [
    { model: "" },
    { effort: "e".repeat(129) },
    { provider: "p".repeat(129) },
    { tags: Array.from({ length: 65 }, () => "tag") },
    { tags: ["t".repeat(257)] },
    { enabled: "false" },
  ])
    expect(
      smithConfigCreateRequestSchema.safeParse({
        ...request,
        smith: { ...smith, ...replacement },
      }).success,
    ).toBe(false);
  for (const expectedRevision of [
    { ...request.expectedRevision, version: 2 },
    { ...request.expectedRevision, user: "A".repeat(64) },
    { ...request.expectedRevision, workspace: "not-a-revision" },
    { ...request.expectedRevision, file: "/DO_NOT_WRITE" },
  ])
    expect(
      smithConfigCreateRequestSchema.safeParse({ ...request, expectedRevision })
        .success,
    ).toBe(false);
  expect(
    smithConfigCreateRequestSchema.safeParse({
      ...request,
      requestId: request.requestId.toUpperCase(),
    }).success,
  ).toBe(false);
});

test("encoded request bounds cover UTF-8 and JSON escaping expansion", () => {
  for (const tags of [
    Array.from({ length: 40 }, () => "🌱".repeat(100)),
    Array.from({ length: 64 }, () => "\t".repeat(128)),
  ]) {
    const oversized = { ...request, smith: { ...smith, tags } };
    expect(tags.reduce((length, tag) => length + tag.length, 0)).toBeLessThan(
      SMITH_CONFIG_CREATE_LIMITS.requestBytes,
    );
    expect(tags.every((tag) => tag.length <= 256)).toBe(true);
    expect(
      new TextEncoder().encode(JSON.stringify(oversized)).byteLength,
    ).toBeGreaterThan(SMITH_CONFIG_CREATE_LIMITS.requestBytes);
    expect(smithConfigCreateRequestSchema.safeParse(oversized).success).toBe(
      false,
    );
  }
});

test("canonical domain input is order-independent while retaining exact field and tag values", () => {
  const reordered = {
    expectedRevision: {
      workspace: request.expectedRevision.workspace,
      user: request.expectedRevision.user,
      version: 1,
    },
    smith: {
      tags: smith.tags,
      enabled: smith.enabled,
      effort: smith.effort,
      model: smith.model,
      provider: smith.provider,
      name: smith.name,
    },
    target: request.target,
    requestId: request.requestId,
  };
  const golden =
    '{"version":1,"requestId":"e630e793-e617-4c93-bdaf-b1e30ba706e5","target":"workspace","smith":{"name":"complete.coding 🌱","provider":"future-provider","model":"exact configured model","effort":"custom effort","enabled":false,"tags":["","  exact tag  "]},"expectedRevision":{"version":1,"user":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","workspace":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}';
  expect(canonicalSmithConfigCreateRequest(request)).toBe(golden);
  expect(canonicalSmithConfigCreateRequest(reordered)).toBe(golden);
  expect(
    canonicalSmithConfigCreateRequest({
      ...request,
      smith: { ...smith, tags: [...smith.tags].reverse() },
    }),
  ).not.toBe(golden);
});

const file = "/owned/workspace/agent-forge.toml";
const preview = {
  version: 1,
  target: "workspace",
  file,
  expectedRevision: request.expectedRevision,
  candidate: { sha256: "c".repeat(64), byteLength: 123, created: true },
  review: {
    before: null,
    after: smith,
    provenance: {
      provider: file,
      model: file,
      effort: file,
      enabled: file,
      tags: file,
    },
  },
} satisfies SmithConfigPreview;
const confirmed = {
  version: 1,
  requestId: request.requestId,
  ownerScopeHash: "d".repeat(64),
  inputHash: "e".repeat(64),
  createdAt: "2026-10-24T00:00:00.000Z",
  original: request,
  result: {
    phase: "confirmed",
    completedAt: "2026-10-24T00:00:01.000Z",
    preview,
    publication: { file, sha256: preview.candidate.sha256, created: true },
  },
} satisfies SmithConfigCreateReceipt;

test("a confirmed historical receipt is bound to its original UUID and reviewed publication", () => {
  expect(smithConfigCreateReceiptSchema.parse(confirmed)).toEqual(confirmed);
  expect(
    smithConfigCreateReceiptSchema.safeParse({
      ...confirmed,
      requestId: "ed30500a-612b-4865-895f-2649be79454c",
    }).success,
  ).toBe(false);
  expect(
    smithConfigCreateReceiptSchema.safeParse({
      ...confirmed,
      result: {
        ...confirmed.result,
        publication: {
          ...confirmed.result.publication,
          sha256: "f".repeat(64),
        },
      },
    }).success,
  ).toBe(false);
});

test("preview and historical receipts expose only their correlated selected Smith", () => {
  expect(smithConfigPreviewSchema.parse(preview)).toEqual(preview);
  for (const change of [
    { rawToml: "DO_NOT_EXPOSE" },
    { file: "relative.toml" },
    {
      candidate: {
        ...preview.candidate,
        byteLength: SMITH_CONFIG_CREATE_LIMITS.sourceBytes + 1,
      },
    },
    { review: { ...preview.review, before: smith } },
    {
      review: {
        ...preview.review,
        provenance: {
          ...preview.review.provenance,
          model: "/foreign/config.toml",
        },
      },
    },
  ])
    expect(
      smithConfigPreviewSchema.safeParse({ ...preview, ...change }).success,
    ).toBe(false);
  for (const changedPreview of [
    { ...preview, target: "user" },
    {
      ...preview,
      expectedRevision: { ...preview.expectedRevision, user: "f".repeat(64) },
    },
    {
      ...preview,
      review: {
        ...preview.review,
        after: { ...smith, model: "another model" },
      },
    },
  ])
    expect(
      smithConfigCreateReceiptSchema.safeParse({
        ...confirmed,
        result: { ...confirmed.result, preview: changedPreview },
      }).success,
    ).toBe(false);
  for (const publication of [
    { ...confirmed.result.publication, file: "/foreign/config.toml" },
    { ...confirmed.result.publication, created: false },
  ])
    expect(
      smithConfigCreateReceiptSchema.safeParse({
        ...confirmed,
        result: { ...confirmed.result, publication },
      }).success,
    ).toBe(false);
});

test("saved nonterminal stages remain held and cannot masquerade as completed or no-effect receipts", () => {
  const held: Extract<SmithConfigCreateResult, { phase: "held" }>[] = [
    { phase: "held", stage: "intent", preview: null },
    { phase: "held", stage: "prepared", preview },
    { phase: "held", stage: "attempted", preview },
    { phase: "held", stage: "unconfirmed", preview: null },
    { phase: "held", stage: "unconfirmed", preview },
  ];
  for (const result of held) {
    const value = { ...confirmed, result };
    expect(smithConfigCreateReceiptSchema.parse(value)).toEqual(value);
  }
  for (const result of [
    { phase: "held", stage: "intent", preview },
    { phase: "held", stage: "prepared", preview: null },
    { phase: "held", stage: "attempted", preview: null },
    { phase: "held", stage: "attempted", preview, replayAllowed: true },
    { phase: "confirmed", preview },
    {
      phase: "refused",
      refusedAt: confirmed.createdAt,
      reason: "stale-revision",
      preview: null,
      stage: "attempted",
    },
  ])
    expect(
      smithConfigCreateReceiptSchema.safeParse({ ...confirmed, result })
        .success,
    ).toBe(false);
  expect(
    smithConfigCreateReceiptSchema.parse({
      ...confirmed,
      result: {
        phase: "refused",
        refusedAt: confirmed.createdAt,
        reason: "stale-revision",
        preview: null,
      },
    }).result.phase,
  ).toBe("refused");
});

test("the protocol bundles for a browser without filesystem, CLI or Bun runtime imports", async () => {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "smith-create-protocol.ts")],
    target: "browser",
  });
  expect(built.success).toBe(true);
  expect(built.logs).toEqual([]);
  expect(built.outputs).toHaveLength(1);
  const text = await built.outputs[0]?.text();
  expect(text).not.toContain('from "node:');
  expect(text).not.toContain("Bun.");
  expect(text).not.toContain("prepareConfigTransaction");
  expect(text).not.toContain("runConfigCli");
});

test("browser-shaped request and receipt parsing needs no Node Buffer global", () => {
  const buffer = globalThis.Buffer;
  let requestValid = false,
    receiptValid = false;
  try {
    Reflect.set(globalThis, "Buffer", undefined);
    requestValid = smithConfigCreateRequestSchema.safeParse(request).success;
    receiptValid = smithConfigCreateReceiptSchema.safeParse(confirmed).success;
  } finally {
    Reflect.set(globalThis, "Buffer", buffer);
  }
  expect(requestValid).toBe(true);
  expect(receiptValid).toBe(true);
});

test("complete create refuses caller paths, arbitrary patches and omitted or extra Smith fields", () => {
  expect(
    smithConfigCreateRequestSchema.safeParse({
      ...request,
      file: "/DO_NOT_WRITE/config.toml",
    }).success,
  ).toBe(false);
  expect(
    smithConfigPreviewRequestSchema.safeParse({
      target: "user",
      smith,
      patch: "[smiths]",
    }).success,
  ).toBe(false);
  expect(
    smithConfigCreateRequestSchema.safeParse({
      ...request,
      smith: { ...smith, command: ["DO_NOT_RUN"] },
    }).success,
  ).toBe(false);
  const { tags: _tags, ...incomplete } = smith;
  expect(
    smithConfigCreateRequestSchema.safeParse({ ...request, smith: incomplete })
      .success,
  ).toBe(false);
});
