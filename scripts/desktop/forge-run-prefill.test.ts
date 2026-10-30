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
  for (const control of [
    "--full",
    "--FULL=other",
    "--mini=x",
    "--Mini",
    "Use --SMITH=other",
  ]) {
    expect(() =>
      forgeRunPrefill("mini", { kind: "text", text: control }),
    ).toThrow(/choose the route above/i);
  }
  expect(
    forgeRunPrefill("mini", {
      kind: "text",
      text: "Keep --full-ish as ordinary punctuation.",
    }).prompt,
  ).toBe("/forgemaster --mini Keep --full-ish as ordinary punctuation.");
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

test("the snapshot covers every visible and hidden provider draft field", () => {
  const mutations = [
    (view: ReturnType<typeof project>) =>
      view.composer.attachments.push({
        kind: "text",
        name: "notes.txt",
        text: "private draft",
      }),
    (view: ReturnType<typeof project>) => {
      view.composerProvider = "codex";
    },
    (view: ReturnType<typeof project>) =>
      view.composer.about.push({ kind: "bead", id: "af-42" }),
    (view: ReturnType<typeof project>) => {
      view.composer.beadId = "af-42";
    },
    (view: ReturnType<typeof project>) => {
      view.codexMode = "chat";
      view.codexChatComposer.prompt = "hidden Codex draft";
    },
    (view: ReturnType<typeof project>) => {
      view.codexComposer.model = "hidden Codex task model";
    },
    (view: ReturnType<typeof project>) => {
      view.geminiMode = "chat";
      view.geminiChatComposer.prompt = "hidden Gemini draft";
    },
    (view: ReturnType<typeof project>) => {
      view.geminiComposer.model = "hidden Gemini task model";
    },
  ];
  for (const mutate of mutations) {
    const view = project();
    const snapshot = captureForgeRunDraft(view);
    mutate(view);
    expect(forgeRunDraftMatches(snapshot, view)).toBe(false);
  }
});

test("all unresolved identity states and scope failures hold preparation", () => {
  const scope = {
    projectId: "project-a",
    workspace: "C:/workspace",
    generation: 4,
  };
  const verified = () => {
    const view = project();
    view.identityPage = {
      version: 1,
      scope: {
        family: "owned-session-start",
        projectId: scope.projectId,
        workspace: scope.workspace,
      },
      identities: [],
    };
    view.identityGeneration = scope.generation;
    return view;
  };
  const heldViews = [
    (() => {
      const view = verified();
      view.pendingStart = {
        requestId: "request",
        smith: "fixture-smith",
        repository: "C:/workspace",
        worktree: "C:/workspace",
        launch: { mode: "chat", model: "fixture-model", prompt: "held" },
      };
      return view;
    })(),
    (() => {
      const view = verified();
      view.startIdentity = {
        projectId: "project-00000000-0000-4000-8000-000000000000",
        requestId: "00000000-0000-4000-8000-000000000000",
        requestHash: "a".repeat(64),
        provider: "claude",
      };
      return view;
    })(),
    (() => {
      const view = verified();
      view.startIdentityError = "identity read failed";
      return view;
    })(),
    (() => {
      const view = verified();
      view.legacyIdentityHint = {
        projectId: "project-00000000-0000-4000-8000-000000000000",
        requestId: "00000000-0000-4000-8000-000000000000",
        requestHash: "b".repeat(64),
        provider: "claude",
      };
      return view;
    })(),
    (() => {
      const view = verified();
      view.legacyIdentityError = "legacy identity unavailable";
      return view;
    })(),
    (() => {
      const view = verified();
      view.legacyIdentityUnavailable = true;
      return view;
    })(),
    (() => {
      const view = verified();
      view.identityInspection = {
        requestId: "request",
        state: "loading",
        sessionId: null,
      };
      return view;
    })(),
    (() => {
      const view = verified();
      view.identityInspection = {
        requestId: "request",
        state: "unavailable",
        sessionId: null,
      };
      return view;
    })(),
  ];
  for (const view of heldViews)
    expect(forgeRunPreparationHold(view, scope)).toMatch(
      /original session request is unresolved/i,
    );

  const missing = verified();
  missing.identityPage = null;
  expect(forgeRunPreparationHold(missing, scope)).toMatch(
    /identity scope is not verified/i,
  );
  expect(forgeRunPreparationHold(verified(), null)).toMatch(
    /identity scope is not verified/i,
  );
  const wrongProject = verified();
  wrongProject.identityPage!.scope.projectId = "project-b";
  expect(forgeRunPreparationHold(wrongProject, scope)).toMatch(
    /identity scope is not verified/i,
  );
  const wrongGeneration = verified();
  wrongGeneration.identityGeneration = scope.generation + 1;
  expect(forgeRunPreparationHold(wrongGeneration, scope)).toMatch(
    /identity scope is not verified/i,
  );
});
