import { describe, expect, test } from "bun:test";
import { DialogView } from "../../../docs/js/ds/Dialog";
import { EmptyState } from "../../../docs/js/ds/EmptyState";
import { ProgressBar } from "../../../docs/js/ds/ProgressBar";
import { StatCard } from "../../../docs/js/ds/StatCard";
import { attrs, findAll, findWhere, tag, textOf } from "./vnode";

describe("StatCard", () => {
  test("shows a label, value and optional note", () => {
    const el = StatCard({ label: "Ready", value: 6, note: "unblocked" });
    expect(textOf(el)).toContain("Ready");
    expect(textOf(el)).toContain("6");
    expect(textOf(el)).toContain("unblocked");
  });

  test("keeps the label readable to assistive tech as one labelled figure", () => {
    const el = StatCard({ label: "Blocked", value: 1 });
    expect(tag(el)).toBe("div");
    expect(attrs(el)["class"]).toContain("af-stat");
  });

  test("carries an accent mark class so tone can vary per stat", () => {
    expect(attrs(StatCard({ label: "a", value: 1 }))["class"]).toContain(
      "af-stat-neutral",
    );
    expect(
      attrs(StatCard({ label: "a", value: 1, tone: "accent" }))["class"],
    ).toContain("af-stat-accent");
  });
});

describe("ProgressBar", () => {
  test("exposes its progress to assistive tech, not just visually", () => {
    const el = ProgressBar({ value: 3, max: 10, label: "Epic progress" });
    const bar = findWhere(el, (p) => p["role"] === "progressbar");
    expect(bar).toBeDefined();
    expect(attrs(bar)["aria-valuenow"]).toBe(3);
    expect(attrs(bar)["aria-valuemin"]).toBe(0);
    expect(attrs(bar)["aria-valuemax"]).toBe(10);
    expect(attrs(bar)["aria-label"]).toBe("Epic progress");
  });

  test("clamps out-of-range values instead of overflowing the track", () => {
    const over = findWhere(
      ProgressBar({ value: 20, max: 10, label: "x" }),
      (p) => typeof p["style"] === "string" && String(p["style"]).includes("%"),
    );
    expect(String(attrs(over)["style"])).toContain("100%");

    const under = findWhere(
      ProgressBar({ value: -5, max: 10, label: "x" }),
      (p) => typeof p["style"] === "string" && String(p["style"]).includes("%"),
    );
    expect(String(attrs(under)["style"])).toContain("0%");
  });

  test("treats a zero maximum as empty rather than dividing by zero", () => {
    const el = ProgressBar({ value: 0, max: 0, label: "no children" });
    const fill = findWhere(
      el,
      (p) => typeof p["style"] === "string" && String(p["style"]).includes("%"),
    );
    expect(String(attrs(fill)["style"])).toContain("0%");
  });
});

describe("EmptyState", () => {
  test("explains the emptiness and can offer a next step", () => {
    const el = EmptyState({
      title: "No epics yet",
      hint: "Create one with bd create --type epic",
    });
    expect(textOf(el)).toContain("No epics yet");
    expect(textOf(el)).toContain("bd create --type epic");
    expect(attrs(el)["class"]).toContain("af-empty");
  });

  test("announces itself politely when it replaces loaded content", () => {
    const el = EmptyState({ title: "Nothing here", live: true });
    expect(attrs(el)["aria-live"]).toBe("polite");
  });
});

// Structure only. Modality — inert background, contained Tab order, focus
// return — needs a real browser and lives in tests/e2e/a11y.spec.ts.
describe("DialogView", () => {
  function view(overrides: Partial<Parameters<typeof DialogView>[0]> = {}) {
    return DialogView({
      open: true,
      title: "Copied to clipboard",
      onClose: () => {},
      children: "body",
      ...overrides,
    });
  }

  test("is a native dialog element, so the browser can make it modal", () => {
    expect(tag(view())).toBe("dialog");
  });

  test("keeps the element mounted but empty while closed", () => {
    const closed = view({ open: false });
    expect(tag(closed)).toBe("dialog");
    expect(findAll(closed, "h2")).toHaveLength(0);
  });

  test("is labelled by its own heading", () => {
    const el = view();
    const labelledBy = attrs(el)["aria-labelledby"];
    expect(typeof labelledBy).toBe("string");
    const heading = findWhere(el, (p) => p["id"] === labelledBy);
    expect(textOf(heading)).toBe("Copied to clipboard");
  });

  test("offers an explicit close control wired to onClose", () => {
    let closed = 0;
    const el = view({
      onClose: () => {
        closed += 1;
      },
    });
    const closer = findWhere(el, (p) => p["aria-label"] === "Close dialog");
    (attrs(closer)["onClick"] as () => void)();
    expect(closed).toBe(1);
  });

  test("Escape (the cancel event) closes through state, not by itself", () => {
    let closed = 0;
    let prevented = false;
    const el = view({
      onClose: () => {
        closed += 1;
      },
    });
    (attrs(el)["onCancel"] as (e: { preventDefault: () => void }) => void)({
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
    expect(closed).toBe(1);
  });

  test("dismisses on backdrop click but not on clicks inside the panel", () => {
    let closed = 0;
    const el = view({
      onClose: () => {
        closed += 1;
      },
    });
    const onClick = attrs(el)["onClick"] as (e: {
      target: unknown;
      currentTarget: unknown;
    }) => void;
    const node = {};
    onClick({ target: node, currentTarget: node });
    expect(closed).toBe(1);
    onClick({ target: {}, currentTarget: node });
    expect(closed).toBe(1);
  });

  test("focuses the close button by default, or defers to content", () => {
    const closer = (el: ReturnType<typeof view>) =>
      findWhere(el, (p) => p["aria-label"] === "Close dialog");
    expect(attrs(closer(view()))["autofocus"]).toBe(true);
    expect(attrs(closer(view({ initialFocus: "content" })))["autofocus"]).toBe(
      false,
    );
  });
});
