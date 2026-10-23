import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { conversationFile } from "../../conversations/paths";
import { createConversationStore } from "../../conversations/store";
import type { PrivateExecInput } from "../../executors/private-capture";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import { ownedCodingPageSchema } from "../../sessions/codex-owned-journal";
import { openShiftAttempt } from "../../shifts/attempt-owner";
import { projectShiftAttemptsPageSchema } from "../../shifts/attempt-read-protocol";
import { createProjectShiftRegistry } from "../../shifts/registry";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
import {
  FIXTURE_SHIFT_ATTEMPT_SESSION_ID,
  FIXTURE_SHIFT_START,
  seedProjectShiftAttempt,
} from "./project-shift-fixture";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});
const base = `/projects/${FIXTURE_PROJECT_ID}/shifts/requests/${FIXTURE_SHIFT_START.requestId}/attempts`;

test("private attempt index, pages and feed are operator-only, inert and fenced to the original shift", async () => {
  const h = await startTestHearth();
  opened.push(h);
  await seedProjectShiftAttempt(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const file = conversationFile(h.home, FIXTURE_PROJECT_ID, {
      kind: "session",
      projectId: FIXTURE_PROJECT_ID,
      sessionId: FIXTURE_SHIFT_ATTEMPT_SESSION_ID,
    }),
    bytes = readFileSync(file, "utf8");
  h.bd.calls.length = 0;
  h.bd.answer = () => ({ status: 1, stdout: "", stderr: "UNAVAILABLE" });
  for (const suffix of [
    "",
    `/${FIXTURE_SHIFT_ATTEMPT_SESSION_ID}`,
    `/${FIXTURE_SHIFT_ATTEMPT_SESSION_ID}/events`,
  ])
    expect(
      (await fetch(`${h.api}${base}${suffix}`, { headers: h.headers() }))
        .status,
    ).toBe(403);
  const index = await fetch(`${h.api}${base}`, {
    headers: h.headers(h.hearth.token),
  });
  expect(index.status).toBe(200);
  const result = await index.json();
  expect(result.ok).toBe(true);
  expect(projectShiftAttemptsPageSchema.parse(result.data).items).toHaveLength(
    1,
  );
  expect(JSON.stringify(result)).not.toContain(
    "Historical private shift attempt",
  );
  const page = await fetch(
    `${h.api}${base}/${FIXTURE_SHIFT_ATTEMPT_SESSION_ID}?limit=1`,
    { headers: h.headers(h.hearth.token) },
  );
  expect(page.status).toBe(200);
  const body = await page.json();
  expect(body.ok).toBe(true);
  expect(ownedCodingPageSchema.parse(body.data)).toMatchObject({
    controllable: false,
    frames: [
      { event: { kind: "user", text: "Historical private shift attempt" } },
    ],
  });
  for (const suffix of [
    "?workspace=/foreign",
    "?after=-1",
    "?after=1&after=2",
    "?limit=101",
    "?requestId=bad",
  ])
    expect(
      (
        await fetch(
          `${h.api}${base}/${FIXTURE_SHIFT_ATTEMPT_SESSION_ID}${suffix}`,
          { headers: h.headers(h.hearth.token) },
        )
      ).status,
    ).toBe(400);
  const wrong = base.replace(
    FIXTURE_SHIFT_START.requestId,
    "83b7e2bd-e478-4973-b0af-155f690d286e",
  );
  expect(
    (
      await fetch(`${h.api}${wrong}/${FIXTURE_SHIFT_ATTEMPT_SESSION_ID}`, {
        headers: h.headers(h.hearth.token),
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await fetch(
        `${h.api}/projects/${FIXTURE_PROJECT_ID}/sessions/${FIXTURE_SHIFT_ATTEMPT_SESSION_ID}`,
        { headers: h.headers(h.hearth.token) },
      )
    ).status,
  ).toBe(409);
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect(h.bd.calls).toEqual([]);
  expect(h.shifts.launches).toEqual([]);
  expect(h.events()).toEqual([]);
});

test("an open private shift feed observes persisted frames without a local changed notification and cannot stop the attempt", async () => {
  const h = await startTestHearth();
  opened.push(h);
  await seedProjectShiftAttempt(h);
  const intent = createProjectShiftRegistry({
    home: h.home,
    root: h.root,
  }).read(FIXTURE_PROJECT_ID, FIXTURE_SHIFT_START.requestId);
  const input: PrivateExecInput = {
    provider: "claude",
    beadId: "alpha-work",
    runId: "another-owned-run",
    workspace: h.workspace,
    cwd: h.workspace,
    smith: {
      name: "claude-journeyman",
      provider: "claude",
      model: "exact-model",
      effort: "medium",
      enabled: true,
      tags: [],
    },
    command: ["/fixture/claude", "-p"],
    stdin: "Private original active input",
    timeoutMs: 1000,
  };
  const active = await openShiftAttempt({
    home: h.home,
    intent,
    input,
    attempt: 1,
    signal: new AbortController().signal,
    prepare: async () => ({ version: "2.1.296" }),
    validate: async () => {},
  });
  const response = await fetch(`${h.api}${base}/${active.record.id}/events`, {
    headers: h.headers(h.hearth.token),
    signal: AbortSignal.timeout(8000),
  });
  const stream = response.body?.getReader();
  if (!stream) throw Error("No private feed");
  try {
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await stream.read();
    await active.owner.append({
      kind: "text",
      text: "Private cross-process observed frame",
    });
    let seen = "";
    while (!seen.includes("Private cross-process observed frame")) {
      const next = await stream.read();
      if (next.done) throw Error("Private feed ended before observation");
      seen += new TextDecoder().decode(next.value);
    }
    expect(seen).toContain('"controllable":false');
    const before = createConversationStore(
      h.home,
      undefined,
      active.address,
    ).read(FIXTURE_PROJECT_ID);
    const stopped = await fetch(
      `${h.api}/projects/${FIXTURE_PROJECT_ID}/sessions/${active.record.id}/stop`,
      {
        method: "POST",
        headers: {
          ...h.headers(h.hearth.token),
          "content-type": "application/json",
        },
        body: JSON.stringify({ requestId: active.record.requestId }),
      },
    );
    expect(stopped.status).toBe(409);
    expect(
      createConversationStore(h.home, undefined, active.address).read(
        FIXTURE_PROJECT_ID,
      ),
    ).toEqual(before);
    expect(h.shifts.launches).toEqual([]);
  } finally {
    await stream.cancel();
    await active.owner.finish({
      phase: "failed",
      reason: "No provider was dispatched.",
    });
  }
}, 12000);
