/**
 * What the page shows about its connection to the hearth's event stream: one
 * notice when live updates are off, and the live stat cards of the dashboard.
 *
 * Each is a pure view and a thin wrapper that reads the stream, so the views
 * are testable as plain functions.
 */

import type { JSX } from "preact";
import {
  type LiveOffReason,
  type LiveState,
  type LiveStats as LiveStatsValues,
  type LiveStatus,
  liveStats,
} from "../app-state";
import { StatCard } from "../ds/StatCard";
import type { RouteId } from "../router";
import { useStream } from "../use-stream";

/** The routes that show something from the stream; the notice appears on these only. */
const LIVE_ROUTES = new Set<RouteId>(["dashboard", "forge-run"]);

export interface LiveBannerViewProps {
  status: LiveStatus;
  reason: LiveOffReason | null;
}

/** Nothing while live updates work or are still being set up; one line once they are off. */
export function LiveBannerView({
  status,
  reason,
}: LiveBannerViewProps): JSX.Element | null {
  if (status !== "off") return null;
  return (
    <p class="af-notice" role="status" data-testid="live-banner">
      {reason === "no-hearth" ? (
        <>
          Live updates are off: no control plane answers here. Run{" "}
          <code>bun run dashboard</code> at the harness root for a live view.
        </>
      ) : (
        <>
          Live updates stopped: the control plane did not answer. What is shown
          may be out of date. Reload the page to connect again.
        </>
      )}
    </p>
  );
}

const bannerOf = (state: LiveState): string =>
  `${state.status}:${state.offReason ?? ""}`;

/**
 * Mounted once by the app, above the route content. It is on every route, so
 * its subscription keeps the one connection open while the user moves between
 * pages; it draws only on the routes that use the stream.
 */
export function LiveBanner({ route }: { route: RouteId }): JSX.Element | null {
  const [status, reason] = useStream(bannerOf).split(":");
  if (!LIVE_ROUTES.has(route)) return null;
  return (
    <LiveBannerView
      // justification: `bannerOf` wrote these two values; an empty reason is none.
      status={status as LiveStatus}
      reason={(reason || null) as LiveOffReason | null}
    />
  );
}

/** A number, or a dash while its collection could not be read. */
const shown = (value: number | null): string | number => value ?? "–";

export function LiveStatsView({
  stats,
  lastKnown = false,
}: {
  stats: LiveStatsValues | null;
  lastKnown?: boolean;
}): JSX.Element | null {
  if (stats === null) return null;
  return (
    <section
      class="af-stat-row"
      aria-label={
        lastKnown
          ? "Last received from the control plane"
          : "Live from the control plane"
      }
      data-testid="live-stats"
    >
      <StatCard
        label="Runs in flight"
        value={shown(stats.runsInFlight)}
        tone="accent"
      />
      <StatCard label="Open sessions" value={shown(stats.openSessions)} />
      <StatCard label="Queued beads" value={shown(stats.queued)} />
      <StatCard
        label="File claims held"
        value={shown(stats.claims)}
        tone="muted"
      />
    </section>
  );
}

const sameStats = (
  a: LiveStatsValues | null,
  b: LiveStatsValues | null,
): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.runsInFlight === b.runsInFlight &&
    a.openSessions === b.openSessions &&
    a.queued === b.queued &&
    a.claims === b.claims);

/** The dashboard's second stat row: absent until a snapshot has arrived, and when live updates are off. */
const retainedStats = (state: LiveState): LiveStatsValues | null =>
  liveStats(
    state.status === "off" ? { ...state, status: "reconnecting" } : state,
  );

export function LiveStats({
  retainLastKnown = false,
}: {
  retainLastKnown?: boolean;
} = {}): JSX.Element | null {
  const stats = useStream(
    retainLastKnown ? retainedStats : liveStats,
    sameStats,
  );
  const lastKnown = useStream(
    (state) => retainLastKnown && state.status !== "live",
  );
  return <LiveStatsView stats={stats} lastKnown={lastKnown} />;
}
