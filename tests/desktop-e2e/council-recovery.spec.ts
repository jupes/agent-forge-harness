import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  projectCouncilMetadataSchema,
  projectCouncilReceiptSchema,
} from "../../types/project-council";
import {
  projectCouncilRunReadSchema,
  type ProjectCouncilRunRead,
} from "../../types/project-council-run-read";
import { openSettled } from "../e2e/fixtures";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha, seedProjects } from "./project-fixtures";

const controlFile = join(HEARTH_HOME, "council-fixture-control.json");
const callsFile = join(HEARTH_HOME, "council-fixture-calls.jsonl");
const reviewsPath = `/__agent-forge/projects/${alpha.id}/council/reviews`;

type Mode = "success" | "hold" | "fail";
type CaseId = "council-cancel" | "council-failure" | "council-unknown" | "idle";
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

declare global {
  interface Window {
    __councilLostCommit?: { status: number; body: unknown };
    __councilLostCommitFailure?: boolean;
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
          value.mode !== "fail")
        || !("caseId" in value)
        || (value.caseId !== "council-cancel" &&
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

function observeRunReads(page: Page, path: string): Promise<ProjectCouncilRunRead>[] {
  const reads: Promise<ProjectCouncilRunRead>[] = [];
  page.on("response", (response) => {
    if (
      response.request().method() !== "GET" ||
      new URL(response.url()).pathname !== path
    )
      return;
    reads.push(
      response.json().then((raw: unknown) => {
        if (!response.ok()) throw Error("The actual Council result read failed.");
        return projectCouncilRunReadSchema.parse(responseData(raw));
      }),
    );
  });
  return reads;
}

async function prepareReview(page: Page) {
  await openSettled(page, `/index.html#/desktop/project/${alpha.id}/overview`);
  await page.getByRole("link", { name: "Reviews", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/desktop/project/${alpha.id}/reviews$`),
  );
  await page.getByRole("button", { name: "New review", exact: true }).click();
  await page
    .getByLabel("Document or question")
    .fill("A real browser Council recovery witness.");
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
  await expect(
    page.getByRole("heading", { name: "Exact saved original" }),
  ).toBeVisible();
  return metadata;
}

test.beforeEach(seedProjects);
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
    .poll(() => callsFor("council-cancel").some((call) => call.kind === "request"))
    .toBe(true);

  await page.getByRole("button", { name: "Stop review", exact: true }).click();
  await expect(page.getByText("Verified state: cancelled")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("region", { name: "Council recommendation" })).toHaveCount(0);
  const runRead = (await Promise.all(runReads)).find(
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
  expect(callsFor("council-cancel").filter((call) => call.kind === "admission")).toEqual([
    { kind: "admission", caseId: "council-cancel", mode: "hold", profileId: original.profileId },
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
  await expect(page.getByRole("region", { name: "Council recommendation" })).toHaveCount(0);
  const runRead = (await Promise.all(runReads)).find(
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
  const requests = callsFor("council-failure").filter((call) => call.kind === "request");
  const failedSeat = requests.find((call) => call.stage === "independent")?.seatId;
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
  expect(callsFor("council-failure").filter((call) => call.kind === "admission")).toHaveLength(1);
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
    if (request.method() === "GET" && new URL(request.url()).pathname === runPath)
      runRequests.push(runPath);
  });
  const commitPath = `${reviewsPath}/${original.requestId}/commit`;
  const commitUrl = new URL(commitPath, page.url()).href;
  try {
    await page.evaluate(({ commitUrl, requestId, intentHash, runId, projectId }) => {
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
            if (size > maxBytes) throw Error("The actual commit receipt exceeded its byte limit.");
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
      const wrapper: typeof fetch = async function (...args) {
        const input = args[0];
        const rawUrl = input instanceof Request ? input.url : String(input);
        const method = args[1]?.method ?? (input instanceof Request ? input.method : "GET");
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
              requestBody.intentHash === intentHash;
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
          const body = await readBounded(response.clone(), 512 * 1024, 5000);
          const data =
            typeof body === "object" && body !== null && "data" in body
              ? body.data
              : null;
          const metadata =
            typeof data === "object" && data !== null && "metadata" in data
              ? data.metadata
              : null;
          const phase =
            typeof data === "object" && data !== null && "phase" in data
              ? data.phase
              : null;
          const strictEnvelope =
            typeof body === "object" &&
            body !== null &&
            Object.keys(body).length === 3 &&
            "ok" in body &&
            "data" in body &&
            "error" in body;
          const strictReceipt =
            typeof data === "object" &&
            data !== null &&
            (Object.keys(data).length === 2 || Object.keys(data).length === 3) &&
            "metadata" in data &&
            "phase" in data &&
            (Object.keys(data).length === 2 || "error" in data);
          const receiptMatches =
            response.ok &&
            response.status === 202 &&
            response.url === commitUrl &&
            strictEnvelope &&
            typeof body === "object" &&
            body !== null &&
            "ok" in body &&
            body.ok === true &&
            "error" in body &&
            body.error === null &&
            typeof metadata === "object" &&
            metadata !== null &&
            strictReceipt &&
            "requestId" in metadata &&
            metadata.requestId === requestId &&
            "intentHash" in metadata &&
            metadata.intentHash === intentHash &&
            "runId" in metadata &&
            metadata.runId === runId &&
            "projectId" in metadata &&
            metadata.projectId === projectId &&
            (phase === "unknown" ||
              phase === "running" ||
              phase === "completed" ||
              phase === "failed" ||
              phase === "cancelled");
          if (!receiptMatches) {
            window.__councilLostCommitFailure = true;
            return response;
          }
          window.__councilLostCommit = { status: response.status, body };
          void response.body?.cancel().catch(() => undefined);
          receiptDropped = true;
          throw new TypeError("fixture intentionally lost the actual receipt delivery");
        } catch (error) {
          if (receiptDropped) throw error;
          window.__councilLostCommitFailure = true;
          return response;
        }
      };
      window.fetch = wrapper;
      window.__restoreCouncilFetch = () => {
        if (window.fetch === wrapper) window.fetch = originalFetch;
        delete window.__restoreCouncilFetch;
      };
    }, {
      commitUrl,
      requestId: original.requestId,
      intentHash: original.intentHash,
      runId: original.runId,
      projectId: alpha.id,
    });

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
          () => !!window.__councilLostCommit || window.__councilLostCommitFailure === true,
        ),
      )
      .toBe(true);
    const receiptState = await page.evaluate(() => ({
      receipt: window.__councilLostCommit,
      failed: window.__councilLostCommitFailure === true,
    }));
    if (receiptState.failed)
      throw Error("The native commit receipt did not pass its bounded identity witness.");
    if (!receiptState.receipt)
      throw Error("The exact Council commit request did not match the one-shot witness.");
    await expect(
      page.getByText(/Check the saved original and result; do not submit Convene again\./),
    ).toBeVisible({ timeout: 15_000 });
    const witness = await page.evaluate(() => window.__councilLostCommit);
    if (!witness) throw Error("The actual commit receipt witness was not captured.");
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
    expect(["unknown", "running", "completed", "failed", "cancelled"]).toContain(
      actualReceipt.phase,
    );
    expect(posts.filter((post) => post.path.endsWith("/commit"))).toEqual([
      { path: commitPath, body: { intentHash: original.intentHash } },
    ]);
    expect(runRequests).toHaveLength(0);

    await page.getByRole("button", { name: "Read saved original" }).click();
    await expect(page.getByRole("button", { name: "Check saved result" })).toBeVisible();
    await page.getByRole("button", { name: "Check saved result" }).click();
    await expect(page.getByText("Verified state: completed")).toBeVisible({
      timeout: 15_000,
    });
    const savedReads = await Promise.all(runReads);
    expect(savedReads).toHaveLength(1);
    expect(savedReads[0]?.provenance).toMatchObject({
      requestId: original.requestId,
      intentHash: original.intentHash,
      runId: original.runId,
      projectId: alpha.id,
    });
    expect(savedReads[0]?.receipt.phase).toBe("completed");
    expect(runRequests).toEqual([runPath]);
    expect(posts.filter((post) => post.path.endsWith("/commit"))).toHaveLength(1);
    expect(callsFor("council-unknown").filter((call) => call.kind === "admission")).toHaveLength(1);
    expect(
      callsFor("council-unknown")
        .filter((call) => call.kind === "request")
        .every((call) => call.runId === actualReceipt.metadata.runId),
    ).toBe(true);
  } finally {
    await page.evaluate(() => window.__restoreCouncilFetch?.());
  }
});
