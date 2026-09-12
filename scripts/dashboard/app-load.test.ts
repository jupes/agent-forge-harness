import { describe, expect, test } from "bun:test";
import {
  needsSnapshot,
  pageTitleFor,
  snapshotLabelFor,
} from "../../docs/js/app-state";
import { parseRoute } from "../../docs/js/router";

describe("which routes need the Beads snapshot", () => {
  // The old shell hid Commands/Skill builder/Bead builder behind a failed
  // fetch on first paint, because the only code path that rendered them ran
  // after loadData() resolved. These routes read no Beads data at all.
  test("data-independent routes render without a snapshot", () => {
    expect(needsSnapshot("commands")).toBe(false);
    expect(needsSnapshot("skill-builder")).toBe(false);
    expect(needsSnapshot("bead-builder")).toBe(false);
    expect(needsSnapshot("forge-run")).toBe(false);
    expect(needsSnapshot("repos")).toBe(false);
  });

  test("issue views do need it", () => {
    expect(needsSnapshot("dashboard")).toBe(true);
    expect(needsSnapshot("issues")).toBe(true);
    expect(needsSnapshot("epics")).toBe(true);
    expect(needsSnapshot("insights")).toBe(true);
  });

  test("a deep link to a data-independent route survives a failed fetch", () => {
    // The exact failure combination from the research doc: first paint, on a
    // deep link, with no snapshot available.
    const route = parseRoute("#/commands");
    expect(needsSnapshot(route)).toBe(false);
  });
});

describe("snapshotLabelFor", () => {
  test("reports the not-loaded state when there is no payload", () => {
    expect(snapshotLabelFor(null)).toEqual({
      label: "Snapshot: not loaded",
      iso: "",
    });
  });

  test("formats a real timestamp and keeps the ISO value for the title", () => {
    const result = snapshotLabelFor("2026-09-10T12:10:00.000Z");
    expect(result.label.startsWith("Snapshot built:")).toBe(true);
    expect(result.iso).toBe("2026-09-10T12:10:00.000Z");
  });

  test("passes an unparseable value through rather than printing Invalid Date", () => {
    const result = snapshotLabelFor("not-a-date");
    expect(result.label).toContain("not-a-date");
    expect(result.label).not.toContain("Invalid");
  });
});

describe("pageTitleFor", () => {
  test("gives every route a title and blurb from the route table", () => {
    expect(pageTitleFor("issues").title).toBe("All issues");
    expect(pageTitleFor("issues").blurb.length).toBeGreaterThan(0);
    expect(pageTitleFor("bead-builder").title).toBe("Bead builder");
  });
});
