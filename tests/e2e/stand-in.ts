/**
 * What a spec reads and seeds in the run's `bd` stand-in (`bd-stand-in.ts`).
 *
 * The stand-in keeps every argument array it was given and its issues in the
 * run's home (`BD_STAND_IN_STATE`). A spec compares calls from a mark it takes
 * itself, since every spec of a run shares them.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { readState, withStateLock, writeState } from "./bd-stand-in-state";
import { BD_STAND_IN_BIN, BD_STAND_IN_STATE } from "./servers";

const API = "/__agent-forge";

/** Every argument array the stand-in has been called with in this run, oldest first. */
export function standInCalls(): string[][] {
  const file = join(BD_STAND_IN_STATE, "calls.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as string[]);
}

export const isList = (call: string[]): boolean => call[0] === "list";

/**
 * The comments bd prints for `id`, read by running the stand-in itself with
 * the call a council's bead source makes (`--readonly comments <id> --json`).
 * The call is recorded like any other.
 */
export function standInComments(id: string): Array<Record<string, unknown>> {
  const program = join(
    BD_STAND_IN_BIN,
    process.platform === "win32" ? "bd.exe" : "bd",
  );
  const run = spawnSync(program, ["--readonly", "comments", id, "--json"], {
    encoding: "utf8",
    env: { ...process.env, BD_STAND_IN_STATE },
  });
  if (run.status !== 0)
    throw new Error(
      `the stand-in did not list the comments of ${id}: ${run.stdout}${run.stderr}`,
    );
  return JSON.parse(run.stdout) as Array<Record<string, unknown>>;
}

/**
 * Stop unless the hearth's `bd` is the stand-in: a read of the queue makes the
 * hearth run `bd list`, and that call must appear in the stand-in's own record.
 * Called before a test's first write, so a hearth that would run anything else
 * is found before it is asked to change something.
 */
export async function requireStandIn(page: Page): Promise<void> {
  const before = standInCalls().filter(isList).length;
  const status = await page.evaluate(
    async (url) => (await fetch(url)).status,
    `${API}/queue`,
  );
  expect(status, "the queue read answers").toBe(200);
  expect(
    standInCalls().filter(isList).length,
    "the hearth's bd is the suite's stand-in",
  ).toBeGreaterThan(before);
}

/**
 * Put a bead the test created through the page into the queue as proposed,
 * as the scheduler's `propose` would: no route proposes, so the label and its
 * backing metadata are written to the stand-in's issues directly.
 */
export function seedProposed(id: string): void {
  withStateLock(BD_STAND_IN_STATE, () => {
    const issues = readState(BD_STAND_IN_STATE);
    const issue = issues[id];
    if (issue === undefined)
      throw new Error(`the stand-in has no issue ${id} to propose`);
    issues[id] = {
      ...issue,
      labels: [...(issue.labels ?? []), "queue:proposed"],
      metadata: { ...(issue.metadata ?? {}), queue_state: "proposed" },
    };
    writeState(BD_STAND_IN_STATE, issues);
  });
}

export const createButton = (page: Page) =>
  page.getByRole("button", { name: "Create bead" });

/** The id shown on the card of the bead most recently created from this page. */
export async function createdId(page: Page): Promise<string> {
  return (
    await page
      .locator("#bead-created-card .issue-id-copy code")
      .first()
      .innerText()
  ).trim();
}

/** Create a bead from the builder and return the id the page shows for it. */
export async function createFromBuilder(
  page: Page,
  title: string,
): Promise<string> {
  await page.fill("#bb-title", title);
  await expect(createButton(page)).toBeEnabled();
  await createButton(page).click();
  await expect(page.locator("#bb-create-result")).toContainText("Created ");
  await expect(page.locator("#bead-created-card")).toContainText(title);
  return createdId(page);
}
