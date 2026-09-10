import { describe, expect, test } from "bun:test";
import { Dialog } from "../../../docs/js/ds/Dialog";
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

describe("Dialog", () => {
  test("renders nothing at all when closed", () => {
    expect(
      Dialog({ open: false, title: "x", onClose: () => {}, children: null }),
    ).toBeNull();
  });

  test("is a labelled modal dialog when open", () => {
    const el = Dialog({
      open: true,
      title: "Copied to clipboard",
      onClose: () => {},
      children: "body",
    });
    const dialog = findWhere(el, (p) => p["role"] === "dialog");
    expect(dialog).toBeDefined();
    expect(attrs(dialog)["aria-modal"]).toBe("true");
    // Labelled by its own heading rather than a duplicated aria-label.
    const labelledBy = attrs(dialog)["aria-labelledby"];
    expect(typeof labelledBy).toBe("string");
    const heading = findWhere(el, (p) => p["id"] === labelledBy);
    expect(textOf(heading)).toBe("Copied to clipboard");
  });

  test("offers an explicit close control wired to onClose", () => {
    let closed = 0;
    const el = Dialog({
      open: true,
      title: "t",
      onClose: () => {
        closed += 1;
      },
      children: null,
    });
    const closer = findWhere(el, (p) => p["aria-label"] === "Close dialog");
    expect(closer).toBeDefined();
    (attrs(closer)["onClick"] as () => void)();
    expect(closed).toBe(1);
  });

  test("closes on Escape from anywhere inside the dialog", () => {
    let closed = 0;
    const el = Dialog({
      open: true,
      title: "t",
      onClose: () => {
        closed += 1;
      },
      children: null,
    });
    const withKeys = findWhere(el, (p) => typeof p["onKeyDown"] === "function");
    expect(withKeys).toBeDefined();
    const onKeyDown = attrs(withKeys)["onKeyDown"] as (e: {
      key: string;
      stopPropagation: () => void;
    }) => void;
    onKeyDown({ key: "Escape", stopPropagation: () => {} });
    expect(closed).toBe(1);
    onKeyDown({ key: "a", stopPropagation: () => {} });
    expect(closed).toBe(1);
  });

  test("dismisses on backdrop click but not on clicks inside the panel", () => {
    let closed = 0;
    const el = Dialog({
      open: true,
      title: "t",
      onClose: () => {
        closed += 1;
      },
      children: null,
    });
    const backdrop = findAll(el, "div")[0];
    const onClick = attrs(backdrop)["onClick"] as (e: {
      target: unknown;
      currentTarget: unknown;
    }) => void;
    const node = {};
    onClick({ target: node, currentTarget: node });
    expect(closed).toBe(1);
    onClick({ target: {}, currentTarget: node });
    expect(closed).toBe(1);
  });
});
