import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProjectShiftIntent } from "../../../types/project-shifts";
import { parseDuration } from "../../config/duration";
import { keeperProposalFile } from "../../keeper/proposal-store";
import { keeperShiftStartReceiptSchema } from "../../keeper/shift-start-protocol";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import { SHIFTS_DIR, writeShiftRecord } from "../../scheduler/shift-store";
import type { ProjectShiftRuntime } from "../../shifts/service";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
import {
  keeperShiftDraft,
  keeperShiftStartFixture,
  seedKeeperShiftStartSource,
} from "./keeper-shift-start-fixture";

function recordingShiftRuntime(
  home: () => string,
  launched: ProjectShiftIntent[],
) {
  let sequence = 0;
  const runtime: ProjectShiftRuntime = {
    attended: true,
    mint: () =>
      `shift-20261025-063000-${(++sequence).toString(16).padStart(4, "0")}`,
    launch(intent) {
      launched.push(intent);
      const options = intent.request.options,
        forMs = parseDuration(options.for),
        startedAt = new Date(Date.parse(intent.createdAt) + 1000);
      if (forMs === null) throw new Error("Invalid fixture Shift duration");
      writeShiftRecord(join(home(), SHIFTS_DIR), {
        shiftId: intent.shiftId,
        workspace: intent.workspace,
        pid: process.pid,
        state: "running",
        startedAt: startedAt.toISOString(),
        deadline: new Date(startedAt.getTime() + forMs).toISOString(),
        options: {
          concurrency: options.concurrency,
          forMs,
          maxBeads: options.maxBeads,
          maxUsd: options.maxUsd,
          repairs: options.repairs,
          base: options.base,
          ...(options.epic !== undefined ? { epic: options.epic } : {}),
          ...(options.smith !== undefined ? { smith: options.smith } : {}),
        },
        spentUsd: 0,
        unpriced: 0,
        admitted: 0,
        beads: [],
      });
    },
  };
  return runtime;
}

async function openShiftHearth(
  onAudit?: (event: unknown) => { ok: false; error: string },
) {
  let home = "";
  const launched: ProjectShiftIntent[] = [];
  const h = await startTestHearth({
    api: {
      projectShiftRuntime: recordingShiftRuntime(() => home, launched),
      ...(onAudit ? { appendEvent: onAudit } : {}),
    },
  });
  home = h.home;
  return { h, launched };
}

const url = (h: TestHearth, proposalId: string) =>
  `${h.api}/projects/${FIXTURE_PROJECT_ID}/keeper/proposals/${proposalId}/shift-start`;
const post = (
  h: TestHearth,
  path: string,
  body: unknown,
  token: string | null = h.hearth.token,
) =>
  fetch(path, {
    method: "POST",
    headers: h.headers(token),
    body: JSON.stringify(body),
  });

test("the audited Keeper Shift route binds one edited original to the shared canonical receipt and duplicate/lost replies stay inert", async () => {
  const { h, launched } = await openShiftHearth();
  try {
    const proposals = await seedKeeperShiftStartSource(h),
      proposal = proposals[0];
    if (!proposal) throw new Error("Missing Keeper Shift proposal fixture");
    const path = url(h, proposal.id),
      body = keeperShiftStartFixture(proposal.sourceHash),
      originalPath = `${path}/${body.start.requestId}`;

    expect((await post(h, path, body, null)).status).toBe(403);
    expect((await fetch(originalPath, { headers: h.headers() })).status).toBe(
      403,
    );
    expect(
      (await fetch(originalPath, { headers: h.headers(h.hearth.token) }))
        .status,
    ).toBe(404);
    expect(launched).toEqual([]);
    expect(h.events(["operator.action"])).toEqual([]);

    expect((await post(h, path, { ...body, extra: true })).status).toBe(400);
    expect((await post(h, `${path}?duplicate=1`, body)).status).toBe(400);
    expect(h.events(["operator.action"])).toEqual([]);
    expect(
      (await post(h, path, { ...body, sourceHash: "f".repeat(64) })).status,
    ).toBe(409);
    expect(launched).toEqual([]);
    const genericApproval = await post(
      h,
      `${h.api}/projects/${FIXTURE_PROJECT_ID}/keeper/proposals/approve`,
      {
        id: proposal.id,
        sourceHash: proposal.sourceHash,
        requestId: "37c8aa56-1db1-4722-8fd2-1dbef8326004",
        expectedRevision: 0,
        draft: proposal.draft,
      },
    );
    expect(genericApproval.status).toBe(409);
    expect(launched).toEqual([]);

    const lostReply = await post(h, path, body);
    expect(lostReply.status).toBe(200);
    await lostReply.body?.cancel();
    expect(launched).toHaveLength(1);
    const startAudit = h.events(["operator.action"]).at(-1);
    if (!startAudit)
      throw new Error("Missing confirmed Keeper Shift audit row");
    expect(startAudit.payload).toMatchObject({
      action: "keeper.proposal.shift.start",
      target: proposal.id,
    });

    const retry = await post(h, path, body);
    expect(retry.status).toBe(200);
    const envelope = await retry.json();
    expect(envelope.ok).toBe(true);
    const receipt = keeperShiftStartReceiptSchema.parse(envelope.data);
    expect(receipt.original).toEqual(body);
    expect(receipt.record.auditEventId).toBe(startAudit.id);
    expect(receipt.record.phase).toBe("done");
    expect(receipt.shift?.intent.request).toEqual(body.start);
    expect(receipt.shift?.observation.actual).not.toBeNull();
    expect(launched).toHaveLength(1);

    const protectedOriginal = await fetch(originalPath, {
      headers: h.headers(h.hearth.token),
    });
    expect(protectedOriginal.status).toBe(200);
    expect(
      keeperShiftStartReceiptSchema.parse((await protectedOriginal.json()).data)
        .original,
    ).toEqual(body);
    expect(
      (
        await fetch(`${originalPath}?requestId=${body.start.requestId}`, {
          headers: h.headers(h.hearth.token),
        })
      ).status,
    ).toBe(400);

    const canonical = await fetch(
      `${h.api}/projects/${FIXTURE_PROJECT_ID}/shifts/requests/${body.start.requestId}`,
      { headers: h.headers(h.hearth.token) },
    );
    expect(canonical.status).toBe(200);
    expect((await canonical.json()).data.intent).toEqual(receipt.shift?.intent);
    expect(
      (
        await post(h, path, {
          ...body,
          start: {
            ...body.start,
            options: { ...body.start.options, maxBeads: 8 },
          },
        })
      ).status,
    ).toBe(409);
    expect(launched).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("audit refusal and malformed review produce no Keeper original or canonical Shift effect", async () => {
  const { h, launched } = await openShiftHearth(() => ({
    ok: false,
    error: "fixture audit unavailable",
  }));
  try {
    const proposal = (await seedKeeperShiftStartSource(h))[0];
    if (!proposal) throw new Error("Missing Keeper Shift proposal fixture");
    const path = url(h, proposal.id),
      body = keeperShiftStartFixture(proposal.sourceHash);
    expect((await post(h, path, { ...body, auditEventId: 42 })).status).toBe(
      400,
    );
    expect((await post(h, path, body)).status).toBe(503);
    expect(launched).toEqual([]);
    expect(h.events(["operator.action"])).toEqual([]);
    expect(existsSync(keeperProposalFile(h.home, FIXTURE_PROJECT_ID))).toBe(
      false,
    );
  } finally {
    await h.close();
  }
});

test("archived Keeper Shift history remains inspectable while a new proposal Start is refused", async () => {
  const { h, launched } = await openShiftHearth();
  try {
    const proposals = await seedKeeperShiftStartSource(h, [
      keeperShiftDraft("First Shift"),
      keeperShiftDraft("Second Shift"),
    ]);
    const [first, second] = proposals;
    if (!first || !second) throw new Error("Missing two Shift proposals");
    const original = keeperShiftStartFixture(first.sourceHash),
      started = await post(h, url(h, first.id), original);
    expect(started.status).toBe(200);
    const before = keeperShiftStartReceiptSchema.parse(
      (await started.json()).data,
    );

    const catalog = projectCatalogFixture(h.workspace);
    if (catalog.projects[0]) catalog.projects[0].archived = true;
    writeOwnerOnly(projectCatalogPath(h.home), JSON.stringify(catalog));
    const history = await fetch(
      `${url(h, first.id)}/${original.start.requestId}`,
      { headers: h.headers(h.hearth.token) },
    );
    expect(history.status).toBe(200);
    expect(
      keeperShiftStartReceiptSchema.parse((await history.json()).data),
    ).toMatchObject({
      original,
      record: { id: before.record.id },
    });
    const newReview = keeperShiftStartFixture(
      second.sourceHash,
      "37c8aa56-1db1-4722-8fd2-1dbef8326003",
      1,
    );
    expect((await post(h, url(h, second.id), newReview)).status).toBe(409);
    expect(launched).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test.each([
  "removed",
  "retargeted",
] as const)("Keeper Shift original GET returns no private body after project scope is %s", async (change) => {
  const { h, launched } = await openShiftHearth();
  try {
    const proposal = (await seedKeeperShiftStartSource(h))[0];
    if (!proposal) throw new Error("Missing Keeper Shift proposal fixture");
    const body = keeperShiftStartFixture(proposal.sourceHash),
      started = await post(h, url(h, proposal.id), body);
    expect(started.status).toBe(200);

    const catalog = projectCatalogFixture(h.workspace);
    if (change === "removed") catalog.projects = [];
    else if (catalog.projects[0])
      catalog.projects[0].workspaces[0]!.root = join(h.workspace, "retargeted");
    writeOwnerOnly(projectCatalogPath(h.home), JSON.stringify(catalog));
    const response = await fetch(
      `${url(h, proposal.id)}/${body.start.requestId}`,
      { headers: h.headers(h.hearth.token) },
    );
    expect(response.status).toBe(change === "removed" ? 404 : 409);
    const text = await response.text();
    expect(text).not.toContain(body.sourceHash);
    expect(text).not.toContain(body.start.requestId);
    expect(text).not.toContain("2h");
    expect(launched).toHaveLength(1);
  } finally {
    await h.close();
  }
});
