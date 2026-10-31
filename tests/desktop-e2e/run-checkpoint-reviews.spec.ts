import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  type Disposable,
  expect,
  type Locator,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import { z } from "zod";
import { runsHref } from "../../apps/desktop/src/project-runs-model";
import type { ForgeState } from "../../scripts/forge/phases";
import { hashText } from "../../scripts/hash-text";
import { OPERATOR_HEADER } from "../../scripts/hearth/paths";
import {
  projectCheckpointReviewHashRequestSchema,
  projectCheckpointReviewIntentJson,
  projectCheckpointReviewMetadataReadSchema,
  projectCheckpointReviewMetadataSchema,
  projectCheckpointReviewOriginalReadSchema,
  projectCheckpointReviewPrepareRequestSchema,
  projectCheckpointReviewReceiptSchema,
} from "../../types/project-checkpoint-reviews";
import type { ProjectRecord } from "../../types/projects";
import {
  readComments,
  readState,
  withStateLock,
  writeState,
} from "../e2e/bd-stand-in-state";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { pageToken } from "../e2e/launch-link";
import { BD_STAND_IN_STATE, DASHBOARD_URL, HEARTH_HOME } from "../e2e/servers";
import { seedCouncilProject } from "./council-fixtures";
import { workspace } from "./project-fixtures";

const ownedRuns = new Map<string, string>();
const ownedFaults = new Map<string, string>();
const faultFile = join(BD_STAND_IN_STATE, "checkpoint-review-fault.json");
const callsFile = join(BD_STAND_IN_STATE, "calls.jsonl");
const dispatchFiles = [
  "codex-fixture-calls.jsonl",
  "gemini-fixture-calls.jsonl",
  "codex-chat-fixture-calls.jsonl",
  "gemini-chat-fixture-calls.json",
  "keeper-fixture-starts.jsonl",
  "coding-fixture-starts.jsonl",
] as const;

type BrowserPost = { path: string; body: unknown };
type ReviewFixture = {
  projectId: string;
  projectSlug: string;
  projectWorkspace: ProjectRecord["workspaces"][number];
  epicId: string;
  beadId: string;
  run: ForgeState;
  runBytes: string;
  secondRun?: ForgeState;
};

declare global {
  interface Window {
    __checkpointOriginalHeld?: boolean;
    __checkpointOriginalReleased?: boolean;
  }
}

function seedReviewFixture(secondRun = false): ReviewFixture {
  const project = seedCouncilProject();
  const projectWorkspace = project.workspaces.find(
    (row) => row.root === workspace,
  );
  if (!projectWorkspace)
    throw Error("The fresh project fixture has no served workspace.");
  const epicId = project.workspaces[0]?.epicIds[0];
  if (!epicId) throw Error("The fresh project fixture has no Beads epic.");
  const beadId = `${epicId}.e2e-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  withStateLock(BD_STAND_IN_STATE, () => {
    const state = readState(BD_STAND_IN_STATE);
    if (!state[epicId] || state[epicId]?.issue_type !== "epic")
      throw Error("The fresh Beads project epic is unavailable.");
    state[beadId] = {
      id: beadId,
      title: "Scoped checkpoint review fixture",
      issue_type: "task",
      status: "in_progress",
      priority: 2,
      labels: [`project:${project.slug}`],
      created_at: "2026-10-29T17:00:00.000Z",
      updated_at: "2026-10-29T17:00:00.000Z",
      dependencies: [
        { issue_id: beadId, depends_on_id: epicId, type: "parent-child" },
      ],
    };
    writeState(BD_STAND_IN_STATE, state);
  });

  const checkout = realpathSync.native(process.cwd());
  const primarySlug = `checkpoint-e2e-${randomUUID().slice(0, 8)}`;
  const path = join(
    checkout,
    ".tmp",
    "work",
    "forge-runs",
    `${primarySlug}.json`,
  );
  mkdirSync(dirname(path), { recursive: true });
  const run: ForgeState = {
    schemaVersion: 2,
    slug: primarySlug,
    feature: "Checkpoint review recovery fixture",
    epic: epicId,
    phase: "plan",
    completed: ["research", "plan"],
    artifacts: {},
    mode: "gated",
    checkout,
    updatedAt: "2026-10-29T18:00:00.000Z",
  };
  const runBytes = JSON.stringify(run);
  writeFileSync(path, runBytes, { flag: "wx" });
  ownedRuns.set(path, runBytes);

  let second: ForgeState | undefined;
  if (secondRun) {
    const slug = `checkpoint-e2e-${randomUUID().slice(0, 8)}`;
    const secondPath = join(
      checkout,
      ".tmp",
      "work",
      "forge-runs",
      `${slug}.json`,
    );
    second = { ...run, slug, feature: "Other checkpoint recovery run" };
    const bytes = JSON.stringify(second);
    writeFileSync(secondPath, bytes, { flag: "wx" });
    ownedRuns.set(secondPath, bytes);
  }
  return {
    projectId: project.id,
    projectSlug: project.slug,
    projectWorkspace,
    epicId,
    beadId,
    run,
    runBytes,
    ...(second ? { secondRun: second } : {}),
  };
}

function expectedCheckpointScopeHash(fixture: ReviewFixture): string {
  return hashText(
    JSON.stringify({
      projectId: fixture.projectId,
      projectSlug: fixture.projectSlug,
      workspace: fixture.projectWorkspace,
      catalogRevision: 1,
      checkout: fixture.run.checkout,
      run: {
        slug: fixture.run.slug,
        epic: fixture.run.epic,
        beadId: fixture.run.beadId ?? null,
        checkout: fixture.run.checkout ?? null,
        updatedAt: fixture.run.updatedAt,
      },
      checkpoints: [
        {
          id: fixture.beadId,
          status: "in_progress",
          groupId: fixture.epicId,
          blockedBy: [],
        },
      ],
      selected: {
        id: fixture.beadId,
        type: "task",
        parent: fixture.epicId,
        status: "in_progress",
      },
    }),
  );
}

function observePosts(page: Page): BrowserPost[] {
  const posts: BrowserPost[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "POST" || !path.startsWith("/__agent-forge/"))
      return;
    let body: unknown = null;
    try {
      body = request.postDataJSON();
    } catch {
      // A malformed request remains visible as null to the exact assertion.
    }
    posts.push({ path, body });
  });
  return posts;
}

function envelopeData(value: unknown): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    !("ok" in value) ||
    value.ok !== true ||
    !("error" in value) ||
    value.error !== null ||
    !("data" in value)
  )
    throw Error(
      "The actual checkpoint review response was not a successful envelope.",
    );
  return value.data;
}

function seedPath(fixture: ReviewFixture): string {
  return `/__agent-forge/projects/${fixture.projectId}/runs/${fixture.run.slug}/checkpoints/${fixture.beadId}/reviews`;
}

function readCallsForComment(beadId: string): string[][] {
  if (!existsSync(callsFile)) return [];
  return readFileSync(callsFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw Error("The Beads stand-in call log was invalid JSON.");
      }
      if (
        !Array.isArray(value) ||
        value.some((part) => typeof part !== "string")
      )
        throw Error("The Beads stand-in call log had an invalid command.");
      return value;
    })
    .filter(
      (args) =>
        args[0] === "comments" && args[1] === "add" && args[4] === beadId,
    );
}

const checkpointCommentEventSchema = z
  .object({
    id: z.number().int().positive(),
    ulid: z.string().min(1),
    ts: z.iso.datetime(),
    workspace: z.string().min(1),
    beadId: z.string().min(1),
    runId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    executor: z
      .object({
        provider: z.string().min(1),
        model: z.string().min(1),
        effort: z.string().min(1).optional(),
        smith: z.string().min(1).optional(),
        sessionId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    kind: z.literal("bead.transitioned"),
    payload: z
      .object({
        action: z.literal("comment"),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        length: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
const checkpointCommentEventsPageSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        events: z.array(checkpointCommentEventSchema).max(1000),
        cursor: z.number().int().nonnegative(),
        more: z.boolean(),
      })
      .strict(),
    error: z.null(),
  })
  .strict();

type CheckpointCommentEvent = z.infer<typeof checkpointCommentEventSchema>;

async function commentEvents(
  page: Page,
  beadId: string,
): Promise<CheckpointCommentEvent[]> {
  const token = await pageToken(page);
  const query = new URLSearchParams({
    bead: beadId,
    beadExact: "1",
    kind: "bead.transitioned",
    limit: "1000",
  });
  const path = `/__agent-forge/events?${query}`;
  const expectedUrl = new URL(path, page.url()).href;
  const answer = await page.evaluate(
    async ({ url, token, header }) => {
      const controller = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const timer = window.setTimeout(() => {
        controller.abort();
        if (reader) void reader.cancel().catch(() => undefined);
      }, 10_000);
      try {
        const response = await fetch(url, {
          headers: { [header]: token },
          signal: controller.signal,
        });
        reader = response.body?.getReader();
        if (!reader)
          throw Error("The protected ledger events response had no body.");
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 1024 * 1024)
            throw Error(
              "The protected ledger events response exceeded its byte limit.",
            );
          chunks.push(part.value);
        }
        let text = "";
        for (const chunk of chunks)
          text += decoder.decode(chunk, { stream: true });
        text += decoder.decode();
        return { status: response.status, url: response.url, text };
      } finally {
        window.clearTimeout(timer);
        if (reader) {
          void reader.cancel().catch(() => undefined);
          try {
            reader.releaseLock();
          } catch {
            // The bounded abort can release an outstanding read first.
          }
        }
      }
    },
    { url: path, token, header: OPERATOR_HEADER },
  );
  expect(answer.url).toBe(expectedUrl);
  expect(answer.status).toBe(200);
  let raw: unknown;
  try {
    raw = JSON.parse(answer.text);
  } catch {
    throw Error("The protected ledger events response was invalid JSON.");
  }
  const parsed = checkpointCommentEventsPageSchema.parse(raw);
  const { events, cursor, more } = parsed.data;
  expect(more).toBe(false);
  expect(cursor).toBe(events.at(-1)?.id ?? 0);
  const ids = events.map((event) => event.id);
  expect(ids).toEqual([...new Set(ids)].sort((a, b) => a - b));
  for (const event of events) {
    expect(event.workspace).toBe(workspace);
    expect(event.beadId).toBe(beadId);
    expect(event.kind).toBe("bead.transitioned");
    expect(event.payload.action).toBe("comment");
  }
  return events;
}

function dispatchSnapshot(): Map<string, string | null> {
  return new Map(
    dispatchFiles.map((name) => {
      const path = join(HEARTH_HOME, name);
      return [name, existsSync(path) ? readFileSync(path, "utf8") : null];
    }),
  );
}

function expectDispatchesUnchanged(before: Map<string, string | null>) {
  for (const [name, bytes] of before) {
    const path = join(HEARTH_HOME, name);
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (
      !["codex-fixture-calls.jsonl", "gemini-fixture-calls.jsonl"].includes(
        name,
      ) ||
      current === bytes
    ) {
      expect(current).toBe(bytes);
      continue;
    }
    if (current === null || (bytes !== null && !current.startsWith(bytes)))
      throw Error(
        "An inert CLI fixture call log changed before its saved prefix.",
      );
    const added = current.slice(bytes?.length ?? 0);
    if (added.length > 0 && !added.endsWith("\n"))
      throw Error("The Codex fixture call log ended with a partial row.");
    const rows = added.split(/\r?\n/).filter(Boolean);
    for (const line of rows) {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw Error("An inert CLI fixture call log had invalid JSON.");
      }
      if (name === "gemini-fixture-calls.jsonl") {
        z.object({ kind: z.literal("version") })
          .strict()
          .parse(raw);
        continue;
      }
      const probe = z
        .object({
          kind: z.enum(["version", "status"]),
          argv: z.array(z.string()),
          stdin: z.literal(""),
          cwd: z.literal(realpathSync.native(process.cwd())),
          id: z.uuid(),
          pid: z.number().int().positive(),
          childPid: z.null(),
        })
        .strict()
        .parse(raw);
      if (
        (probe.kind === "version" &&
          JSON.stringify(probe.argv) !== JSON.stringify(["--version"])) ||
        (probe.kind === "status" &&
          JSON.stringify(probe.argv) !== JSON.stringify(["login", "status"]))
      )
        throw Error("The Codex fixture recorded a non-read-only startup call.");
    }
  }
}

function expectRunAndBeadUnchanged(fixture: ReviewFixture): void {
  expect(readState(BD_STAND_IN_STATE)[fixture.beadId]?.status).toBe(
    "in_progress",
  );
  expect(
    readFileSync(
      join(
        realpathSync.native(process.cwd()),
        ".tmp",
        "work",
        "forge-runs",
        `${fixture.run.slug}.json`,
      ),
      "utf8",
    ),
  ).toBe(fixture.runBytes);
}

function ownFault(beadId: string, requestId: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      requestId,
    )
  )
    throw Error("The fault control request ID was not a canonical UUID.");
  if (existsSync(faultFile))
    throw Error("A checkpoint fault control already exists.");
  const bytes = JSON.stringify({
    mode: "comment-persist-unknown",
    beadId,
    requestId,
  });
  if (Buffer.byteLength(bytes, "utf8") > 4 * 1024)
    throw Error("The checkpoint fault control exceeded its fixture limit.");
  const privateStandInState = realpathSync.native(BD_STAND_IN_STATE);
  if (realpathSync.native(dirname(faultFile)) !== privateStandInState)
    throw Error(
      "The checkpoint fault control escaped its private fixture home.",
    );
  writeFileSync(faultFile, bytes, { flag: "wx", mode: 0o600 });
  const stat = lstatSync(faultFile);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size > 4 * 1024
  )
    throw Error("The checkpoint fault control was not a private regular file.");
  if (readFileSync(faultFile, "utf8") !== bytes)
    throw Error("The checkpoint fault control did not verify after writing.");
  ownedFaults.set(faultFile, bytes);
  return bytes;
}

function expectFaultConsumed(): void {
  expect(existsSync(faultFile)).toBe(false);
  ownedFaults.delete(faultFile);
}

function cleanupOwnedFiles(): void {
  for (const [path, expected] of ownedRuns) {
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(expected);
    unlinkSync(path);
    expect(existsSync(path)).toBe(false);
  }
  ownedRuns.clear();
  for (const [path, expected] of ownedFaults) {
    if (existsSync(path)) {
      const stat = lstatSync(path);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.isFile()).toBe(true);
      expect(stat.nlink).toBe(1);
      expect(readFileSync(path, "utf8")).toBe(expected);
      unlinkSync(path);
    }
    expect(existsSync(path)).toBe(false);
  }
  ownedFaults.clear();
}

type CheckpointCaptureKind =
  | "prepare"
  | "original"
  | "commit"
  | "history"
  | "readback";
function isCheckpointCaptureKind(
  value: unknown,
): value is CheckpointCaptureKind {
  return (
    value === "prepare" ||
    value === "original" ||
    value === "commit" ||
    value === "history" ||
    value === "readback"
  );
}
type CheckpointMarker = { sequence: number; epoch: number };
type CheckpointObserverPhase = "setup" | "post-release";
type CheckpointCapture = {
  kind: CheckpointCaptureKind;
  sequence: number;
  epoch: number;
  data: unknown;
};
type CheckpointWaiter = {
  kind: CheckpointCaptureKind;
  marker: CheckpointMarker;
  newerEpoch: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: CheckpointCapture): void;
  reject(error: Error): void;
};
type CheckpointObserverOptions = {
  expectedNote: string;
  loseCommitReply?: boolean;
  holdOriginal?: boolean;
};

declare global {
  interface Window {
    __checkpointObserverReady?: (input: unknown) => Promise<unknown>;
    __checkpointObserverBegin?: (input: unknown) => Promise<unknown>;
    __checkpointObserverComplete?: (input: unknown) => Promise<unknown>;
    __checkpointObserverFailure?: () => Promise<unknown>;
    __checkpointObserverMark?: (input: unknown) => Promise<unknown>;
    __checkpointObserverNonce?: string;
    __checkpointReaders?: ReadableStreamDefaultReader<Uint8Array>[];
    __checkpointObserverRelease?: () => Promise<void>;
    __checkpointObserverDrain?: () => Promise<void>;
    __checkpointObserverStop?: () => void;
    __checkpointObserverHeld?: boolean;
    __checkpointObserverReleased?: boolean;
  }
}

let activeCheckpointObserver: { dispose(): Promise<void> } | undefined;

async function installCheckpointResponseObserver(
  page: Page,
  fixture: ReviewFixture,
  options: CheckpointObserverOptions,
) {
  const basePath = seedPath(fixture);
  const origin = new URL(DASHBOARD_URL).origin;
  const maxReads = 64;
  const maxTotalBytes = 8 * 1024 * 1024;
  let sequence = 0;
  let epoch = 0;
  let nonce: string | undefined;
  const seenNonces = new Set<string>();
  let accepted:
    | ReturnType<typeof projectCheckpointReviewMetadataSchema.parse>
    | undefined;
  let preparedOriginal:
    | ReturnType<typeof projectCheckpointReviewOriginalReadSchema.parse>
    | undefined;
  let commitReceipt:
    | ReturnType<typeof projectCheckpointReviewReceiptSchema.parse>
    | undefined;
  let historyRead:
    | ReturnType<typeof projectCheckpointReviewMetadataReadSchema.parse>
    | undefined;
  let readbackReceipt:
    | ReturnType<typeof projectCheckpointReviewReceiptSchema.parse>
    | undefined;
  let invalid: Error | undefined;
  let lostCommitInjected = false;
  let acceptedReads = 0;
  let totalBytes = 0;
  let phase: CheckpointObserverPhase = "setup";
  let held = false;
  let disposed = false;
  let initDisposable: Disposable | undefined;
  const bindingDisposables: Disposable[] = [];
  let releaseHold!: () => void;
  const holdGate = new Promise<void>((resolve) => (releaseHold = resolve));
  const captures: CheckpointCapture[] = [];
  const waiters = new Set<CheckpointWaiter>();
  const pending = new Map<
    number,
    {
      epoch: number;
      kind: CheckpointCaptureKind;
      phase: CheckpointObserverPhase;
    }
  >();

  const fail: (message: string) => never = (message) => {
    invalid ??= Error(message);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(invalid);
    }
    waiters.clear();
    throw invalid;
  };
  const exactScope = (scope: unknown) => {
    expect(scope).toEqual({
      projectId: fixture.projectId,
      workspacePath: workspace,
      runSlug: fixture.run.slug,
      beadId: fixture.beadId,
    });
  };
  const parseRequestBody = (text: unknown): unknown => {
    if (typeof text !== "string")
      fail("A checkpoint request body was missing.");
    try {
      return JSON.parse(text);
    } catch {
      return fail("A checkpoint request body was invalid JSON.");
    }
  };
  const routeKind = (
    method: unknown,
    path: unknown,
  ): CheckpointCaptureKind | undefined => {
    if (typeof method !== "string" || typeof path !== "string")
      return undefined;
    if (method === "GET" && path === basePath) return "history";
    if (method === "POST" && path === basePath) return "prepare";
    if (!accepted) return undefined;
    if (path === `${basePath}/${accepted.requestId}`) {
      return method === "GET" ? "original" : undefined;
    }
    if (path === `${basePath}/${accepted.requestId}/commit`) {
      return method === "POST" ? "commit" : undefined;
    }
    if (path === `${basePath}/${accepted.requestId}/readback`) {
      return method === "POST" ? "readback" : undefined;
    }
    return undefined;
  };
  const parseCapture = (
    kind: CheckpointCaptureKind,
    status: unknown,
    path: unknown,
    responseUrl: unknown,
    requestBodyText: unknown,
    responseText: unknown,
  ): unknown => {
    if (status !== 200) fail(`The actual ${kind} response was not HTTP 200.`);
    if (typeof path !== "string" || typeof responseUrl !== "string")
      fail("A checkpoint response path was missing.");
    const finalUrl = new URL(responseUrl);
    if (
      finalUrl.origin !== origin ||
      finalUrl.pathname !== path ||
      finalUrl.search ||
      finalUrl.hash
    )
      fail("The actual checkpoint response changed its route.");
    const envelopeValue = (() => {
      if (typeof responseText !== "string")
        fail("A checkpoint response body was missing.");
      try {
        return JSON.parse(responseText);
      } catch {
        return fail(`The actual ${kind} response was invalid JSON.`);
      }
    })();
    const data = envelopeData(envelopeValue);
    if (kind === "prepare") {
      if (path !== basePath)
        fail("The actual prepare path did not match the fixture.");
      const request = projectCheckpointReviewPrepareRequestSchema.parse(
        parseRequestBody(requestBodyText),
      );
      if (
        request.expectedEpicId !== fixture.epicId ||
        request.expectedRunUpdatedAt !== fixture.run.updatedAt ||
        request.decision !== "request-changes" ||
        request.note !== options.expectedNote
      )
        fail("The actual prepare request did not match the review fixture.");
      const value = projectCheckpointReviewMetadataSchema.parse(data);
      exactScope(value.scope);
      expect(value.state).toBe("prepared");
      expect(value.requestId).toBe(request.requestId);
      accepted = value;
      if (options.loseCommitReply) ownFault(fixture.beadId, request.requestId);
      return value;
    }
    const current = accepted;
    if (kind === "history") {
      if (path !== basePath)
        fail("The actual history path did not match the fixture.");
      const value = projectCheckpointReviewMetadataReadSchema.parse(data);
      exactScope(value.scope);
      if (!current) {
        if (
          value.items.length !== 0 ||
          value.activeRequestId !== null ||
          value.blocked
        )
          fail("Pre-prepare history was not the exact empty fixture state.");
        historyRead = value;
        return value;
      }
      if (value.items.length === 0) {
        if (value.activeRequestId !== null)
          fail("Empty history claimed an active review.");
      } else {
        const row = value.items.find(
          (item) => item.requestId === current.requestId,
        );
        if (!row || row.intentHash !== current.intentHash)
          fail("History did not match the accepted prepare.");
      }
      historyRead = value;
      return value;
    }
    if (!current) fail(`The actual ${kind} arrived before a verified prepare.`);
    if (kind === "original") {
      if (path !== `${basePath}/${current.requestId}`)
        fail("The original path did not match the accepted prepare.");
      const value = projectCheckpointReviewOriginalReadSchema.parse(data);
      expect(value.metadata).toMatchObject({
        requestId: current.requestId,
        intentHash: current.intentHash,
      });
      exactScope(value.metadata.scope);
      expect(value.original).toMatchObject({
        requestId: current.requestId,
        intentHash: current.intentHash,
        decision: "request-changes",
        note: options.expectedNote,
        binding: {
          projectId: fixture.projectId,
          workspacePath: workspace,
          checkout: fixture.run.checkout,
          runSlug: fixture.run.slug,
          epicId: fixture.epicId,
          beadId: fixture.beadId,
          runUpdatedAt: fixture.run.updatedAt,
          catalogRevision: 1,
          scopeHash: expectedCheckpointScopeHash(fixture),
        },
      });
      expect(
        createHash("sha256")
          .update(projectCheckpointReviewIntentJson(value.original), "utf8")
          .digest("hex"),
      ).toBe(current.intentHash);
      preparedOriginal = value;
      return value;
    }
    const request = projectCheckpointReviewHashRequestSchema.parse(
      parseRequestBody(requestBodyText),
    );
    expect(request.intentHash).toBe(current.intentHash);
    if (kind === "commit") {
      if (path !== `${basePath}/${current.requestId}/commit`)
        fail("The commit path did not match the accepted prepare.");
      const value = projectCheckpointReviewReceiptSchema.parse(data);
      expect(value.requestId).toBe(current.requestId);
      expect(value.intentHash).toBe(current.intentHash);
      expect(value).toMatchObject(
        options.loseCommitReply
          ? { state: "unknown", readback: "not-checked", commentId: null }
          : { state: "confirmed", readback: "found" },
      );
      commitReceipt = value;
      if (options.loseCommitReply) {
        expectFaultConsumed();
        if (lostCommitInjected)
          fail("The lost commit delivery was injected more than once.");
        const rows = readComments(BD_STAND_IN_STATE)[fixture.beadId] ?? [];
        if (
          rows.length !== 1 ||
          !rows[0]?.text.includes(options.expectedNote) ||
          !rows[0]?.text.endsWith(
            `Forge checkpoint review ${current.requestId}`,
          )
        )
          fail(
            "The lost commit was not backed by one persisted fixture comment.",
          );
        lostCommitInjected = true;
      }
      return value;
    }
    if (path !== `${basePath}/${current.requestId}/readback`)
      fail("The readback path did not match the accepted prepare.");
    const value = projectCheckpointReviewReceiptSchema.parse(data);
    expect(value).toMatchObject({
      requestId: current.requestId,
      intentHash: current.intentHash,
      state: "confirmed",
      readback: "found",
    });
    readbackReceipt = value;
    return value;
  };

  const onReady = (input: unknown) => {
    if (
      disposed ||
      typeof input !== "object" ||
      input === null ||
      !("nonce" in input) ||
      !("origin" in input)
    )
      fail("The checkpoint observer document handshake was invalid.");
    if (
      input.origin !== origin ||
      typeof input.nonce !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        input.nonce,
      )
    )
      fail("The checkpoint observer document scope was invalid.");
    if (seenNonces.has(input.nonce))
      fail("A checkpoint document repeated an observer nonce.");
    if (seenNonces.size >= maxReads + 1)
      fail("The checkpoint observer document limit was exceeded.");
    if (
      !Number.isSafeInteger(acceptedReads) ||
      acceptedReads < 0 ||
      acceptedReads > maxReads ||
      !Number.isSafeInteger(totalBytes) ||
      totalBytes < 0 ||
      totalBytes > maxTotalBytes
    )
      fail("The checkpoint observer cumulative limits were invalid.");
    seenNonces.add(input.nonce);
    nonce = input.nonce;
    epoch++;
    return {
      epoch,
      acceptedReads,
      totalBytes,
      accepted: accepted
        ? { requestId: accepted.requestId, intentHash: accepted.intentHash }
        : null,
    };
  };
  const onBegin = (input: unknown) => {
    if (
      disposed ||
      typeof input !== "object" ||
      input === null ||
      !("nonce" in input) ||
      !("epoch" in input) ||
      !("method" in input) ||
      !("path" in input) ||
      !("search" in input) ||
      !("hash" in input)
    )
      fail("A checkpoint observation could not begin.");
    if (
      input.nonce !== nonce ||
      input.epoch !== epoch ||
      input.search !== "" ||
      input.hash !== ""
    )
      fail(
        "A stale or out-of-scope checkpoint document attempted an observation.",
      );
    const kind = routeKind(input.method, input.path);
    if (!kind) return { accepted: false };
    if (acceptedReads >= maxReads)
      fail("The checkpoint observer read limit was exceeded.");
    acceptedReads++;
    sequence++;
    pending.set(sequence, { epoch, kind, phase });
    return { accepted: true, sequence, epoch, kind };
  };
  const onComplete = (input: unknown) => {
    if (
      disposed ||
      typeof input !== "object" ||
      input === null ||
      !("nonce" in input) ||
      !("epoch" in input) ||
      !("sequence" in input) ||
      !("kind" in input) ||
      !("status" in input) ||
      !("path" in input) ||
      !("responseUrl" in input) ||
      !("requestBodyText" in input) ||
      !("responseText" in input)
    )
      fail("A checkpoint observation was incomplete.");
    if (
      typeof input.sequence !== "number" ||
      !Number.isSafeInteger(input.sequence) ||
      !isCheckpointCaptureKind(input.kind) ||
      typeof input.responseText !== "string"
    )
      fail("A checkpoint observation carried invalid identifiers.");
    const responseBytes = new TextEncoder().encode(
      input.responseText,
    ).byteLength;
    if (responseBytes > 1024 * 1024)
      fail("A checkpoint response exceeded the per-read limit.");
    if (totalBytes + responseBytes > maxTotalBytes)
      fail("The checkpoint observer total byte limit was exceeded.");
    const pendingRead = pending.get(input.sequence);
    if (
      !pendingRead ||
      input.nonce !== nonce ||
      input.epoch !== epoch ||
      pendingRead.epoch !== epoch ||
      pendingRead.kind !== input.kind
    )
      fail("A stale checkpoint response was rejected.");
    pending.delete(input.sequence);
    const kind = input.kind;
    if (
      routeKind(
        kind === "prepare"
          ? "POST"
          : kind === "history" || kind === "original"
            ? "GET"
            : "POST",
        input.path,
      ) !== kind
    )
      fail("A checkpoint response route changed during capture.");
    const data = parseCapture(
      kind,
      input.status,
      input.path,
      input.responseUrl,
      input.requestBodyText,
      input.responseText,
    );
    totalBytes += responseBytes;
    const hold =
      kind === "original" &&
      options.holdOriginal === true &&
      !held &&
      preparedOriginal?.metadata.state === "prepared";
    if (hold) held = true;
    const capture = { kind, sequence: input.sequence, epoch, data };
    captures.push(capture);
    for (const waiter of waiters) {
      if (
        waiter.kind === kind &&
        capture.sequence > waiter.marker.sequence &&
        (!waiter.newerEpoch || capture.epoch > waiter.marker.epoch)
      ) {
        clearTimeout(waiter.timer);
        waiter.resolve(capture);
        waiters.delete(waiter);
      }
    }
    return {
      valid: true,
      requestId: accepted?.requestId ?? null,
      intentHash: accepted?.intentHash ?? null,
      lose:
        kind === "commit" &&
        options.loseCommitReply === true &&
        lostCommitInjected,
      hold,
    };
  };
  const latchFailure = () => {
    invalid ??= Error("The native checkpoint response observation failed.");
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(invalid);
    }
    waiters.clear();
    return { valid: false };
  };
  const safeReady = (input: unknown) => {
    if (disposed) return { epoch: 0, accepted: null };
    try {
      return onReady(input);
    } catch {
      latchFailure();
      return { epoch: 0, accepted: null };
    }
  };
  const safeBegin = (input: unknown) => {
    try {
      return onBegin(input);
    } catch {
      latchFailure();
      return { accepted: false };
    }
  };
  const safeComplete = (input: unknown) => {
    try {
      return onComplete(input);
    } catch {
      latchFailure();
      return { valid: false };
    }
  };
  const expose = async (
    name: string,
    callback: (input?: unknown) => unknown,
  ) => {
    const binding = await page.exposeBinding(name, (source, ...args) => {
      let sourceOrigin = "";
      try {
        sourceOrigin = new URL(source.frame.url()).origin;
      } catch {
        /* invalid source remains untrusted */
      }
      if (
        source.page !== page ||
        source.frame !== page.mainFrame() ||
        sourceOrigin !== origin
      ) {
        latchFailure();
        return undefined;
      }
      return callback(args[0]);
    });
    bindingDisposables.push(binding);
  };
  try {
    await expose("__checkpointObserverReady", safeReady);
    await expose("__checkpointObserverBegin", safeBegin);
    await expose("__checkpointObserverComplete", safeComplete);
    await expose("__checkpointObserverFailure", latchFailure);
    await expose("__checkpointObserverMark", (input) => {
      if (
        !nonce ||
        disposed ||
        typeof input !== "object" ||
        input === null ||
        !("nonce" in input) ||
        input.nonce !== nonce
      )
        fail("The checkpoint mark came from a stale document.");
      return { sequence, epoch } satisfies CheckpointMarker;
    });
    initDisposable = await page.addInitScript(
      (config: { origin: string; basePath: string }) => {
        if (window.top !== window || window.location.origin !== config.origin)
          return;
        const nonce = crypto.randomUUID();
        window.__checkpointObserverNonce = nonce;
        let epoch = 0;
        let acceptedId: string | null = null;
        let acceptedHash: string | null = null;
        let count = 0;
        let total = 0;
        let overflowReported = false;
        let dropped = false;
        let held = false;
        let stopped = false;
        let release!: () => void;
        const holdGate = new Promise<void>((resolve) => (release = resolve));
        const originalFetch = window.fetch;
        const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
        const activeTasks = new Set<Promise<void>>();
        window.__checkpointReaders = [];
        window.__checkpointObserverHeld = false;
        window.__checkpointObserverReleased = false;
        window.__checkpointOriginalHeld = false;
        window.__checkpointOriginalReleased = false;
        const ready = window.__checkpointObserverReady;
        if (!ready) return;
        const handshakeReady = ready({
          nonce,
          origin: window.location.origin,
        }).then(
          async (handshake) => {
            if (
              typeof handshake !== "object" ||
              handshake === null ||
              !("epoch" in handshake) ||
              typeof handshake.epoch !== "number" ||
              handshake.epoch < 1 ||
              !Number.isSafeInteger(handshake.epoch) ||
              !("acceptedReads" in handshake) ||
              typeof handshake.acceptedReads !== "number" ||
              !Number.isSafeInteger(handshake.acceptedReads) ||
              handshake.acceptedReads < 0 ||
              handshake.acceptedReads > 64 ||
              !("totalBytes" in handshake) ||
              typeof handshake.totalBytes !== "number" ||
              !Number.isSafeInteger(handshake.totalBytes) ||
              handshake.totalBytes < 0 ||
              handshake.totalBytes > 8 * 1024 * 1024 ||
              !("accepted" in handshake)
            ) {
              try {
                await window.__checkpointObserverFailure?.();
              } catch {
                /* handshake failure remains fatal in the Node observer */
              }
              return false;
            }
            epoch = handshake.epoch;
            count = handshake.acceptedReads;
            total = handshake.totalBytes;
            const acceptedRecord = handshake.accepted;
            if (
              typeof acceptedRecord === "object" &&
              acceptedRecord !== null &&
              "requestId" in acceptedRecord &&
              "intentHash" in acceptedRecord &&
              typeof acceptedRecord.requestId === "string" &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
                acceptedRecord.requestId,
              ) &&
              typeof acceptedRecord.intentHash === "string" &&
              /^[a-f0-9]{64}$/.test(acceptedRecord.intentHash)
            ) {
              acceptedId = acceptedRecord.requestId;
              acceptedHash = acceptedRecord.intentHash;
            }
            return true;
          },
          async () => {
            try {
              await window.__checkpointObserverFailure?.();
            } catch {
              /* handshake failure remains fatal in the Node observer */
            }
            return false;
          },
        );
        const reportFailure = async () => {
          try {
            await window.__checkpointObserverFailure?.();
          } catch {
            /* preserve the actual fetch outcome */
          }
        };
        const classify = (
          method: string,
          url: URL,
        ): CheckpointCaptureKind | undefined => {
          if (url.origin !== config.origin || url.search || url.hash)
            return undefined;
          if (method === "GET" && url.pathname === config.basePath)
            return "history";
          if (method === "POST" && url.pathname === config.basePath)
            return "prepare";
          if (
            !acceptedId ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
              acceptedId,
            )
          )
            return undefined;
          if (
            url.pathname === `${config.basePath}/${acceptedId}` &&
            method === "GET"
          )
            return "original";
          if (
            url.pathname === `${config.basePath}/${acceptedId}/commit` &&
            method === "POST"
          )
            return "commit";
          if (
            url.pathname === `${config.basePath}/${acceptedId}/readback` &&
            method === "POST"
          )
            return "readback";
          return undefined;
        };
        const cloneText = async (response: Response): Promise<string> => {
          const reader = response.clone().body?.getReader();
          if (!reader) throw Error("missing body");
          readers.add(reader);
          window.__checkpointReaders?.push(reader);
          let timer = 0;
          let complete = false;
          const read = async () => {
            const decoder = new TextDecoder("utf-8", { fatal: true });
            let text = "";
            let size = 0;
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              size += part.value.byteLength;
              total += part.value.byteLength;
              if (size > 1024 * 1024 || total > 8 * 1024 * 1024)
                throw Error("response limit");
              text += decoder.decode(part.value, { stream: true });
            }
            const result = text + decoder.decode();
            complete = true;
            return result;
          };
          const timeout = new Promise<never>((_, reject) => {
            timer = window.setTimeout(
              () => reject(Error("response timeout")),
              10_000,
            );
          });
          try {
            return await Promise.race([read(), timeout]);
          } finally {
            window.clearTimeout(timer);
            readers.delete(reader);
            window.__checkpointReaders = (
              window.__checkpointReaders ?? []
            ).filter((active) => active !== reader);
            if (!complete) void reader.cancel().catch(() => undefined);
            try {
              reader.releaseLock();
            } catch {
              /* reader already settled */
            }
          }
        };
        const cloneRequestText = async (request: Request): Promise<string> => {
          const reader = request.clone().body?.getReader();
          if (!reader) return "";
          readers.add(reader);
          window.__checkpointReaders?.push(reader);
          let timer = 0;
          let complete = false;
          const read = async () => {
            const decoder = new TextDecoder("utf-8", { fatal: true });
            let text = "";
            let size = 0;
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              size += part.value.byteLength;
              if (size > 16 * 1024) throw Error("request limit");
              text += decoder.decode(part.value, { stream: true });
            }
            const result = text + decoder.decode();
            complete = true;
            return result;
          };
          const timeout = new Promise<never>((_, reject) => {
            timer = window.setTimeout(
              () => reject(Error("request timeout")),
              10_000,
            );
          });
          try {
            return await Promise.race([read(), timeout]);
          } finally {
            window.clearTimeout(timer);
            readers.delete(reader);
            window.__checkpointReaders = (
              window.__checkpointReaders ?? []
            ).filter((active) => active !== reader);
            if (!complete) void reader.cancel().catch(() => undefined);
            try {
              reader.releaseLock();
            } catch {
              /* reader already settled */
            }
          }
        };
        const wrapper = Object.assign(async function (
          this: Window,
          ...args: Parameters<typeof originalFetch>
        ): Promise<Response> {
          const [input, init] = args;
          if (stopped) return Reflect.apply(originalFetch, this, args);
          let url: URL;
          try {
            url = new URL(
              input instanceof Request ? input.url : input.toString(),
              window.location.href,
            );
          } catch {
            return Reflect.apply(originalFetch, this, args);
          }
          const method = (
            init?.method ?? (input instanceof Request ? input.method : "GET")
          ).toUpperCase();
          if (
            url.origin !== config.origin ||
            url.search ||
            url.hash ||
            !(
              url.pathname === config.basePath ||
              url.pathname.startsWith(`${config.basePath}/`)
            ) ||
            (method !== "GET" && method !== "POST")
          )
            return Reflect.apply(originalFetch, this, args);
          if (!(await handshakeReady))
            return Reflect.apply(originalFetch, this, args);
          const kind = classify(method, url);
          if (!kind || window.location.origin !== config.origin)
            return Reflect.apply(originalFetch, this, args);
          if (count >= 64) {
            if (!overflowReported) {
              overflowReported = true;
              await reportFailure();
            }
            return Reflect.apply(originalFetch, this, args);
          }
          count++;
          const task = (async () => {
            let request: Request;
            try {
              request =
                input instanceof Request && init === undefined
                  ? input.clone()
                  : new Request(input, init);
            } catch {
              await reportFailure();
              return Reflect.apply(originalFetch, this, args);
            }
            let requestBodyText = "";
            if (method === "POST") {
              try {
                requestBodyText = await cloneRequestText(request);
              } catch {
                await reportFailure();
                return Reflect.apply(originalFetch, this, args);
              }
            }
            const begin = await window.__checkpointObserverBegin?.({
              nonce,
              epoch,
              search: url.search,
              hash: url.hash,
              method,
              path: url.pathname,
            });
            if (
              typeof begin !== "object" ||
              begin === null ||
              !("accepted" in begin) ||
              begin.accepted !== true ||
              !("sequence" in begin) ||
              typeof begin.sequence !== "number" ||
              !Number.isSafeInteger(begin.sequence)
            ) {
              await reportFailure();
              return Reflect.apply(originalFetch, this, args);
            }
            const ownSequence = begin.sequence;
            let response: Response;
            try {
              response = await Reflect.apply(originalFetch, this, args);
            } catch (error) {
              await reportFailure();
              throw error;
            }
            let responseText: string;
            try {
              responseText = await cloneText(response);
            } catch {
              await reportFailure();
              return response;
            }
            const complete = await window.__checkpointObserverComplete?.({
              nonce,
              epoch,
              sequence: ownSequence,
              kind,
              status: response.status,
              path: url.pathname,
              responseUrl: response.url,
              requestBodyText,
              responseText,
            });
            if (
              typeof complete !== "object" ||
              complete === null ||
              !("valid" in complete) ||
              complete.valid !== true
            )
              return response;
            if (
              acceptedHash &&
              (!("intentHash" in complete) ||
                complete.intentHash !== acceptedHash)
            ) {
              await reportFailure();
              return response;
            }
            if (
              kind === "prepare" &&
              "requestId" in complete &&
              "intentHash" in complete &&
              typeof complete.requestId === "string" &&
              typeof complete.intentHash === "string"
            ) {
              acceptedId = complete.requestId;
              acceptedHash = complete.intentHash;
            }
            if (
              kind === "original" &&
              "hold" in complete &&
              complete.hold === true &&
              !held
            ) {
              held = true;
              window.__checkpointObserverHeld = true;
              window.__checkpointOriginalHeld = true;
              await holdGate;
              window.__checkpointObserverReleased = true;
              window.__checkpointOriginalReleased = true;
            }
            if (
              kind === "commit" &&
              "lose" in complete &&
              complete.lose === true &&
              !dropped
            ) {
              dropped = true;
              throw new TypeError("Failed to fetch");
            }
            return response;
          })();
          const tracked = task.then(
            () => undefined,
            () => undefined,
          );
          activeTasks.add(tracked);
          try {
            return await task;
          } finally {
            activeTasks.delete(tracked);
          }
        }, originalFetch);
        window.fetch = wrapper;
        window.__checkpointObserverRelease = async () => {
          release();
        };
        window.__checkpointObserverStop = () => {
          stopped = true;
          release();
          if (window.fetch === wrapper) window.fetch = originalFetch;
        };
        window.__checkpointObserverDrain = async () => {
          let timer = 0;
          const timeout = new Promise<never>((_, reject) => {
            timer = window.setTimeout(
              () => reject(Error("checkpoint observer drain timed out")),
              10_000,
            );
          });
          try {
            await Promise.race([Promise.all([...activeTasks]), timeout]);
          } finally {
            window.clearTimeout(timer);
          }
        };
      },
      { origin, basePath },
    );
  } catch (error) {
    if (!page.isClosed()) {
      try {
        await page.evaluate(async () => {
          window.__checkpointObserverStop?.();
          await window.__checkpointObserverRelease?.();
          const readers = window.__checkpointReaders ?? [];
          for (const reader of readers)
            void reader.cancel().catch(() => undefined);
          await window.__checkpointObserverDrain?.();
        });
      } catch {
        /* retain the original setup failure */
      }
    }
    try {
      await initDisposable?.dispose();
    } catch {
      /* retain the original setup failure */
    }
    for (const binding of bindingDisposables.reverse()) {
      try {
        await binding.dispose();
      } catch {
        /* retain the original setup failure */
      }
    }
    disposed = true;
    throw error;
  }

  const check = () => {
    if (invalid) throw invalid;
  };
  const mark = async (): Promise<CheckpointMarker> => {
    check();
    const marker = await page.evaluate(async () =>
      window.__checkpointObserverMark?.({
        nonce: window.__checkpointObserverNonce,
      }),
    );
    if (
      typeof marker !== "object" ||
      marker === null ||
      !("sequence" in marker) ||
      !("epoch" in marker) ||
      typeof marker.sequence !== "number" ||
      !Number.isSafeInteger(marker.sequence) ||
      marker.sequence < 0 ||
      typeof marker.epoch !== "number" ||
      !Number.isSafeInteger(marker.epoch) ||
      marker.epoch < 1
    )
      fail("The checkpoint observer did not return a mark.");
    return { sequence: marker.sequence, epoch: marker.epoch };
  };
  const waitFor = async (
    kind: CheckpointCaptureKind,
    marker: CheckpointMarker,
    newerEpoch = false,
  ): Promise<CheckpointCapture> => {
    check();
    if (waiters.size >= maxReads)
      fail("The checkpoint observer waiter limit was exceeded.");
    const existing = captures.find(
      (capture) =>
        capture.kind === kind &&
        capture.sequence > marker.sequence &&
        (!newerEpoch || capture.epoch > marker.epoch),
    );
    if (existing) return existing;
    const pendingWait = new Promise<CheckpointCapture>((resolve, reject) => {
      let waiter!: CheckpointWaiter;
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        latchFailure();
        reject(
          invalid ??
            Error("The required checkpoint response was not observed."),
        );
      }, 10_000);
      waiter = { kind, marker, newerEpoch, timer, resolve, reject };
      waiters.add(waiter);
    });
    void pendingWait.catch(() => undefined);
    return await pendingWait;
  };
  const observer = {
    mark,
    waitFor,
    setPhase(value: CheckpointObserverPhase) {
      phase = value;
    },
    diagnosticSnapshot: () => ({
      epoch,
      pending: [...pending.entries()].map(([sequence, entry]) => ({
        phase: entry.phase,
        kind: entry.kind,
        sequence,
        epoch: entry.epoch,
      })),
    }),
    prepared: () => accepted,
    original: () => preparedOriginal,
    commit: () => commitReceipt,
    history: () => historyRead,
    readback: () => readbackReceipt,
    async releaseOriginal() {
      releaseHold();
      if (!page.isClosed())
        await page.evaluate(() => window.__checkpointObserverRelease?.());
    },
    async dispose() {
      if (disposed) return;
      let drainError: unknown;
      if (!page.isClosed()) {
        try {
          await page.evaluate(async () => {
            window.__checkpointObserverStop?.();
            await window.__checkpointObserverRelease?.();
            const readers = window.__checkpointReaders;
            if (readers)
              for (const reader of readers)
                void reader.cancel().catch(() => undefined);
            await window.__checkpointObserverDrain?.();
          });
        } catch (error) {
          drainError = error;
        }
      }
      releaseHold();
      if (waiters.size > 0 || pending.size > 0) latchFailure();
      let cleanupError: unknown;
      try {
        if (!page.isClosed()) {
          try {
            await initDisposable?.dispose();
          } catch (error) {
            cleanupError = error;
          }
          for (const binding of bindingDisposables.reverse()) {
            try {
              await binding.dispose();
            } catch (error) {
              cleanupError ??= error;
            }
          }
        }
      } finally {
        disposed = true;
      }
      if (activeCheckpointObserver === observer)
        activeCheckpointObserver = undefined;
      check();
      if (drainError) throw drainError;
      if (cleanupError) throw cleanupError;
    },
  };
  activeCheckpointObserver = observer;
  return observer;
}

async function expectNoPersistentNote(page: Page, note: string) {
  const persisted = await page.evaluate(() =>
    [
      window.location.href,
      ...Object.values(localStorage),
      ...Object.values(sessionStorage),
    ].join("\n"),
  );
  expect(persisted).not.toContain(note);
}

async function screenshotIfRequested(
  page: Page,
  name: string,
  mask: Locator[],
): Promise<void> {
  const shotDir = process.env["SHOT_DIR"];
  if (!shotDir) return;
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({
    path: join(shotDir, name),
    animations: "disabled",
    mask,
  });
}

test.afterEach(async ({ page }) => {
  try {
    await activeCheckpointObserver?.dispose();
  } catch (error) {
    if (!page.isClosed()) throw error;
  } finally {
    activeCheckpointObserver = undefined;
    cleanupOwnedFiles();
  }
});

test("keyboard request-changes records one exact comment without changing run or checkpoint state", async ({
  page,
}) => {
  const fixture = seedReviewFixture();
  const basePath = seedPath(fixture);
  const note = `Private checkpoint review ${randomUUID()}`;
  const posts = observePosts(page);
  const dispatchesBefore = dispatchSnapshot();
  const observer = await installCheckpointResponseObserver(page, fixture, {
    expectedNote: note,
  });
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(
    page,
    `/index.html${runsHref(fixture.projectId, fixture.run.slug)}`,
  );
  const panel = page.getByRole("region", {
    name: `Checkpoint review ${fixture.beadId}`,
  });
  const noteField = panel.getByRole("textbox", { name: "Review note" });
  const changes = panel.getByRole("button", { name: "Request changes" });
  await expect(noteField).toBeVisible();
  await expect(changes).toBeDisabled();
  expect(posts).toEqual([]);
  await noteField.focus();
  const notePresentation = await noteField.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineWidth: style.outlineWidth,
      outlineStyle: style.outlineStyle,
      horizontalOverflow:
        document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  expect(notePresentation).toMatchObject({
    outlineWidth: "2px",
    outlineStyle: "solid",
    horizontalOverflow: false,
  });

  const marker = await observer.mark();
  await noteField.fill(note);
  await changes.focus();
  await expect(changes).toBeFocused();
  await page.keyboard.press("Enter");

  const [preparedCapture, originalCapture, commitCapture] = await Promise.all([
    observer.waitFor("prepare", marker),
    observer.waitFor("original", marker),
    observer.waitFor("commit", marker),
  ]);

  const prepared = projectCheckpointReviewMetadataSchema.parse(
    preparedCapture.data,
  );
  const prepareBody = projectCheckpointReviewPrepareRequestSchema.parse(
    posts[0]?.body,
  );
  expect(prepareBody).toMatchObject({
    requestId: prepared.requestId,
    expectedEpicId: fixture.epicId,
    expectedRunUpdatedAt: fixture.run.updatedAt,
    decision: "request-changes",
    note,
  });
  const originalRead = projectCheckpointReviewOriginalReadSchema.parse(
    originalCapture.data,
  );
  expect(originalRead.original).toMatchObject({
    requestId: prepared.requestId,
    decision: "request-changes",
    note,
    binding: {
      projectId: fixture.projectId,
      workspacePath: workspace,
      checkout: fixture.run.checkout,
      runSlug: fixture.run.slug,
      epicId: fixture.epicId,
      beadId: fixture.beadId,
      runUpdatedAt: fixture.run.updatedAt,
    },
  });
  expect(
    createHash("sha256")
      .update(projectCheckpointReviewIntentJson(originalRead.original), "utf8")
      .digest("hex"),
  ).toBe(prepared.intentHash);
  const receipt = projectCheckpointReviewReceiptSchema.parse(
    commitCapture.data,
  );
  expect(receipt).toMatchObject({
    requestId: prepared.requestId,
    intentHash: prepared.intentHash,
    state: "confirmed",
    readback: "found",
  });
  expect(posts.map((post) => post.path)).toEqual([
    basePath,
    `${basePath}/${prepared.requestId}/commit`,
  ]);
  expect(posts[1]?.body).toEqual({ intentHash: prepared.intentHash });
  await expect(
    panel
      .getByRole("status")
      .filter({ hasText: "Review comment recorded and verified." }),
  ).toBeVisible();
  await screenshotIfRequested(page, "checkpoint-review-confirmed.png", [
    panel.getByText(`Recorded note: ${note}`, { exact: true }),
  ]);

  const comments = readComments(BD_STAND_IN_STATE)[fixture.beadId] ?? [];
  expect(comments).toHaveLength(1);
  expect(comments[0]).toMatchObject({
    id: receipt.commentId,
    issueId: fixture.beadId,
    text: originalRead.original.commentText,
  });
  expect(comments[0]?.text.split(/\r?\n/).at(-1)).toBe(
    `Forge checkpoint review ${prepared.requestId}`,
  );
  expect(readCallsForComment(fixture.beadId)).toHaveLength(1);
  const events = await commentEvents(page, fixture.beadId);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    workspace,
    beadId: fixture.beadId,
    payload: {
      action: "comment",
      hash: hashText(originalRead.original.commentText),
      length: originalRead.original.commentText.length,
    },
  });
  expect(JSON.stringify(events)).not.toContain(note);
  expectRunAndBeadUnchanged(fixture);
  await expectNoPersistentNote(page, note);
  expectDispatchesUnchanged(dispatchesBefore);
});

test("lost commit reply after comment persistence stays held until explicit exact readback", async ({
  page,
}) => {
  const fixture = seedReviewFixture();
  const basePath = seedPath(fixture);
  const note = `Lost reply checkpoint note ${randomUUID()}`;
  const posts = observePosts(page);
  const dispatchesBefore = dispatchSnapshot();
  const observer = await installCheckpointResponseObserver(page, fixture, {
    expectedNote: note,
    loseCommitReply: true,
  });
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(
    page,
    `/index.html${runsHref(fixture.projectId, fixture.run.slug)}`,
  );
  const panel = page.getByRole("region", {
    name: `Checkpoint review ${fixture.beadId}`,
  });
  await expect(
    panel.getByRole("textbox", { name: "Review note" }),
  ).toBeVisible();
  await panel.getByRole("textbox", { name: "Review note" }).fill(note);
  const initialMarker = await observer.mark();
  await panel.getByRole("button", { name: "Request changes" }).click();
  await expect(panel.getByRole("alert")).toContainText(
    "Read this exact original before continuing",
  );
  await expect(
    panel.getByRole("button", { name: "Request changes" }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: "Check recorded comment" }),
  ).toHaveCount(0);
  await Promise.all([
    observer.waitFor("prepare", initialMarker),
    observer.waitFor("commit", initialMarker),
  ]);
  const prepared = observer.prepared();
  const lost = observer.commit();
  if (!prepared || !lost)
    throw Error(
      "The real prepare/unknown commit observations were not captured.",
    );
  expect(lost.requestId).toBe(prepared.requestId);
  expect(lost.intentHash).toBe(prepared.intentHash);
  expect(lost.state).toBe("unknown");
  const commentsAfterLostReply =
    readComments(BD_STAND_IN_STATE)[fixture.beadId] ?? [];
  expect(commentsAfterLostReply).toHaveLength(1);
  expect(commentsAfterLostReply[0]?.text).toContain(note);
  expect(commentsAfterLostReply[0]?.text.split(/\r?\n/).at(-1)).toBe(
    `Forge checkpoint review ${prepared.requestId}`,
  );
  expect(readCallsForComment(fixture.beadId)).toHaveLength(1);
  expectFaultConsumed();
  expect(await commentEvents(page, fixture.beadId)).toHaveLength(0);
  await screenshotIfRequested(page, "checkpoint-review-unknown-held.png", [
    panel.getByRole("textbox", { name: "Review note" }),
  ]);
  expect(posts.map((post) => post.path)).toEqual([
    basePath,
    `${basePath}/${prepared.requestId}/commit`,
  ]);
  await expectNoPersistentNote(page, note);

  const reloadMarker = await observer.mark();
  await reloadSettled(page);
  const historyCapture = await observer.waitFor("history", reloadMarker, true);
  const history = projectCheckpointReviewMetadataReadSchema.parse(
    historyCapture.data,
  );
  expect(history).toMatchObject({
    activeRequestId: prepared.requestId,
    items: [
      {
        requestId: prepared.requestId,
        intentHash: prepared.intentHash,
        state: "unknown",
      },
    ],
  });
  expect(posts.map((post) => post.path)).toEqual([
    basePath,
    `${basePath}/${prepared.requestId}/commit`,
  ]);

  const restoredPanel = page.getByRole("region", {
    name: `Checkpoint review ${fixture.beadId}`,
  });
  const saved = restoredPanel.locator("details");
  await saved.locator("summary").click();
  const originalMarker = await observer.mark();
  await saved.getByRole("button", { name: "Read saved decision" }).click();
  const originalCapture = await observer.waitFor("original", originalMarker);
  const savedOriginal = projectCheckpointReviewOriginalReadSchema.parse(
    originalCapture.data,
  );
  if (!savedOriginal)
    throw Error("The explicit protected-original capture was unavailable.");
  expect(savedOriginal).toMatchObject({
    metadata: {
      requestId: prepared.requestId,
      intentHash: prepared.intentHash,
      state: "unknown",
    },
    original: {
      requestId: prepared.requestId,
      intentHash: prepared.intentHash,
      decision: "request-changes",
      note,
      binding: {
        projectId: fixture.projectId,
        workspacePath: workspace,
        checkout: fixture.run.checkout,
        runSlug: fixture.run.slug,
        epicId: fixture.epicId,
        beadId: fixture.beadId,
        runUpdatedAt: fixture.run.updatedAt,
      },
    },
    receipt: {
      requestId: prepared.requestId,
      intentHash: prepared.intentHash,
      state: "unknown",
    },
  });
  expect(
    createHash("sha256")
      .update(projectCheckpointReviewIntentJson(savedOriginal.original), "utf8")
      .digest("hex"),
  ).toBe(prepared.intentHash);
  expect(savedOriginal.original.commentText.split(/\r?\n/).at(-1)).toBe(
    `Forge checkpoint review ${prepared.requestId}`,
  );
  await expect(restoredPanel.getByText(`Recorded note: ${note}`)).toBeVisible();
  const readbackMarker = await observer.mark();
  await restoredPanel
    .getByRole("button", { name: "Check recorded comment" })
    .click();
  const readbackCapture = await observer.waitFor("readback", readbackMarker);
  const confirmed = projectCheckpointReviewReceiptSchema.parse(
    readbackCapture.data,
  );
  expect(confirmed).toMatchObject({
    requestId: prepared.requestId,
    intentHash: prepared.intentHash,
    state: "confirmed",
    readback: "found",
    commentId: readComments(BD_STAND_IN_STATE)[fixture.beadId]?.[0]?.id,
  });
  expect(posts.map((post) => post.path)).toEqual([
    basePath,
    `${basePath}/${prepared.requestId}/commit`,
    `${basePath}/${prepared.requestId}/readback`,
  ]);
  expect(readCallsForComment(fixture.beadId)).toHaveLength(1);
  const comments = readComments(BD_STAND_IN_STATE)[fixture.beadId] ?? [];
  expect(comments).toHaveLength(1);
  expect(comments[0]?.text).toBe(savedOriginal.original.commentText);
  const events = await commentEvents(page, fixture.beadId);
  expect(events).toHaveLength(1);
  expect(JSON.stringify(events)).not.toContain(note);
  expectRunAndBeadUnchanged(fixture);
  await expectNoPersistentNote(page, note);
  expectDispatchesUnchanged(dispatchesBefore);
});

test("prepared checkpoint review survives a run switch and reload but needs an explicit record action", async ({
  page,
}) => {
  const fixture = seedReviewFixture(true);
  const secondRun = fixture.secondRun;
  if (!secondRun) throw Error("The second scoped run fixture was not created.");
  const basePath = seedPath(fixture);
  const note = `Prepared recovery note ${randomUUID()}`;
  const posts = observePosts(page);
  const dispatchesBefore = dispatchSnapshot();
  const observer = await installCheckpointResponseObserver(page, fixture, {
    expectedNote: note,
    holdOriginal: true,
  });
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(
    page,
    `/index.html${runsHref(fixture.projectId, fixture.run.slug)}`,
  );
  const firstPanel = page.getByRole("region", {
    name: `Checkpoint review ${fixture.beadId}`,
  });
  await firstPanel.getByRole("textbox", { name: "Review note" }).fill(note);
  const prepareMarker = await observer.mark();
  await firstPanel.getByRole("button", { name: "Request changes" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__checkpointOriginalHeld))
    .toBe(true);
  await Promise.all([
    observer.waitFor("prepare", prepareMarker),
    observer.waitFor("original", prepareMarker),
  ]);
  const saved = observer.original();
  if (
    !saved ||
    saved.metadata.state !== "prepared" ||
    saved.original.note !== note
  )
    throw Error(
      "The held actual original read did not match the prepared note.",
    );
  expect(posts.map((post) => post.path)).toEqual([basePath]);

  await page.getByRole("link", { name: "All runs", exact: true }).click();
  await page
    .getByRole("table", { name: "Recorded forge runs" })
    .getByRole("link", {
      name: secondRun.feature ?? secondRun.slug,
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: secondRun.feature ?? secondRun.slug,
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText(note);
  observer.setPhase("post-release");
  const postReleaseMarker = await observer.mark();
  const historyUrl = new URL(basePath, DASHBOARD_URL).href;
  let releaseHistoryRoute!: () => void;
  const historyRouteGate = new Promise<void>(
    (resolve) => (releaseHistoryRoute = resolve),
  );
  let resolveHistoryRoute!: () => void;
  let rejectHistoryRoute!: (error: Error) => void;
  const historyRouteReached = new Promise<void>((resolve, reject) => {
    resolveHistoryRoute = resolve;
    rejectHistoryRoute = reject;
  });
  void historyRouteReached.catch(() => undefined);
  let resolveHistoryRouteDone!: () => void;
  const historyRouteDone = new Promise<void>(
    (resolve) => (resolveHistoryRouteDone = resolve),
  );
  let historyRouteClaimed = false;
  let historyRouteTimer: ReturnType<typeof setTimeout> | undefined;
  let routedHistoryMetadata: ReturnType<
    typeof observer.diagnosticSnapshot
  >["pending"] = [];
  const historyRoute = async (route: Route) => {
    if (historyRouteClaimed || route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    historyRouteClaimed = true;
    routedHistoryMetadata = observer
      .diagnosticSnapshot()
      .pending.filter(
        (entry) =>
          entry.phase === "post-release" &&
          entry.kind === "history" &&
          entry.epoch === postReleaseMarker.epoch &&
          entry.sequence > postReleaseMarker.sequence,
      );
    resolveHistoryRoute();
    try {
      await historyRouteGate;
      await route.continue();
    } catch {
      // Reload may abort the held fetch before the gate is released.
    } finally {
      resolveHistoryRouteDone();
    }
  };
  await page.route(historyUrl, historyRoute);
  try {
    await observer.releaseOriginal();
    await expect
      .poll(() => page.evaluate(() => window.__checkpointOriginalReleased))
      .toBe(true);
    historyRouteTimer = setTimeout(
      () =>
        rejectHistoryRoute(
          Error("The exact history GET was not routed within 10 seconds."),
        ),
      10_000,
    );
    await historyRouteReached;
    expect(routedHistoryMetadata).toHaveLength(1);
    const orphanCandidate = routedHistoryMetadata[0];
    if (!orphanCandidate)
      throw Error("The gated history GET had no observer metadata.");
    expect(posts.map((post) => post.path)).toEqual([basePath]);
    const historyWait = observer.waitFor("history", postReleaseMarker);
    void historyWait.catch(() => undefined);
    releaseHistoryRoute();
    const historyCapture = await historyWait;
    expect(historyCapture.sequence).toBe(orphanCandidate.sequence);
    expect(historyCapture.epoch).toBe(orphanCandidate.epoch);
    await page.evaluate(() => window.__checkpointObserverDrain?.());
    const pendingBeforeReload = observer.diagnosticSnapshot().pending;
    expect(pendingBeforeReload).not.toContainEqual(orphanCandidate);
    await reloadSettled(page);
    await expect
      .poll(() => observer.diagnosticSnapshot().epoch)
      .toBeGreaterThan(postReleaseMarker.epoch);
    const pendingAfterReload = observer.diagnosticSnapshot().pending;
    expect(pendingAfterReload).not.toContainEqual(orphanCandidate);
  } finally {
    if (historyRouteTimer) clearTimeout(historyRouteTimer);
    releaseHistoryRoute();
    await page.unroute(historyUrl, historyRoute);
    if (historyRouteClaimed) {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          historyRouteDone,
          new Promise<void>((_, reject) => {
            cleanupTimer = setTimeout(
              () =>
                reject(
                  Error(
                    "The held history route did not settle within 10 seconds.",
                  ),
                ),
              10_000,
            );
          }),
        ]);
      } finally {
        if (cleanupTimer) clearTimeout(cleanupTimer);
      }
    }
    if (!page.isClosed())
      await page.evaluate(() => window.__checkpointObserverDrain?.());
  }
  await expect(
    page.getByRole("heading", {
      name: secondRun.feature ?? secondRun.slug,
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("link", { name: "All runs", exact: true }).click();
  await page
    .getByRole("table", { name: "Recorded forge runs" })
    .getByRole("link", {
      name: fixture.run.feature ?? fixture.run.slug,
      exact: true,
    })
    .click();
  const restoredPanel = page.getByRole("region", {
    name: `Checkpoint review ${fixture.beadId}`,
  });
  const savedReviews = restoredPanel.locator("details");
  await savedReviews.locator("summary").click();
  const originalMarker = await observer.mark();
  await savedReviews
    .getByRole("button", { name: "Read saved decision" })
    .click();
  const restoredOriginal = await observer.waitFor("original", originalMarker);
  expect(restoredOriginal.data).toMatchObject({
    original: {
      requestId: saved.original.requestId,
      intentHash: saved.original.intentHash,
    },
  });
  await expect(restoredPanel.getByText(`Recorded note: ${note}`)).toBeVisible();
  await screenshotIfRequested(
    page,
    "checkpoint-review-prepared-recovered.png",
    [restoredPanel.getByText(`Recorded note: ${note}`, { exact: true })],
  );
  expect(posts.map((post) => post.path)).toEqual([basePath]);
  const commitMarker = await observer.mark();
  await restoredPanel
    .getByRole("button", { name: "Record saved decision" })
    .click();
  const commitCapture = await observer.waitFor("commit", commitMarker);
  const receipt = projectCheckpointReviewReceiptSchema.parse(
    commitCapture.data,
  );
  expect(receipt).toMatchObject({
    requestId: saved.original.requestId,
    intentHash: saved.original.intentHash,
    state: "confirmed",
    readback: "found",
  });
  expect(posts.map((post) => post.path)).toEqual([
    basePath,
    `${basePath}/${saved.original.requestId}/commit`,
  ]);
  expect(readCallsForComment(fixture.beadId)).toHaveLength(1);
  const comments = readComments(BD_STAND_IN_STATE)[fixture.beadId] ?? [];
  expect(comments).toHaveLength(1);
  expect(comments[0]?.text).toBe(saved.original.commentText);
  expect(await commentEvents(page, fixture.beadId)).toHaveLength(1);
  expectRunAndBeadUnchanged(fixture);
  await expectNoPersistentNote(page, note);
  expectDispatchesUnchanged(dispatchesBefore);
});
