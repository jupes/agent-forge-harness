/**
 * Agent Forge dashboard — the SPA root.
 *
 * Replaces the previous imperative renderer: nav clicks mutated a module
 * variable and re-wrote `#content` by hand, the URL never changed, and the only
 * code path that rendered anything ran *after* the Beads fetch resolved.
 */

import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import type { BeadsPayload } from "../../types/beads";
import { needsSnapshot, pageTitleFor, snapshotLabelFor } from "./app-state";
import { installCopyDelegation } from "./copy-to-clipboard";
import { AppShell } from "./ds/AppShell";
import { EmptyState } from "./ds/EmptyState";
import { BeadBuilderIsland } from "./islands/BeadBuilderIsland";
import { CommandsIsland } from "./islands/CommandsIsland";
import { EpicsIsland } from "./islands/EpicsIsland";
import { ForgeRunIsland } from "./islands/ForgeRunIsland";
import { InsightsIsland } from "./islands/InsightsIsland";
import { IssuesViewsIsland } from "./islands/IssuesViewsIsland";
import { ReposIsland } from "./islands/ReposIsland";
import { SkillBuilderIsland } from "./islands/SkillBuilderIsland";
import {
  DEFAULT_ROUTE,
  legacyRedirectFor,
  parseRoute,
  type RouteId,
  routeForHashChange,
} from "./router";

const BEADS_URL = "data/beads.json";
const REBUILD_PATH = "/__agent-forge/rebuild-pages";

/** Current route, kept in sync with the address bar. */
function useHashRoute(): RouteId {
  const [route, setRoute] = useState<RouteId>(() => {
    // An old `?view=` link becomes its hash equivalent before first paint, so
    // bookmarks land on the right view and the URL self-corrects.
    const redirect = legacyRedirectFor(
      window.location.search,
      window.location.hash,
    );
    if (redirect) {
      // Replace the whole URL, not just the hash, so the consumed `?view=`
      // does not linger in the address bar next to its own replacement.
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${redirect}`,
      );
      return parseRoute(redirect);
    }
    return parseRoute(window.location.hash);
  });

  useEffect(() => {
    const onHashChange = () =>
      setRoute((current) => routeForHashChange(window.location.hash, current));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return route;
}

interface SnapshotState {
  payload: BeadsPayload | null;
  error: string | null;
  loading: boolean;
}

function DashboardApp() {
  const route = useHashRoute();
  const [snapshot, setSnapshot] = useState<SnapshotState>({
    payload: null,
    error: null,
    loading: true,
  });
  const [refreshing, setRefreshing] = useState(false);

  // View state that must survive re-renders and route changes.
  const [initiativeFilter, setInitiativeFilter] = useState("all");
  const [expandedIssueId, setExpandedIssueId] = useState<string | null>(null);
  const [listStatusFilter, setListStatusFilter] = useState("all");
  const [listSearchQuery, setListSearchQuery] = useState("");

  const loadSnapshot = useCallback(async () => {
    try {
      const response = await fetch(BEADS_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as BeadsPayload;
      setSnapshot({ payload, error: null, loading: false });
    } catch (error) {
      setSnapshot({
        payload: null,
        error: error instanceof Error ? error.message : String(error),
        loading: false,
      });
    }
  }, []);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  useEffect(() => installCopyDelegation(document.body), []);

  const onRefreshSnapshot = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch(REBUILD_PATH, { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? response.statusText);
      await loadSnapshot();
    } catch (error) {
      window.alert(
        `Could not refresh the data snapshot.\n\n${
          error instanceof Error ? error.message : String(error)
        }\n\nThis button talks to the Vite dev server only. If you opened files directly or use GitHub Pages, run in the repo root:\n\n  bun run build-pages\n\nthen reload the page.`,
      );
    } finally {
      setRefreshing(false);
    }
  }, [loadSnapshot]);

  const { title, blurb } = pageTitleFor(route);
  const { label, iso } = snapshotLabelFor(
    snapshot.payload?.generatedAt ?? null,
  );

  const changeInitiative = useCallback((value: string) => {
    setInitiativeFilter(value || "all");
    setExpandedIssueId(null);
  }, []);

  const issueViewProps = {
    payload: snapshot.payload as BeadsPayload,
    initiativeFilter,
    onInitiativeChange: changeInitiative,
    expandedIssueId,
    onExpandedChange: setExpandedIssueId,
    listStatusFilter,
    listSearchQuery,
    onListStatusChange: setListStatusFilter,
    onListSearchChange: setListSearchQuery,
  };

  return (
    <AppShell
      active={route}
      title={title}
      blurb={blurb}
      onRefreshSnapshot={() => void onRefreshSnapshot()}
      refreshing={refreshing}
      snapshotLabel={label}
      snapshotIso={iso}
    >
      {renderRoute()}
    </AppShell>
  );

  function renderRoute() {
    // Views that read no Beads data render regardless of the snapshot — the
    // fetch failing must never hide them.
    if (needsSnapshot(route)) {
      if (snapshot.loading) {
        return <EmptyState title="Loading the Beads snapshot…" live />;
      }
      if (!snapshot.payload) {
        return (
          <EmptyState
            title="No snapshot loaded"
            hint={
              <>
                Run <code>bun run build-pages</code> to generate{" "}
                <code>docs/data/beads.json</code>, or use Refresh snapshot while
                the dev server is running.
                {snapshot.error ? ` (${snapshot.error})` : null}
              </>
            }
            live
          />
        );
      }
    }

    switch (route) {
      case "dashboard":
        return <IssuesViewsIsland variant="dashboard" {...issueViewProps} />;
      case "issues":
        return <IssuesViewsIsland variant="list" {...issueViewProps} />;
      case "epics":
        return (
          <EpicsIsland
            payload={snapshot.payload as BeadsPayload}
            initiativeFilter={initiativeFilter}
            onInitiativeChange={changeInitiative}
          />
        );
      case "insights":
        return (
          <InsightsIsland
            payload={snapshot.payload as BeadsPayload}
            initiativeFilter={initiativeFilter}
            onInitiativeChange={changeInitiative}
          />
        );
      case "commands":
        return <CommandsIsland />;
      case "skill-builder":
        return <SkillBuilderIsland />;
      case "bead-builder":
        return <BeadBuilderIsland />;
      case "forge-run":
        return <ForgeRunIsland />;
      case "repos":
        return <ReposIsland />;
      default:
        return <IssuesViewsIsland variant="dashboard" {...issueViewProps} />;
    }
  }
}

const root = document.getElementById("app");
if (root) render(<DashboardApp />, root);

export { DashboardApp, DEFAULT_ROUTE };
