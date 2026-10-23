import { expect, test } from "bun:test";
import { sessionObservationRows } from "../../apps/desktop/src/session-observations";
import type { OwnedCodingSessionRecord } from "../../types/codex-owned-task";
import type {
  ProjectSessionObservations,
  SessionOwnershipMetadata,
} from "../../types/session-observations";

const record: OwnedCodingSessionRecord = {
  projectId: "project-015821b4-4b38-4bf3-9326-71ce9c09ff46",
  id: "session-78d55e8f-4521-40bc-a45a-cd8e68e575ae",
  requestId: "825f49e8-14b5-46d2-80f5-a143ae120bed",
  requestHash: "a".repeat(64),
  workspace: "/fixture",
  repository: "/fixture",
  worktree: "/fixture",
  provider: "claude",
  mode: "chat",
  smith: "claude-journeyman",
  requestedModel: "sonnet",
  requestedEffort: null,
  createdAt: "2026-10-23T17:00:00.000Z",
};
const owner: SessionOwnershipMetadata = { record, origin: null };
const index = (available = true): ProjectSessionObservations => ({
  projectId: record.projectId,
  workspace: record.workspace,
  asOf: record.createdAt,
  observations: [
    {
      sessionId: record.id,
      workspace: record.workspace,
      kind: "headless",
      lastEventAt: record.createdAt,
      executor: { provider: "codex", model: "unverified-ledger-model" },
    },
  ],
  observationsComplete: true,
  ownership: available
    ? { available: true, records: [owner], reason: null }
    : {
        available: false,
        records: [],
        reason: "The private registry could not be read.",
      },
  problems: [],
});

test("verified historical ownership wins a matching ledger address once and never becomes Observed", () => {
  const rows = sessionObservationRows(index());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: record.id,
    ownership: "owned",
    provider: "claude",
    status: "unverified",
    owner,
  });
  expect(rows[0]?.title).toContain("Chat");
});

test("a failed registry read retains verified ownership only inside its exact project and workspace", () => {
  const failed = index(false);
  const rows = sessionObservationRows(failed, [owner]);
  expect(rows[0]).toMatchObject({
    ownership: "owned",
    status: "unverified",
    owner,
  });
  expect(rows[0]?.reason).toContain("Previously verified");
  expect(rows[0]?.reason).toContain("could not be read");
  for (const foreign of [
    { ...owner, record: { ...record, workspace: "/other" } },
    {
      ...owner,
      record: {
        ...record,
        projectId: "project-f05a117f-8d19-4906-80f0-75d72835f3e8",
      },
    },
  ]) {
    const isolated = sessionObservationRows(failed, [foreign]);
    expect(isolated[0]?.ownership).toBe("unavailable");
    expect(isolated[0]?.owner).toBeNull();
  }
});

test("unverified headless activity is not a Shift or an external terminal, and UUID spelling does not establish ownership", () => {
  const data = index();
  data.ownership = { available: true, records: [], reason: null };
  const rows = sessionObservationRows(data);
  expect(rows[0]).toMatchObject({
    ownership: "unavailable",
    status: "unverified",
    owner: null,
  });
  expect(rows[0]?.title).not.toContain("Shift");
  expect(rows[0]?.reason).toContain("origin is unavailable");
  data.observations[0]!.kind = "interactive";
  expect(sessionObservationRows(data)[0]).toMatchObject({
    ownership: "external",
    status: "observed",
    owner: null,
  });
});

test("explicit shift provenance stays owned even when no generic controllable row exists", () => {
  const data = index();
  const shift: SessionOwnershipMetadata = {
    record: { ...record, beadId: "fixture-epic.1" },
    origin: {
      kind: "shift",
      projectId: record.projectId,
      originalRequestId: record.requestId,
      shiftId: "shift-20261023-170000-a1b2",
      runId: "fixture-run",
      beadId: "fixture-epic.1",
      attempt: 1,
    },
  };
  data.ownership = { available: true, records: [shift], reason: null };
  expect(sessionObservationRows(data)[0]).toMatchObject({
    ownership: "owned",
    title: "Shift · fixture-epic.1",
    status: "unverified",
    owner: shift,
  });
  expect(sessionObservationRows(data)[0]?.reason).toContain(
    "unavailable in this view",
  );
});

test("a known owned history remains visible when its later complete index omits it, without claiming current control", () => {
  const data = index();
  data.observations = [];
  data.ownership = { available: true, records: [], reason: null };
  const rows = sessionObservationRows(data, [owner]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    ownership: "owned",
    observation: null,
    status: "unverified",
  });
  expect(rows[0]?.reason).toContain("absent from the current registry");
});
