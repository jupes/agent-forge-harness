import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NO_PROJECT_NOTIFICATIONS,
  PROJECT_NOTIFICATION_EVENTS,
  projectInterruptionAllowed,
} from "./project-notifications-protocol";
import { createProjectStore } from "./store";
import { projectFixture } from "./testing";

test("project interruption preferences persist, isolate projects, and preserve creation history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "forge-notifications-"));
  try {
    const store = createProjectStore(directory);
    const { slug, name, description, icon, workspaces } =
      projectFixture(directory);
    const original = { slug, name, description, icon, workspaces };
    const catalog = await store.create(original, 0);
    const project = catalog.projects[0]!;
    const enabled = { ...NO_PROJECT_NOTIFICATIONS, "failed-gate": true };
    const saved = await store.updateNotifications(project.id, 1, enabled);
    expect(saved.projects[0]?.notifications).toEqual(enabled);
    expect(createProjectStore(directory).read()).toEqual(saved);
    for (const kind of PROJECT_NOTIFICATION_EVENTS) {
      expect(
        projectInterruptionAllowed(saved.projects[0]!, {
          projectId: project.id,
          kind,
          reason: "halted",
        }),
      ).toBe(kind === "failed-gate");
      expect(
        projectInterruptionAllowed(saved.projects[0]!, {
          projectId: "another-project",
          kind,
        }),
      ).toBe(false);
      expect(
        projectInterruptionAllowed(
          { ...saved.projects[0]!, archived: true },
          { projectId: project.id, kind },
        ),
      ).toBe(false);
      expect(
        projectInterruptionAllowed(project, { projectId: project.id, kind }),
      ).toBe(false);
    }
    expect(
      projectInterruptionAllowed(
        { ...project, notifications: { ...enabled, "stopped-shift": true } },
        { projectId: project.id, kind: "stopped-shift", reason: "completed" },
      ),
    ).toBe(false);
    expect(
      projectInterruptionAllowed(
        { ...project, notifications: { ...enabled, "stopped-shift": true } },
        { projectId: project.id, kind: "stopped-shift", reason: "halted" },
      ),
    ).toBe(true);
    await expect(
      store.updateNotifications(project.id, 1, enabled),
    ).rejects.toThrow();
    expect(store.read()).toEqual(saved);
    const cleared = await store.updateNotifications(project.id, 2, {
      ...NO_PROJECT_NOTIFICATIONS,
    });
    expect(cleared.projects[0]?.notifications).toEqual(
      NO_PROJECT_NOTIFICATIONS,
    );
    expect(cleared.createOperations).toEqual(catalog.createOperations);
    expect({
      ...cleared.projects[0],
      notifications: undefined,
      updatedAt: project.updatedAt,
    }).toEqual({ ...project, notifications: undefined });
    const second = await store.create(
      { ...original, slug: "another-project" },
      cleared.revision,
    );
    const archived = await store.preferences(project.id, second.revision, {
      archived: true,
    });
    await expect(
      store.updateNotifications(project.id, archived.revision, enabled),
    ).rejects.toMatchObject({ status: 409 });
    expect(store.read()).toEqual(archived);
    expect(store.read().projects[1]?.notifications).toBeUndefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
