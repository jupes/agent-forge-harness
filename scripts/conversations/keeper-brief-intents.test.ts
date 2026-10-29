import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeeperBriefSnapshot } from "../../types/keeper-brief";
import { createConversationStore } from "./store";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
const homeForTest = () => {
  const home = mkdtempSync(join(tmpdir(), "forge-brief-intent-"));
  homes.push(home);
  return home;
};

function snapshot(projectId: string, asOf: string): KeeperBriefSnapshot {
  return {
    version: 1,
    projectId,
    projectName: "Fixture project",
    workspace: "/served",
    catalogRevision: 4,
    asOf,
    since: asOf,
    scope: {
      label: "project:fixture",
      epicIds: [],
      epicCount: 0,
      repositoryCount: 1,
    },
    observed: {
      beads: 0,
      queue: 0,
      sessions: 0,
      runs: 0,
      activity: 0,
    },
    complete: true,
    limitations: [],
    facts: [],
  };
}

test("canonical brief reservation survives a lost reply and store recreation without changing conversation revision", async () => {
  const home = homeForTest();
  const projectId = `project-${randomUUID()}`;
  const origin = {
    kind: "overview" as const,
    projectId,
    workspace: "/served",
    catalogRevision: 4,
  };
  const firstStore = createConversationStore(home);

  // Treat the reserve response as lost: only a newly created store may recover it.
  await firstStore.reserveKeeperBrief(projectId, {
    expectedRevision: 0,
    origin,
    snapshot: snapshot(projectId, "2026-10-29T12:00:00.000Z"),
  });
  expect(firstStore.read(projectId).revision).toBe(0);

  const reopenedStore = createConversationStore(home);
  const recovered = reopenedStore.discoverKeeperBrief(projectId);
  expect(recovered).not.toBeNull();
  if (!recovered) throw new Error("The canonical reservation was not recovered.");
  expect(
    reopenedStore.readKeeperBriefIntent(projectId, recovered.requestId),
  ).toEqual(recovered);

  const retried = await reopenedStore.reserveKeeperBrief(projectId, {
    expectedRevision: 0,
    origin,
    snapshot: snapshot(projectId, "2026-10-29T12:01:00.000Z"),
  });
  expect(retried).toEqual(recovered);
  expect(recovered?.snapshot.asOf).toBe("2026-10-29T12:00:00.000Z");
  expect(reopenedStore.read(projectId).revision).toBe(0);
  expect(reopenedStore.read(projectId).turns).toEqual([]);
  expect(reopenedStore.read(projectId).frames).toEqual([]);
});
