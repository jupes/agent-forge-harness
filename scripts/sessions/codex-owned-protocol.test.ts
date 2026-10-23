import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { CodexTaskStartRequest } from "../../types/codex-owned-task";
import type { SessionStartRequest } from "../../types/session-requests";
import {
  canonicalOwnedSessionStart,
  parseOwnedSessionStart,
} from "./codex-owned-protocol";
import { canonicalSessionInput } from "./preparation";
import { parseSessionStart } from "./request-protocol";

const legacy = {
  requestId: "a5832fa0-7a21-403b-8184-44892f0d8d86",
  smith: "claude-journeyman",
  repository: "/fixture",
  worktree: "/fixture/tree",
  beadId: "alpha-1",
  about: [{ kind: "bead", id: "alpha-1" }],
  launch: {
    mode: "chat",
    model: "claude-sonnet-5-5",
    prompt: "  Exact private question\n",
    permissionMode: "acceptEdits",
    attachments: [{ kind: "text", name: "note.txt", text: "Private context" }],
  },
} satisfies SessionStartRequest;
const codex = {
  ...legacy,
  provider: "codex",
  smith: "codex-journeyman",
  launch: {
    mode: "task",
    model: "gpt-example-exact",
    prompt: legacy.launch.prompt,
    sandbox: "read-only",
    approvalPolicy: "never",
    attachments: legacy.launch.attachments,
  },
} satisfies CodexTaskStartRequest;

test("the owned Codex branch preserves the legacy Claude parse and literal original-request hash", () => {
  const before = parseSessionStart(legacy);
  expect(parseOwnedSessionStart(legacy)).toEqual(before);
  const canonical = canonicalOwnedSessionStart(legacy);
  expect(canonical).toBe(canonicalSessionInput(before));
  expect(createHash("sha256").update(canonical).digest("hex")).toBe(
    "ea53240522727d66c33c60531aac9bac1ba9e4b0bac05714ca0a3eb79b9e3e57",
  );
  expect(canonical).not.toContain('"provider"');
});

test("Codex Task intent has an explicit provider and retains exact prompt/options without caller paths or authority", () => {
  expect(parseOwnedSessionStart(codex)).toEqual(codex);
  expect(canonicalOwnedSessionStart(codex)).toBe(
    canonicalOwnedSessionStart({ ...codex, launch: { ...codex.launch } }),
  );
  expect(canonicalOwnedSessionStart(codex)).toContain('"provider":"codex"');
  expect(() => parseSessionStart(codex)).toThrow();
  for (const launch of [
    { ...codex.launch, mode: "chat" },
    { ...codex.launch, cwd: "/arbitrary" },
    { ...codex.launch, context: { projectId: "forged" } },
    { ...codex.launch, command: ["codex"] },
    { ...codex.launch, approvalPolicy: "on-request" },
    { ...codex.launch, sandbox: "danger-full-access" },
    { ...codex.launch, outputSchema: {} },
    { ...codex.launch, attachments: [{ kind: "image", data: "hidden" }] },
  ])
    expect(() => parseOwnedSessionStart({ ...codex, launch })).toThrow();
  for (const provider of ["claude", "Codex", "gemini", "unknown", null])
    expect(() => parseOwnedSessionStart({ ...codex, provider })).toThrow();
  expect(() =>
    parseOwnedSessionStart({ ...legacy, smith: "codex-journeyman" }),
  ).not.toThrow();
  expect(
    parseOwnedSessionStart({ ...legacy, smith: "codex-journeyman" }),
  ).not.toHaveProperty("provider");
});
