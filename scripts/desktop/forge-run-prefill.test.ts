import { expect, test } from "bun:test";
import { createSessionsClient } from "../../apps/desktop/src/session-client";
import {
  captureForgeRunDraft,
  forgeRunComposerPatch,
  forgeRunDraftIsPristine,
  forgeRunDraftMatches,
  forgeRunPrefill,
  forgeRunPreparationHold,
} from "../../apps/desktop/src/forge-run-prefill";

function project() {
  const client = createSessionsClient({
    canWrite: () => true,
    requestId: () => "request",
    list: async () => ({}),
    read: async () => ({}),
    post: async () => ({ state: "refused", message: "unused" }),
    stream: () => () => ({ close() {} }),
  });
  return client.project("project-a");
}

test("forge prefill preserves exact text or uses only the scoped bead identity", () => {
  expect(
    forgeRunPrefill("full", { kind: "text", text: "  Build it!\n" }),
  ).toEqual({
    prompt: "/forgemaster --full   Build it!\n",
    beadId: "",
    about: [],
  });
  expect(
    forgeRunPrefill("mini", {
      kind: "bead",
      id: "af-123",
      title: "Display-only title",
    }),
  ).toEqual({
    prompt: "/forgemaster --mini af-123",
    beadId: "af-123",
    about: [{ kind: "bead", id: "af-123" }],
  });
  expect(
    forgeRunComposerPatch({
      prompt: "/forgemaster --mini af-123",
      beadId: "af-123",
      about: [{ kind: "bead", id: "af-123" }],
    }),
  ).toEqual({
    prompt: "/forgemaster --mini af-123",
    beadId: "af-123",
    about: [{ kind: "bead", id: "af-123" }],
    attachments: [],
  });
});

test("forge prefill refuses empty input and route or smith control tokens without altering unrelated flags", () => {
  expect(() => forgeRunPrefill("full", { kind: "text", text: " \n " })).toThrow(
    /enter feature text/i,
  );
  for (const control of ["--full", "--mini=x", "Use --SMITH=other"]) {
    expect(() =>
      forgeRunPrefill("mini", { kind: "text", text: control }),
    ).toThrow(/choose the route above/i);
  }
  expect(
    forgeRunPrefill("mini", {
      kind: "text",
      text: "Keep --label=ready and punctuation: (yes)!",
    }).prompt,
  ).toBe("/forgemaster --mini Keep --label=ready and punctuation: (yes)!");
});

test("pristine detection requires every provider draft and mode to retain its exact defaults", () => {
  const view = project();
  expect(forgeRunDraftIsPristine(captureForgeRunDraft(view))).toBe(true);
  view.identityPage = {
    version: 1,
    scope: {
      family: "owned-session-start",
      projectId: "project-a",
      workspace: "C:/workspace",
    },
    identities: [],
  };
  view.identityGeneration = 4;
  expect(forgeRunDraftIsPristine(captureForgeRunDraft(view))).toBe(true);
  view.geminiChatComposer.smith = "a saved hidden draft";
  expect(forgeRunDraftIsPristine(captureForgeRunDraft(view))).toBe(false);
});

test("the volatile snapshot notices hidden provider edits and the shared identity hold requires current scope", () => {
  const view = project();
  view.identityPage = {
    version: 1,
    scope: {
      family: "owned-session-start",
      projectId: "project-a",
      workspace: "C:/workspace",
    },
    identities: [],
  };
  view.identityGeneration = 4;
  const snapshot = captureForgeRunDraft(view);
  const currentScope = {
    projectId: "project-a",
    workspace: "C:/workspace",
    generation: 4,
  };
  expect(forgeRunDraftMatches(snapshot, view)).toBe(true);
  expect(forgeRunPreparationHold(view, currentScope)).toBe(null);
  expect(
    forgeRunPreparationHold(view, { ...currentScope, generation: 5 }),
  ).toMatch(/identity scope is not verified/i);
  view.identityGeneration = 5;
  expect(forgeRunDraftMatches(snapshot, view)).toBe(false);
  expect(forgeRunPreparationHold(view, { ...currentScope, generation: 5 })).toBe(
    null,
  );
  view.identityGeneration = 4;
  view.codexComposer.model = "changed while reviewing";
  expect(forgeRunDraftMatches(snapshot, view)).toBe(false);
  expect(
    forgeRunPreparationHold(view, {
      ...currentScope,
      workspace: "C:/other",
    }),
  ).toMatch(/identity scope is not verified/i);
  for (const state of ["reserved", "attempted", "not-sent"] as const) {
    view.identityPage.identities = [
      {
        version: 1,
        requestId: "request",
        requestHash: "a".repeat(64),
        provider: "claude",
        mode: "chat",
        state,
      },
    ];
    expect(
      forgeRunPreparationHold(view, currentScope),
    ).toMatch(/original session request is unresolved/i);
  }
  view.identityPage.identities = [];
  view.identityLoading = true;
  expect(
    forgeRunPreparationHold(view, currentScope),
  ).toMatch(/identity read to finish/i);
  view.identityLoading = false;
  view.starting = true;
  expect(
    forgeRunPreparationHold(view, currentScope),
  ).toMatch(/original session request is unresolved/i);
});
