import { createHash, randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { z } from "zod";
import { OPERATOR_HEADER } from "../../scripts/hearth/paths";
import type { ProjectCheckpointReviewBinding } from "../../types/project-checkpoint-reviews";
import { projectCheckpointSourceContextReadSchema } from "../../types/project-checkpoint-source-context";
import {
  type ProjectCheckpointSourceVersion,
  type ProjectCheckpointSubmissionRecord,
  projectCheckpointSubmissionOriginalJson,
  projectCheckpointSubmissionPublishSchema,
  projectCheckpointSubmissionRecordSchema,
} from "../../types/project-checkpoint-submissions";
import { pageToken } from "../e2e/launch-link";

const successful = z
  .object({ ok: z.literal(true), data: z.unknown(), error: z.null() })
  .strict();
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const reviewHash = (originalHash: string) =>
  digest(
    JSON.stringify({
      family: "checkpoint-source-submission",
      originalHash,
      schemaVersion: 1,
    }),
  );

async function sourceData(
  page: Page,
  path: string,
  body?: string,
): Promise<unknown> {
  const token = await pageToken(page);
  const url = new URL(path, page.url());
  if (url.origin !== new URL(page.url()).origin || url.search || url.hash)
    throw Error(
      "The source fixture request escaped its exact same-origin route.",
    );
  const answer = await page.evaluate(
    async ({ url, token, header, body }) => {
      const controller = new AbortController();
      const deadline = performance.now() + 10_000;
      const ensureComplete = () => {
        if (controller.signal.aborted || performance.now() >= deadline)
          throw Error(
            "The source fixture response missed its completion deadline: " +
              new URL(url).pathname,
          );
      };
      let completed: { status: number; url: string; text: string } | null =
        null;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const timer = window.setTimeout(() => {
        controller.abort();
        if (reader) void reader.cancel().catch(() => undefined);
      }, 10_000);
      try {
        const response = await fetch(url, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            [header]: token,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body }),
          signal: controller.signal,
          redirect: "error",
          credentials: "same-origin",
        });
        ensureComplete();
        reader = response.body?.getReader();
        if (!reader)
          throw Error("The protected source fixture response had no body.");
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let bytes = 0,
          text = "";
        for (;;) {
          const part = await reader.read();
          ensureComplete();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 128 * 1024)
            throw Error("The source fixture response exceeded its byte bound.");
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
        ensureComplete();
        completed = { status: response.status, url: response.url, text };
      } finally {
        try {
          if (reader) {
            try {
              await reader.cancel();
            } catch {
              /* The bounded response may already be closed. */
            }
            reader.releaseLock();
          }
        } finally {
          window.clearTimeout(timer);
        }
      }
      ensureComplete();
      if (!completed)
        throw Error("The source fixture response did not complete.");
      return completed;
    },
    { url: url.href, token, header: OPERATOR_HEADER, body },
  );
  expect(answer.url).toBe(url.href);
  expect(answer.status).toBe(200);
  let raw: unknown;
  try {
    raw = JSON.parse(answer.text);
  } catch {
    throw Error("The protected source fixture response was invalid JSON.");
  }
  return successful.parse(raw).data;
}

export type CheckpointSourceFixtureTarget = Pick<
  ProjectCheckpointReviewBinding,
  | "projectId"
  | "workspacePath"
  | "checkout"
  | "runSlug"
  | "epicId"
  | "beadId"
  | "runUpdatedAt"
  | "catalogRevision"
> & { scopeHash?: string };
export type PublishedCheckpointSource = {
  record: ProjectCheckpointSubmissionRecord;
  reviewScopeHash: string;
};

/** Explicit producer setup, before the exercise's POST observers and effect baselines. */
export async function publishCheckpointSourceFixture(
  page: Page,
  expected: CheckpointSourceFixtureTarget,
): Promise<PublishedCheckpointSource> {
  const prefix =
    "/__agent-forge/projects/" +
    encodeURIComponent(expected.projectId) +
    "/runs/" +
    encodeURIComponent(expected.runSlug) +
    "/checkpoints/" +
    encodeURIComponent(expected.beadId);
  const read = projectCheckpointSourceContextReadSchema.parse(
    await sourceData(page, prefix + "/source-context"),
  );
  if (!read.available)
    throw Error("The fixture cannot publish an unavailable source context.");
  const before = read.context;
  expect(before.baseBinding).toMatchObject(expected);
  expect(before.state).toBe("unbound");
  expect(before.generation).toBe(0);
  const original = projectCheckpointSubmissionPublishSchema.parse({
    schemaVersion: 1,
    kind: "publish",
    requestId: randomUUID(),
    binding: before.baseBinding,
    sourceVersion: before.sourceVersion,
    expectedSubmissionGeneration: before.generation,
  });
  const originalText = projectCheckpointSubmissionOriginalJson(original);
  const originalHash = digest(originalText);
  const reviewScopeHash = reviewHash(originalHash);
  const { record } = z
    .object({
      created: z.literal(true),
      record: projectCheckpointSubmissionRecordSchema,
    })
    .strict()
    .parse(await sourceData(page, prefix + "/source-submissions", originalText));
  expect(projectCheckpointSubmissionOriginalJson(record.original)).toBe(
    originalText,
  );
  expect(record.originalHash).toBe(originalHash);
  expect(record.receipt).toMatchObject({
    requestId: original.requestId,
    originalHash,
    observedGeneration: before.generation,
    resultingGeneration: before.generation + 1,
    reviewScopeHash,
  });
  const exact = projectCheckpointSubmissionRecordSchema.parse(
    await sourceData(
      page,
      prefix + "/source-submissions/" + original.requestId,
    ),
  );
  expect(exact).toEqual(record);
  const fresh = projectCheckpointSourceContextReadSchema.parse(
    await sourceData(page, prefix + "/source-context"),
  );
  if (!fresh.available)
    throw Error("The published fixture source could not be freshly verified.");
  expect(fresh.context).toEqual({
    state: "current",
    generation: record.receipt.resultingGeneration,
    continuity: "anchored",
    baseBinding: before.baseBinding,
    sourceVersion: before.sourceVersion,
    reviewBinding: { ...before.baseBinding, scopeHash: reviewScopeHash },
    record,
    foreign: null,
  });
  return { record, reviewScopeHash };
}

/** Schema-correct mocked authority for the palette's isolated route fixture only. */
export function mockCurrentCheckpointSource(
  binding: ProjectCheckpointReviewBinding,
  sourceVersion: ProjectCheckpointSourceVersion,
) {
  const original = projectCheckpointSubmissionPublishSchema.parse({
    schemaVersion: 1,
    kind: "publish",
    requestId: randomUUID(),
    binding,
    sourceVersion,
    expectedSubmissionGeneration: 0,
  });
  const originalHash = digest(
    projectCheckpointSubmissionOriginalJson(original),
  );
  const scopeHash = reviewHash(originalHash);
  const record = projectCheckpointSubmissionRecordSchema.parse({
    original,
    originalHash,
    receipt: {
      schemaVersion: 1,
      requestId: original.requestId,
      originalHash,
      scope: {
        projectId: binding.projectId,
        workspacePath: binding.workspacePath,
        runSlug: binding.runSlug,
        beadId: binding.beadId,
      },
      state: "applied",
      observedGeneration: 0,
      resultingGeneration: 1,
      auditEventId: 1,
      appliedAt: binding.runUpdatedAt,
      reviewScopeHash: scopeHash,
    },
  });
  return projectCheckpointSourceContextReadSchema.parse({
    available: true,
    context: {
      state: "current",
      generation: 1,
      continuity: "anchored",
      baseBinding: binding,
      sourceVersion,
      reviewBinding: { ...binding, scopeHash },
      record,
      foreign: null,
    },
  });
}
