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
import { expect, type Locator, type Page, test } from "@playwright/test";
import { runsHref } from "../../apps/desktop/src/project-runs-model";
import type { ForgeState } from "../../scripts/forge/phases";
import { hashText } from "../../scripts/hash-text";
import { writeOwnerOnly } from "../../scripts/hearth/token";
import { queryEvents } from "../../scripts/ledger/query";
import type { LedgerEvent } from "../../types/hearth";
import {
  projectCheckpointReviewHashRequestSchema,
  projectCheckpointReviewIntentJson,
  projectCheckpointReviewMetadataReadSchema,
  projectCheckpointReviewMetadataSchema,
  projectCheckpointReviewOriginalReadSchema,
  projectCheckpointReviewPrepareRequestSchema,
  projectCheckpointReviewReceiptSchema,
} from "../../types/project-checkpoint-reviews";
import {
  readComments,
  readState,
  withStateLock,
  writeState,
} from "../e2e/bd-stand-in-state";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { BD_STAND_IN_STATE, HEARTH_HOME } from "../e2e/servers";
import { captureTextResponseThroughBrowserFetch } from "./browser-response-capture";
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
  epicId: string;
  beadId: string;
  run: ForgeState;
  runBytes: string;
  secondRun?: ForgeState;
};

declare global {
  interface Window {
    __checkpointReviewObserve?: (observation: unknown) => Promise<void>;
    __checkpointCancelCloneReads?: () => void;
    __checkpointDrainCloneReads?: () => Promise<void>;
    __releaseCheckpointOriginal?: () => Promise<void>;
    __checkpointOriginalHeld?: boolean;
    __checkpointOriginalReleased?: boolean;
    __restoreCheckpointFetch?: () => Promise<void>;
  }
}

function seedReviewFixture(secondRun = false): ReviewFixture {
  const project = seedCouncilProject();
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
    epicId,
    beadId,
    run,
    runBytes,
    ...(second ? { secondRun: second } : {}),
  };
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

function commentEvents(
  beadId: string,
): Extract<LedgerEvent, { kind: "bead.transitioned" }>[] {
  return queryEvents(
    { workspace, beadId, beadExact: true, kinds: ["bead.transitioned"] },
    { path: join(HEARTH_HOME, "ledger.db") },
  ).filter(
    (event): event is Extract<LedgerEvent, { kind: "bead.transitioned" }> =>
      event.kind === "bead.transitioned" &&
      "action" in event.payload &&
      event.payload.action === "comment",
  );
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
    expect(existsSync(path) ? readFileSync(path, "utf8") : null).toBe(bytes);
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
  writeOwnerOnly(faultFile, bytes);
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

async function installLostCommitHook(
  page: Page,
  fixture: ReviewFixture,
  expectedNote: string,
) {
  let metadata:
    | ReturnType<typeof projectCheckpointReviewMetadataSchema.parse>
    | undefined;
  let lostReceipt:
    | ReturnType<typeof projectCheckpointReviewReceiptSchema.parse>
    | undefined;
  await page.exposeFunction(
    "__checkpointReviewObserve",
    (observation: unknown) => {
      if (typeof observation !== "object" || observation === null)
        throw Error(
          "The native checkpoint review hook returned no observation.",
        );
      if (
        !("kind" in observation) ||
        !("status" in observation) ||
        !("path" in observation)
      )
        throw Error(
          "The native checkpoint review hook observation was incomplete.",
        );
      if (observation.kind === "prepare") {
        if (!("requestBody" in observation) || !("envelope" in observation))
          throw Error(
            "The prepared checkpoint review observation was incomplete.",
          );
        const request = projectCheckpointReviewPrepareRequestSchema.parse(
          observation.requestBody,
        );
        expect(request.decision).toBe("request-changes");
        expect(request.note).toBe(expectedNote);
        expect(request.expectedEpicId).toBe(fixture.epicId);
        const prepared = projectCheckpointReviewMetadataSchema.parse(
          envelopeData(observation.envelope),
        );
        expect(observation.status).toBe(200);
        expect(observation.path).toBe(seedPath(fixture));
        expect(prepared.requestId).toBe(request.requestId);
        expect(prepared.scope).toMatchObject({
          projectId: fixture.projectId,
          workspacePath: workspace,
          runSlug: fixture.run.slug,
          beadId: fixture.beadId,
        });
        expect(prepared.state).toBe("prepared");
        metadata = prepared;
        ownFault(fixture.beadId, request.requestId);
        return;
      }
      if (
        observation.kind !== "lost-commit" ||
        !("requestBody" in observation) ||
        !("envelope" in observation)
      )
        throw Error(
          "The lost checkpoint commit observation had an unexpected kind.",
        );
      const prepared = metadata;
      if (!prepared)
        throw Error(
          "The commit was reached before the actual prepare response.",
        );
      const request = projectCheckpointReviewHashRequestSchema.parse(
        observation.requestBody,
      );
      expect(observation.status).toBe(200);
      expect(observation.path).toBe(
        `${seedPath(fixture)}/${prepared.requestId}/commit`,
      );
      expect(request.intentHash).toBe(prepared.intentHash);
      const receipt = projectCheckpointReviewReceiptSchema.parse(
        envelopeData(observation.envelope),
      );
      expect(receipt).toMatchObject({
        requestId: prepared.requestId,
        intentHash: prepared.intentHash,
        state: "unknown",
        readback: "not-checked",
        commentId: null,
      });
      lostReceipt = receipt;
    },
  );
  await page.addInitScript(
    (config: { basePath: string }) => {
      const originalFetch = window.fetch;
      let preparedId: string | null = null;
      let dropped = false;
      const activeReads = new Set<{ cancel(): void; done: Promise<void> }>();
      window.__checkpointCancelCloneReads = () => {
        for (const read of activeReads) read.cancel();
      };
      window.__checkpointDrainCloneReads = async () => {
        await Promise.all([...activeReads].map((read) => read.done));
      };
      const cloneJsonBounded = async (response: Response): Promise<unknown> => {
        const reader = response.clone().body?.getReader();
        if (!reader) throw Error("The actual checkpoint response had no body.");
        let finish!: () => void;
        const done = new Promise<void>((resolve) => (finish = resolve));
        const activeRead = { cancel: () => {}, done };
        activeRead.cancel = () => void reader.cancel().catch(() => undefined);
        activeReads.add(activeRead);
        let timer = 0;
        const read = async (): Promise<unknown> => {
          const decoder = new TextDecoder("utf-8", { fatal: true });
          let text = "";
          let size = 0;
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 64 * 1024)
              throw Error("The actual checkpoint response exceeded its limit.");
            text += decoder.decode(part.value, { stream: true });
          }
          text += decoder.decode();
          try {
            const value: unknown = JSON.parse(text);
            return value;
          } catch {
            throw Error("The actual checkpoint response was invalid JSON.");
          }
        };
        const timeout = new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => {
            activeRead.cancel();
            reject(Error("The actual checkpoint response read timed out."));
          }, 10_000);
        });
        try {
          return await Promise.race([read(), timeout]);
        } finally {
          window.clearTimeout(timer);
          activeRead.cancel();
          try {
            reader.releaseLock();
          } catch {
            // A canceled pending read can release the clone branch first.
          }
          activeReads.delete(activeRead);
          finish();
        }
      };
      const wrapper = Object.assign(
        async function (
          this: Window,
          ...args: Parameters<typeof originalFetch>
        ) {
          const [input, init] = args;
        const request =
          input instanceof Request && init === undefined
            ? input.clone()
            : new Request(input, init);
        const url = new URL(request.url);
        const method = request.method.toUpperCase();
        const bodyText = method === "POST" ? await request.clone().text() : "";
        const response = await Reflect.apply(originalFetch, this, [
          input,
          init,
        ]);
        if (url.origin !== window.location.origin) return response;
        if (method === "POST" && url.pathname === config.basePath) {
          const envelope = await cloneJsonBounded(response);
          let requestBody: unknown;
          try {
            requestBody = JSON.parse(bodyText);
          } catch {
            throw Error("The actual prepare request was not JSON.");
          }
          await window.__checkpointReviewObserve?.({
            kind: "prepare",
            status: response.status,
            path: url.pathname,
            requestBody,
            envelope,
          });
          if (
            typeof envelope === "object" &&
            envelope !== null &&
            "data" in envelope &&
            typeof envelope.data === "object" &&
            envelope.data !== null &&
            "requestId" in envelope.data &&
            typeof envelope.data.requestId === "string"
          )
            preparedId = envelope.data.requestId;
        }
        if (
          !dropped &&
          preparedId !== null &&
          method === "POST" &&
          url.pathname === `${config.basePath}/${preparedId}/commit`
        ) {
          const envelope = await cloneJsonBounded(response);
          let requestBody: unknown;
          try {
            requestBody = JSON.parse(bodyText);
          } catch {
            throw Error("The actual commit request was not JSON.");
          }
          await window.__checkpointReviewObserve?.({
            kind: "lost-commit",
            status: response.status,
            path: url.pathname,
            requestBody,
            envelope,
          });
          dropped = true;
          if (window.fetch === wrapper) window.fetch = originalFetch;
          throw new TypeError("Failed to fetch");
        }
        return response;
      },
        originalFetch,
      );
      window.__restoreCheckpointFetch = async () => {
        if (window.fetch === wrapper) window.fetch = originalFetch;
        window.__checkpointCancelCloneReads?.();
        await window.__checkpointDrainCloneReads?.();
      };
      window.fetch = wrapper;
    },
    { basePath: seedPath(fixture) },
  );
  return {
    prepared: () => metadata,
    lost: () => lostReceipt,
  };
}

async function installOriginalReadHold(page: Page, fixture: ReviewFixture) {
  let preparedId: string | null = null;
  let heldOriginal:
    | ReturnType<typeof projectCheckpointReviewOriginalReadSchema.parse>
    | undefined;
  await page.exposeFunction(
    "__checkpointReviewObserve",
    (observation: unknown) => {
      if (typeof observation !== "object" || observation === null)
        throw Error("The native checkpoint read hook returned no observation.");
      if (
        !("kind" in observation) ||
        !("status" in observation) ||
        !("path" in observation) ||
        !("envelope" in observation)
      )
        throw Error(
          "The native checkpoint read hook observation was incomplete.",
        );
      if (observation.kind === "prepare") {
        if (!("requestBody" in observation))
          throw Error(
            "The prepared checkpoint observation omitted its request.",
          );
        const request = projectCheckpointReviewPrepareRequestSchema.parse(
          observation.requestBody,
        );
        const prepared = projectCheckpointReviewMetadataSchema.parse(
          envelopeData(observation.envelope),
        );
        expect(observation.status).toBe(200);
        expect(observation.path).toBe(seedPath(fixture));
        expect(request.requestId).toBe(prepared.requestId);
        expect(prepared.state).toBe("prepared");
        preparedId = prepared.requestId;
        return;
      }
      if (observation.kind !== "protected-original")
        throw Error("The original-read hook observed an unexpected request.");
      if (
        !preparedId ||
        observation.path !== `${seedPath(fixture)}/${preparedId}`
      )
        throw Error(
          "The held original read did not match the actual prepared UUID.",
        );
      heldOriginal = projectCheckpointReviewOriginalReadSchema.parse(
        envelopeData(observation.envelope),
      );
      expect(observation.status).toBe(200);
      expect(heldOriginal.original.requestId).toBe(preparedId);
      expect(heldOriginal.original.binding).toMatchObject({
        projectId: fixture.projectId,
        workspacePath: workspace,
        checkout: fixture.run.checkout,
        runSlug: fixture.run.slug,
        beadId: fixture.beadId,
      });
      expect(
        createHash("sha256")
          .update(
            projectCheckpointReviewIntentJson(heldOriginal.original),
            "utf8",
          )
          .digest("hex"),
      ).toBe(heldOriginal.original.intentHash);
    },
  );
  await page.addInitScript(
    (config: { basePath: string }) => {
      const originalFetch = window.fetch;
      let preparedId: string | null = null;
      let hasHeld = false;
      const activeReads = new Set<{ cancel(): void; done: Promise<void> }>();
      window.__checkpointCancelCloneReads = () => {
        for (const read of activeReads) read.cancel();
      };
      window.__checkpointDrainCloneReads = async () => {
        await Promise.all([...activeReads].map((read) => read.done));
      };
      const cloneJsonBounded = async (response: Response): Promise<unknown> => {
        const reader = response.clone().body?.getReader();
        if (!reader) throw Error("The actual checkpoint response had no body.");
        let finish!: () => void;
        const done = new Promise<void>((resolve) => (finish = resolve));
        const activeRead = { cancel: () => {}, done };
        activeRead.cancel = () => void reader.cancel().catch(() => undefined);
        activeReads.add(activeRead);
        let timer = 0;
        const read = async (): Promise<unknown> => {
          const decoder = new TextDecoder("utf-8", { fatal: true });
          let text = "";
          let size = 0;
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 64 * 1024)
              throw Error("The actual checkpoint response exceeded its limit.");
            text += decoder.decode(part.value, { stream: true });
          }
          text += decoder.decode();
          try {
            const value: unknown = JSON.parse(text);
            return value;
          } catch {
            throw Error("The actual checkpoint response was invalid JSON.");
          }
        };
        const timeout = new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => {
            activeRead.cancel();
            reject(Error("The actual checkpoint response read timed out."));
          }, 10_000);
        });
        try {
          return await Promise.race([read(), timeout]);
        } finally {
          window.clearTimeout(timer);
          activeRead.cancel();
          try {
            reader.releaseLock();
          } catch {
            // A canceled pending read can release the clone branch first.
          }
          activeReads.delete(activeRead);
          finish();
        }
      };
      let release!: () => void;
      let finishHeld!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const heldDrained = new Promise<void>((resolve) => {
        finishHeld = resolve;
      });
      window.__checkpointOriginalHeld = false;
      window.__checkpointOriginalReleased = false;
      window.__releaseCheckpointOriginal = async () => {
        release();
        if (hasHeld) await heldDrained;
      };
      const wrapper = Object.assign(
        async function (
          this: Window,
          ...args: Parameters<typeof originalFetch>
        ) {
          const [input, init] = args;
        const request =
          input instanceof Request && init === undefined
            ? input.clone()
            : new Request(input, init);
        const url = new URL(request.url);
        const method = request.method.toUpperCase();
        const response = await Reflect.apply(originalFetch, this, [
          input,
          init,
        ]);
        if (url.origin !== window.location.origin) return response;
        if (method === "POST" && url.pathname === config.basePath) {
          const envelope = await cloneJsonBounded(response);
          let requestBody: unknown;
          try {
            requestBody = JSON.parse(await request.clone().text());
          } catch {
            throw Error("The actual prepare request was not JSON.");
          }
          await window.__checkpointReviewObserve?.({
            kind: "prepare",
            status: response.status,
            path: url.pathname,
            requestBody,
            envelope,
          });
          if (
            typeof envelope === "object" &&
            envelope !== null &&
            "data" in envelope &&
            typeof envelope.data === "object" &&
            envelope.data !== null &&
            "requestId" in envelope.data &&
            typeof envelope.data.requestId === "string"
          )
            preparedId = envelope.data.requestId;
        }
        if (
          !hasHeld &&
          preparedId !== null &&
          method === "GET" &&
          url.pathname === `${config.basePath}/${preparedId}`
        ) {
          const envelope = await cloneJsonBounded(response);
          await window.__checkpointReviewObserve?.({
            kind: "protected-original",
            status: response.status,
            path: url.pathname,
            envelope,
          });
          hasHeld = true;
          window.__checkpointOriginalHeld = true;
          await gate;
          window.__checkpointOriginalReleased = true;
          if (window.fetch === wrapper) window.fetch = originalFetch;
          finishHeld();
        }
        return response;
      },
        originalFetch,
      );
      window.__restoreCheckpointFetch = async () => {
        if (window.fetch === wrapper) window.fetch = originalFetch;
        window.__checkpointCancelCloneReads?.();
        await window.__checkpointDrainCloneReads?.();
      };
      window.fetch = wrapper;
    },
    { basePath: seedPath(fixture) },
  );
  return { original: () => heldOriginal };
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
    await page.evaluate(async () => {
      await window.__releaseCheckpointOriginal?.();
      await window.__restoreCheckpointFetch?.();
      await window.__checkpointDrainCloneReads?.();
    });
  } catch (error) {
    if (!page.isClosed()) throw error;
  }
  cleanupOwnedFiles();
});

test("keyboard request-changes records one exact comment without changing run or checkpoint state", async ({
  page,
}) => {
  const fixture = seedReviewFixture();
  const basePath = seedPath(fixture);
  const note = `Private checkpoint review ${randomUUID()}`;
  const posts = observePosts(page);
  const dispatchesBefore = dispatchSnapshot();
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

  const preparedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === basePath,
  );
  const originalResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname.startsWith(`${basePath}/`) &&
      !new URL(response.url()).pathname.endsWith("/commit") &&
      !new URL(response.url()).pathname.endsWith("/readback") &&
      !new URL(response.url()).pathname.endsWith("/retire"),
  );
  const commitResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/commit"),
  );
  await noteField.fill(note);
  await changes.focus();
  await expect(changes).toBeFocused();
  await page.keyboard.press("Enter");

  const prepared = projectCheckpointReviewMetadataSchema.parse(
    envelopeData(await (await preparedResponse).json()),
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
    envelopeData(await (await originalResponse).json()),
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
    envelopeData(await (await commitResponse).json()),
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
  const events = commentEvents(fixture.beadId);
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
  const hook = await installLostCommitHook(page, fixture, note);
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
  await panel.getByRole("button", { name: "Request changes" }).click();
  await expect(
    panel.getByRole("button", { name: "Check recorded comment" }),
  ).toBeVisible();
  const prepared = hook.prepared();
  const lost = hook.lost();
  if (!prepared || !lost)
    throw Error(
      "The real prepare/unknown commit observations were not captured.",
    );
  expect(lost.requestId).toBe(prepared.requestId);
  expect(lost.intentHash).toBe(prepared.intentHash);
  expect(lost.state).toBe("unknown");
  expect(readComments(BD_STAND_IN_STATE)[fixture.beadId]).toHaveLength(1);
  expectFaultConsumed();
  expect(commentEvents(fixture.beadId)).toHaveLength(0);
  await screenshotIfRequested(page, "checkpoint-review-unknown-held.png", [
    panel.getByRole("textbox", { name: "Review note" }),
  ]);
  expect(posts.map((post) => post.path)).toEqual([
    basePath,
    `${basePath}/${prepared.requestId}/commit`,
  ]);
  await expectNoPersistentNote(page, note);

  const historyResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === basePath,
  );
  await reloadSettled(page);
  const history = projectCheckpointReviewMetadataReadSchema.parse(
    envelopeData(await (await historyResponse).json()),
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
  const savedOriginalCapture = await captureTextResponseThroughBrowserFetch(
    page,
    {
      method: "GET",
      origin: new URL(page.url()).origin,
      path: `${basePath}/${prepared.requestId}`,
    },
  );
  let savedOriginal:
    | ReturnType<typeof projectCheckpointReviewOriginalReadSchema.parse>
    | undefined;
  try {
    await saved.getByRole("button", { name: "Read saved decision" }).click();
    const captured = await savedOriginalCapture.response;
    expect(captured.status).toBe(200);
    const capturedEnvelope: unknown = JSON.parse(captured.text);
    savedOriginal = projectCheckpointReviewOriginalReadSchema.parse(
      envelopeData(capturedEnvelope),
    );
  } finally {
    await savedOriginalCapture.dispose();
  }
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
  const readbackResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        `${basePath}/${prepared.requestId}/readback`,
  );
  await restoredPanel
    .getByRole("button", { name: "Check recorded comment" })
    .click();
  const confirmed = projectCheckpointReviewReceiptSchema.parse(
    envelopeData(await (await readbackResponse).json()),
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
  expect(commentEvents(fixture.beadId)).toHaveLength(1);
  expect(JSON.stringify(commentEvents(fixture.beadId))).not.toContain(note);
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
  const hook = await installOriginalReadHold(page, fixture);
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
  await firstPanel.getByRole("button", { name: "Request changes" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__checkpointOriginalHeld))
    .toBe(true);
  const saved = hook.original();
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
  await page.evaluate(() => window.__releaseCheckpointOriginal?.());
  await expect
    .poll(() => page.evaluate(() => window.__checkpointOriginalReleased))
    .toBe(true);
  expect(posts.map((post) => post.path)).toEqual([basePath]);
  await reloadSettled(page);
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
  await savedReviews
    .getByRole("button", { name: "Read saved decision" })
    .click();
  await expect(restoredPanel.getByText(`Recorded note: ${note}`)).toBeVisible();
  await screenshotIfRequested(
    page,
    "checkpoint-review-prepared-recovered.png",
    [restoredPanel.getByText(`Recorded note: ${note}`, { exact: true })],
  );
  expect(posts.map((post) => post.path)).toEqual([basePath]);
  const commitResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        `${basePath}/${saved.original.requestId}/commit`,
  );
  await restoredPanel
    .getByRole("button", { name: "Record saved decision" })
    .click();
  const receipt = projectCheckpointReviewReceiptSchema.parse(
    envelopeData(await (await commitResponse).json()),
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
  expect(commentEvents(fixture.beadId)).toHaveLength(1);
  expectRunAndBeadUnchanged(fixture);
  await expectNoPersistentNote(page, note);
  expectDispatchesUnchanged(dispatchesBefore);
});
