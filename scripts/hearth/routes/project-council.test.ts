import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  projectCouncilHistorySchema,
  projectCouncilIntentJson,
  projectCouncilOriginalReadSchema,
  projectCouncilReceiptSchema,
  projectCouncilReserveRequestSchema,
} from "../../../types/project-council";
import { projectCouncilRunReadSchema } from "../../../types/project-council-run-read";
import { councilOutcome } from "../../council/ledger-events";
import { workspaceKey } from "../../projects/scope";
import { createProjectStore, projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";

const opened: TestHearth[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  for (const hearth of opened.splice(0)) await hearth.close();
});

test("project Council reads catalog authority after the awaited tracker snapshot", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const originalCatalog = projectCatalogFixture(h.workspace);
  writeOwnerOnly(projectCatalogPath(h.home), JSON.stringify(originalCatalog));
  const entered = deferred<void>();
  const release = deferred<void>();
  h.bd.answer = (args) => {
    if (args[0] !== "export") return undefined;
    entered.resolve();
    return release.promise.then(() => ({ status: 0, stdout: "", stderr: "" }));
  };
  const responsePromise = fetch(
    `${h.api}/projects/${FIXTURE_PROJECT_ID}/council/reviews`,
    {
      headers: h.headers(h.hearth.token),
    },
  );
  await entered.promise;
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify({
      ...originalCatalog,
      revision: originalCatalog.revision + 1,
      projects: [],
    }),
  );
  release.resolve();
  const response = await responsePromise;
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ ok: false });
});

test("a project Council review reserves against the current project and advertised inert profile without starting a run", async () => {
  const h = await startTestHearth();
  opened.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );

  const profileResponse = await fetch(`${h.api}/council-api/profiles`);
  expect(profileResponse.status).toBe(200);
  const envelope: unknown = await profileResponse.json();
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    Array.isArray(envelope) ||
    Object.keys(envelope).length !== 3 ||
    !("ok" in envelope) ||
    envelope.ok !== true ||
    !("error" in envelope) ||
    envelope.error !== null ||
    !("data" in envelope) ||
    !Array.isArray(envelope.data)
  )
    throw new Error("The advertised Council profile response is invalid.");
  const rawProfiles = envelope.data;
  if (
    !Array.isArray(rawProfiles) ||
    rawProfiles.length === 0 ||
    rawProfiles.length > 128
  )
    throw new Error("The advertised Council profile list is invalid.");
  const profile = rawProfiles.find(
    (choice: unknown): choice is Record<string, unknown> =>
      typeof choice === "object" &&
      choice !== null &&
      !Array.isArray(choice) &&
      "id" in choice &&
      choice.id === "default-review",
  );
  if (!profile) throw new Error("The inert demo Council profile is missing.");
  const profilePath = profile["path"],
    readiness = profile["readiness"],
    seats = profile["seats"],
    chair = profile["chair"];
  if (
    typeof profilePath !== "string" ||
    profilePath.length > 4096 ||
    !isAbsolute(profilePath) ||
    !Array.isArray(readiness) ||
    readiness.length === 0 ||
    readiness.length > 32 ||
    !readiness.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        "configured" in entry &&
        entry.configured === true,
    ) ||
    !Array.isArray(seats) ||
    seats.length === 0 ||
    seats.length > 32 ||
    !seats.every(
      (seat: unknown) =>
        typeof seat === "object" &&
        seat !== null &&
        !Array.isArray(seat) &&
        "provider" in seat &&
        seat.provider === "fake",
    ) ||
    typeof chair !== "object" ||
    chair === null ||
    Array.isArray(chair) ||
    !("provider" in chair) ||
    chair.provider !== "fake"
  )
    throw new Error("The advertised Council profile is not inert and valid.");

  const request = {
    sourceChoice: {
      sourceType: "text",
      source: "A bounded inert project review fixture.",
    },
    profileChoice: profilePath,
    maxUsd: 0.25,
    maxBytes: 1024,
    redactSecrets: false,
    deepDiscussion: false,
  };
  const strictRequest = projectCouncilReserveRequestSchema.safeParse(request);
  if (!strictRequest.success)
    throw new Error("The project Council reserve fixture is not schema-valid.");
  const post = () =>
    fetch(`${h.api}/projects/${FIXTURE_PROJECT_ID}/council/reviews`, {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify(request),
    });
  const response = await post();
  if (response.status !== 202) {
    const diagnostic: unknown = await response.json();
    throw new Error(
      `Project Council reserve returned ${response.status}: ${JSON.stringify(diagnostic)}`,
    );
  }
  expect(response.status).toBe(202);
  const reserved: unknown = await response.json();
  if (
    typeof reserved !== "object" ||
    reserved === null ||
    Array.isArray(reserved) ||
    !("data" in reserved) ||
    typeof reserved.data !== "object" ||
    reserved.data === null ||
    Array.isArray(reserved.data) ||
    !("metadata" in reserved.data) ||
    typeof reserved.data.metadata !== "object" ||
    reserved.data.metadata === null ||
    Array.isArray(reserved.data.metadata) ||
    !("requestId" in reserved.data.metadata) ||
    typeof reserved.data.metadata.requestId !== "string" ||
    !("intentHash" in reserved.data.metadata) ||
    typeof reserved.data.metadata.intentHash !== "string"
  )
    throw new Error(
      "The reserved project Council original is missing its identity.",
    );
  const metadata = reserved.data.metadata;
  expect(reserved.data).toMatchObject({ created: true });
  expect(JSON.stringify(reserved.data)).not.toContain(
    request.sourceChoice.source,
  );

  const retry = await post();
  expect(retry.status).toBe(202);
  expect(await retry.json()).toMatchObject({
    data: {
      created: false,
      metadata: {
        requestId: metadata.requestId,
        intentHash: metadata.intentHash,
      },
    },
  });

  const historyResponse = await fetch(
    `${h.api}/projects/${FIXTURE_PROJECT_ID}/council/reviews`,
    {
      headers: h.headers(h.hearth.token),
    },
  );
  expect(historyResponse.status).toBe(200);
  const historyEnvelope: unknown = await historyResponse.json();
  if (
    typeof historyEnvelope !== "object" ||
    historyEnvelope === null ||
    Array.isArray(historyEnvelope) ||
    !("data" in historyEnvelope)
  )
    throw new Error("The project Council history has no data.");
  const history = projectCouncilHistorySchema.safeParse(historyEnvelope.data);
  if (!history.success)
    throw new Error("The project Council history is not strict.");
  expect(history.data).toMatchObject({
    version: 1,
    projectId: FIXTURE_PROJECT_ID,
    workspace: h.workspace,
    activeRequestId: metadata.requestId,
    total: 1,
    omitted: 0,
    items: [{ requestId: metadata.requestId, phase: "reserved" }],
  });
  expect(JSON.stringify(history.data)).not.toContain(
    request.sourceChoice.source,
  );

  const exactResponse = await fetch(
    `${h.api}/projects/${FIXTURE_PROJECT_ID}/council/reviews/${metadata.requestId}`,
    { headers: h.headers(h.hearth.token) },
  );
  expect(exactResponse.status).toBe(200);
  const exactEnvelope: unknown = await exactResponse.json();
  if (
    typeof exactEnvelope !== "object" ||
    exactEnvelope === null ||
    Array.isArray(exactEnvelope) ||
    !("data" in exactEnvelope)
  )
    throw new Error("The protected original response has no data.");
  const exactRead = projectCouncilOriginalReadSchema.safeParse(
    exactEnvelope.data,
  );
  if (!exactRead.success)
    throw new Error("The protected Council original is not strict.");
  expect(exactRead.data.metadata).toMatchObject({
    requestId: metadata.requestId,
    state: "reserved",
  });
  expect(exactRead.data.original.context.evidence[0]?.content).toBe(
    request.sourceChoice.source,
  );
  expect(exactRead.data.original.profile.depth).toBe("balanced");
  expect("maxDiscussionRounds" in exactRead.data.original.profile).toBe(false);
  expect(exactRead.data.original.options.deepDiscussion).toBe(false);
  expect(
    createHash("sha256")
      .update(projectCouncilIntentJson(exactRead.data.original), "utf8")
      .digest("hex"),
  ).toBe(exactRead.data.original.intentHash);
  const runResponse = await fetch(
    `${h.api}/projects/${FIXTURE_PROJECT_ID}/council/reviews/${metadata.requestId}/run`,
    { headers: h.headers(h.hearth.token) },
  );
  expect(runResponse.status).toBe(200);
  expect(await runResponse.json()).toMatchObject({
    data: { version: 1, receipt: { phase: "reserved" }, job: null },
  });
  expect(h.commands.calls).toEqual([]);
  expect(existsSync(join(h.root, "council-runs"))).toBe(false);
  expect(h.events(["council.run.started", "council.run.finished"])).toEqual([]);
});

test("project Council reserves the selected deep-discussion profile explicitly", async () => {
  const h = await startTestHearth();
  opened.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const response = await fetch(`${h.api}/council-api/profiles`);
  const envelope: unknown = await response.json();
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    Array.isArray(envelope) ||
    !("data" in envelope) ||
    !Array.isArray(envelope.data)
  )
    throw new Error("The advertised Council profiles are invalid.");
  const profile = envelope.data.find(
    (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      "id" in value &&
      value.id === "default-review" &&
      "path" in value &&
      typeof value.path === "string" &&
      "seats" in value &&
      Array.isArray(value.seats) &&
      value.seats.every(
        (seat: unknown) =>
          typeof seat === "object" &&
          seat !== null &&
          !Array.isArray(seat) &&
          "provider" in seat &&
          seat.provider === "fake",
      ) &&
      "chair" in value &&
      typeof value.chair === "object" &&
      value.chair !== null &&
      !Array.isArray(value.chair) &&
      "provider" in value.chair &&
      value.chair.provider === "fake",
  );
  if (!profile || typeof profile.path !== "string")
    throw new Error("The inert Council profile is missing.");
  const request = {
    sourceChoice: {
      sourceType: "text",
      source: "Explicit deep discussion fixture.",
    },
    profileChoice: profile.path,
    maxUsd: 0.25,
    maxBytes: 1024,
    redactSecrets: false,
    deepDiscussion: true,
  };
  const reserve = await fetch(
    `${h.api}/projects/${FIXTURE_PROJECT_ID}/council/reviews`,
    {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify(request),
    },
  );
  expect(reserve.status).toBe(202);
  const body: unknown = await reserve.json();
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    !("data" in body) ||
    typeof body.data !== "object" ||
    body.data === null ||
    Array.isArray(body.data) ||
    !("metadata" in body.data) ||
    typeof body.data.metadata !== "object" ||
    body.data.metadata === null ||
    Array.isArray(body.data.metadata) ||
    !("requestId" in body.data.metadata) ||
    typeof body.data.metadata.requestId !== "string"
  )
    throw new Error("The deep-discussion original is missing its identity.");
  const exact = await fetch(
    `${h.api}/projects/${FIXTURE_PROJECT_ID}/council/reviews/${body.data.metadata.requestId}`,
    {
      headers: h.headers(h.hearth.token),
    },
  );
  expect(exact.status).toBe(200);
  const exactEnvelope: unknown = await exact.json();
  if (
    typeof exactEnvelope !== "object" ||
    exactEnvelope === null ||
    Array.isArray(exactEnvelope) ||
    !("data" in exactEnvelope)
  )
    throw new Error("The protected original response has no data.");
  const parsed = projectCouncilOriginalReadSchema.safeParse(exactEnvelope.data);
  if (!parsed.success)
    throw new Error("The deep-discussion original is invalid.");
  expect(parsed.data.original.options.deepDiscussion).toBe(true);
  expect(parsed.data.original.profile).toMatchObject({
    depth: "deep",
    maxDiscussionRounds: 1,
  });
  expect(h.commands.calls).toEqual([]);
});

test("a completed project Council Bead review posts its verdict once and replays without another comment", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const beadId = "demo-task";
  h.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stderr: "",
          stdout:
            [
              {
                id: "alpha-epic",
                title: "Alpha epic",
                issue_type: "epic",
                status: "open",
                priority: 1,
                labels: ["project:alpha"],
                dependencies: [],
              },
              {
                id: beadId,
                title: "Teach the kiln to report its temperature",
                issue_type: "task",
                status: "in_progress",
                priority: 2,
                labels: ["project:alpha"],
                dependencies: [
                  {
                    issue_id: beadId,
                    depends_on_id: "alpha-epic",
                    type: "parent-child",
                  },
                ],
              },
            ]
              .map((issue) => JSON.stringify(issue))
              .join("\n") + "\n",
        }
      : undefined;
  h.commands.answer = async (command) => {
    const [bd, readonly, verb, id] = command;
    if (bd !== "bd" || readonly !== "--readonly" || id !== beadId)
      return { exitCode: 2, stdout: "", stderr: "not arranged" };
    if (verb === "show")
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            id: beadId,
            title: "Teach the kiln to report its temperature",
            acceptance_criteria: "[ ] The reading is in Celsius.",
            status: "in_progress",
            priority: 2,
            issue_type: "task",
          },
        ]),
        stderr: "",
      };
    if (verb === "comments") return { exitCode: 0, stdout: "[]", stderr: "" };
    return { exitCode: 2, stdout: "", stderr: "not arranged" };
  };
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const profileResponse = await fetch(`${h.api}/council-api/profiles`);
  expect(profileResponse.status).toBe(200);
  const profileEnvelope: unknown = await profileResponse.json();
  if (
    typeof profileEnvelope !== "object" ||
    profileEnvelope === null ||
    Array.isArray(profileEnvelope) ||
    !("data" in profileEnvelope) ||
    !Array.isArray(profileEnvelope.data)
  )
    throw new Error("The advertised Council profiles are invalid.");
  const profileChoice = profileEnvelope.data.find(
    (choice: unknown): choice is Record<string, unknown> =>
      typeof choice === "object" &&
      choice !== null &&
      !Array.isArray(choice) &&
      "id" in choice &&
      choice.id === "default-review" &&
      "path" in choice &&
      typeof choice.path === "string" &&
      "seats" in choice &&
      Array.isArray(choice.seats) &&
      choice.seats.length > 0 &&
      choice.seats.every(
        (seat: unknown) =>
          typeof seat === "object" &&
          seat !== null &&
          !Array.isArray(seat) &&
          "provider" in seat &&
          seat.provider === "fake",
      ) &&
      "chair" in choice &&
      typeof choice.chair === "object" &&
      choice.chair !== null &&
      !Array.isArray(choice.chair) &&
      "provider" in choice.chair &&
      choice.chair.provider === "fake",
  );
  if (!profileChoice || typeof profileChoice.path !== "string")
    throw new Error("The advertised inert Council profile is missing.");

  const source = beadId;
  const request = {
    sourceChoice: { sourceType: "bead", source },
    profileChoice: profileChoice.path,
    maxUsd: 0.25,
    maxBytes: 1024,
    redactSecrets: false,
    deepDiscussion: false,
  };
  if (!projectCouncilReserveRequestSchema.safeParse(request).success)
    throw new Error("The positive reserve fixture is not schema-valid.");
  const reserveResponse = await fetch(
    `${h.api}/projects/${FIXTURE_PROJECT_ID}/council/reviews`,
    {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify(request),
    },
  );
  if (reserveResponse.status !== 202)
    throw new Error(
      `The inert Council review did not reserve: ${reserveResponse.status} ${JSON.stringify(await reserveResponse.json())}`,
    );
  const reserveEnvelope: unknown = await reserveResponse.json();
  if (
    typeof reserveEnvelope !== "object" ||
    reserveEnvelope === null ||
    Array.isArray(reserveEnvelope) ||
    !("data" in reserveEnvelope) ||
    typeof reserveEnvelope.data !== "object" ||
    reserveEnvelope.data === null ||
    Array.isArray(reserveEnvelope.data) ||
    !("metadata" in reserveEnvelope.data) ||
    typeof reserveEnvelope.data.metadata !== "object" ||
    reserveEnvelope.data.metadata === null ||
    Array.isArray(reserveEnvelope.data.metadata) ||
    !("requestId" in reserveEnvelope.data.metadata) ||
    typeof reserveEnvelope.data.metadata.requestId !== "string" ||
    !("intentHash" in reserveEnvelope.data.metadata) ||
    typeof reserveEnvelope.data.metadata.intentHash !== "string"
  )
    throw new Error("The positive reserve response has no strict identity.");
  const { requestId, intentHash } = reserveEnvelope.data.metadata;

  const exactResponse = await fetch(
    `${h.api}/projects/${FIXTURE_PROJECT_ID}/council/reviews/${requestId}`,
    { headers: h.headers(h.hearth.token) },
  );
  expect(exactResponse.status).toBe(200);
  const exactEnvelope: unknown = await exactResponse.json();
  if (
    typeof exactEnvelope !== "object" ||
    exactEnvelope === null ||
    Array.isArray(exactEnvelope) ||
    !("data" in exactEnvelope)
  )
    throw new Error("The protected original response has no data.");
  const originalRead = projectCouncilOriginalReadSchema.safeParse(
    exactEnvelope.data,
  );
  if (!originalRead.success)
    throw new Error("The protected original failed strict validation.");
  const original = originalRead.data.original;
  expect(original.context.source).toMatchObject({
    kind: "bead",
    locator: beadId,
  });
  expect(original.context.evidence[0]?.content).toContain(
    "Teach the kiln to report its temperature",
  );
  expect(
    createHash("sha256")
      .update(projectCouncilIntentJson(original), "utf8")
      .digest("hex"),
  ).toBe(intentHash);

  const commitPath = `${h.api}/projects/${FIXTURE_PROJECT_ID}/council/reviews/${requestId}/commit`;
  const commit = await fetch(commitPath, {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: JSON.stringify({ intentHash }),
  });
  if (commit.status !== 202)
    throw new Error(
      `The inert Council review did not commit: ${commit.status} ${JSON.stringify(await commit.json())}`,
    );
  const commitEnvelope: unknown = await commit.json();
  if (
    typeof commitEnvelope !== "object" ||
    commitEnvelope === null ||
    Array.isArray(commitEnvelope) ||
    !("data" in commitEnvelope)
  )
    throw new Error("The Council commit response has no receipt.");
  const initialReceipt = projectCouncilReceiptSchema.safeParse(
    commitEnvelope.data,
  );
  if (!initialReceipt.success)
    throw new Error("The Council commit receipt is not strict.");
  expect(initialReceipt.data.metadata).toMatchObject({ requestId, intentHash });

  const readRun = async () => {
    const response = await fetch(
      `${h.api}/projects/${FIXTURE_PROJECT_ID}/council/reviews/${requestId}/run`,
      { headers: h.headers(h.hearth.token) },
    );
    if (response.status !== 200)
      throw new Error(
        `The protected Council run read returned ${response.status}.`,
      );
    const envelope: unknown = await response.json();
    if (
      typeof envelope !== "object" ||
      envelope === null ||
      Array.isArray(envelope) ||
      !("data" in envelope)
    )
      throw new Error("The protected Council run response has no data.");
    const parsed = projectCouncilRunReadSchema.safeParse(envelope.data);
    if (!parsed.success)
      throw new Error(
        `The protected Council run is invalid: ${parsed.error.message}`,
      );
    return parsed.data;
  };
  const deadline = Date.now() + 20_000;
  let completed = await readRun();
  while (
    (completed.receipt.phase !== "completed" ||
      completed.job?.run?.status !== "completed") &&
    Date.now() < deadline
  ) {
    await new Promise((done) => setTimeout(done, 25));
    completed = await readRun();
  }
  const completedJob = completed.job;
  if (
    completed.receipt.phase !== "completed" ||
    !completedJob ||
    !completedJob.run ||
    completedJob.run.status !== "completed"
  )
    throw new Error(
      "The inert Council run did not finish before the deadline.",
    );
  const run = completedJob.run;
  expect(completed.provenance).toMatchObject({ requestId, intentHash });
  expect(run.context).toEqual({
    source: original.context.source,
    contentHash: original.context.contentHash,
    byteLength: original.context.byteLength,
    truncated: original.context.truncated,
    redactions: original.context.redactions,
    evidence: original.context.evidence,
  });
  expect(run.profile).toEqual(original.profile);
  expect(
    run.events.filter((event) => event.type === "run.started"),
  ).toHaveLength(1);
  expect(
    run.events.filter((event) => event.type === "run.completed"),
  ).toHaveLength(1);

  const expectedComment = `review: COUNCIL ${run.runId} ${councilOutcome({ status: run.status, aggregatedFindings: run.aggregatedFindings, ...(run.chair === undefined ? {} : { chair: run.chair }) }).toUpperCase()} — findings ${(["blocker", "high", "medium", "low"] as const).map((severity) => run.aggregatedFindings.filter((finding) => finding.severity === severity).length).join("/")} (blocker/high/medium/low)`;
  const verdictDeadline = Date.now() + 20_000;
  let verdict = h
    .events(["council.verdict.comment"])
    .find(
      (event) =>
        event.kind === "council.verdict.comment" &&
        event.beadId === beadId &&
        event.payload.councilRunId === run.runId,
    );
  while (!verdict && Date.now() < verdictDeadline) {
    await new Promise((done) => setTimeout(done, 25));
    verdict = h
      .events(["council.verdict.comment"])
      .find(
        (event) =>
          event.kind === "council.verdict.comment" &&
          event.beadId === beadId &&
          event.payload.councilRunId === run.runId,
      );
  }
  expect(verdict).toMatchObject({
    kind: "council.verdict.comment",
    beadId,
    payload: { councilRunId: run.runId, status: "posted" },
  });
  expect(
    h.bd.calls.filter((call) => call[0] === "comments" && call[1] === "add"),
  ).toEqual([["comments", "add", "--json", "--", beadId, expectedComment]]);

  const replay = await fetch(commitPath, {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: JSON.stringify({ intentHash }),
  });
  expect(replay.status).toBe(202);
  const replayEnvelope: unknown = await replay.json();
  if (
    typeof replayEnvelope !== "object" ||
    replayEnvelope === null ||
    Array.isArray(replayEnvelope) ||
    !("data" in replayEnvelope)
  )
    throw new Error("The replayed Council commit response has no receipt.");
  const replayReceipt = projectCouncilReceiptSchema.safeParse(
    replayEnvelope.data,
  );
  if (!replayReceipt.success || replayReceipt.data.phase !== "completed")
    throw new Error(
      "The replayed Council commit changed its completed receipt.",
    );
  expect(replayReceipt.data.metadata).toMatchObject({ requestId, intentHash });
  expect(
    h.bd.calls.filter((call) => call[0] === "comments" && call[1] === "add"),
  ).toEqual([["comments", "add", "--json", "--", beadId, expectedComment]]);
  expect(h.events(["council.verdict.comment"])).toHaveLength(1);
  const replayedRun = await readRun();
  expect(replayedRun.job?.runId).toBe(completedJob.runId);
  expect(replayedRun.job?.run).toEqual(run);

  const historyResponse = await fetch(
    `${h.api}/projects/${FIXTURE_PROJECT_ID}/council/reviews`,
    { headers: h.headers(h.hearth.token) },
  );
  expect(historyResponse.status).toBe(200);
  const historyEnvelope: unknown = await historyResponse.json();
  if (
    typeof historyEnvelope !== "object" ||
    historyEnvelope === null ||
    Array.isArray(historyEnvelope) ||
    !("data" in historyEnvelope)
  )
    throw new Error("The completed Council history has no data.");
  const history = projectCouncilHistorySchema.safeParse(historyEnvelope.data);
  if (!history.success)
    throw new Error("The completed Council history is not strict.");
  expect(history.data).toMatchObject({
    version: 1,
    projectId: FIXTURE_PROJECT_ID,
    workspace: h.workspace,
  });
  expect(history.data.total).toBe(1);
  expect(history.data.items).toMatchObject([
    { requestId, state: "completed", phase: "completed" },
  ]);
  expect(
    h.commands.calls.map(({ command, cwd }) => ({
      command,
      cwd: workspaceKey(cwd),
    })),
  ).toEqual([
    {
      command: ["bd", "--readonly", "show", beadId, "--json"],
      cwd: h.workspace,
    },
    {
      command: ["bd", "--readonly", "comments", beadId, "--json"],
      cwd: h.workspace,
    },
  ]);
});

test("project Council commit refuses a scope change before dispatch and keeps the reviewed original", async () => {
  const h = await startTestHearth();
  opened.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const profileResponse = await fetch(`${h.api}/council-api/profiles`);
  expect(profileResponse.status).toBe(200);
  const profileEnvelope: unknown = await profileResponse.json();
  if (
    typeof profileEnvelope !== "object" ||
    profileEnvelope === null ||
    Array.isArray(profileEnvelope) ||
    !("data" in profileEnvelope) ||
    !Array.isArray(profileEnvelope.data)
  )
    throw new Error("The advertised Council profile list is invalid.");
  const profile = profileEnvelope.data.find(
    (choice: unknown): choice is Record<string, unknown> =>
      typeof choice === "object" &&
      choice !== null &&
      !Array.isArray(choice) &&
      "id" in choice &&
      choice.id === "default-review" &&
      "path" in choice &&
      typeof choice.path === "string" &&
      "seats" in choice &&
      Array.isArray(choice.seats) &&
      choice.seats.every(
        (seat: unknown) =>
          typeof seat === "object" &&
          seat !== null &&
          !Array.isArray(seat) &&
          "provider" in seat &&
          seat.provider === "fake",
      ) &&
      "chair" in choice &&
      typeof choice.chair === "object" &&
      choice.chair !== null &&
      !Array.isArray(choice.chair) &&
      "provider" in choice.chair &&
      choice.chair.provider === "fake",
  );
  if (!profile || typeof profile.path !== "string")
    throw new Error("The advertised inert demo Council profile is missing.");

  const source = "Scope drift must hold the reviewed project Council original.";
  const reserve = await fetch(
    `${h.api}/projects/${FIXTURE_PROJECT_ID}/council/reviews`,
    {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify({
        sourceChoice: { sourceType: "text", source },
        profileChoice: profile.path,
        maxUsd: 0.25,
        maxBytes: 1024,
        redactSecrets: false,
        deepDiscussion: false,
      }),
    },
  );
  expect(reserve.status).toBe(202);
  const reserved: unknown = await reserve.json();
  if (
    typeof reserved !== "object" ||
    reserved === null ||
    Array.isArray(reserved) ||
    !("data" in reserved) ||
    typeof reserved.data !== "object" ||
    reserved.data === null ||
    Array.isArray(reserved.data) ||
    !("metadata" in reserved.data) ||
    typeof reserved.data.metadata !== "object" ||
    reserved.data.metadata === null ||
    Array.isArray(reserved.data.metadata) ||
    !("requestId" in reserved.data.metadata) ||
    typeof reserved.data.metadata.requestId !== "string" ||
    !("intentHash" in reserved.data.metadata) ||
    typeof reserved.data.metadata.intentHash !== "string"
  )
    throw new Error(
      "The project Council original did not return its identity.",
    );
  const { requestId, intentHash } = reserved.data.metadata;

  const catalog = createProjectStore(h.home).read();
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify({ ...catalog, revision: catalog.revision + 1 }),
  );
  const commit = await fetch(
    `${h.api}/projects/${FIXTURE_PROJECT_ID}/council/reviews/${requestId}/commit`,
    {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify({ intentHash }),
    },
  );
  expect(commit.status).toBe(409);
  expect(await commit.json()).toMatchObject({ ok: false });
  expect(h.commands.calls).toEqual([]);
  expect(h.events(["council.run.started", "council.run.finished"])).toEqual([]);
  expect(existsSync(join(h.root, "council-runs"))).toBe(false);

  const exact = await fetch(
    `${h.api}/projects/${FIXTURE_PROJECT_ID}/council/reviews/${requestId}`,
    { headers: h.headers(h.hearth.token) },
  );
  expect(exact.status).toBe(200);
  const exactEnvelope: unknown = await exact.json();
  if (
    typeof exactEnvelope !== "object" ||
    exactEnvelope === null ||
    Array.isArray(exactEnvelope) ||
    !("data" in exactEnvelope)
  )
    throw new Error("The protected original response has no data.");
  const exactRead = projectCouncilOriginalReadSchema.safeParse(
    exactEnvelope.data,
  );
  if (!exactRead.success)
    throw new Error("The protected Council original is not strict.");
  expect(exactRead.data.metadata).toMatchObject({
    requestId,
    state: "reserved",
  });
  expect(exactRead.data.original.context.evidence[0]?.content).toBe(source);
});
