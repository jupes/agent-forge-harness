import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { OPERATOR_HEADER } from "../../scripts/hearth/paths";
import { providerReadinessPageSchema } from "../../scripts/providers/protocol";
import { providerReadinessFixture } from "../../scripts/providers/testing";
import { pageToken } from "../e2e/launch-link";
import { HEARTH_HOME } from "../e2e/servers";
import { alpha, seedProjects, workspace } from "./project-fixtures";

test.beforeEach(() => seedProjects());
const starts = () => {
  const file = join(HEARTH_HOME, "keeper-fixture-starts.jsonl");
  return existsSync(file)
    ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length
    : 0;
};

test("five factual provider cards run the audited non-generating doctor and share usage through navigation", async ({
  page,
}) => {
  const before = starts();
  await page.goto("/index.html#/desktop/providers");
  await expect(
    page.getByRole("heading", { name: "Providers & usage", exact: true }),
  ).toBeVisible();
  for (const name of ["Claude", "Codex", "Gemini", "Grok", "OpenRouter"])
    await expect(
      page.getByRole("article", { name, exact: true }),
    ).toBeVisible();
  const claude = page.getByRole("article", { name: "Claude", exact: true });
  await expect(
    claude.getByText("API key", { exact: true }).first(),
  ).toBeVisible();
  const reply = page.waitForResponse(
    (response) =>
      response.url().endsWith("/providers/claude/doctor") &&
      response.request().method() === "POST",
  );
  await claude
    .getByRole("button", { name: "Run doctor · Claude", exact: true })
    .click();
  const response = await reply;
  expect(response.status()).toBe(200);
  const envelope = await response.json();
  expect(envelope.ok).toBe(true);
  const report = providerReadinessPageSchema.parse(envelope.data);
  expect(report.providers[0]?.authentication.mode).toBe("api-key");
  expect(JSON.stringify(report)).not.toContain(
    "inert-browser-fixture-not-a-key",
  );
  expect(starts()).toBe(before);
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Subscriptions", exact: true })
      .getByText("Usage — not reported"),
  ).toHaveCount(5);
  expect(
    await page
      .locator('.af-desktop-title-actions a[aria-label^="Providers and usage"]')
      .getAttribute("title"),
  ).toContain("Claude: Usage — not reported");
});

test("reported units, missing reset, filtered empty and compact keyboard focus never turn unknown allowance into zero", async ({
  page,
}) => {
  const data = providerReadinessFixture(workspace, alpha.id);
  await page.route("**/providers/readiness", (route) =>
    route.fulfill({ json: { ok: true, data, error: null } }),
  );
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/index.html#/desktop/providers");
  const claude = page.getByRole("article", { name: "Claude", exact: true });
  await expect(
    claude.getByText("Subscription", { exact: true }).first(),
  ).toBeVisible();
  await expect(claude.getByRole("progressbar")).toHaveAttribute("value", "40");
  await expect(claude.getByText(/Reset not reported/)).toBeVisible();
  const grok = page.getByRole("article", { name: "Grok", exact: true });
  await expect(
    grok.getByText("Reporting unavailable", { exact: true }),
  ).toBeVisible();
  await expect(grok.getByRole("progressbar")).toHaveCount(0);
  await expect(
    page
      .getByRole("article", { name: "Gemini", exact: true })
      .getByText("Exhausted", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("article", { name: "OpenRouter", exact: true })
      .getByText("Degraded", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "State", exact: true })
    .selectOption("signed-out");
  await expect(
    page.getByText("No providers match these filters", { exact: true }),
  ).toBeVisible();
  const clear = page.getByRole("button", {
    name: "Clear filters",
    exact: true,
  });
  await clear.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("article")).toHaveCount(5);
  const search = page.getByRole("searchbox", {
    name: "Find providers",
    exact: true,
  });
  await search.focus();
  expect(
    await search.evaluate((element) => getComputedStyle(element).outlineWidth),
  ).toBe("2px");
  expect(
    await search.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(24);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("providers-1100.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Subscriptions", exact: true })
      .getByText("Fixture weekly allowance: 40% used"),
  ).toHaveCount(2);
  expect(
    await page
      .locator('.af-desktop-title-actions a[aria-label^="Providers and usage"]')
      .getAttribute("title"),
  ).toContain("Claude: Fixture weekly allowance: 40% used");
  await page.goto(`/index.html#/desktop/project/${alpha.id}/overview`);
  const usage = page.getByRole("region", {
    name: "Reported project usage",
    exact: true,
  });
  await expect(usage.getByText("12", { exact: true })).toBeVisible();
  await expect(usage.getByRole("cell", { name: "—", exact: true })).toHaveCount(
    2,
  );
});

test("loading and failed refresh keep distinct states and preserve focused check controls with last-known evidence", async ({
  page,
}) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const data = providerReadinessFixture(workspace, alpha.id);
  let failed = false;
  await page.route("**/providers/readiness", async (route) => {
    await hold;
    await route.fulfill(
      failed
        ? {
            status: 503,
            json: {
              ok: false,
              data: null,
              error: "Synthetic status read failed",
            },
          }
        : { json: { ok: true, data, error: null } },
    );
  });
  await page.goto("/index.html#/desktop/providers");
  await expect(
    page.getByText("Checking providers…", { exact: true }),
  ).toBeVisible();
  release();
  await expect(
    page.getByRole("article", { name: "Claude", exact: true }),
  ).toBeVisible();
  failed = true;
  const refresh = page.getByRole("button", {
    name: "Refresh providers",
    exact: true,
  });
  await refresh.focus();
  await page.keyboard.press("Enter");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Showing the last-known report" }),
  ).toBeVisible();
  await expect(refresh).toBeFocused();
  await expect(
    page.getByRole("article", { name: "Claude", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Providers could not be read", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
});

test("a pre-admission sign-in survives reload and404; explicit original retry opens only one owned inert CLI and Stop ends its tree", async ({
  page,
  context,
}) => {
  const data = providerReadinessFixture(workspace, alpha.id),
    claudeReport = data.providers.find(
      (provider) => provider.provider === "claude",
    );
  if (!claudeReport) throw Error("Missing fixture Claude");
  claudeReport.signIn.nativeAvailable = true;
  const source = "**/providers/readiness";
  await context.route(source, (route) =>
    route.fulfill({ json: { ok: true, data, error: null } }),
  );
  const log = join(HEARTH_HOME, "provider-login-starts.jsonl"),
    recorded = () => {
      if (!existsSync(log)) return [];
      try {
        return readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(
            (line) =>
              JSON.parse(line) as {
                provider: string;
                pid: number;
                childPid: number;
              },
          );
      } catch {
        throw Error("Invalid inert sign-in recording");
      }
    };
  const before = recorded().length;
  let release = () => {},
    entered = () => {},
    admitted = () => {},
    original: string | null = null;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    intercepted = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    dispatched = new Promise<void>((resolve) => {
      admitted = resolve;
    });
  await page.route("**/providers/claude/sign-in", async (route) => {
    const body: unknown = route.request().postDataJSON();
    if (
      !body ||
      typeof body !== "object" ||
      !("requestId" in body) ||
      typeof body.requestId !== "string"
    )
      throw Error("No original UUID before sign-in request");
    original = body.requestId;
    entered();
    await held;
    const response = await route.fetch({
      headers: {
        ...(await route.request().allHeaders()),
        Origin: new URL(route.request().url()).origin,
        "Sec-Fetch-Site": "same-origin",
      },
    });
    admitted();
    try {
      await route.fulfill({ response });
    } catch {
      /* Original page was deliberately reloaded; admission still happened. */
    }
  });
  try {
    await page.goto("/index.html#/desktop/providers");
    let claude = page.getByRole("article", { name: "Claude", exact: true }),
      signIn = claude.getByRole("button", {
        name: "Sign in… · Claude",
        exact: true,
      });
    await expect(signIn).toBeEnabled();
    await signIn.click();
    await intercepted;
    expect(recorded()).toHaveLength(before);
    await page.reload();
    claude = page.getByRole("article", { name: "Claude", exact: true });
    signIn = claude.getByRole("button", {
      name: "Sign in… · Claude",
      exact: true,
    });
    await expect(signIn).toBeDisabled();
    await claude
      .getByRole("button", { name: "Check original sign-in", exact: true })
      .click();
    await expect(
      claude.getByText(
        "The original sign-in outcome could not be verified. Check it before opening another terminal.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(signIn).toBeDisabled();
    expect(recorded()).toHaveLength(before);
    release();
    await dispatched;
    await page.unroute("**/providers/claude/sign-in");
    await expect.poll(() => recorded().length).toBe(before + 1);
    await claude
      .getByRole("button", { name: "Check original sign-in", exact: true })
      .click();
    await expect(
      claude.getByText(/Complete the vendor's own sign-in window/),
    ).toBeVisible();
    await claude
      .getByRole("button", { name: "Close sign-in terminal", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath("provider-sign-in-controls.png"),
    });
    await claude
      .getByRole("button", { name: "Retry original sign-in", exact: true })
      .click();
    await expect(
      claude.getByRole("button", {
        name: "Retry original sign-in",
        exact: true,
      }),
    ).toBeEnabled();
    expect(recorded()).toHaveLength(before + 1);
    const second = await context.newPage();
    await second.goto("/index.html#/desktop/providers");
    const other = second.getByRole("article", { name: "Claude", exact: true });
    await expect(
      other.getByRole("button", { name: "Sign in… · Claude", exact: true }),
    ).toBeDisabled();
    await other
      .getByRole("button", { name: "Close sign-in terminal", exact: true })
      .click();
    await expect(
      other.getByText(/Run doctor to check authentication/),
    ).toBeVisible();
    for (const pid of [recorded().at(-1)?.pid, recorded().at(-1)?.childPid]) {
      if (typeof pid !== "number") throw Error("Missing inert process PID");
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    }
    expect(recorded()).toHaveLength(before + 1);
    await second.close();
    await page.bringToFront();
    await expect(signIn).toBeEnabled();
    await expect(
      claude.getByText(/Run doctor to check authentication/),
    ).toBeVisible();
  } finally {
    release();
    if (original && !page.isClosed()) {
      const token = await pageToken(page);
      await page.evaluate(
        async ({ requestId, token, header }) => {
          await fetch(
            `/__agent-forge/providers/claude/sign-in/${requestId}/stop`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", [header]: token },
              body: "{}",
            },
          );
        },
        { requestId: original, token, header: OPERATOR_HEADER },
      );
    }
  }
});
