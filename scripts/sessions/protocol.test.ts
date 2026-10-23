import { expect, test } from "bun:test";
import { join } from "node:path";
import type {
  SessionPreviewReceipt,
  SessionStartReceipt,
} from "../../types/session-requests";
import { serializeClaudeLaunch } from "./claude-launch";
import {
  ownedSessionSchema,
  sessionPreviewReceiptSchema,
  sessionStartReceiptSchema,
} from "./protocol";

function fixture() {
  const projectId = "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
    requestId = "0c296333-b021-4249-8c56-a397a09f3fd7",
    id = "session-33005ac7-b603-4b44-aebf-786615784db1",
    at = "2026-10-23T03:00:00.000Z";
  const start: SessionStartReceipt = {
    session: {
      projectId,
      id,
      requestId,
      requestHash: "a".repeat(64),
      createdAt: at,
      mode: "chat",
      provider: "claude",
      workspace: "/fixture/repo",
      repository: "/fixture/repo",
      worktree: "/fixture/repo",
      smith: "coding",
      requestedModel: "sonnet",
      requestedEffort: null,
    },
    receipt: {
      conversationId: id,
      revision: 1,
      turn: {
        requestId,
        hash: "b".repeat(64),
        phase: "accepted",
        createdAt: at,
        updatedAt: at,
        reason: null,
        owner: null,
      },
    },
  };
  const snapshot: SessionPreviewReceipt["snapshot"] = {
    version: 1,
    provider: "claude",
    smith: "coding",
    cwd: "/fixture/repo",
    launch: {
      mode: "chat",
      model: "sonnet",
      prompt: "  Exact private 🌱\n",
      attachments: [
        {
          kind: "image",
          name: "fixture.png",
          mediaType: "image/png",
          data: "iVBORw0KGgo=",
        },
      ],
      context: {
        projectId,
        repository: "/fixture/repo",
        worktree: "/fixture/repo",
        about: [],
      },
    },
    capabilities: {
      version: "2.1.296",
      flags: [
        "--print",
        "--input-format",
        "--output-format",
        "--verbose",
        "--include-partial-messages",
        "--model",
        "--permission-mode",
        "--permission-prompts",
        "--allowedTools",
        "--resume",
      ],
    },
  };
  const preview: SessionPreviewReceipt = {
    projectId,
    requestId,
    snapshot,
    serialized: serializeClaudeLaunch(snapshot.launch, snapshot.capabilities),
  };
  return { start, preview };
}

test("shared browser receipts preserve exact private input without Node or Bun globals", () => {
  const { start, preview } = fixture(),
    buffer = globalThis.Buffer,
    bun = globalThis.Bun;
  let parsed: SessionPreviewReceipt | undefined;
  try {
    Reflect.set(globalThis, "Buffer", undefined);
    Reflect.set(globalThis, "Bun", undefined);
    expect(ownedSessionSchema.safeParse(start.session).success).toBe(true);
    expect(sessionStartReceiptSchema.safeParse(start).success).toBe(true);
    parsed = sessionPreviewReceiptSchema.parse(preview);
  } finally {
    Reflect.set(globalThis, "Buffer", buffer);
    Reflect.set(globalThis, "Bun", bun);
  }
  expect(parsed).toEqual(preview);
});

test("Start metadata and receipts reject unknown fields, invalid identity and cross-session correlation", () => {
  const { start } = fixture();
  for (const invalid of [
    { ...start, privatePrompt: "forged" },
    { ...start, session: { ...start.session, body: "forged" } },
    { ...start, session: { ...start.session, worktree: "relative" } },
    { ...start, session: { ...start.session, requestHash: "invalid" } },
    {
      ...start,
      receipt: {
        ...start.receipt,
        conversationId: `session-${start.session.requestId}`,
      },
    },
    {
      ...start,
      receipt: {
        ...start.receipt,
        turn: {
          ...start.receipt.turn,
          requestId: "13c0317d-c70d-44aa-ad0a-9630c89d9c4d",
        },
      },
    },
  ])
    expect(sessionStartReceiptSchema.safeParse(invalid).success).toBe(false);
});

test("preview receipts refuse altered commands, foreign context, resume and unknown private fields", () => {
  const { preview } = fixture();
  for (const invalid of [
    { ...preview, extra: true },
    { ...preview, snapshot: { ...preview.snapshot, argv: ["forged"] } },
    { ...preview, snapshot: { ...preview.snapshot, cwd: "/foreign" } },
    {
      ...preview,
      snapshot: {
        ...preview.snapshot,
        launch: {
          ...preview.snapshot.launch,
          resumeSessionId: preview.requestId,
        },
      },
    },
    {
      ...preview,
      snapshot: {
        ...preview.snapshot,
        launch: {
          ...preview.snapshot.launch,
          context: {
            ...preview.snapshot.launch.context,
            projectId: "project-13c0317d-c70d-44aa-ad0a-9630c89d9c4d",
          },
        },
      },
    },
    ...Object.keys(preview.serialized).map((key) => ({
      ...preview,
      serialized: {
        ...preview.serialized,
        [key]: Array.isArray(
          preview.serialized[key as keyof typeof preview.serialized],
        )
          ? ["forged"]
          : "forged",
      },
    })),
  ])
    expect(sessionPreviewReceiptSchema.safeParse(invalid).success).toBe(false);
});

test("shared receipts bundle for a browser without Node or Bun runtime imports", async () => {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "protocol.ts")],
    target: "browser",
    plugins: [
      {
        name: "refuse-server-runtime",
        setup(build) {
          build.onResolve({ filter: /^(?:node:|bun:)/ }, ({ path }) => {
            throw Error(`Server runtime imported: ${path}`);
          });
        },
      },
    ],
  });
  expect(built.success).toBe(true);
  expect(built.outputs).toHaveLength(1);
  expect(await built.outputs[0]!.text()).not.toMatch(
    /\bBun\.(?:spawn|which|file|write|serve)\b/,
  );
});
