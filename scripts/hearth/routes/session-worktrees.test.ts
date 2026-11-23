import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { SessionWorktreeReceipt } from "../../../types/session-worktrees";
import { FIXTURE_PROJECT_ID } from "../../projects/testing";
import {
  sessionWorktreeId,
  sessionWorktreeJournalFile,
  sessionWorktreeRequestHash,
} from "../../sessions/worktrees";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
import { fixtureSessionGit } from "./session-fixture";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});

test("same-project foreign-repository worktree receipts refuse GET and exact POST without foreign Git or journal changes", async () => {
  const calls: string[] = [];
  const h = await startTestHearth({
    api: {
      git: (args, cwd) => {
        calls.push(cwd);
        return fixtureSessionGit(args, cwd);
      },
    },
  });
  opened.push(h);
  const foreignRoot = join(h.root, "foreign-repository");
  mkdirSync(join(foreignRoot, ".git"), { recursive: true });
  const repository = realpathSync.native(foreignRoot),
    request = {
      requestId: randomUUID(),
      repository,
      baseRef: "HEAD",
      branch: "feat/private-foreign",
    },
    id = sessionWorktreeId(FIXTURE_PROJECT_ID, request.requestId);
  const plan: SessionWorktreeReceipt = {
    projectId: FIXTURE_PROJECT_ID,
    requestId: request.requestId,
    repository,
    baseRef: request.baseRef,
    resolvedCommit: "a".repeat(40),
    branch: request.branch,
    worktree: {
      id,
      path: join(repository, "trees", id),
      branch: request.branch,
      createdAt: "2026-10-23T00:00:00.000Z",
    },
    state: "unknown",
    reason: "Original foreign intent.",
  };
  mkdirSync(plan.worktree!.path, { recursive: true });
  writeOwnerOnly(
    sessionWorktreeJournalFile(h.home),
    JSON.stringify({
      version: 1,
      records: [
        {
          request,
          requestHash: sessionWorktreeRequestHash(FIXTURE_PROJECT_ID, request),
          plan,
          receipt: null,
        },
      ],
    }),
  );
  const before = readFileSync(sessionWorktreeJournalFile(h.home), "utf8"),
    seen = calls.length,
    path = `/projects/${FIXTURE_PROJECT_ID}/session-worktrees`;
  const read = await fetch(`${h.api}${path}/${request.requestId}`, {
    headers: h.headers(h.hearth.token),
  });
  const retry = await fetch(`${h.api}${path}`, {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: JSON.stringify(request),
  });
  expect([read.status, retry.status]).toEqual([409, 409]);
  expect(await read.text()).not.toContain(repository);
  expect(await retry.text()).not.toContain(repository);
  expect(calls.slice(seen)).toEqual([]);
  expect(readFileSync(sessionWorktreeJournalFile(h.home), "utf8")).toBe(before);
});
