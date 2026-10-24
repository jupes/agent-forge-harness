import { expect, test } from "bun:test";
import {
  activityHref,
  activityPagePath,
  emptyActivityFilters,
  parseActivityFilters,
} from "../../apps/desktop/src/project-activity-model";

const projectId = "project-015821b4-4b38-4bf3-9326-71ce9c09ff46";
test("Activity links round-trip exact project/object/time filters without losing selected event identity", () => {
  const filters = {
    ...emptyActivityFilters(),
    kinds: ["tool.called" as const, "gate.ran" as const],
    provider: "remote smith",
    sessionId: "session/with ? characters",
    since: "2026-10-23T12:00:00.000Z",
  };
  const href = activityHref(projectId, filters, 31);
  expect(parseActivityFilters(href)).toEqual({ filters, error: "" });
  const url = new URL(href.slice(1), "http://127.0.0.1");
  expect(url.searchParams.get("selectionId")).toBe("31");
  const path = new URL(
    activityPagePath(projectId, filters, 17),
    "http://127.0.0.1",
  );
  expect(path.pathname).toBe(`/__agent-forge/projects/${projectId}/activity`);
  expect(path.searchParams.get("after")).toBe("17");
  expect(path.searchParams.get("session")).toBe(filters.sessionId);
  expect(path.searchParams.get("kind")).toBe("tool.called,gate.ran");
  expect(path.searchParams.has("workspace")).toBe(false);
});

test("invalid, widened or repeated filters remain invalid instead of silently showing every project event", () => {
  for (const query of [
    "provider=a&provider=b",
    "workspace=/other",
    "kind=invalid",
    "since=yesterday",
    "since=2026-10-23T12:00:00Z&until=2026-10-22T12:00:00Z",
  ]) {
    const parsed = parseActivityFilters(
      `#/desktop/project/${projectId}/activity?${query}`,
    );
    expect(parsed.filters).toBeNull();
    expect(parsed.error).not.toBe("");
  }
});
