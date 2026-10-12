import { expect, test } from "@playwright/test";
import { openSettled, reloadSettled } from "./fixtures";

/**
 * The settle helpers themselves (`fixtures.ts`).
 *
 * A reload's old document keeps running until the new one commits, and may
 * start requests in that time: the Workbench reads `/queue` again when its
 * stream drops. When that document goes, the runner reports neither an end nor
 * a failure for such a request, so a helper that counted it would wait for it
 * until its own limit.
 */

test("a reload settles although the old document started a request after the reload had begun", async ({
  page,
}) => {
  await openSettled(page, "/index.html#/commands");

  let asked = false;
  let releaseAnswer: () => void = () => undefined;
  const answer = new Promise<void>((resolve) => {
    releaseAnswer = resolve;
  });
  await page.route("**/settle-check/never-answered", async (route) => {
    asked = true;
    await answer;
    await route.abort().catch(() => undefined);
  });

  // The old document asks once its own held request is answered, which is
  // only done while the reload is under way: a script cannot be run in a page
  // that is navigating.
  let go: () => void = () => undefined;
  const goAnswered = new Promise<void>((resolve) => {
    go = resolve;
  });
  await page.route("**/settle-check/go", async (route) => {
    await goAnswered;
    await route.fulfill({ body: "go" });
  });
  await page.evaluate(() => {
    void fetch("/settle-check/go").then(() =>
      fetch("/settle-check/never-answered").catch(() => undefined),
    );
  });

  // The new document is held until the old one has asked.
  let documentRequested: () => void = () => undefined;
  const requested = new Promise<void>((resolve) => {
    documentRequested = resolve;
  });
  let releaseDocument: () => void = () => undefined;
  const documentReleased = new Promise<void>((resolve) => {
    releaseDocument = resolve;
  });
  await page.route("**/index.html", async (route) => {
    documentRequested();
    await documentReleased;
    await route.continue();
  });

  const reloading = reloadSettled(page);
  await requested;
  go();
  await expect.poll(() => asked).toBe(true);
  releaseDocument();

  await reloading;
  releaseAnswer();
  await expect(page.locator("h1")).toHaveText("Commands");
});
