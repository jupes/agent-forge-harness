import { expect, test } from "bun:test";
import {
  type DesktopRoute,
  desktopHref,
  desktopRoute,
  navigateGlobal,
  navigateProject,
} from "../../apps/desktop/src/navigation";

test("desktop destinations round-trip stable identifiers independently of display names", () => {
  const route: DesktopRoute = {
    destination: "beads",
    projectId: "project/one ?&",
    selection: { kind: "bead", id: "harness-x.1" },
  };
  expect(desktopRoute(desktopHref(route))).toEqual(route);
  expect(
    desktopRoute(desktopHref({ ...route, destination: "project-settings" }))
      .destination,
  ).toBe("project-settings");
});

test("global navigation preserves project scope and selection and returning to a project uses the same id", () => {
  const before: DesktopRoute = {
    destination: "sessions",
    projectId: "p-1",
    selection: { kind: "session", id: "provider-session-42" },
  };
  const providers = navigateGlobal(before, "providers");
  expect(providers).toEqual({ ...before, destination: "providers" });
  expect(desktopRoute(desktopHref(providers))).toEqual(providers);
  expect(navigateProject(providers, "overview")).toEqual({
    ...before,
    destination: "overview",
  });
});

test("missing projects and malformed links remain honest rather than inventing a selected project", () => {
  expect(desktopRoute("")).toEqual({
    destination: "projects",
    projectId: null,
    selection: null,
  });
  for (const hash of [
    "#/desktop/project//beads",
    "#/desktop/project/%XX/beads",
    "#/desktop/unknown",
    "#/desktop/project/p/unknown",
  ]) {
    expect(desktopRoute(hash)).toEqual({
      destination: "projects",
      projectId: null,
      selection: null,
    });
  }
  expect(navigateProject(desktopRoute(""), "beads").destination).toBe(
    "projects",
  );
});
