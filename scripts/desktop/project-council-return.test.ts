import { describe, expect, test } from "bun:test";
import type { ProjectCouncilDraftScope } from "../../apps/desktop/src/project-council-draft";
import {
  createProjectCouncilReturnMemory,
  projectCouncilReturnTargetMatches,
  type ProjectCouncilReturnOrigin,
} from "../../apps/desktop/src/project-council-return";

const scope: ProjectCouncilDraftScope = {
  projectId: "project-a",
  workspace: "C:/workspace/a",
};
const otherScope: ProjectCouncilDraftScope = {
  projectId: "project-b",
  workspace: "C:/workspace/b",
};
const originA: ProjectCouncilReturnOrigin = {
  kind: "run-checkpoint",
  ...scope,
  runSlug: "similar-run-a",
  checkpointId: "epic.task-a",
};
const originB: ProjectCouncilReturnOrigin = {
  ...originA,
  runSlug: "similar-run-b",
  checkpointId: "epic.task-b",
};

describe("Council Run return memory", () => {
  test("Keep preserves the existing origin and Replace transfers the current intent", () => {
    const memory = createProjectCouncilReturnMemory();
    const initial = memory.begin(scope, originA);
    expect(memory.apply(initial, scope)).toBe(true);
    expect(memory.apply(initial, scope)).toBe(false);

    const replacement = memory.begin(scope, originB);
    expect(memory.keep(replacement, scope)).toBe(true);
    expect(memory.isCurrent(replacement, scope)).toBe(false);
    expect(memory.get(scope)).toEqual(originA);

    const replace = memory.begin(scope, originB);
    expect(memory.apply(replace, scope)).toBe(true);
    expect(memory.apply(replace, scope)).toBe(false);
    expect(memory.get(scope)).toEqual(originB);
  });

  test("stale source generations and changed scopes cannot transfer an origin", () => {
    const memory = createProjectCouncilReturnMemory();
    const initial = memory.begin(scope, originA);
    expect(memory.apply(initial, scope)).toBe(true);
    const stale = memory.begin(scope, originB);
    memory.begin(scope, null);

    expect(memory.isCurrent(stale, scope)).toBe(false);
    expect(memory.apply(stale, scope)).toBe(false);
    expect(memory.reject(stale, scope)).toBe(false);
    expect(memory.get(scope)).toEqual(originA);
    expect(memory.keep(stale, otherScope)).toBe(false);
    const refused = memory.begin(scope, originB);
    expect(memory.reject(refused, scope)).toBe(true);
    expect(memory.get(scope)).toEqual(originA);

    memory.clear();
    expect(memory.get(scope)).toBeNull();
  });

  test("successful unrelated replacement clears the origin; Back consumes it once", () => {
    const memory = createProjectCouncilReturnMemory();
    const initial = memory.begin(scope, originA);
    expect(memory.apply(initial, scope)).toBe(true);
    const unrelated = memory.begin(scope, null);
    expect(memory.apply(unrelated, scope)).toBe(true);
    expect(memory.get(scope)).toBeNull();

    const checkpoint = memory.begin(scope, originB);
    expect(memory.apply(checkpoint, scope)).toBe(true);
    const returned = memory.take(scope, originB);
    expect(returned?.origin).toEqual(originB);
    expect(memory.take(scope, originB)).toBeNull();
    expect(memory.get(scope)).toBeNull();
  });

  test("return focus requires the exact scope, Run slug, and active checkpoint", () => {
    expect(
      projectCouncilReturnTargetMatches(originA, scope, originA.runSlug, [
        originA.checkpointId,
      ]),
    ).toBe(true);
    expect(
      projectCouncilReturnTargetMatches(originA, scope, originB.runSlug, [
        originA.checkpointId,
      ]),
    ).toBe(false);
    expect(
      projectCouncilReturnTargetMatches(originA, scope, originA.runSlug, []),
    ).toBe(false);
    expect(
      projectCouncilReturnTargetMatches(
        originA,
        otherScope,
        originA.runSlug,
        [originA.checkpointId],
      ),
    ).toBe(false);
  });
});
