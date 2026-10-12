import { expect, type Page, test } from "@playwright/test";
import { OVERSCAN, ROW_PX } from "../../docs/js/timeline-model";
import type { LedgerEvent } from "../../types/hearth";
import { BEADS, openSettled, reloadSettled, stubSnapshot } from "./fixtures";
import { createFromBuilder, requireStandIn } from "./stand-in";

/**
 * The Timeline: one bead's or one run's ledger events, in ledger order.
 *
 * The first tests read the suite's real hearth, whose ledger holds what the
 * page's own writes recorded: a bead created and commented on through the
 * bead builder has three events under `bead=<id>` (the create's
 * `bead.transitioned`; the comment's `operator.action` and
 * `bead.transitioned`). The create's `operator.action` names no bead, since
 * none existed yet, and no operator write carries a session, so nothing else
 * joins.
 */

/** A bead bd knows, with one comment, created through the page; and a snapshot that lists it. */
async function beadWithComment(page: Page, title: string): Promise<string> {
  await openSettled(page, "/index.html#/bead-builder");
  await requireStandIn(page);
  const id = await createFromBuilder(page, title);
  const actions = page
    .locator("#bead-created-card")
    .getByRole("region", { name: `Actions on ${id}` });
  await actions.getByLabel("Comment").fill("worklog: on the timeline");
  await actions.getByRole("button", { name: "Add comment" }).click();
  await expect(actions.getByRole("status")).toContainText(
    `Comment added to ${id}`,
  );
  await stubSnapshot(page, {
    ...BEADS,
    issues: [
      ...BEADS.issues,
      {
        id,
        type: "task",
        title,
        status: "open",
        createdAt: "2026-10-12T00:00:00.000Z",
        updatedAt: "2026-10-12T00:00:00.000Z",
      },
    ],
  });
  return id;
}

const rows = (page: Page) => page.locator(".af-timeline-row");

async function kindsShown(page: Page): Promise<string[]> {
  return rows(page).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-kind") ?? ""),
  );
}

test("a bead opened from its issue detail's Timeline link shows its events from the hearth, in ledger order", async ({
  page,
}) => {
  const id = await beadWithComment(page, "Timeline tracer");

  // The snapshot is read when a document loads: go to the list, then reload.
  await openSettled(page, "/index.html#/issues");
  await reloadSettled(page);
  await page.locator(`[data-issue-id="${id}"]`).click();
  await page
    .locator(".af-detail")
    .getByRole("link", { name: "Timeline" })
    .click();

  await expect(page).toHaveURL(
    new RegExp(`#/timeline\\?bead=${id.replace(".", "\\.")}$`),
  );
  await expect(page.locator("h1")).toHaveText("Timeline");
  await expect(rows(page)).toHaveCount(3);
  expect(await kindsShown(page)).toEqual([
    "bead.transitioned",
    "operator.action",
    "bead.transitioned",
  ]);
  await expect(rows(page).nth(0)).toContainText("create");
  await expect(rows(page).nth(2)).toContainText("comment");
  // Every row is this bead's, in ledger order.
  const shown = await rows(page).evaluateAll((elements) =>
    elements.map((element) => Number(element.getAttribute("data-event-id"))),
  );
  expect(shown).toEqual([...shown].sort((a, b) => a - b));
});

test("choosing a kind narrows the rows to that kind, puts it in the address, survives a reload, and reads nothing more", async ({
  page,
}) => {
  const id = await beadWithComment(page, "Timeline kinds");
  await openSettled(page, `/index.html#/timeline?bead=${id}`);
  await expect(rows(page)).toHaveCount(3);

  const kinds = page.getByRole("group", { name: "Kinds" });
  const action = kinds.getByRole("button", { name: /^operator\.action/ });
  await expect(action).toHaveAttribute("aria-pressed", "false");
  await expect(action).toContainText("1");
  await expect(
    kinds.getByRole("button", { name: /^bead\.transitioned/ }),
  ).toContainText("2");

  const reads: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/__agent-forge/events"))
      reads.push(request.url());
  });
  await action.click();
  await expect(action).toHaveAttribute("aria-pressed", "true");
  await expect(rows(page)).toHaveCount(1);
  expect(await kindsShown(page)).toEqual(["operator.action"]);
  expect(page.url()).toContain(`#/timeline?bead=${id}&kind=operator.action`);
  expect(reads, "a kind change is applied to what was read").toEqual([]);

  await reloadSettled(page);
  await expect(rows(page)).toHaveCount(1);
  await expect(
    page
      .getByRole("group", { name: "Kinds" })
      .getByRole("button", { name: /^operator\.action/ }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Every kind" }).click();
  await expect(rows(page)).toHaveCount(3);
  expect(page.url().endsWith(`#/timeline?bead=${id}`)).toBe(true);
});

test("at phone width the filled list and its kind chips fit the screen, and the page does not scroll sideways @mobile", async ({
  page,
}) => {
  const id = await beadWithComment(page, "Timeline at 375px");
  await openSettled(page, `/index.html#/timeline?bead=${id}`);
  await expect(rows(page)).toHaveCount(3);
  const width = page.viewportSize()?.width ?? 0;
  expect(width).toBe(375);
  for (const part of [
    page.locator(".af-timeline-list"),
    page.getByRole("group", { name: "Kinds" }),
  ]) {
    const box = await part.boundingBox();
    expect(box, "the part is laid out").not.toBeNull();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? Infinity)).toBeLessThanOrEqual(width);
  }
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

// ── 10,000 events ───────────────────────────────────────────────────────────

const LOAD_EVENTS = 10_000;
const LOAD_BEAD = "load-test";
/** The browser's own long-task threshold; the bar for "without jank" (plan, Checkpoint D). */
const LONG_TASK_MS = 50;

/** 10,000 events of one bead, in three sessions that all appear on the first page. */
function loadEvents(): LedgerEvent[] {
  const start = Date.UTC(2026, 9, 12);
  return Array.from({ length: LOAD_EVENTS }, (_, index): LedgerEvent => {
    const base = {
      id: index + 1,
      ulid: `load-${index + 1}`,
      ts: new Date(start + index * 1000).toISOString(),
      workspace: "/load",
      beadId: LOAD_BEAD,
      sessionId: `session-${index % 3}`,
    };
    return index % 2 === 0
      ? {
          ...base,
          kind: "tool.called",
          payload: { tool: "Bash", argsHash: "h", durationMs: index % 900 },
        }
      : {
          ...base,
          kind: "gate.ran",
          payload: { gate: "typecheck", passed: index % 7 !== 0 },
        };
  });
}

/** Answer `/events` from `events` as the hearth would: forward pages after a cursor, by session when asked. */
async function serveEvents(page: Page, events: LedgerEvent[]): Promise<void> {
  await page.route("**/__agent-forge/events?*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    const after = Number(params.get("after") ?? "0");
    const limit = Number(params.get("limit") ?? "200");
    const session = params.get("session");
    const matching = events.filter(
      (entry) =>
        entry.id > after && (session === null || entry.sessionId === session),
    );
    const answer = matching.slice(0, limit);
    return route.fulfill({
      json: {
        ok: true,
        data: {
          events: answer,
          cursor: answer.at(-1)?.id ?? after,
          more: matching.length > limit,
        },
        error: null,
      },
    });
  });
}

interface LongTask {
  start: number;
  duration: number;
}

/** Long tasks, recorded from before the page's own scripts run. */
async function observeMainThread(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const record = window as unknown as {
      longTasks: Array<{ start: number; duration: number }>;
    };
    record.longTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        record.longTasks.push({
          start: entry.startTime,
          duration: entry.duration,
        });
    }).observe({ type: "longtask", buffered: true });
  });
}

function longIn(tasks: LongTask[], from: number, to: number): LongTask[] {
  return tasks.filter((task) => task.start >= from && task.start <= to);
}

function describeTasks(tasks: LongTask[]): string {
  if (tasks.length === 0) return "none";
  const longest = Math.max(...tasks.map((task) => task.duration));
  return `${tasks.length}, longest ${Math.round(longest)} ms`;
}

test("10,000 events: at every step of a scroll to the end the document holds no more than the rows in view and twice the overscan, and the last event is reached; load and scroll are measured", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await observeMainThread(page);
  await serveEvents(page, loadEvents());

  await openSettled(page, `/index.html#/timeline?bead=${LOAD_BEAD}`);
  await expect(page.locator(".af-timeline-scope-line")).toContainText(
    `${LOAD_EVENTS} shown of ${LOAD_EVENTS}`,
  );
  await expect(page.locator(".af-timeline-scope-line")).not.toContainText(
    "reading more",
  );
  const loadedAt = await page.evaluate(() => performance.now());

  const scroll = await page.locator(".af-timeline-list").evaluate(
    async (list, { rowPx, overscan }) => {
      const frame = () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      const inView = Math.ceil(list.clientHeight / rowPx) + 1;
      const counts: number[] = [];
      const startedAt = performance.now();
      while (list.scrollTop + list.clientHeight < list.scrollHeight - 1) {
        list.scrollTop += list.clientHeight;
        await frame();
        counts.push(list.querySelectorAll(".af-timeline-row").length);
        // A step over the bound has failed already: stop rather than scroll a list of every row.
        if ((counts.at(-1) ?? 0) > inView + 2 * overscan) break;
      }
      const ids = [...list.querySelectorAll(".af-timeline-row")].map((row) =>
        Number(row.getAttribute("data-event-id")),
      );
      return {
        counts,
        steps: counts.length,
        startedAt,
        endedAt: performance.now(),
        lastId: Math.max(...ids),
        inView,
      };
    },
    { rowPx: ROW_PX, overscan: OVERSCAN },
  );

  expect(Math.max(...scroll.counts)).toBeLessThanOrEqual(
    scroll.inView + 2 * OVERSCAN,
  );
  expect(scroll.steps, "the list scrolls").toBeGreaterThan(10);
  expect(scroll.lastId).toBe(LOAD_EVENTS);

  const { longTasks, firstRead, lastAnswer } = await page.evaluate(() => {
    const record = window as unknown as {
      longTasks: Array<{ start: number; duration: number }>;
    };
    const reads = performance
      .getEntriesByType("resource")
      .filter((entry) => entry.name.includes("/__agent-forge/events"))
      .map((entry) => entry as PerformanceResourceTiming);
    return {
      longTasks: record.longTasks,
      firstRead: Math.min(...reads.map((entry) => entry.startTime)),
      lastAnswer: Math.max(...reads.map((entry) => entry.responseEnd)),
    };
  });
  const duringLoad = longIn(longTasks, firstRead, loadedAt);
  const duringScroll = longIn(longTasks, scroll.startedAt, scroll.endedAt);
  const boot = longIn(longTasks, 0, firstRead);
  // The measured values belong in the run's log; the bar is checked by a person (plan, Checkpoint D).
  process.stdout.write(
    `    [timeline-10k] read ${LOAD_EVENTS} events in ${Math.round(lastAnswer - firstRead)} ms (first request to last answer); ` +
      `long tasks (over ${LONG_TASK_MS} ms) while loading: ${describeTasks(duringLoad)}; ` +
      `while scrolling ${scroll.steps} steps in ${Math.round(scroll.endedAt - scroll.startedAt)} ms: ${describeTasks(duringScroll)}; ` +
      `before the first read (page start): ${describeTasks(boot)}; ` +
      `most rows in the document: ${Math.max(...scroll.counts)} (bound ${scroll.inView + 2 * OVERSCAN})\n`,
  );
});
