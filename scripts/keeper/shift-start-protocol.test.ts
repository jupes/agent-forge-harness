import { expect, test } from "bun:test";
import type { KeeperShiftStartRequest } from "../../types/keeper-shift-start";
import {
  keeperShiftProposalMatches,
  keeperShiftStartHashes,
  keeperShiftStartIntentSchema,
  keeperShiftStartProposalSchema,
  keeperShiftStartRequestSchema,
  sameKeeperShiftStart,
} from "./shift-start-protocol";

const projectId = "project-a5832fa0-7a21-403b-8184-44892f0d8d86";
const proposalId = "proposal-1a5832fa-7a21-403b-8184-44892f0d8d86-0";
const workspace = "C:/fixture/repository";
const reviewed: KeeperShiftStartRequest = {
  sourceHash: "a".repeat(64),
  expectedRevision: 7,
  start: {
    requestId: "b14cc7eb-3231-4930-a288-d411c5ee0426",
    expectedCatalogRevision: 12,
    options: {
      for: "45m",
      concurrency: 2,
      maxBeads: 5,
      maxUsd: 8,
      repairs: 1,
      base: "main",
      epic: "cla5.5",
      smith: "claude-journeyman",
      runTimeout: "300s",
    },
  },
};
const proposal = {
  durationMinutes: 45,
  concurrency: 2,
  beadLimit: 5,
  spendLimitUsd: 8,
};

function intent(original: KeeperShiftStartRequest = reviewed) {
  const { startHash, reviewHash } = keeperShiftStartHashes(
    projectId,
    proposalId,
    workspace,
    proposal,
    original,
  );
  return {
    projectId,
    proposalId,
    workspace,
    proposal,
    original,
    startHash,
    reviewHash,
    createdAt: "2026-10-25T18:00:00.000Z",
  };
}

test("a Keeper Shift review retains the full strict original and every optional bound", () => {
  expect(keeperShiftStartRequestSchema.parse(reviewed)).toEqual(reviewed);
  expect(
    keeperShiftStartRequestSchema.safeParse({ ...reviewed, extra: true })
      .success,
  ).toBe(false);
  expect(
    keeperShiftStartRequestSchema.safeParse({
      ...reviewed,
      start: {
        ...reviewed.start,
        options: { ...reviewed.start.options, arbitraryFlags: ["--unsafe"] },
      },
    }).success,
  ).toBe(false);
});

test("the four proposed values remain bound and must agree with the reviewed request", () => {
  expect(keeperShiftStartProposalSchema.parse(proposal)).toEqual(proposal);
  expect(keeperShiftProposalMatches(proposal, reviewed)).toBe(true);
  expect(
    keeperShiftProposalMatches({ ...proposal, durationMinutes: 44 }, reviewed),
  ).toBe(false);
  expect(
    keeperShiftStartProposalSchema.safeParse({ ...proposal, extra: true })
      .success,
  ).toBe(false);
});

test("the private intent binds the complete request, proposal source, revision and served scope", () => {
  const original = intent();
  expect(keeperShiftStartIntentSchema.parse(original)).toEqual(original);
  for (const changed of [
    {
      ...original,
      original: { ...reviewed, sourceHash: "b".repeat(64) },
    },
    {
      ...original,
      original: { ...reviewed, expectedRevision: 8 },
    },
    {
      ...original,
      original: {
        ...reviewed,
        start: {
          ...reviewed.start,
          options: { ...reviewed.start.options, maxUsd: 9 },
        },
      },
    },
    { ...original, startHash: "f".repeat(64) },
    { ...original, reviewHash: "f".repeat(64) },
    { ...original, proposal: { ...proposal, spendLimitUsd: 9 } },
  ])
    expect(keeperShiftStartIntentSchema.safeParse(changed).success).toBe(false);
  expect(
    keeperShiftStartIntentSchema.safeParse({ ...original, unknown: true })
      .success,
  ).toBe(false);
});

test("exact intent retries match and changed scope or original content do not", () => {
  const original = intent();
  expect(sameKeeperShiftStart(original, intent())).toBe(true);
  expect(
    sameKeeperShiftStart(original, {
      ...intent(),
      workspace: "C:/other/repository",
    }),
  ).toBe(false);
  expect(
    sameKeeperShiftStart(original, {
      ...intent(),
      proposal: { ...proposal, beadLimit: 9 },
    }),
  ).toBe(false);
  expect(
    sameKeeperShiftStart(original, {
      ...intent(),
      original: {
        ...reviewed,
        start: {
          ...reviewed.start,
          requestId: "c14cc7eb-3231-4930-a288-d411c5ee0426",
        },
      },
    }),
  ).toBe(false);
});
