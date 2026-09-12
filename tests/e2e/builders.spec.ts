import { expect, type Page, test } from "@playwright/test";

/**
 * The builders' clipboard fallback and feedback.
 *
 * The fallback only appears when the clipboard is unavailable, which a normal
 * browser run never exercises — so force it. The original PR's check read the
 * textarea's value, which still worked while readOnly, its ref and the
 * auto-selection had all silently stopped working.
 */

async function denyClipboard(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => Promise.reject(new Error("clipboard denied in test")),
      },
    });
  });
}

async function selectionOf(page: Page, selector: string) {
  return page.locator(selector).evaluate((el) => {
    const textarea = el as HTMLTextAreaElement;
    return {
      readOnly: textarea.readOnly,
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
      length: textarea.value.length,
      value: textarea.value,
      focused: document.activeElement === textarea,
    };
  });
}

test("bead builder fallback is read-only, focused and fully selected", async ({
  page,
}) => {
  await denyClipboard(page);
  await page.goto("/index.html#/bead-builder", { waitUntil: "networkidle" });
  await page.fill("#bb-title", "Fallback check");
  await page.click("button[type=submit]");

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText("Copy this command");

  await expect
    .poll(() => selectionOf(page, "#bb-modal-textarea"))
    .toMatchObject({ readOnly: true, start: 0, focused: true });
  const selection = await selectionOf(page, "#bb-modal-textarea");
  expect(selection.value).toContain("bd create");
  expect(selection.end).toBe(selection.length);
});

test("skill builder fallback is read-only, focused and fully selected", async ({
  page,
}) => {
  await denyClipboard(page);
  await page.goto("/index.html#/skill-builder", { waitUntil: "networkidle" });
  await page.fill("#sb-skill-name", "deploy staging");
  await page.fill("#sb-description", "Deploy to staging");
  await page.click("button[type=submit]");

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText("Copy this prompt");

  await expect
    .poll(() => selectionOf(page, "#sb-modal-textarea"))
    .toMatchObject({ readOnly: true, start: 0, focused: true });
  const selection = await selectionOf(page, "#sb-modal-textarea");
  expect(selection.value).toContain("authoring-agent-skills");
  expect(selection.end).toBe(selection.length);
});

test("the fallback text cannot be edited", async ({ page }) => {
  await denyClipboard(page);
  await page.goto("/index.html#/bead-builder", { waitUntil: "networkidle" });
  await page.fill("#bb-title", "Read-only check");
  await page.click("button[type=submit]");

  const textarea = page.locator("#bb-modal-textarea");
  await expect(textarea).toBeVisible();
  const before = await textarea.inputValue();
  await textarea.press("End");
  await page.keyboard.type("tampered");
  await expect(textarea).toHaveValue(before);
});

for (const [route, card, fill] of [
  ["bead-builder", "#bead-form-card", ["#bb-title", "Flash check"]],
  ["skill-builder", "#skill-form-card", ["#sb-skill-name", "flash"]],
] as const) {
  test(`${route} success flash lands on its card and clears`, async ({
    page,
  }) => {
    await page.goto(`/index.html#/${route}`, { waitUntil: "networkidle" });
    const target = page.locator(card);
    await expect(target).toHaveCount(1);

    await page.fill(fill[0], fill[1]);
    if (route === "skill-builder") {
      await page.fill("#sb-description", "flash description");
    }
    await page.click("button[type=submit]");

    await expect(target).toHaveClass(/is-success-flash/);
    await expect(target).not.toHaveClass(/is-success-flash/, {
      timeout: 5_000,
    });
  });
}
