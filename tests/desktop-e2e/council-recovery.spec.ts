import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  projectCouncilMetadataSchema,
  projectCouncilReceiptSchema,
} from "../../types/project-council";
import {
  type ProjectCouncilRunRead,
  projectCouncilRunReadSchema,
} from "../../types/project-council-run-read";
import { openSettled } from "../e2e/fixtures";
import { HEARTH_HOME } from "../e2e/servers";
import { seedCouncilProject } from "./council-fixtures";
import { alpha as alphaTemplate } from "./project-fixtures";

const controlFile = join(HEARTH_HOME, "council-fixture-control.json");
const callsFile = join(HEARTH_HOME, "council-fixture-calls.jsonl");
let alpha = alphaTemplate;
let reviewsPath = `/__agent-forge/projects/${alpha.id}/council/reviews`;

type Mode = "success" | "hold" | "fail";
type CaseId =
  | "council-cancel"
  | "council-deep-discussion"
  | "council-failure"
  | "council-unknown"
  | "idle";
type CouncilCall =
  | { kind: "admission"; caseId: CaseId; mode: Mode; profileId: string }
  | {
      kind: "request";
      caseId: CaseId;
      mode: Mode;
      runId: string;
      stage: string;
      seatId: string;
    };
type CouncilPost = { path: string; body: unknown };
type ExpectedReceipt = {
  requestId: string;
  intentHash: string;
  runId: string;
  projectId: string;
};

declare global {
  interface Window {
    __councilLostCommit?: { status: number; body: unknown };
    __councilLostCommitFailure?: boolean;
    __validateCouncilCommitReceipt?: (
      status: number,
      body: unknown,
    ) => Promise<boolean>;
    __restoreCouncilFetch?: () => void;
  }
}

function selectMode(mode: Mode, caseId: CaseId): void {
  writeFileSync(controlFile, JSON.stringify({ mode, caseId }));
}

function calls(): CouncilCall[] {
  if (!existsSync(callsFile)) return [];
  return readFileSync(callsFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw Error("Council fixture call marker was invalid JSON.");
      }
      if (
        typeof value !== "object" ||
        value === null ||
        !("kind" in value) ||
        !("mode" in value) ||
        (value.mode !== "success" &&
          value.mode !== "hold" &&
          value.mode !== "fail") ||
        !("caseId" in value) ||
        (value.caseId !== "council-cancel" &&
          value.caseId !== "council-deep-discussion" &&
          value.caseId !== "council-failure" &&
          value.caseId !== "council-unknown" &&
          value.caseId !== "idle")
      )
        throw Error("Council fixture call marker did not match its shape.");
      if (
        value.kind === "admission" &&
        "profileId" in value &&
        typeof value.profileId === "string"
      )
        return {
          kind: "admission",
          caseId: value.caseId,
          mode: value.mode,
          profileId: value.profileId,
        };
      if (
        value.kind === "request" &&
        "runId" in value &&
        typeof value.runId === "string" &&
        "stage" in value &&
        typeof value.stage === "string" &&
        "seatId" in value &&
        typeof value.seatId === "string"
      )
        return {
          kind: "request",
          caseId: value.caseId,
          mode: value.mode,
          runId: value.runId,
          stage: value.stage,
          seatId: value.seatId,
        };
      throw Error("Council fixture call marker did not match its kind.");
    });
}

function callsFor(caseId: CaseId): CouncilCall[] {
  return calls().filter((call) => call.caseId === caseId);
}

function observeCouncilPosts(page: Page): CouncilPost[] {
  const posts: CouncilPost[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "POST" || !path.startsWith(reviewsPath)) return;
    let body: unknown = null;
    try {
      body = request.postDataJSON();
    } catch {
      // An absent or non-JSON body remains visible as null in the witness.
    }
    posts.push({ path, body });
  });
  return posts;
}

function responseData(value: unknown): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    !("ok" in value) ||
    value.ok !== true ||
    !("error" in value) ||
    value.error !== null ||
    !("data" in value)
  )
    throw Error("The actual Council response envelope was not successful.");
  return value.data;
}

type RunReadObservation =
  | { kind: "verified"; read: ProjectCouncilRunRead }
  | { kind: "interrupted"; reason: "aborted" | "body-unavailable" }
  | { kind: "invalid"; message: string };

function observeRunReads(
  page: Page,
  path: string,
): Promise<RunReadObservation>[] {
  const reads: Promise<RunReadObservation>[] = [];
  page.on("response", (response) => {
    if (
      response.request().method() !== "GET" ||
      new URL(response.url()).pathname !== path
    )
      return;
    reads.push(
      (async (): Promise<RunReadObservation> => {
        try {
          const finished = await response.finished();
          if (!response.ok())
            return {
              kind: "invalid",
              message: `Council result read returned HTTP ${response.status()}.`,
            };
          if (response.request().failure()?.errorText === "net::ERR_ABORTED")
            return { kind: "interrupted", reason: "aborted" };
          if (finished) return { kind: "invalid", message: finished.message };
          try {
            const raw = await response.json();
            return {
              kind: "verified",
              read: projectCouncilRunReadSchema.parse(responseData(raw)),
            };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (
              /^(?:response\.json: )?Protocol error \(Network\.getResponseBody\): No data found for (?:the )?resource with given identifier(?:\nResponse body is not available for a response that was navigated away from\. Read response\.body\(\) before triggering any navigation\.)?$/.test(
                message,
              )
            )
              return { kind: "interrupted", reason: "body-unavailable" };
            return { kind: "invalid", message };
          }
        } catch (error) {
          if (
            response.ok() &&
            response.request().failure()?.errorText === "net::ERR_ABORTED"
          )
            return { kind: "interrupted", reason: "aborted" };
          return {
            kind: "invalid",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      })(),
    );
  });
  return reads;
}

async function verifiedRunReads(
  observations: readonly Promise<RunReadObservation>[],
): Promise<ProjectCouncilRunRead[]> {
  const results = await Promise.all(observations);
  const invalid = results.find((result) => result.kind === "invalid");
  if (invalid?.kind === "invalid")
    throw Error(
      `The actual Council result read was invalid: ${invalid.message}`,
    );
  return results.flatMap((result) =>
    result.kind === "verified" ? [result.read] : [],
  );
}

async function prepareReview(page: Page, deepDiscussion = false) {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/overview`);
  await page.getByRole("link", { name: "Reviews", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/desktop/project/${alpha.id}/reviews$`),
  );
  await page.getByRole("button", { name: "New review", exact: true }).click();
  await page
    .getByLabel("Document or question")
    .fill("A real browser Council recovery witness.");
  const budget = page.getByLabel("Maximum estimated cost (USD)");
  const budgetBefore = await budget.inputValue();
  if (deepDiscussion) {
    await page
      .getByLabel("Allow deep discussion when supported by this profile")
      .check();
    expect(await budget.inputValue()).toBe(budgetBefore);
  }
  const reservedResponse = page.waitForResponse((response) => {
    const request = response.request();
    return (
      request.method() === "POST" &&
      new URL(response.url()).pathname === reviewsPath
    );
  });
  await page
    .getByRole("button", { name: "Prepare original for review" })
    .click();
  const response = await reservedResponse;
  expect(response.status()).toBe(202);
  const raw = await response.json();
  const data = responseData(raw);
  if (typeof data !== "object" || data === null || !("metadata" in data))
    throw Error("The actual Council reservation omitted metadata.");
  const metadata = projectCouncilMetadataSchema.parse(data.metadata);
  if (deepDiscussion) expect(metadata.maxUsd).toBe(Number(budgetBefore));
  await expect(
    page.getByRole("heading", { name: "Exact saved original" }),
  ).toBeVisible();
  return metadata;
}

test.beforeEach(async () => {
  alpha = await seedCouncilProject();
  reviewsPath = `/__agent-forge/projects/${alpha.id}/council/reviews`;
});
test.afterEach(() => selectMode("success", "idle"));

test("actual Stop cancels the held Council transport and keeps the same original", async ({
  page,
}) => {
  selectMode("hold", "council-cancel");
  const posts = observeCouncilPosts(page);
  const original = await prepareReview(page);
  const runReads = observeRunReads(
    page,
    `${reviewsPath}/${original.requestId}/run`,
  );
  await page
    .getByRole("button", { name: "Convene this exact original" })
    .click();
  await expect(
    page.getByRole("button", { name: "Stop review", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() =>
      callsFor("council-cancel").some((call) => call.kind === "request"),
    )
    .toBe(true);

  await page.getByRole("button", { name: "Stop review", exact: true }).click();
  await expect(page.getByText("Verified state: cancelled")).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByRole("region", { name: "Council recommendation" }),
  ).toHaveCount(0);
  const runRead = (await verifiedRunReads(runReads)).find(
    (read) => read.receipt.phase === "cancelled",
  );
  if (!runRead) throw Error("The cancelled Council result was not read back.");
  expect(runRead.provenance).toMatchObject({
    requestId: original.requestId,
    intentHash: original.intentHash,
    runId: original.runId,
    projectId: alpha.id,
  });
  expect(runRead.job?.run?.chair).toBeUndefined();
  expect(posts.filter((post) => post.path.endsWith("/commit"))).toEqual([
    {
      path: `${reviewsPath}/${original.requestId}/commit`,
      body: { intentHash: original.intentHash },
    },
  ]);
  expect(posts.filter((post) => post.path.endsWith("/cancel"))).toEqual([
    {
      path: `${reviewsPath}/${original.requestId}/cancel`,
      body: { intentHash: original.intentHash },
    },
  ]);
  expect(
    callsFor("council-cancel").filter((call) => call.kind === "admission"),
  ).toEqual([
    {
      kind: "admission",
      caseId: "council-cancel",
      mode: "hold",
      profileId: original.profileId,
    },
  ]);
});

test("actual deep discussion exposes peer round zero before Stop cancels its held revision", async ({
  page,
}) => {
  selectMode("hold", "council-deep-discussion");
  const posts = observeCouncilPosts(page);
  const original = await prepareReview(page, true);
  const runReads = observeRunReads(
    page,
    `${reviewsPath}/${original.requestId}/run`,
  );
  await page
    .getByRole("button", { name: "Convene this exact original" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Verified state: running" }),
  ).toContainText("Discussing round 1", { timeout: 15_000 });

  let liveRead: ProjectCouncilRunRead | undefined;
  await expect
    .poll(async () => {
      liveRead = (await verifiedRunReads(runReads))
        .reverse()
        .find(
          (read) =>
            read.receipt.phase === "running" &&
            read.job?.events.some(
              (e) =>
                e.type === "stage.started" &&
                e.payload.stage === "revision" &&
                e.payload.round === 1,
            ) &&
            read.job?.discussion?.some(
              (r) => r.stage === "peer" && r.round === 0,
            ),
        );
      return liveRead !== undefined;
    })
    .toBe(true);
  if (!liveRead?.job?.profile)
    throw Error("The live deep-discussion profile was not read back.");
  expect(liveRead.receipt.metadata.maxUsd).toBe(original.maxUsd);
  expect(
    [...liveRead.job.profile.seats, liveRead.job.profile.chair].map(
      (s) => s.timeoutMs,
    ),
  ).toEqual([5000, 5000, 5000, 5000, 5000]);
  const peer = liveRead.job.discussion?.find(
    (round) => round.stage === "peer" && round.round === 0,
  );
  expect(peer?.records.map((r) => r.seatId).sort()).toEqual(
    liveRead.job.profile.seats.map((s) => s.id).sort(),
  );
  expect(peer?.records.every((r) => r.status === "completed")).toBe(true);
  const discussion = page.getByRole("region", { name: "Council discussion" });
  const roundPicker = discussion.getByLabel("Round");
  const peerIndex = liveRead.job.discussion?.findIndex(
    (round) => round.stage === "peer" && round.round === 0,
  );
  expect(peerIndex).toBeGreaterThanOrEqual(0);
  await expect(roundPicker).toBeVisible();
  await roundPicker.press("Home");
  for (let index = 0; index < (peerIndex ?? 0); index++)
    await roundPicker.press("ArrowDown");
  await expect(roundPicker).toHaveValue(String(peerIndex));
  await expect(roundPicker.locator("option:checked")).toHaveText("peer 0");
  await expect(
    discussion.getByRole("list").first().getByRole("listitem"),
  ).toHaveCount(peer?.records.length ?? 0);
  const progress = page.getByRole("region", { name: "Council progress" });
  await expect(progress.getByRole("listitem")).toHaveCount(5);
  await expect(
    progress.getByRole("listitem").filter({ hasText: "chair" }),
  ).toContainText("Pending");
  const shotDir = process.env["SHOT_DIR"];
  if (shotDir) {
    mkdirSync(shotDir, { recursive: true });
    await page.screenshot({
      path: join(shotDir, "council-live-discussion.png"),
    });
  }

  await page.getByRole("button", { name: "Stop review", exact: true }).click();
  await expect(page.getByText("Verified state: cancelled")).toBeVisible({
    timeout: 15_000,
  });
  const cancelled = (await verifiedRunReads(runReads)).find(
    (read) => read.receipt.phase === "cancelled",
  );
  if (!cancelled?.job?.run)
    throw Error("The stopped revision did not produce a cancelled result.");
  expect(cancelled.provenance).toMatchObject({
    requestId: original.requestId,
    intentHash: original.intentHash,
    runId: original.runId,
    projectId: alpha.id,
  });
  expect(cancelled.job.run.chair).toBeUndefined();
  const revisions = cancelled.job.run.records.filter(
    (record) => record.stage === "revision",
  );
  expect(revisions).toHaveLength(liveRead.job.profile.seats.length);
  const delayedSeat = liveRead.job.profile.seats[0]!.id;
  expect(revisions.find((r) => r.seatId === delayedSeat)?.status).toBe(
    "cancelled",
  );
  expect(
    revisions
      .filter((r) => r.seatId !== delayedSeat)
      .every((r) => r.status === "completed"),
  ).toBe(true);
  expect(posts.filter((post) => post.path.endsWith("/commit"))).toHaveLength(1);
  expect(posts.filter((post) => post.path.endsWith("/cancel"))).toHaveLength(1);
  const requests = callsFor("council-deep-discussion").filter(
    (call) => call.kind === "request",
  );
  expect(requests.every((call) => call.runId === original.runId)).toBe(true);
  expect(
    requests.filter((c) => c.stage === "revision" && c.seatId === delayedSeat),
  ).toHaveLength(1);
  expect(
    callsFor("council-deep-discussion").filter(
      (call) => call.kind === "admission",
    ),
  ).toEqual([
    {
      kind: "admission",
      caseId: "council-deep-discussion",
      mode: "hold",
      profileId: original.profileId,
    },
  ]);
});

test("actual failed Council run keeps partial seat records and no recommendation", async ({
  page,
}) => {
  selectMode("fail", "council-failure");
  const posts = observeCouncilPosts(page);
  const original = await prepareReview(page);
  const runReads = observeRunReads(
    page,
    `${reviewsPath}/${original.requestId}/run`,
  );
  await page
    .getByRole("button", { name: "Convene this exact original" })
    .click();
  await expect(page.getByText("Verified state: failed")).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByRole("region", { name: "Council recommendation" }),
  ).toHaveCount(0);
  const runRead = (await verifiedRunReads(runReads)).find(
    (read) => read.receipt.phase === "failed",
  );
  if (!runRead) throw Error("The failed Council result was not read back.");
  expect(runRead.provenance).toMatchObject({
    requestId: original.requestId,
    intentHash: original.intentHash,
    runId: original.runId,
    projectId: alpha.id,
  });
  const records = runRead.job?.run?.records ?? [];
  const requests = callsFor("council-failure").filter(
    (call) => call.kind === "request",
  );
  const failedSeat = requests.find(
    (call) => call.stage === "independent",
  )?.seatId;
  const chairSeat = requests.find((call) => call.stage === "chair")?.seatId;
  expect(failedSeat).toBeTruthy();
  expect(chairSeat).toBeTruthy();
  expect(
    records.some(
      (record) =>
        record.stage === "independent" &&
        record.seatId === failedSeat &&
        record.status === "failed",
    ),
  ).toBe(true);
  expect(
    records.some(
      (record) =>
        record.stage === "chair" &&
        record.seatId === chairSeat &&
        record.status === "failed",
    ),
  ).toBe(true);
  expect(
    records.some(
      (record) =>
        record.stage === "independent" &&
        record.seatId !== failedSeat &&
        record.status === "completed",
    ),
  ).toBe(true);
  expect(posts.filter((post) => post.path.endsWith("/commit"))).toHaveLength(1);
  expect(
    callsFor("council-failure").filter((call) => call.kind === "admission"),
  ).toHaveLength(1);
  expect(requests.every((call) => call.runId === original.runId)).toBe(true);
});

test("lost commit delivery stays unknown until the exact saved result is checked", async ({
  page,
}) => {
  selectMode("success", "council-unknown");
  const posts = observeCouncilPosts(page);
  const original = await prepareReview(page);
  const runPath = `${reviewsPath}/${original.requestId}/run`;
  const runReads = observeRunReads(page, runPath);
  const runRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      new URL(request.url()).pathname === runPath
    )
      runRequests.push(runPath);
  });
  const commitPath = `${reviewsPath}/${original.requestId}/commit`;
  const commitUrl = new URL(commitPath, page.url()).href;
  const expectedReceipt: ExpectedReceipt = {
    requestId: original.requestId,
    intentHash: original.intentHash,
    runId: original.runId,
    projectId: alpha.id,
  };
  const receiptValidator = await page.exposeFunction(
    "__validateCouncilCommitReceipt",
    (status: number, body: unknown) => {
      if (status !== 202) return false;
      try {
        const result = projectCouncilReceiptSchema.safeParse(
          responseData(body),
        );
        return (
          result.success &&
          result.data.phase !== "reserved" &&
          result.data.phase !== "retired" &&
          result.data.metadata.requestId === expectedReceipt.requestId &&
          result.data.metadata.intentHash === expectedReceipt.intentHash &&
          result.data.metadata.runId === expectedReceipt.runId &&
          result.data.metadata.projectId === expectedReceipt.projectId
        );
      } catch {
        return false;
      }
    },
  );
  try {
    await page.evaluate(
      ({ commitUrl, expectedIntentHash }) => {
        const originalFetch = window.fetch;
        let claimed = false;
        const readBounded = async (
          response: Response,
          maxBytes: number,
          timeoutMs: number,
        ): Promise<unknown> => {
          const reader = response.body?.getReader();
          if (!reader) throw Error("The actual commit receipt had no body.");
          let timer = 0;
          const read = async (): Promise<unknown> => {
            const decoder = new TextDecoder("utf-8", { fatal: true });
            let text = "";
            let size = 0;
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              size += part.value.byteLength;
              if (size > maxBytes)
                throw Error(
                  "The actual commit receipt exceeded its byte limit.",
                );
              text += decoder.decode(part.value, { stream: true });
            }
            text += decoder.decode();
            const value: unknown = JSON.parse(text);
            return value;
          };
          const timeout = new Promise<never>((_, reject) => {
            timer = window.setTimeout(() => {
              void reader.cancel().catch(() => undefined);
              reject(Error("The actual commit receipt witness timed out."));
            }, timeoutMs);
          });
          try {
            return await Promise.race([read(), timeout]);
          } finally {
            window.clearTimeout(timer);
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }
        };
        const wrapper = Object.assign(async function (
          this: unknown,
          ...args: Parameters<typeof originalFetch>
        ): Promise<Response> {
          const input = args[0];
          const rawUrl = input instanceof Request ? input.url : String(input);
          const method =
            args[1]?.method ??
            (input instanceof Request ? input.method : "GET");
          const url = new URL(rawUrl, window.location.href);
          let bodyMatches = false;
          if (typeof args[1]?.body === "string") {
            try {
              const requestBody: unknown = JSON.parse(args[1].body);
              bodyMatches =
                typeof requestBody === "object" &&
                requestBody !== null &&
                Object.keys(requestBody).length === 1 &&
                "intentHash" in requestBody &&
                requestBody.intentHash === expectedIntentHash;
            } catch {
              bodyMatches = false;
            }
          }
          const isTarget =
            !claimed &&
            method.toUpperCase() === "POST" &&
            url.origin === window.location.origin &&
            url.href === commitUrl &&
            bodyMatches;
          if (!isTarget) return Reflect.apply(originalFetch, this, args);
          claimed = true;
          const response = await Reflect.apply(originalFetch, this, args);
          let receiptDropped = false;
          try {
            const deadline = performance.now() + 5000;
            const body = await readBounded(
              response.clone(),
              512 * 1024,
              Math.max(1, deadline - performance.now()),
            );
            const strictEnvelope =
              typeof body === "object" &&
              body !== null &&
              Object.keys(body).length === 3 &&
              "ok" in body &&
              "data" in body &&
              "error" in body;
            const envelopeMatches =
              response.ok &&
              response.status === 202 &&
              response.url === commitUrl &&
              strictEnvelope &&
              typeof body === "object" &&
              body !== null &&
              "ok" in body &&
              body.ok === true &&
              "error" in body &&
              body.error === null;
            const validate = window.__validateCouncilCommitReceipt;
            let schemaValid = false;
            const remaining = deadline - performance.now();
            if (
              envelopeMatches &&
              typeof validate === "function" &&
              remaining > 0
            ) {
              let validationTimer = 0;
              const callbackTimeout = new Promise<boolean>((resolve) => {
                validationTimer = window.setTimeout(
                  () => resolve(false),
                  remaining,
                );
              });
              schemaValid = await Promise.race([
                validate(response.status, body),
                callbackTimeout,
              ]).finally(() => window.clearTimeout(validationTimer));
            }
            if (!schemaValid) {
              window.__councilLostCommitFailure = true;
              return response;
            }
            window.__councilLostCommit = { status: response.status, body };
            void response.body?.cancel().catch(() => undefined);
            receiptDropped = true;
            throw new TypeError(
              "fixture intentionally lost the actual receipt delivery",
            );
          } catch (error) {
            if (receiptDropped) throw error;
            window.__councilLostCommitFailure = true;
            return response;
          }
        }, originalFetch);
        window.fetch = wrapper;
        window.__restoreCouncilFetch = () => {
          if (window.fetch === wrapper) window.fetch = originalFetch;
          delete window.__restoreCouncilFetch;
        };
      },
      {
        commitUrl,
        expectedIntentHash: expectedReceipt.intentHash,
      },
    );

    const commitResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).href === commitUrl,
    );
    await page
      .getByRole("button", { name: "Convene this exact original" })
      .click();
    await commitResponse;
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            !!window.__councilLostCommit ||
            window.__councilLostCommitFailure === true,
        ),
      )
      .toBe(true);
    const receiptState = await page.evaluate(() => ({
      receipt: window.__councilLostCommit,
      failed: window.__councilLostCommitFailure === true,
    }));
    if (receiptState.failed)
      throw Error(
        "The native commit receipt did not pass its bounded identity witness.",
      );
    if (!receiptState.receipt)
      throw Error(
        "The exact Council commit request did not match the one-shot witness.",
      );
    await expect(
      page.getByText(
        /Check the saved original and result; do not submit Convene again\./,
      ),
    ).toBeVisible({ timeout: 15_000 });
    const witness = await page.evaluate(() => window.__councilLostCommit);
    if (!witness)
      throw Error("The actual commit receipt witness was not captured.");
    expect(witness.status).toBe(202);
    const actualReceipt = projectCouncilReceiptSchema.parse(
      responseData(witness.body),
    );
    expect(actualReceipt.metadata).toMatchObject({
      requestId: original.requestId,
      intentHash: original.intentHash,
      runId: original.runId,
      projectId: alpha.id,
    });
    expect([
      "unknown",
      "running",
      "completed",
      "failed",
      "cancelled",
    ]).toContain(actualReceipt.phase);
    expect(posts.filter((post) => post.path.endsWith("/commit"))).toEqual([
      { path: commitPath, body: { intentHash: original.intentHash } },
    ]);
    expect(runRequests).toHaveLength(0);

    await page.getByRole("button", { name: "Read saved original" }).click();
    await expect(
      page.getByRole("button", { name: "Check saved result" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Check saved result" }).click();
    await expect(page.getByText("Verified state: completed")).toBeVisible({
      timeout: 15_000,
    });
    const savedReads = await verifiedRunReads(runReads);
    expect(savedReads).toHaveLength(1);
    expect(savedReads[0]?.provenance).toMatchObject({
      requestId: original.requestId,
      intentHash: original.intentHash,
      runId: original.runId,
      projectId: alpha.id,
    });
    expect(savedReads[0]?.receipt.phase).toBe("completed");
    expect(runRequests).toEqual([runPath]);
    expect(posts.filter((post) => post.path.endsWith("/commit"))).toHaveLength(
      1,
    );
    expect(
      callsFor("council-unknown").filter((call) => call.kind === "admission"),
    ).toHaveLength(1);
    expect(
      callsFor("council-unknown")
        .filter((call) => call.kind === "request")
        .every((call) => call.runId === actualReceipt.metadata.runId),
    ).toBe(true);
  } finally {
    try {
      await page.evaluate(() => window.__restoreCouncilFetch?.());
    } finally {
      await receiptValidator.dispose();
    }
  }
});
