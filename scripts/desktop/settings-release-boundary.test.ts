import { expect, test } from "bun:test";
import { join } from "node:path";
import { importGraph } from "../import-graph";

test("production1.0 packaged graph excludes foreign Source and Scope-edit services while retaining the local complete tracker", () => {
  const graph = importGraph(
    join(import.meta.dir, "../hearth/compiled-entry.ts"),
  );
  const names = graph.files.map((file) => file.replaceAll("\\", "/"));
  for (const deferred of [
    "projects/connected-source-service.ts",
    "projects/connected-source-transport.ts",
    "projects/connected-source-picker.ts",
    "projects/scope-settings-service.ts",
    "hearth/routes/connected-sources.ts",
    "hearth/routes/scope-settings.ts",
    "hearth/routes/deferred-project-settings-fixture.ts",
  ])
    expect(names.some((file) => file.endsWith("/" + deferred))).toBe(false);
  expect(
    names.some((file) => file.endsWith("/projects/complete-tracker-reader.ts")),
  ).toBe(true);
  expect(
    names.some((file) => file.endsWith("/projects/complete-tracker-entry.ts")),
  ).toBe(true);
});
test("production1.0 desktop graph cannot activate OS-notification observers or the deferred Scope editor", () => {
  const names = importGraph(
    join(import.meta.dir, "../../apps/desktop/src/DesktopApp.tsx"),
  ).files;
  for (const deferred of [
    "use-notification-delivery.ts",
    "notification-delivery.ts",
    "project-event-notifications.ts",
    "app-notifications-client.ts",
    "AppNotificationSettings.tsx",
    "ProjectScopeSettings.tsx",
    "project-scope-client.ts",
  ])
    expect(names.some((file) => file.endsWith("/" + deferred))).toBe(false);
  expect(
    names.some((file) => file.endsWith("/ProjectSettingsBaseline.tsx")),
  ).toBe(true);
  expect(names.some((file) => file.endsWith("/ProjectActivity.tsx"))).toBe(
    true,
  );
});
