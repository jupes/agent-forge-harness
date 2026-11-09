import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { alpha, catalog, catalogFile, seedProjects } from "./project-fixtures";

test("1.0 Settings keeps saved Scope and preferences while deferring native notification controls", async ({
  page,
}) => {
  seedProjects();
  const id = `project-${randomUUID()}`;
  writeFileSync(
    catalogFile,
    JSON.stringify({
      ...catalog,
      projects: catalog.projects.map((project) =>
        project.id === alpha.id
          ? {
              ...project,
              id,
              notifications: {
                "stopped-shift": true,
                "failed-gate": true,
                "council-verdict": false,
                "bead-approval": true,
              },
            }
          : project,
      ),
    }),
  );
  const before = readFileSync(catalogFile, "utf8");
  await page.addInitScript(() => {
    const calls: string[] = [];
    Object.defineProperty(window, "__settingsNotificationCalls", {
      value: calls,
    });
    class UnexpectedNotification {
      constructor() {
        calls.push("constructor");
      }
      static requestPermission() {
        calls.push("permission");
        return Promise.resolve("denied");
      }
    }
    Object.defineProperty(window, "Notification", {
      value: UnexpectedNotification,
      configurable: true,
    });
  });
  await openSettled(
    page,
    `/index.html#/desktop/project/${id}/project-settings`,
  );
  const notifications = page.getByRole("region", {
    name: "Notifications",
    exact: true,
  });
  await expect(notifications).toContainText("planned for 1.1");
  await expect(notifications.getByRole("checkbox")).toHaveCount(0);
  await expect(notifications.getByRole("button")).toHaveCount(0);
  const scope = page.getByRole("region", { name: "Scope", exact: true });
  await expect(scope).toContainText("read-only in 1.0");
  await expect(scope).toContainText("alpha-epic");
  await expect(scope.getByRole("button")).toHaveCount(0);
  await reloadSettled(page);
  await expect(notifications).toContainText("planned for 1.1");
  expect(
    await page.evaluate(() =>
      Reflect.get(window, "__settingsNotificationCalls"),
    ),
  ).toEqual([]);
  expect(readFileSync(catalogFile, "utf8")).toBe(before);
});
