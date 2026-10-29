import { describe, expect, test } from "bun:test";
import {
  blankProjectCouncilDraft,
  createProjectCouncilDraftCache,
  type ProjectCouncilDraftScope,
} from "../../apps/desktop/src/project-council-draft";

const alpha: ProjectCouncilDraftScope = {
  projectId: "alpha",
  workspace: "C:/projects/alpha",
};

describe("Project Council draft memory", () => {
  test("isolates exact project and workspace pairs", () => {
    const cache = createProjectCouncilDraftCache();
    const changedWorkspace = { ...alpha, workspace: "C:/projects/other" };
    const changedProject = { ...alpha, projectId: "alpha: C:/projects/alpha" };

    cache.write(alpha, { ...blankProjectCouncilDraft(), source: "one" });
    cache.write(changedWorkspace, {
      ...blankProjectCouncilDraft(),
      source: "two",
    });
    cache.write(changedProject, {
      ...blankProjectCouncilDraft(),
      source: "three",
    });

    expect(cache.read(alpha)?.draft.source).toBe("one");
    expect(cache.read(changedWorkspace)?.draft.source).toBe("two");
    expect(cache.read(changedProject)?.draft.source).toBe("three");
  });

  test("prefills only source identity and preserves all review options", () => {
    const cache = createProjectCouncilDraftCache();
    const existing = {
      ...blankProjectCouncilDraft(),
      sourceType: "plan" as const,
      source: "existing plan",
      profileChoice: "deep-profile",
      maxUsd: "17.25",
      maxBytes: "9000",
      redactSecrets: false,
      deepDiscussion: true,
    };
    cache.write(alpha, existing);

    const result = cache.prefill(alpha, { sourceType: "bead", source: "AB-3" });

    expect(result.kind).toBe("confirmation-required");
    if (result.kind !== "confirmation-required") return;
    const applied = cache.confirm(alpha, result.pending);
    expect(applied.kind).toBe("applied");
    expect(cache.read(alpha)?.draft).toEqual({
      ...existing,
      sourceType: "bead",
      source: "AB-3",
    });
  });

  test("applies empty and identical source prefill without confirmation", () => {
    const cache = createProjectCouncilDraftCache();
    expect(
      cache.prefill(alpha, { sourceType: "bead", source: "AB-4" }).kind,
    ).toBe("applied");
    expect(
      cache.prefill(alpha, { sourceType: "bead", source: "AB-4" }).kind,
    ).toBe("applied");
  });

  test("rejects stale and replayed confirmation without replacing edits", () => {
    const cache = createProjectCouncilDraftCache();
    cache.write(alpha, { ...blankProjectCouncilDraft(), source: "old" });
    const pending = cache.prefill(alpha, {
      sourceType: "file",
      source: "notes/plan.md",
    });
    if (pending.kind !== "confirmation-required")
      throw new Error("expected a replacement confirmation");

    cache.write(alpha, { ...blankProjectCouncilDraft(), source: "new edit" });
    expect(cache.confirm(alpha, pending.pending).kind).toBe("stale");
    expect(cache.read(alpha)?.draft.source).toBe("new edit");

    const fresh = cache.prefill(alpha, {
      sourceType: "file",
      source: "notes/plan.md",
    });
    if (fresh.kind !== "confirmation-required")
      throw new Error("expected a fresh replacement confirmation");
    expect(cache.confirm(alpha, fresh.pending).kind).toBe("applied");
    expect(cache.confirm(alpha, fresh.pending).kind).toBe("stale");
  });

  test("binds pending confirmation to its captured exact scope", () => {
    const cache = createProjectCouncilDraftCache();
    cache.write(alpha, { ...blankProjectCouncilDraft(), source: "old" });
    const pending = cache.prefill(alpha, { sourceType: "pr", source: "PR-8" });
    if (pending.kind !== "confirmation-required")
      throw new Error("expected a replacement confirmation");

    expect(
      cache.confirm({ ...alpha, workspace: "C:/elsewhere" }, pending.pending),
    ).toEqual({ kind: "refused", reason: "invalid-scope" });
    expect(cache.read(alpha)?.draft.source).toBe("old");
  });

  test("refuses oversized UTF-8 sources and full capacity without data loss", () => {
    const cache = createProjectCouncilDraftCache();
    const original = { ...blankProjectCouncilDraft(), source: "kept" };
    cache.write(alpha, original);
    const oversized = "💡".repeat(256 * 1024);
    expect(cache.write(alpha, { ...original, source: oversized })).toEqual({
      kind: "refused",
      reason: "source-too-large",
    });
    expect(cache.read(alpha)?.draft.source).toBe("kept");

    for (let index = 1; index < 32; index += 1)
      cache.write(
        { projectId: `project-${index}`, workspace: `workspace-${index}` },
        blankProjectCouncilDraft(),
      );
    expect(
      cache.write(
        { projectId: "project-32", workspace: "workspace-32" },
        blankProjectCouncilDraft(),
      ),
    ).toEqual({ kind: "refused", reason: "capacity" });
    expect(cache.read(alpha)?.draft.source).toBe("kept");
  });

  test("copies values at the cache boundary and refuses empty scope", () => {
    const cache = createProjectCouncilDraftCache();
    const draft = { ...blankProjectCouncilDraft(), source: "saved" };
    cache.write(alpha, draft);
    draft.source = "mutated input";
    const read = cache.read(alpha);
    if (!read) throw new Error("expected saved draft");
    read.draft.source = "mutated output";
    expect(cache.read(alpha)?.draft.source).toBe("saved");
    expect(cache.write({ ...alpha, projectId: "" }, blankProjectCouncilDraft())).toEqual({
      kind: "refused",
      reason: "invalid-scope",
    });
  });
});
