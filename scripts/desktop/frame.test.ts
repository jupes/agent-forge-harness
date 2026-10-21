import { expect, test } from "bun:test";
import {
  DesktopFrame,
  ProviderMonogram,
} from "../../apps/desktop/src/DesktopFrame";
import { desktopRoute } from "../../apps/desktop/src/navigation";
import { attrs, findAll, textOf } from "../dashboard/ds/vnode";

test("the desktop frame exposes global, project, main and inspector landmarks with honest unknown chips", () => {
  const view = DesktopFrame({
    route: desktopRoute(""),
    project: null,
    connectionLabel: "Connecting",
    inspectorOpen: true,
    onInspectorToggle() {},
    children: "Projects content",
  });
  expect(
    findAll(view, "nav").map((node) => attrs(node)["aria-label"]),
  ).toContain("Global");
  expect(
    findAll(view, "aside").map((node) => attrs(node)["aria-label"]),
  ).toEqual(["Project", "Inspector"]);
  expect(findAll(view, "main").map((node) => attrs(node).id)).toEqual([
    "af-main",
  ]);
  expect(textOf(view)).toContain("No project selected");
  expect(textOf(view)).toContain("Usage —");
  expect(textOf(view)).not.toContain("42%");
  expect(
    findAll(view, "a").filter((node) => attrs(node)["aria-current"] === "page"),
  ).toHaveLength(1);
});

test("selected links carry stable project ids, long names have a title, and foreign session rows stay out", () => {
  const route = desktopRoute("#/desktop/project/p-1/beads");
  const name = "A very long project name ".repeat(12);
  const project = { id: "p-1", name, sessions: [] };
  const view = DesktopFrame({
    route,
    project,
    connectionLabel: "Connected",
    inspectorOpen: false,
    onInspectorToggle() {},
    children: "Beads",
  });
  expect(findAll(view, "a").some((node) => attrs(node).title === name)).toBe(
    true,
  );
  const selected = findAll(view, "a").filter(
    (node) => attrs(node)["aria-current"] === "page",
  );
  expect(selected.map((node) => attrs(node).href)).toContain(
    "#/desktop/project/p-1/beads",
  );
  const other = DesktopFrame({
    route,
    project: {
      ...project,
      id: "p-other",
      sessions: [
        {
          id: "secret-session",
          title: "Other project session",
          provider: "claude",
          status: "running",
        },
      ],
    },
    connectionLabel: "Connected",
    inspectorOpen: false,
    onInspectorToggle() {},
    children: "Beads",
  });
  expect(textOf(other)).not.toContain("Other project session");
});

test("provider monograms always carry the provider name", () => {
  for (const provider of [
    "claude",
    "codex",
    "gemini",
    "grok",
    "openrouter",
    "keeper",
  ] as const) {
    const view = ProviderMonogram({ provider });
    expect(attrs(view)["aria-label"]).toBeTruthy();
    expect(textOf(view).length).toBeGreaterThan(0);
  }
});
