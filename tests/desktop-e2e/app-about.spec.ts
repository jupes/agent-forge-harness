import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { version } from "../../package.json";
import { HEARTH_API_VERSION } from "../../scripts/hearth/protocol";
import { providerReadinessPageSchema } from "../../scripts/providers/protocol";
import { openSettled } from "../e2e/fixtures";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha, seedProjects } from "./project-fixtures";

test.beforeEach(seedProjects);
const starts = () => {
  const file = join(HEARTH_HOME, "keeper-fixture-starts.jsonl");
  return existsSync(file)
    ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length
    : 0;
};
test("About identifies the renderer and opens project-preserving diagnostics without running doctor or a provider task", async ({
  page,
}) => {
  const before = starts();
  let doctors = 0,
    signins = 0;
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (/\/providers\/[^/]+\/doctor$/.test(request.url())) doctors++;
    if (/\/providers\/[^/]+\/login/.test(request.url())) signins++;
  });
  await openSettled(
    page,
    "/#/desktop/app-settings?project=" +
      alpha.id +
      "&selectionKind=bead&selectionId=alpha-epic",
  );
  const about = page.getByRole("region", { name: "About", exact: true });
  await expect(
    about.getByRole("heading", { name: "About", exact: true }),
  ).toBeVisible();
  await expect(about.getByText(version, { exact: true })).toBeVisible();
  await expect(
    about.getByText(String(HEARTH_API_VERSION), { exact: true }),
  ).toBeVisible();
  const diagnostics = about.getByRole("link", {
    name: "Open provider diagnostics",
    exact: true,
  });
  await expect(diagnostics).toHaveAttribute(
    "href",
    "#/desktop/providers?project=" +
      alpha.id +
      "&selectionKind=bead&selectionId=alpha-epic",
  );
  await page.keyboard.press("Tab");
  await diagnostics.focus();
  expect(
    await diagnostics.evaluate((el) => getComputedStyle(el).outlineWidth),
  ).toBe("2px");
  mkdirSync(".tmp/screenshots/about-settings", { recursive: true });
  await about.screenshot({
    path: ".tmp/screenshots/about-settings/about-selected-bead.png",
  });
  await diagnostics.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Providers & usage", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(
      "project=" + alpha.id + "&selectionKind=bead&selectionId=alpha-epic$",
    ),
  );
  const doctor = page
    .getByRole("article", { name: "Claude", exact: true })
    .getByRole("button", { name: "Run doctor · Claude", exact: true });
  await expect(doctor).toBeEnabled();
  expect(doctors).toBe(0);
  expect(signins).toBe(0);
  expect(starts()).toBe(before);
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/providers/claude/doctor") &&
      r.request().method() === "POST",
  );
  await doctor.click();
  const answer = await response;
  expect(answer.status()).toBe(200);
  const envelope: unknown = await answer.json();
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    !("ok" in envelope) ||
    envelope.ok !== true ||
    !("data" in envelope)
  )
    throw Error("Doctor outcome unavailable");
  expect(providerReadinessPageSchema.safeParse(envelope.data).success).toBe(
    true,
  );
  expect(doctors).toBe(1);
  expect(signins).toBe(0);
  expect(starts()).toBe(before);
});
