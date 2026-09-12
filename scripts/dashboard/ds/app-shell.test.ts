import { describe, expect, test } from "bun:test";
import { AppShell } from "../../../docs/js/ds/AppShell";
import { ROUTES } from "../../../docs/js/router";
import { attrs, findAll, findWhere, textOf } from "./vnode";

/** Minimum props for a shell render. */
function shell(overrides: Record<string, unknown> = {}) {
  return AppShell({
    active: "dashboard",
    title: "Dashboard",
    blurb: "Beads snapshot",
    children: "page content",
    ...overrides,
  } as Parameters<typeof AppShell>[0]);
}

describe("AppShell navigation", () => {
  test("renders every SPA route plus the two standalone documents", () => {
    const links = findAll(shell(), "a").filter((a) =>
      String(attrs(a)["class"] ?? "").includes("af-nav-item"),
    );
    // 9 hash routes + plan-review.html + council.html
    expect(links).toHaveLength(ROUTES.length + 2);
    expect(links).toHaveLength(11);
  });

  test("links standalone pages by document, and SPA views by hash", () => {
    const hrefs = findAll(shell(), "a")
      .filter((a) => String(attrs(a)["class"] ?? "").includes("af-nav-item"))
      .map((a) => String(attrs(a)["href"]));

    expect(hrefs).toContain("#/issues");
    expect(hrefs).toContain("#/forge-run");
    expect(hrefs).toContain("#/repos");
    expect(hrefs).toContain("plan-review.html");
    expect(hrefs).toContain("council.html");
  });

  test("marks the active destination for assistive tech, not just visually", () => {
    const current = findAll(shell({ active: "issues" }), "a").filter(
      (a) => attrs(a)["aria-current"] === "page",
    );
    expect(current).toHaveLength(1);
    expect(textOf(current[0])).toContain("All issues");
  });

  test("marks a standalone page active when the shell is mounted there", () => {
    const current = findAll(shell({ active: "council" }), "a").filter(
      (a) => attrs(a)["aria-current"] === "page",
    );
    expect(current).toHaveLength(1);
    expect(textOf(current[0])).toContain("Council");
  });

  test("targets the SPA by document from a standalone page so links still work", () => {
    const hrefs = findAll(shell({ active: "council" }), "a")
      .filter((a) => String(attrs(a)["class"] ?? "").includes("af-nav-item"))
      .map((a) => String(attrs(a)["href"]));
    expect(hrefs).toContain("index.html#/issues");
    expect(hrefs).not.toContain("#/issues");
  });

  test("nav is a labelled landmark and the content region is a main", () => {
    const el = shell();
    const nav = findAll(el, "nav")[0];
    expect(attrs(nav)["aria-label"]).toBe("Main");
    expect(findAll(el, "main")).toHaveLength(1);
  });

  test("offers a skip control that does not touch the hash", () => {
    const skip = findWhere(shell(), (p) =>
      String(p["class"] ?? "").includes("af-skip-link"),
    );
    expect(skip).toBeDefined();
    expect(textOf(skip)).toContain("Skip to content");
    // A button, not an anchor: an href="#af-main" would go through the hash
    // router and navigate away from the current page.
    expect(attrs(skip)["type"]).toBe("button");
    expect(attrs(skip)["href"]).toBeUndefined();

    const main = findAll(shell(), "main")[0];
    expect(attrs(main)["id"]).toBe("af-main");
    // Focusable by script without joining the tab order.
    expect(attrs(main)["tabIndex"]).toBe(-1);
  });
});

describe("AppShell global actions", () => {
  // Council's hand-written nav dropped all of these. The shell owns them so no
  // page can silently ship without them again.

  test("renders the refresh-snapshot control wired to its handler", () => {
    let refreshed = 0;
    const el = shell({
      onRefreshSnapshot: () => {
        refreshed += 1;
      },
    });
    const button = findWhere(el, (p) =>
      String(p["class"] ?? "").includes("af-shell-refresh"),
    );
    expect(button).toBeDefined();
    (attrs(button)["onClick"] as () => void)();
    expect(refreshed).toBe(1);
  });

  test("disables the refresh control and says so while a refresh is in flight", () => {
    const el = shell({ onRefreshSnapshot: () => {}, refreshing: true });
    const button = findWhere(el, (p) =>
      String(p["class"] ?? "").includes("af-shell-refresh"),
    );
    expect(attrs(button)["disabled"]).toBe(true);
    expect(textOf(button)).toContain("Refreshing");
  });

  test("announces the snapshot timestamp politely, with the ISO value in title", () => {
    const el = shell({
      snapshotLabel: "Snapshot built: Sep 10, 2026, 12:10",
      snapshotIso: "2026-09-10T12:10:00.000Z",
    });
    const label = findWhere(el, (p) =>
      String(p["class"] ?? "").includes("af-shell-snapshot"),
    );
    expect(attrs(label)["aria-live"]).toBe("polite");
    expect(textOf(label)).toContain("Snapshot built");
    expect(String(attrs(label)["title"])).toContain("2026-09-10T12:10");
  });

  test("shows the not-loaded snapshot state rather than an empty gap", () => {
    const label = findWhere(shell(), (p) =>
      String(p["class"] ?? "").includes("af-shell-snapshot"),
    );
    expect(textOf(label)).toContain("not loaded");
  });

  test("always mounts the copy-toast target so every page can announce a copy", () => {
    const toast = findWhere(shell(), (p) => p["id"] === "copy-toast");
    expect(toast).toBeDefined();
    expect(attrs(toast)["role"]).toBe("status");
    expect(attrs(toast)["aria-live"]).toBe("polite");
  });
});

describe("AppShell header", () => {
  test("renders the page title as the h1 and its blurb beneath", () => {
    const el = shell({ title: "All issues", blurb: "The Beads graph" });
    const h1 = findAll(el, "h1")[0];
    expect(textOf(h1)).toBe("All issues");
    expect(textOf(el)).toContain("The Beads graph");
  });

  test("renders page-supplied header actions beside the title", () => {
    const el = shell({ headerActions: "custom action" });
    expect(textOf(el)).toContain("custom action");
  });

  test("renders the page content inside main", () => {
    expect(textOf(findAll(shell(), "main")[0])).toContain("page content");
  });
});
