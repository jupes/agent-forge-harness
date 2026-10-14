import { describe, expect, test } from "bun:test";
import {
  BeadCountsView,
  shownBeadCounts,
} from "../../docs/js/islands/BeadCounts";
import type { BeadCounts } from "../../types/hearth";
import { attrs, findAll, tag } from "./ds/vnode";

/**
 * The dashboard's four Beads cards: which counts they show (the tracker's,
 * read through the hearth, or the snapshot's) and how the row is drawn. The
 * reading itself is `useOperatorRead`, covered in `use-stream.test.ts`; the
 * page is exercised in `tests/e2e/bead-counts.spec.ts`.
 */

const SNAPSHOT: BeadCounts = { open: 3, inProgress: 3, blocked: 2, closed: 1 };
const TRACKER: BeadCounts = { open: 9, inProgress: 4, blocked: 0, closed: 12 };

describe("which counts the Beads cards show", () => {
  test("with every initiative shown, the tracker's counts replace the snapshot's", () => {
    expect(shownBeadCounts(SNAPSHOT, TRACKER, "all")).toEqual({
      counts: TRACKER,
      source: "tracker",
    });
  });

  test("with an initiative chosen, the snapshot's counts for it are shown", () => {
    expect(shownBeadCounts(SNAPSHOT, TRACKER, "demo-epic")).toEqual({
      counts: SNAPSHOT,
      source: "snapshot",
    });
  });

  test("until the tracker has answered, the snapshot's counts are shown", () => {
    expect(shownBeadCounts(SNAPSHOT, null, "all")).toEqual({
      counts: SNAPSHOT,
      source: "snapshot",
    });
  });

  test("without a snapshot, the tracker's counts are shown", () => {
    expect(shownBeadCounts(null, TRACKER, "all")).toEqual({
      counts: TRACKER,
      source: "tracker",
    });
  });

  test("with neither, nothing is shown", () => {
    expect(shownBeadCounts(null, null, "all")).toBeNull();
  });
});

describe("the Beads cards", () => {
  test("no row without counts", () => {
    expect(BeadCountsView({ shown: null })).toBeNull();
  });

  test("four labelled cards in the order and tones the dashboard has always used", () => {
    const row = BeadCountsView({
      shown: { counts: TRACKER, source: "tracker" },
    });
    const cards = findAll(row, "StatCard").map((card) => [
      card.props["label"],
      card.props["value"],
      card.props["tone"],
    ]);
    expect(cards).toEqual([
      ["Open", 9, "accent"],
      ["In progress", 4, "accent"],
      ["Blocked", 0, undefined],
      ["Closed", 12, "muted"],
    ]);
  });

  test("the row names where its numbers come from", () => {
    const live = BeadCountsView({
      shown: { counts: TRACKER, source: "tracker" },
    });
    expect(tag(live)).toBe("section");
    expect(attrs(live)).toMatchObject({
      class: "af-stat-row",
      "data-testid": "bead-counts",
      "data-source": "tracker",
      "aria-label": "Beads counts, live from the tracker",
    });
    const bundled = BeadCountsView({
      shown: { counts: SNAPSHOT, source: "snapshot" },
    });
    expect(attrs(bundled)).toMatchObject({
      "data-source": "snapshot",
      "aria-label": "Beads counts, from the snapshot",
    });
  });
});
