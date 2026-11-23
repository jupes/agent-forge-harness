import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { keeperProposalPageSchema } from "../../keeper/proposal-protocol";
import { FIXTURE_PROJECT_ID } from "../../projects/testing";
import { startTestHearth, type TestHearth } from "../testing";
import {
  FIXTURE_KEEPER_DECISION,
  seedKeeperProposalSource,
} from "./keeper-proposal-fixture";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});
test("protected proposal approval uses actual source and audit ids, dispatches one existing comment row, and reconciles retries without another write", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const sources = await seedKeeperProposalSource(h),
    proposal = sources[0];
  if (!proposal) throw new Error("Missing source proposal");
  const path = `${h.api}/projects/${FIXTURE_PROJECT_ID}/keeper/proposals`;
  expect((await fetch(path, { headers: h.headers(null) })).status).toBe(403);
  const initial = await fetch(path, { headers: h.headers(h.hearth.token) });
  expect(initial.status).toBe(200);
  const first: unknown = await initial.json();
  expect(first).toMatchObject({
    ok: true,
    data: {
      projectId: FIXTURE_PROJECT_ID,
      revision: 0,
      proposals: [{ available: true }, { available: true }],
    },
  });
  const body = {
    id: proposal.id,
    sourceHash: proposal.sourceHash,
    requestId: randomUUID(),
    expectedRevision: 0,
    draft: proposal.draft,
  };
  const post = (suffix: string, value: unknown) =>
    fetch(`${path}/${suffix}`, {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify(value),
    });
  expect((await post("approve", { ...body, auditEventId: 99999 })).status).toBe(
    400,
  );
  const written = await post("approve", body);
  expect(written.status).toBe(200);
  const result: unknown = await written.json();
  const audit = h
    .events(["operator.action"])
    .find(
      (event) =>
        event.kind === "operator.action" &&
        event.payload.action === "keeper.proposal.approve",
    );
  expect(result).toMatchObject({
    ok: true,
    data: {
      record: {
        id: proposal.id,
        phase: "done",
        pending: false,
        auditEventId: audit?.id,
      },
    },
  });
  expect((await post("approve", body)).status).toBe(200);
  const projected = await fetch(`${path}?requestId=${body.requestId}`, {
    headers: h.headers(h.hearth.token),
  });
  const projection = keeperProposalPageSchema.parse(
    (await projected.json()).data,
  );
  expect(projection.request).toMatchObject({
    requestId: body.requestId,
    phase: "done",
  });
  expect(projection.proposals[0]?.activity).toMatchObject({
    id: audit?.id,
    target: proposal.id,
    action: "keeper.proposal.approve",
  });
  expect(
    (
      await fetch(`${path}?requestId=nope`, {
        headers: h.headers(h.hearth.token),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await fetch(
        `${path}?requestId=${body.requestId}&requestId=${body.requestId}`,
        { headers: h.headers(h.hearth.token) },
      )
    ).status,
  ).toBe(400);
  expect(
    h.bd.calls.filter((args) => args[0] === "comments" && args[1] === "add"),
  ).toHaveLength(1);
  expect(JSON.stringify(h.events())).not.toContain(FIXTURE_KEEPER_DECISION);
  expect(
    h
      .events(["operator.action"])
      .some(
        (event) =>
          event.kind === "operator.action" &&
          event.payload.action === "bead.comment",
      ),
  ).toBe(true);
});
