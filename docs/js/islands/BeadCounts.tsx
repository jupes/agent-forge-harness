/**
 * The dashboard's four Beads cards (Open, In progress, Blocked, Closed).
 *
 * The bundled snapshot is a copy of the tracker taken when it was built. When
 * a hearth answers, the cards show its count of the tracker itself
 * (`GET /beads/counts`, the snapshot builder's rules), read when the dashboard
 * is shown and again when a `bead.transitioned` event arrives or the stream
 * reopens. The hearth records that event for the writes it makes (the Beads
 * routes, the queue moves); a write made with `bd` outside the hearth records
 * nothing, and the cards show it at the next read.
 *
 * The tracker's counts are of the whole tracker, so with an initiative chosen
 * the cards show the snapshot's counts for it, as the tables below them do.
 * Where no hearth answers (a static copy), the read fails (one failed request
 * each time the dashboard is shown) and the cards show the snapshot's counts,
 * as they always have.
 *
 * A pure view and a thin wrapper that calls the hook, so the view is testable
 * as a plain function.
 */

import type { JSX } from "preact";
import type {
  BeadCounts as BeadCountValues,
  LedgerEventKind,
} from "../../../types/hearth";
import { StatCard } from "../ds/StatCard";
import { useOperatorRead } from "../use-stream";

/** A tracker write and a queue move each record this kind. */
const BEAD_COUNT_KINDS: readonly LedgerEventKind[] = ["bead.transitioned"];

export type BeadCountsSource = "tracker" | "snapshot";

export interface ShownBeadCounts {
  counts: BeadCountValues;
  source: BeadCountsSource;
}

/**
 * What the cards show: the tracker's counts while every initiative is shown
 * and the hearth has answered, otherwise the snapshot's (`snapshot` is null
 * when none is loaded). Null when there is neither.
 */
export function shownBeadCounts(
  snapshot: BeadCountValues | null,
  tracker: BeadCountValues | null,
  initiativeFilter: string,
): ShownBeadCounts | null {
  if (tracker !== null && initiativeFilter === "all")
    return { counts: tracker, source: "tracker" };
  return snapshot === null ? null : { counts: snapshot, source: "snapshot" };
}

const LABEL: Record<BeadCountsSource, string> = {
  tracker: "Beads counts, live from the tracker",
  snapshot: "Beads counts, from the snapshot",
};

export function BeadCountsView({
  shown,
}: {
  shown: ShownBeadCounts | null;
}): JSX.Element | null {
  if (shown === null) return null;
  const { counts, source } = shown;
  return (
    <section
      class="af-stat-row"
      aria-label={LABEL[source]}
      data-testid="bead-counts"
      data-source={source}
    >
      <StatCard label="Open" value={counts.open} tone="accent" />
      <StatCard label="In progress" value={counts.inProgress} tone="accent" />
      <StatCard label="Blocked" value={counts.blocked} />
      <StatCard label="Closed" value={counts.closed} tone="muted" />
    </section>
  );
}

/** The dashboard's Beads cards; `snapshot` is the snapshot's counts for the chosen initiative, or null without a snapshot. */
export function BeadCounts({
  snapshot,
  initiativeFilter,
}: {
  snapshot: BeadCountValues | null;
  initiativeFilter: string;
}): JSX.Element | null {
  const tracker = useOperatorRead<BeadCountValues>(
    "/beads/counts",
    BEAD_COUNT_KINDS,
  );
  return (
    <BeadCountsView
      shown={shownBeadCounts(snapshot, tracker.data, initiativeFilter)}
    />
  );
}
