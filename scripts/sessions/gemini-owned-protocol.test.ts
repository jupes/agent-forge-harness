import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { GeminiTaskStartRequest } from "../../types/gemini-owned-task";
import {
  canonicalOwnedSessionStart,
  parseOwnedSessionStart,
} from "./codex-owned-protocol";

const request = {
  requestId: "f144c851-7152-463e-aa26-a8bd191b3d73",
  provider: "gemini",
  smith: "gemini-example",
  repository: "/fixture",
  worktree: "/fixture/tree",
  beadId: "alpha-1",
  about: [{ kind: "bead", id: "alpha-1" }],
  launch: {
    route: "gemini-cli",
    mode: "task",
    prompt: "Exact private Gemini 🌱\n",
    model: "exact-model",
    approvalMode: "plan",
    sandbox: true,
    attachments: [{ kind: "text", name: "note", text: "@private inline data" }],
  },
} satisfies GeminiTaskStartRequest;

test("owned Gemini Task is an explicit closed native branch with stable exact original bytes", () => {
  expect(parseOwnedSessionStart(request)).toEqual(request);
  const original = canonicalOwnedSessionStart(request);
  expect(original).toBe(canonicalOwnedSessionStart(structuredClone(request)));
  expect(original).toContain('"provider":"gemini"');
  expect(original).toContain('"route":"gemini-cli"');
  expect(createHash("sha256").update(original).digest("hex")).not.toBe(
    createHash("sha256")
      .update(
        canonicalOwnedSessionStart({
          ...request,
          launch: { ...request.launch, prompt: "Changed private prompt" },
        }),
      )
      .digest("hex"),
  );
  for (const launch of [
    { ...request.launch, mode: "chat" },
    { ...request.launch, route: "antigravity" },
    { ...request.launch, cwd: "/arbitrary" },
    { ...request.launch, context: { projectId: "forged" } },
    { ...request.launch, command: ["gemini"] },
    { ...request.launch, resumeSessionId: request.requestId },
    { ...request.launch, approvalMode: "yolo" },
    { ...request.launch, effort: "high" },
    { ...request.launch, token: "synthetic-private" },
    { ...request.launch, policyFiles: ["/unreviewed/policy"] },
    { ...request.launch, includeDirectories: ["/unreviewed/directory"] },
    {
      ...request.launch,
      attachments: [{ kind: "image", name: "photo", data: "hidden" }],
    },
  ])
    expect(() => parseOwnedSessionStart({ ...request, launch })).toThrow();
  for (const provider of ["claude", "codex", "Gemini", null])
    expect(() => parseOwnedSessionStart({ ...request, provider })).toThrow();
});

test("omitted native Gemini selections remain omitted instead of becoming invented effort/model controls", () => {
  const defaults = {
    ...request,
    launch: {
      route: "gemini-cli",
      mode: "task",
      prompt: request.launch.prompt,
    },
  } satisfies GeminiTaskStartRequest;
  expect(parseOwnedSessionStart(defaults)).toEqual(defaults);
  expect(canonicalOwnedSessionStart(defaults)).not.toContain('"effort"');
  expect(canonicalOwnedSessionStart(defaults)).not.toContain('"model"');
});

test("public Gemini preview and admission share the private journal's message and attachment bounds", () => {
  expect(
    parseOwnedSessionStart({
      ...request,
      launch: {
        ...request.launch,
        prompt: "x".repeat(16_384),
        attachments: Array.from(
          { length: 8 },
          () => request.launch.attachments[0],
        ),
      },
    }),
  ).toBeDefined();
  for (const launch of [
    { ...request.launch, prompt: "x".repeat(16_385) },
    {
      ...request.launch,
      attachments: Array.from(
        { length: 9 },
        () => request.launch.attachments[0],
      ),
    },
  ])
    expect(() => parseOwnedSessionStart({ ...request, launch })).toThrow();
});
