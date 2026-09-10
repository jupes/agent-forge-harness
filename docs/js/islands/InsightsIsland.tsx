import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { BeadsPayload } from "../../../types/beads";
import { renderInsightsHtml, wireInsights } from "../insights.mjs";
import { applyInitiativeFilter } from "../issues-selection.mjs";
import { InitiativeSelect } from "./InitiativeSelect";

export interface InsightsIslandProps {
  payload: BeadsPayload;
  initiativeFilter: string;
  onInitiativeChange: (value: string) => void;
}

/**
 * Throughput charts.
 *
 * The chart bodies are still rendered by `insights.mjs`, which builds HTML and
 * drives Chart.js imperatively. That module keeps its dynamic import (so the
 * charting library only loads on this route) and its graceful degrade when the
 * import fails; this island owns the filter and the mount point.
 */
export function InsightsIsland({
  payload,
  initiativeFilter,
  onInitiativeChange,
}: InsightsIslandProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    node.innerHTML = renderInsightsHtml("");
    void wireInsights(node, {
      issues: applyInitiativeFilter(payload.issues ?? [], initiativeFilter),
    });
  }, [payload, initiativeFilter]);

  return (
    <>
      <InitiativeSelect
        issues={payload.issues ?? []}
        initiativeFilter={initiativeFilter}
        onInitiativeChange={onInitiativeChange}
        id="filter-initiative-insights"
      />
      <div ref={host} class="af-insights" />
    </>
  );
}
