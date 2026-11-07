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
