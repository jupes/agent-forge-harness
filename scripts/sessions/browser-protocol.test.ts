import { expect, test } from "bun:test";
import {
  conversationPageSchema,
  parseSessionSend,
} from "../conversations/protocol";

test("owned session replay validates text and inline images without a Node Buffer global", () => {
  const requestId = "0c296333-b021-4249-8c56-a397a09f3fd7";
  const at = "2026-10-23T03:00:00.000Z";
  const image = {
    kind: "image",
    name: "fixture.png",
    mediaType: "image/png",
    data: "iVBORw0KGgo=",
  };
  const page = (attachments: unknown[]) => ({
    version: 1,
    projectId: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
    conversationId: "session-33005ac7-b603-4b44-aebf-786615784db1",
    revision: 1,
    binding: null,
    turns: [],
    frames: [
      {
        seq: 1,
        turnId: requestId,
        at,
        event: {
          kind: "user",
          text: "  Exact private input 🌱\n",
          about: [],
          session: {
            version: 1,
            provider: "claude",
            smith: "coding",
            cwd: "/fixture/repo",
            launch: {
              mode: "chat",
              model: "sonnet",
              prompt: "  Exact private input 🌱\n",
              attachments,
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
              ],
            },
          },
        },
      },
    ],
    more: false,
    lastSequence: 1,
    nextCursor: 1,
    request: null,
    controllable: false,
  });
  const buffer = globalThis.Buffer;
  const results: boolean[] = [];
  try {
    Reflect.set(globalThis, "Buffer", undefined);
    results.push(conversationPageSchema.safeParse(page([])).success);
    results.push(conversationPageSchema.safeParse(page([image])).success);
    results.push(
      conversationPageSchema.safeParse(page([{ ...image, data: "bad base64" }]))
        .success,
    );
    results.push(
      parseSessionSend({
        requestId,
        expectedRevision: 0,
        text: "  exact\n",
        about: [],
        attachments: [image],
      }).text === "  exact\n",
    );
  } finally {
    Reflect.set(globalThis, "Buffer", buffer);
  }
  expect(results).toEqual([true, true, false, true]);
});
