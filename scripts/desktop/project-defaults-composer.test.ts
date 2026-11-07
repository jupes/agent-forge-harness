import { expect, test } from "bun:test";
import { createSessionsClient } from "../../apps/desktop/src/session-client";
import type { SmithsView } from "../../types/hearth";
import { projectFixture } from "../projects/testing";

const smiths: SmithsView = {
  defaultSmith: "global",
  benches: { low: [], medium: [], high: [] },
  smiths: [
    {
      name: "global",
      provider: "claude",
      model: "global-model",
      effort: "medium",
      enabled: true,
      tags: [],
    },
    {
      name: "project-choice",
      provider: "claude",
      model: "project-model",
      effort: "high",
      enabled: true,
      tags: [],
    },
  ],
};
function fixture() {
  const project = {
    ...projectFixture("/repo"),
    claudeSessionSmith: "project-choice",
  };
  const client = createSessionsClient({
    canWrite: () => true,
    requestId: () => "00000000-0000-4000-8000-000000000001",
    list: async () => [],
    read: async () => {
      throw Error("No session");
    },
    post: async () => ({ state: "unknown", message: "No dispatch" }),
    stream: () => () => ({ close() {} }),
  });
  return { project, client };
}
test("pristine remount reads a newer default while dirty and sealed drafts keep their choice", () => {
  const { project, client } = fixture();
  try {
    client.initializeComposer(project, smiths, []);
    expect(client.project(project.id).composer.smith).toBe("project-choice");
    const changed = { ...project, claudeSessionSmith: "global" };
    client.initializeComposer(changed, smiths, []);
    expect(client.project(project.id).composer.smith).toBe("global");
    client.editComposer(project.id, {
      prompt: "Retained private draft",
      smith: "project-choice",
      model: "project-model",
    });
    const before = structuredClone(client.project(project.id).composer);
    client.initializeComposer(changed, smiths, []);
    expect(client.project(project.id).composer).toEqual(before);
  } finally {
    client.dispose();
  }
  const other = fixture();
  try {
    other.client.editComposer(other.project.id, {
      initialized: true,
      smith: "sealed",
      prompt: "Reviewed original",
    });
    const before = structuredClone(
      other.client.project(other.project.id).composer,
    );
    other.client.initializeComposer(other.project, smiths, []);
    expect(other.client.project(other.project.id).composer).toEqual(before);
  } finally {
    other.client.dispose();
  }
});
test("pending Start fences default application", () => {
  const { project, client } = fixture();
  try {
    const view = client.project(project.id);
    view.starting = true;
    client.initializeComposer(project, smiths, []);
    expect(view.composer.initialized).toBe(false);
  } finally {
    client.dispose();
  }
});
test("provider-first common initialization keeps the Claude baseline and provider-specific draft intact", () => {
  const { project, client } = fixture();
  try {
    client.chooseComposerProvider(project.id, "codex");
    const codex = structuredClone(client.project(project.id).codexComposer);
    client.initializeComposer(project, smiths, []);
    client.chooseComposerProvider(project.id, "claude");
    client.initializeComposer(
      { ...project, claudeSessionSmith: "global" },
      smiths,
      [],
    );
    expect(client.project(project.id).composer.smith).toBe("global");
    expect(client.project(project.id).codexComposer).toEqual(codex);
  } finally {
    client.dispose();
  }
});
test("a prefilled private prompt is an existing draft after first initialization", () => {
  const { project, client } = fixture();
  try {
    client.editComposer(project.id, { prompt: "Retain this requested work" });
    client.initializeComposer(project, smiths, []);
    client.initializeComposer(
      { ...project, claudeSessionSmith: "global" },
      smiths,
      [],
    );
    expect(client.project(project.id).composer.smith).toBe("project-choice");
  } finally {
    client.dispose();
  }
});

test("fresh provider drafts use saved Smiths and launch modes without creating a worktree", () => {
  const { project, client } = fixture();
  const configured: SmithsView = {
    ...smiths,
    smiths: [
      ...smiths.smiths,
      {
        name: "cx",
        provider: "codex",
        model: "cx-model",
        effort: "high",
        enabled: true,
        tags: [],
      },
      {
        name: "gm",
        provider: "gemini",
        model: "gm-model",
        effort: "medium",
        enabled: true,
        tags: [],
      },
    ],
  };
  const defaults = {
    ...project,
    codexSessionSmith: "cx",
    geminiSessionSmith: "gm",
    sessionWhere: "new" as const,
    sessionRunAs: "chat" as const,
  };
  try {
    client.prepareComposerDefaults(defaults);
    client.initializeComposer(defaults, configured, []);
    client.initializeProviderComposer(defaults, configured, "codex", "chat");
    client.initializeProviderComposer(defaults, configured, "gemini", "chat");
    const view = client.project(project.id);
    expect(view.codexMode).toBe("chat");
    expect(view.geminiMode).toBe("chat");
    expect(view.composer.where).toBe("new");
    expect(view.composer.worktree).toBe("");
    expect(view.composer.createdWorktree).toBeNull();
    expect(view.codexChatComposer).toMatchObject({
      smith: "cx",
      model: "cx-model",
      sandbox: "read-only",
    });
    expect(view.geminiChatComposer).toMatchObject({
      smith: "gm",
      model: "gm-model",
      approvalMode: "",
    });
    client.editCodexChatComposer(project.id, { model: "private-model" });
    client.editComposer(project.id, { prompt: "Do not replace this draft" });
    client.prepareComposerDefaults({
      ...defaults,
      sessionRunAs: "task",
      sessionWhere: "main",
    });
    client.initializeProviderComposer(
      { ...defaults, codexSessionSmith: "missing" },
      configured,
      "codex",
      "chat",
    );
    expect(view.codexMode).toBe("chat");
    expect(view.composer.where).toBe("new");
    expect(view.codexChatComposer.model).toBe("private-model");
  } finally {
    client.dispose();
  }
});

test("unavailable project choices stay explicit, while pending and sealed drafts retain authority", () => {
  const { project, client } = fixture();
  try {
    const defaults = { ...project, codexSessionSmith: "missing" };
    client.initializeProviderComposer(defaults, smiths, "codex", "task");
    expect(client.project(project.id).codexComposer).toMatchObject({
      smith: "missing",
      model: "",
    });
    client.editGeminiComposer(project.id, {
      initialized: true,
      smith: "sealed",
      model: "original",
    });
    client.initializeProviderComposer(
      { ...project, geminiSessionSmith: "other" },
      smiths,
      "gemini",
      "task",
    );
    expect(client.project(project.id).geminiComposer.smith).toBe("sealed");
    client.project(project.id).starting = true;
    client.prepareComposerDefaults({ ...project, sessionRunAs: "chat" });
    expect(client.project(project.id).geminiMode).toBe("task");
  } finally {
    client.dispose();
  }
});

test.each([
  "task",
  "chat",
] as const)("clearing a pristine Gemini %s default restores the inherited CLI model", (mode) => {
  const { project, client } = fixture();
  const configured: SmithsView = {
    ...smiths,
    smiths: [
      ...smiths.smiths,
      {
        name: "gm",
        provider: "gemini",
        model: "project-model",
        effort: "medium",
        enabled: true,
        tags: [],
      },
    ],
  };
  try {
    client.initializeComposer(project, configured, []);
    client.initializeProviderComposer(
      { ...project, geminiSessionSmith: "gm" },
      configured,
      "gemini",
      mode,
    );
    const view = client.project(project.id);
    expect(
      (mode === "chat" ? view.geminiChatComposer : view.geminiComposer).model,
    ).toBe("project-model");
    client.initializeProviderComposer(project, configured, "gemini", mode);
    expect(
      mode === "chat" ? view.geminiChatComposer : view.geminiComposer,
    ).toMatchObject({ smith: "gm", model: "" });
  } finally {
    client.dispose();
  }
});
