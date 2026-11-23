import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type {
  KeeperContinuationRecord,
  KeeperRecoveryPage,
} from "../../../types/keeper-recovery";
import { createConversationStore } from "../../conversations/store";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";

const open: TestHearth[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});
test("protected readiness and audited continuation preserve history, reject malformed intent, and reconcile without another change", async () => {
  const h = await startTestHearth();
  open.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const path = `${h.api}/projects/${FIXTURE_PROJECT_ID}/keeper`;
  expect((await fetch(path + "/recovery")).status).toBe(403);
  expect(
    (
      await fetch(path + "/recovery?unknown=1", {
        headers: h.headers(h.hearth.token),
      })
    ).status,
  ).toBe(400);
  const report = (await fetch(path + "/recovery", {
    headers: h.headers(h.hearth.token),
  }).then((r) => r.json())) as { ok: boolean; data: KeeperRecoveryPage };
  expect(report.ok).toBe(true);
  expect(
    report.data.choices.find((row) => row.smith.provider === "codex")?.readiness
      .connection,
  ).toBe("adapter-missing");
  expect(
    report.data.choices.find((row) => row.smith.name === "claude-journeyman")
      ?.readiness.allowance,
  ).toBe("unreported");
  const body = {
    requestId: randomUUID(),
    expectedRevision: 0,
    mode: "switch",
    smith: "claude-master",
    summary: "Private reviewed summary",
  };
  const post = (value: unknown) =>
    fetch(path + "/continuations", {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify(value),
    });
  expect((await post({ ...body, provider: "codex" })).status).toBe(400);
  const changed = await post(body);
  expect(changed.status).toBe(200);
  const saved = (await changed.json()) as {
    ok: boolean;
    data: KeeperContinuationRecord;
  };
  expect(saved.ok).toBe(true);
  const before = createConversationStore(h.home).read(FIXTURE_PROJECT_ID);
  expect((await post(body)).status).toBe(200);
  expect(createConversationStore(h.home).read(FIXTURE_PROJECT_ID)).toEqual(
    before,
  );
  const found = (await fetch(path + "/recovery?requestId=" + body.requestId, {
    headers: h.headers(h.hearth.token),
  }).then((r) => r.json())) as { ok: boolean; data: KeeperRecoveryPage };
  expect(found.ok).toBe(true);
  expect(found.data.request).toEqual(saved.data);
  const events = await fetch(h.api + "/events", {
    headers: h.headers(h.hearth.token),
  }).then((r) => r.json());
  expect(JSON.stringify(events)).not.toContain(body.summary);
  expect(JSON.stringify(events)).toContain("keeper.continue");
});
