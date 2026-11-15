import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { integrationAuthorizationRequestSchema } from "../../scripts/desktop/mcp-authorization";
import { integrationClientSchema } from "../../types/app-integrations";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { seedProjects } from "./project-fixtures";

test.beforeEach(seedProjects);
const requestId = "ad000000-0000-4000-8000-000000000001",
  scopeKey = "a".repeat(64);
const nativeRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({ operation: z.literal("review"), client: integrationClientSchema })
    .strict(),
  z
    .object({ operation: z.literal("commit"), requestId: z.string().uuid() })
    .strict(),
  z
    .object({ operation: z.literal("recover"), requestId: z.string().uuid() })
    .strict(),
]);
type NativeRequest = z.infer<typeof nativeRequestSchema>;
const panel = (page: Page) =>
  page.getByRole("region", { name: "MCP integrations", exact: true });
async function nativeFixture(
  page: Page,
  mode: "confirmed" | "lost" = "confirmed",
) {
  const calls: NativeRequest[] = [];
  const approvals: ReturnType<
    typeof integrationAuthorizationRequestSchema.parse
  >[] = [];
  await page.exposeFunction("__AF_MCP_RECORD", (raw: unknown) => {
    calls.push(nativeRequestSchema.parse(raw));
  });
  await page.addInitScript(
    ({ requestId, scopeKey, mode }) => {
      Object.defineProperty(window, "__TAURI_INTERNALS__", {
        value: {
          async invoke(command: string, input: { request: NativeRequest }) {
            if (command !== "mcp_registration")
              throw Error("Unexpected native command");
            const request = input.request,
              record: unknown = Reflect.get(window, "__AF_MCP_RECORD");
            if (typeof record !== "function")
              throw Error("Missing native observer");
            await Reflect.apply(record, window, [request]);
            const data =
              request.operation === "review"
                ? {
                    state: "review",
                    client: request.client,
                    requestId,
                    scopeKey,
                    expiresAt: Date.now() + 120000,
                  }
                : {
                    state: "confirmed",
                    client: "claude",
                    requestId: request.requestId,
                    scopeKey,
                    reason: null,
                  };
            if (request.operation === "commit" && mode === "lost")
              throw Error("PRIVATE_CONFIG");
            return { ok: true, data, error: null };
          },
        },
      });
    },
    { requestId, scopeKey, mode },
  );
  await page.route(
    "**/__agent-forge/app-settings/integrations/authorize",
    async (route) => {
      expect(route.request().method()).toBe("POST");
      const request = integrationAuthorizationRequestSchema.parse(
        route.request().postDataJSON(),
      );
      approvals.push(request);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: { schemaVersion: 1, ...request, authorized: true },
          error: null,
        }),
      });
    },
  );
  return { calls, approvals };
}
async function negativeControl(
  page: Page,
  kind: "unavailable" | "review" | "recover" | "focus",
) {
  if (process.env.FORGE_MCP_UI_NEGATIVE_CONTROL !== "1") return;
  await page.addInitScript((kind) => {
    if (kind === "unavailable")
      new MutationObserver(() => {
        for (const button of document.querySelectorAll("button"))
          if (
            button.textContent?.trim().startsWith("Review ") &&
            button.textContent.trim().endsWith(" registration") &&
            button.disabled
          )
            button.disabled = false;
      }).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["disabled"],
      });
    if (kind === "review" || kind === "recover")
      document.addEventListener(
        "click",
        (event) => {
          const button =
            event.target instanceof Element
              ? event.target.closest("button")
              : null;
          const label = button?.textContent?.trim();
          if (
            label ===
            (kind === "review"
              ? "Review Claude Code registration"
              : "Check Claude Code registration receipt")
          ) {
            event.preventDefault();
            event.stopImmediatePropagation();
          }
        },
        true,
      );
  }, kind);
}
test("browser integration controls stay unavailable without native authority", async ({
  page,
}) => {
  await negativeControl(page, "unavailable");
  await openSettled(page, "/#/desktop/app-settings");
  const region = panel(page);
  await expect(
    region.getByText(
      "MCP registration is available in the Windows desktop app.",
      { exact: true },
    ),
  ).toBeVisible();
  for (const client of ["Claude Code", "Codex", "Cursor"])
    await expect(
      region.getByRole("button", {
        name: "Review " + client + " registration",
        exact: true,
      }),
    ).toBeDisabled();
});
test("integration review and Cancel are inert; keyboard confirmation sends one approval and publication", async ({
  page,
}) => {
  await negativeControl(page, "review");
  const fixture = await nativeFixture(page);
  await openSettled(page, "/#/desktop/app-settings");
  const region = panel(page),
    review = region.getByRole("button", {
      name: "Review Claude Code registration",
      exact: true,
    });
  expect(fixture.calls).toEqual([]);
  expect(fixture.approvals).toEqual([]);
  await review.focus();
  await page.keyboard.press("Enter");
  await expect(
    region.getByRole("group", {
      name: "Confirm Claude Code registration",
      exact: true,
    }),
  ).toBeVisible();
  expect(fixture.calls.map((x) => x.operation)).toEqual(["review"]);
  expect(fixture.approvals).toEqual([]);
  await region
    .getByRole("button", { name: "Cancel Claude Code review", exact: true })
    .click();
  await expect(
    region.getByRole("group", {
      name: "Confirm Claude Code registration",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(fixture.approvals).toEqual([]);
  await review.click();
  const confirm = region.getByRole("button", {
    name: "Register Forge in Claude Code",
    exact: true,
  });
  await confirm.focus();
  await page.keyboard.press("Enter");
  await expect(
    region.getByText(
      "Forge configuration confirmed. Client connection and trust have not been checked.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(fixture.approvals).toEqual([{ client: "claude", requestId }]);
  expect(fixture.calls.map((x) => x.operation)).toEqual([
    "review",
    "review",
    "commit",
  ]);
});
test("lost integration response survives reload and only original recovery can resolve it", async ({
  page,
}) => {
  await negativeControl(page, "recover");
  const fixture = await nativeFixture(page, "lost");
  await openSettled(page, "/#/desktop/app-settings");
  const region = panel(page);
  await region
    .getByRole("button", {
      name: "Review Claude Code registration",
      exact: true,
    })
    .click();
  await region
    .getByRole("button", { name: "Register Forge in Claude Code", exact: true })
    .click();
  const recover = region.getByRole("button", {
    name: "Check Claude Code registration receipt",
    exact: true,
  });
  await expect(recover).toBeEnabled();
  await expect(
    region.getByRole("button", {
      name: "Review Claude Code registration",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    region.getByText("PRIVATE_CONFIG", { exact: false }),
  ).toHaveCount(0);
  await reloadSettled(page);
  await expect(recover).toBeEnabled();
  expect(fixture.calls.filter((x) => x.operation === "commit")).toHaveLength(1);
  expect(fixture.approvals).toHaveLength(1);
  await recover.click();
  await expect(
    region.getByText(
      "Forge configuration confirmed. Client connection and trust have not been checked.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(fixture.calls.at(-1)).toEqual({ operation: "recover", requestId });
  expect(fixture.calls.filter((x) => x.operation === "commit")).toHaveLength(1);
  expect(fixture.approvals).toHaveLength(1);
});
test("integration review labels and keyboard targets fit desktop minimum in Light and dark", async ({
  page,
}) => {
  await negativeControl(page, "focus");
  await nativeFixture(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(page, "/#/desktop/app-settings");
  const region = panel(page);
  await region
    .getByRole("button", {
      name: "Review Claude Code registration",
      exact: true,
    })
    .click();
  const confirm = region.getByRole("button", {
    name: "Register Forge in Claude Code",
    exact: true,
  });
  await page.keyboard.press("Tab");
  await confirm.focus();
  await expect(confirm).toBeFocused();
  await expect
    .poll(() => confirm.evaluate((el) => getComputedStyle(el).outlineWidth))
    .toBe("2px");
  if (process.env.FORGE_MCP_UI_NEGATIVE_CONTROL === "1")
    await confirm.evaluate((el) =>
      el.style.setProperty("outline-width", "0px", "important"),
    );
  expect(
    await confirm.evaluate((el) => getComputedStyle(el).outlineWidth),
  ).toBe("2px");
  mkdirSync(".tmp/screenshots/integrations", { recursive: true });
  for (const [theme, width] of [
    ["dark", 1280],
    ["light", 1100],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page
      .locator("html")
      .evaluate((el, theme) => el.setAttribute("data-af-theme", theme), theme);
    await expect(page.locator("html")).toHaveAttribute("data-af-theme", theme);
    await expect(confirm).toBeVisible();
    expect(
      await confirm.evaluate((el) => el.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(32);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await region.screenshot({
      path:
        ".tmp/screenshots/integrations/review-" + theme + "-" + width + ".png",
    });
  }
});
