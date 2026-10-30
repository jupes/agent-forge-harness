import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";
import { runsHref } from "../../apps/desktop/src/project-runs-model";
import { reviewCommentFor } from "../../scripts/dashboard/forge-run-model";
import type { ForgeState } from "../../scripts/forge/phases";
import { hashText } from "../../scripts/hash-text";
import { OPERATOR_HEADER } from "../../scripts/hearth/paths";
import { projectCheckpointReviewPrepareRequestSchema } from "../../types/project-checkpoint-reviews";
import { projectCouncilReserveRequestSchema } from "../../types/project-council";
import {
  readComments,
  readState,
  withStateLock,
  writeState,
} from "../e2e/bd-stand-in-state";
import { openSettled } from "../e2e/fixtures";
import { pageToken } from "../e2e/launch-link";
import { BD_STAND_IN_STATE, HEARTH_HOME } from "../e2e/servers";
import { seedCouncilProject } from "./council-fixtures";
import { workspace } from "./project-fixtures";

const controlFile = join(HEARTH_HOME, "council-fixture-control.json");
const callsFile = join(HEARTH_HOME, "council-fixture-calls.jsonl");
const dispatchFiles = [
  "codex-fixture-calls.jsonl",
  "gemini-fixture-calls.jsonl",
  "codex-chat-fixture-calls.jsonl",
  "gemini-chat-fixture-calls.json",
  "keeper-fixture-starts.jsonl",
  "coding-fixture-starts.jsonl",
] as const;
const ownedRunFiles: Array<{ path: string; root: string; bytes: Buffer }> = [];
type Fixture = {
  projectId: string;
  epicId: string;
  beadA: string;
  beadB: string;
  runA: ForgeState;
  runB: ForgeState;
};
type CapturedPost = { path: string; body: unknown };
const callLogRowSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("admission"),
      caseId: z.literal("idle"),
      mode: z.literal("success"),
      profileId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("request"),
      caseId: z.literal("idle"),
      mode: z.literal("success"),
      runId: z.string().min(1),
      stage: z.string().min(1),
      seatId: z.string().min(1),
    })
    .strict(),
]);
const requestIdSchema = z
  .uuid()
  .refine((value) => value === value.toLowerCase());

function inside(root: string, path: string): void {
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw Error("The Council return fixture path escaped its owned root.");
}

function seedFixture(): Fixture {
  const project = seedCouncilProject();
  const epicId = project.workspaces[0]?.epicIds[0];
  if (!epicId) throw Error("The fresh Council project has no Beads epic.");
  const marker = randomUUID().replaceAll("-", "").slice(0, 10);
  const beadA = `${epicId}.return-${marker}-a`;
  const beadB = `${epicId}.return-${marker}-b`;
  withStateLock(BD_STAND_IN_STATE, () => {
    const state = readState(BD_STAND_IN_STATE);
    if (state[epicId]?.issue_type !== "epic")
      throw Error("The fresh Beads epic is unavailable.");
    for (const [id, suffix] of [
      [beadA, "A"],
      [beadB, "B"],
    ] as const) {
      state[id] = {
        id,
        title: `Checkpoint return ${marker} ${suffix}`,
        issue_type: "task",
        status: "in_progress",
        priority: 2,
        labels: [`project:${project.slug}`],
        created_at: "2026-10-29T17:00:00.000Z",
        updated_at: "2026-10-29T17:00:00.000Z",
        dependencies: [
          { issue_id: id, depends_on_id: epicId, type: "parent-child" },
        ],
      };
    }
    writeState(BD_STAND_IN_STATE, state);
  });

  const checkout = realpathSync.native(process.cwd());
  const root = resolve(checkout, ".tmp", "work", "forge-runs");
  mkdirSync(root, { recursive: true });
  const runA: ForgeState = {
    schemaVersion: 2,
    slug: `checkpoint-return-${marker}-review-alpha`,
    feature: `Checkpoint return ${marker} review alpha`,
    epic: epicId,
    phase: "plan",
    completed: ["research", "plan"],
    artifacts: {},
    mode: "gated",
    checkout,
    updatedAt: "2026-10-29T18:00:00.000Z",
  };
  const runB: ForgeState = {
    ...runA,
    slug: `checkpoint-return-${marker}-review-alpine`,
    feature: `Checkpoint return ${marker} review alpine`,
  };
  for (const run of [runA, runB]) {
    const path = resolve(root, `${run.slug}.json`);
    inside(root, path);
    const bytes = Buffer.from(JSON.stringify(run), "utf8");
    writeFileSync(path, bytes, { flag: "wx" });
    ownedRunFiles.push({ path, root, bytes });
  }
  return { projectId: project.id, epicId, beadA, beadB, runA, runB };
}

function observePosts(page: Page, projectId: string): CapturedPost[] {
  const posts: CapturedPost[] = [];
  const prefix = `/__agent-forge/projects/${projectId}/`;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() !== "POST" || !url.pathname.startsWith(prefix)) return;
    let body: unknown = null;
    try {
      body = request.postDataJSON();
    } catch {
      // Keep malformed bodies visible as null for the exact assertion.
    }
    posts.push({ path: url.pathname, body });
  });
  return posts;
}

function callLog(): string | null {
  return existsSync(callsFile) ? readFileSync(callsFile, "utf8") : null;
}

function dispatchSnapshot(): Map<string, string | null> {
  return new Map(
    dispatchFiles.map((name) => {
      const path = join(HEARTH_HOME, name);
      return [name, existsSync(path) ? readFileSync(path, "utf8") : null];
    }),
  );
}

function expectOnlyReadinessProbes(before: Map<string, string | null>): void {
  for (const [name, prior] of before) {
    const path = join(HEARTH_HOME, name);
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (
      !["codex-fixture-calls.jsonl", "gemini-fixture-calls.jsonl"].includes(
        name,
      ) ||
      current === prior
    ) {
      expect(current).toBe(prior);
      continue;
    }
    if (current === null || (prior !== null && !current.startsWith(prior)))
      throw Error("A provider readiness log lost its saved prefix.");
    const added = current.slice(prior?.length ?? 0);
    if (added && !added.endsWith("\n"))
      throw Error("A provider readiness log ended with a partial row.");
    for (const line of added.split(/\r?\n/).filter(Boolean)) {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw Error("A provider readiness log contained invalid JSON.");
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
        throw Error(
          "A provider fixture recorded a non-read-only startup call.",
        );
    }
  }
}

function expectCallLogAppend(
  before: string | null,
  expectedRunId: string,
): void {
  const after = callLog();
  const prefix = before ?? "";
  if (after === null || !after.startsWith(prefix))
    throw Error("The Council fake call log lost its saved prefix.");
  const added = after.slice(prefix.length);
  if (added && !added.endsWith("\n"))
    throw Error("The Council fake call log ended with a partial row.");
  const rows = added.split(/\r?\n/).filter(Boolean);
  const parsed: Array<z.infer<typeof callLogRowSchema>> = [];
  for (const row of rows) {
    let value: unknown;
    try {
      value = JSON.parse(row);
    } catch {
      throw Error("The Council fake call log contained invalid JSON.");
    }
    parsed.push(callLogRowSchema.parse(value));
  }
  const admissions = parsed.filter((row) => row.kind === "admission");
  expect(admissions).toHaveLength(1);
  const requests = parsed.filter((row) => row.kind === "request");
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) expect(request.runId).toBe(expectedRunId);
}

const commentEventSchema = z
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
const eventPageSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        events: z.array(commentEventSchema).max(1000),
        cursor: z.number().int().nonnegative(),
        more: z.boolean(),
      })
      .strict(),
    error: z.null(),
  })
  .strict();

async function commentEvents(page: Page, beadId: string) {
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
    async ({ url, header, token }) => {
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
        if (!reader) throw Error("The ledger events response had no body.");
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 1024 * 1024)
            throw Error("The ledger events response exceeded 1 MiB.");
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
            // The bounded abort may release an outstanding read first.
          }
        }
      }
    },
    { url: path, header: OPERATOR_HEADER, token },
  );
  expect(answer.url).toBe(expectedUrl);
  expect(answer.status).toBe(200);
  let raw: unknown;
  try {
    raw = JSON.parse(answer.text);
  } catch {
    throw Error("The protected ledger events response was invalid JSON.");
  }
  const parsed = eventPageSchema.parse(raw);
  expect(parsed.data.more).toBe(false);
  expect(parsed.data.cursor).toBe(parsed.data.events.at(-1)?.id ?? 0);
  const ids = parsed.data.events.map((event) => event.id);
  expect(ids).toEqual([...new Set(ids)].sort((a, b) => a - b));
  for (const event of parsed.data.events) {
    expect(event.workspace).toBe(workspace);
    expect(event.beadId).toBe(beadId);
  }
  return parsed.data.events;
}

function expectRunFilesUnchanged(): void {
  for (const owned of ownedRunFiles) {
    inside(realpathSync.native(process.cwd()), owned.path);
    inside(realpathSync.native(owned.root), owned.path);
    expect(readFileSync(owned.path).equals(owned.bytes)).toBe(true);
  }
}

function expectBeadsInProgress(ids: readonly string[]): void {
  const state = readState(BD_STAND_IN_STATE);
  for (const id of ids) expect(state[id]?.status).toBe("in_progress");
}

async function focusedCheckpointField(
  page: Page,
  beadId: string,
): Promise<Locator> {
  const region = page.getByRole("region", {
    name: `Checkpoint review ${beadId}`,
  });
  const field = region.getByRole("textbox", { name: "Review note" });
  await expect(field).toBeVisible();
  await expect(field).toBeFocused();
  const appearance = await field.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineWidth: style.outlineWidth,
      outlineStyle: style.outlineStyle,
      horizontalOverflow:
        document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  expect(appearance).toEqual({
    outlineWidth: "2px",
    outlineStyle: "solid",
    horizontalOverflow: false,
  });
  return field;
}

async function openRun(page: Page, projectId: string, run: ForgeState) {
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Forge runs" })).toBeVisible();
  await page
    .getByRole("link", { name: run.feature ?? run.slug, exact: true })
    .click();
  await expect
    .poll(() => new URL(page.url()).hash)
    .toBe(runsHref(projectId, run.slug));
  await expect(
    page
      .getByRole("article", { name: "Selected forge run" })
      .getByText(run.slug, { exact: true }),
  ).toBeVisible();
}

test.beforeEach(() => {
  ownedRunFiles.length = 0;
  writeFileSync(
    controlFile,
    JSON.stringify({ mode: "success", caseId: "idle" }),
  );
});

test.afterEach(() => {
  writeFileSync(
    controlFile,
    JSON.stringify({ mode: "success", caseId: "idle" }),
  );
  for (const owned of ownedRunFiles.splice(0)) {
    inside(realpathSync.native(process.cwd()), owned.path);
    inside(realpathSync.native(owned.root), owned.path);
    if (existsSync(owned.path)) {
      const stat = lstatSync(owned.path);
      const current = readFileSync(owned.path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        !current.equals(owned.bytes)
      )
        throw Error(
          "An owned Run fixture changed and was retained for review.",
        );
      unlinkSync(owned.path);
    }
    expect(existsSync(owned.path)).toBe(false);
  }
});

test("dirty Council draft keeps options and only its accepted source owns return focus", async ({
  page,
}) => {
  const fixture = seedFixture();
  const posts = observePosts(page, fixture.projectId);
  const callsBefore = callLog();
  const commentsBefore = readComments(BD_STAND_IN_STATE);
  expect(commentsBefore[fixture.beadA] ?? []).toEqual([]);
  expect(commentsBefore[fixture.beadB] ?? []).toEqual([]);
  const dispatchBefore = dispatchSnapshot();
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(
    page,
    `/index.html${runsHref(fixture.projectId, fixture.runA.slug)}`,
  );
  const eventBaselineA = await commentEvents(page, fixture.beadA);
  const eventBaselineB = await commentEvents(page, fixture.beadB);
  expect(eventBaselineA).toEqual([]);
  expect(eventBaselineB).toEqual([]);
  await page
    .getByRole("button", { name: `Send ${fixture.beadA} to Council` })
    .click();
  const profile = page.getByLabel("Council profile");
  await expect(profile).toHaveValue(/.+/);
  const profileBefore = await profile.inputValue();
  const backA = page.getByRole("button", {
    name: `Back to Run ${fixture.runA.slug} checkpoint ${fixture.beadA}`,
  });
  await expect(backA).toBeVisible();
  await page.getByLabel("Maximum estimated cost (USD)").fill("12.50");
  await page.getByLabel("Maximum prepared bytes").fill("123456");
  await page
    .getByLabel(
      "Redact detected secrets; otherwise source preparation rejects them",
    )
    .uncheck();
  await page
    .getByLabel("Allow deep discussion when supported by this profile")
    .check();
  await expect(backA).toBeVisible();

  await openRun(page, fixture.projectId, fixture.runB);
  await page
    .getByRole("button", { name: `Send ${fixture.beadB} to Council` })
    .click();
  const keepDialog = page.getByRole("dialog", {
    name: "Replace Council draft source?",
  });
  await keepDialog.getByRole("button", { name: "Keep draft" }).click();
  await expect(page.getByLabel("Source type")).toHaveValue("bead");
  await expect(page.getByLabel("Beads issue ID")).toHaveValue(fixture.beadA);
  await expect(backA).toBeVisible();
  await expect(profile).toHaveValue(profileBefore);
  await expect(page.getByLabel("Maximum estimated cost (USD)")).toHaveValue(
    "12.50",
  );
  await expect(page.getByLabel("Maximum prepared bytes")).toHaveValue("123456");
  await expect(
    page.getByLabel(
      "Redact detected secrets; otherwise source preparation rejects them",
    ),
  ).not.toBeChecked();
  await expect(
    page.getByLabel("Allow deep discussion when supported by this profile"),
  ).toBeChecked();

  await openRun(page, fixture.projectId, fixture.runB);
  await page
    .getByRole("button", { name: `Send ${fixture.beadB} to Council` })
    .click();
  const replaceDialog = page.getByRole("dialog", {
    name: "Replace Council draft source?",
  });
  await replaceDialog.getByRole("button", { name: "Replace source" }).click();
  await expect(page.getByLabel("Source type")).toHaveValue("bead");
  await expect(page.getByLabel("Beads issue ID")).toHaveValue(fixture.beadB);
  await expect(
    page.getByRole("button", {
      name: `Back to Run ${fixture.runB.slug} checkpoint ${fixture.beadB}`,
    }),
  ).toBeVisible();
  await expect(profile).toHaveValue(profileBefore);
  await expect(page.getByLabel("Maximum estimated cost (USD)")).toHaveValue(
    "12.50",
  );
  await expect(page.getByLabel("Maximum prepared bytes")).toHaveValue("123456");
  await expect(
    page.getByLabel(
      "Redact detected secrets; otherwise source preparation rejects them",
    ),
  ).not.toBeChecked();
  await expect(
    page.getByLabel("Allow deep discussion when supported by this profile"),
  ).toBeChecked();

  await page
    .getByRole("button", {
      name: `Back to Run ${fixture.runB.slug} checkpoint ${fixture.beadB}`,
    })
    .focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => new URL(page.url()).hash)
    .toBe(runsHref(fixture.projectId, fixture.runB.slug));
  await expect(
    page
      .getByRole("article", { name: "Selected forge run" })
      .getByText(fixture.runB.slug, { exact: true }),
  ).toBeVisible();
  await focusedCheckpointField(page, fixture.beadB);

  await page
    .getByRole("button", { name: `Send ${fixture.beadB} to Council` })
    .click();
  const backB = page.getByRole("button", {
    name: `Back to Run ${fixture.runB.slug} checkpoint ${fixture.beadB}`,
  });
  await expect(backB).toBeVisible();
  await page.getByLabel("Maximum estimated cost (USD)").fill("8.75");
  await expect(backB).toBeVisible();
  await page.getByLabel("Source type").selectOption("text");
  const manualSource = `Manual source ${randomUUID()}`;
  await page.getByLabel("Document or question").fill(manualSource);
  await expect(backB).toHaveCount(0);
  const persistedText = await page.evaluate(() =>
    [
      window.location.href,
      ...Object.values(localStorage),
      ...Object.values(sessionStorage),
    ].join("\n"),
  );
  expect(persistedText).not.toContain(manualSource);
  expect(posts).toEqual([]);
  expect(callLog()).toBe(callsBefore);
  expectOnlyReadinessProbes(dispatchBefore);
  expectRunFilesUnchanged();
  expectBeadsInProgress([fixture.beadA, fixture.beadB]);
  expect(readComments(BD_STAND_IN_STATE)[fixture.beadA] ?? []).toEqual([]);
  expect(readComments(BD_STAND_IN_STATE)[fixture.beadB] ?? []).toEqual([]);
  expect(await commentEvents(page, fixture.beadA)).toEqual(eventBaselineA);
  expect(await commentEvents(page, fixture.beadB)).toEqual(eventBaselineB);
});

test("completed Council verdict returns to the exact checkpoint for a separate human comment", async ({
  page,
}) => {
  const fixture = seedFixture();
  const posts = observePosts(page, fixture.projectId);
  const callsBefore = callLog();
  const dispatchBefore = dispatchSnapshot();
  const baseCouncilPath = `/__agent-forge/projects/${fixture.projectId}/council/reviews`;
  const checkpointPath = `/__agent-forge/projects/${fixture.projectId}/runs/${fixture.runB.slug}/checkpoints/${fixture.beadB}/reviews`;
  const note = `Separate human checkpoint review ${randomUUID()}`;
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(
    page,
    `/index.html${runsHref(fixture.projectId, fixture.runB.slug)}`,
  );
  await page
    .getByRole("button", { name: `Send ${fixture.beadB} to Council` })
    .click();
  await expect(page.getByLabel("Source type")).toHaveValue("bead");
  await expect(page.getByLabel("Beads issue ID")).toHaveValue(fixture.beadB);
  expect(posts).toEqual([]);

  const prepareCouncil = page.getByRole("button", {
    name: "Prepare original for review",
  });
  await expect(prepareCouncil).toBeEnabled({ timeout: 15_000 });
  await prepareCouncil.click();
  const original = page.getByRole("region", {
    name: "Exact saved Council original",
  });
  await expect(original).toBeVisible({ timeout: 15_000 });
  const identityCodes = original.locator("details").first().locator("dd code");
  const identitySummary = original.getByText("Request identity and scope", {
    exact: true,
  });
  await identitySummary.focus();
  await page.keyboard.press("Enter");
  await expect(identityCodes.nth(0)).toBeVisible();
  const councilRequestId = await identityCodes.nth(0).innerText();
  const councilIntentHash = await identityCodes.nth(1).innerText();
  const councilRunId = z
    .string()
    .min(1)
    .max(256)
    .parse(await identityCodes.nth(2).innerText());
  expect(requestIdSchema.parse(councilRequestId)).toBe(councilRequestId);
  expect(councilIntentHash).toMatch(/^[a-f0-9]{64}$/);
  const councilPrepare = projectCouncilReserveRequestSchema.parse(
    posts[0]?.body,
  );
  expect(posts[0]?.path).toBe(baseCouncilPath);
  expect(councilPrepare.sourceChoice).toEqual({
    sourceType: "bead",
    source: fixture.beadB,
  });
  expect(posts).toHaveLength(1);

  await page
    .getByRole("button", { name: "Convene this exact original" })
    .click();
  await expect(
    page.getByText("Verified state: completed", { exact: true }),
  ).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.getByRole("heading", { name: "Council result" }),
  ).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.getByRole("heading", { name: "Verified result facts" }),
  ).toBeVisible();
  const previewNode = page
    .getByRole("region", { name: "Bead verdict comment preview" })
    .locator("pre");
  await expect(previewNode).toBeVisible();
  const preview = await previewNode.innerText();
  await expect(page.getByTestId("council-verdict-status")).toHaveText(
    "Verdict comment posted to the bead.",
    { timeout: 15_000 },
  );
  await expect
    .poll(() => readComments(BD_STAND_IN_STATE)[fixture.beadB]?.length)
    .toBe(1);
  const councilComment = readComments(BD_STAND_IN_STATE)[fixture.beadB]?.[0];
  if (!councilComment)
    throw Error("The actual Council verdict comment was absent.");
  expect(councilComment.text).toBe(preview);
  expectCallLogAppend(callsBefore, councilRunId);
  expect(posts).toHaveLength(2);
  expect(posts[0]?.path).toBe(baseCouncilPath);
  expect(posts[1]?.path).toBe(`${baseCouncilPath}/${councilRequestId}/commit`);
  expect(posts[1]?.body).toEqual({ intentHash: councilIntentHash });

  const councilEvents = await commentEvents(page, fixture.beadB);
  expect(councilEvents).toHaveLength(1);
  expect(councilEvents[0]?.payload).toEqual({
    action: "comment",
    hash: hashText(preview),
    length: preview.length,
  });
  await page
    .getByRole("button", {
      name: `Back to Run ${fixture.runB.slug} checkpoint ${fixture.beadB}`,
    })
    .click();
  await expect
    .poll(() => new URL(page.url()).hash)
    .toBe(runsHref(fixture.projectId, fixture.runB.slug));
  await expect(
    page
      .getByRole("article", { name: "Selected forge run" })
      .getByText(fixture.runB.slug, { exact: true }),
  ).toBeVisible();
  const region = page.getByRole("region", {
    name: `Checkpoint review ${fixture.beadB}`,
  });
  const field = await focusedCheckpointField(page, fixture.beadB);
  expect(posts).toHaveLength(2);
  await field.fill(note);
  const requestChanges = region.getByRole("button", {
    name: "Request changes",
  });
  await requestChanges.focus();
  await expect(requestChanges).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Review comment recorded and verified." }),
  ).toBeVisible({ timeout: 15_000 });
  expect(posts).toHaveLength(4);
  const humanPrepare = projectCheckpointReviewPrepareRequestSchema.parse(
    posts[2]?.body,
  );
  expect(posts[2]?.path).toBe(checkpointPath);
  expect(humanPrepare).toMatchObject({
    expectedEpicId: fixture.epicId,
    expectedRunUpdatedAt: fixture.runB.updatedAt,
    decision: "request-changes",
    note,
  });
  const humanCommit = z
    .object({ intentHash: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict()
    .parse(posts[3]?.body);
  const humanCommitPath = posts[3]?.path;
  const humanPrefix = `${checkpointPath}/`;
  if (
    !humanCommitPath?.startsWith(humanPrefix) ||
    !humanCommitPath.endsWith("/commit")
  )
    throw Error("The human checkpoint commit used an unexpected route.");
  const humanRequestId = humanCommitPath.slice(
    humanPrefix.length,
    -"/commit".length,
  );
  expect(requestIdSchema.parse(humanRequestId)).toBe(humanRequestId);
  expect(humanPrepare.requestId).toBe(humanRequestId);

  await expect
    .poll(() => readComments(BD_STAND_IN_STATE)[fixture.beadB]?.length)
    .toBe(2);
  const comments = readComments(BD_STAND_IN_STATE)[fixture.beadB] ?? [];
  expect(comments.map((comment) => comment.id)).toHaveLength(2);
  expect(new Set(comments.map((comment) => comment.id)).size).toBe(2);
  expect(comments[0]?.id).toBe(councilComment.id);
  expect(comments[0]?.text).toBe(preview);
  const humanComment = comments.find((comment) => comment.text.includes(note));
  if (!humanComment)
    throw Error("The explicit human checkpoint comment was absent.");
  expect(humanRequestId).not.toBe(councilRequestId);
  expect(humanCommitPath).toBe(`${checkpointPath}/${humanRequestId}/commit`);
  expect(humanCommit.intentHash).toMatch(/^[a-f0-9]{64}$/);
  const humanReview = reviewCommentFor({
    issueId: fixture.beadB,
    decision: "request-changes",
    note,
  });
  if (!humanReview.ok)
    throw Error("The checkpoint note did not produce a valid review comment.");
  expect(humanComment.text).toBe(
    `${humanReview.body}\nForge checkpoint review ${humanRequestId}`,
  );
  const events = await commentEvents(page, fixture.beadB);
  expect(events).toHaveLength(councilEvents.length + 1);
  expect(
    events.slice(0, councilEvents.length).map((event) => event.id),
  ).toEqual(councilEvents.map((event) => event.id));
  expect(events.at(-1)?.payload).toEqual({
    action: "comment",
    hash: hashText(humanComment.text),
    length: humanComment.text.length,
  });
  expect(JSON.stringify(events)).not.toContain(note);
  expectRunFilesUnchanged();
  expectBeadsInProgress([fixture.beadA, fixture.beadB]);
  expectOnlyReadinessProbes(dispatchBefore);
});
