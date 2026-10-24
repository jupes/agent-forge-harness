import { expect, test } from "bun:test";
import { type ComponentChildren, isValidElement } from "preact";
import {
  ProjectShiftListStatus,
  type ShiftListRead,
} from "../../apps/desktop/src/ProjectShiftListStatus";

interface NoticeProps {
  children?: ComponentChildren;
  role?: string;
  "aria-live"?: string;
  "aria-hidden"?: boolean;
}
function nodes(value: ComponentChildren): NoticeProps[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement(value)) return [];
  return [value.props, ...nodes(value.props.children)];
}
function content(value: ComponentChildren): string {
  if (Array.isArray(value)) return value.map(content).join("");
  if (isValidElement(value)) return content(value.props.children);
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}
const empty = {
  projectId: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  asOf: "2026-10-23T18:00:00.000Z",
  items: [],
};
function render(patch: Partial<ShiftListRead> = {}) {
  return ProjectShiftListStatus({
    view: { page: null, loading: false, error: null, identity: null, ...patch },
  });
}

test("a held initial Shift read is visible, announced and never presented as verified empty", () => {
  for (const tree of [render(), render({ loading: true })]) {
    expect(content(tree)).toContain("Loading project shifts");
    expect(nodes(tree)).toContainEqual(
      expect.objectContaining({ role: "status", "aria-live": "polite" }),
    );
    expect(content(tree)).not.toContain("No project shifts reported");
    expect(nodes(tree).some((node) => node["aria-hidden"] === true)).toBe(true);
  }
});

test("a failed first read or stale empty read remains unknown with a retry rather than an empty claim", () => {
  for (const page of [null, empty]) {
    const tree = render({
      page,
      error: "The scoped read could not be verified.",
    });
    expect(nodes(tree).some((node) => node.role === "alert")).toBe(true);
    expect(content(tree)).toContain("Refresh shifts");
    expect(content(tree)).not.toContain("No project shifts reported");
  }
});

test("only a successfully verified empty page shows the empty list and a background read remains announced", () => {
  const tree = render({ page: empty });
  expect(content(tree)).toContain("No project shifts reported");
  expect(nodes(tree).some((node) => node.role === "status")).toBe(false);
  const checking = render({ page: empty, loading: true });
  expect(content(checking)).toContain("Checking project shifts");
  expect(content(checking)).not.toContain("No project shifts reported");
});

test("read-state transitions retain one keyed DOM boundary instead of borrowing the adjacent focused list", () => {
  const states = [
    render(),
    render({ page: empty, loading: true }),
    render({ page: empty }),
    render({ page: empty, error: "Read unavailable" }),
  ];
  for (const tree of states) {
    expect(tree.type).toBe("div");
    expect(tree.key).toBe("shift-read-state");
  }
});
