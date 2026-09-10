import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { BeadsPayload } from "../../../types/beads";
import { Card } from "../ds/Card";
import { StatCard } from "../ds/StatCard";
import {
  computeInsights,
  destroyInsightCharts,
  mountInsightCharts,
} from "../insights.mjs";
import { applyInitiativeFilter } from "../issues-selection.mjs";
import { InitiativeSelect } from "./InitiativeSelect";

export interface InsightsIslandProps {
  payload: BeadsPayload;
  initiativeFilter: string;
  onInitiativeChange: (value: string) => void;
}

/**
 * Throughput over time.
 *
 * The island owns the chrome — filter, KPI cards, headings — while
 * `insights.mjs` keeps the bucketing and the Chart.js configs. Chart.js is
 * still imported on demand so it only loads on this route, and a failed import
 * degrades to the KPI cards plus a message rather than an empty page.
 */
export function InsightsIsland({
  payload,
  initiativeFilter,
  onInitiativeChange,
}: InsightsIslandProps): JSX.Element {
  const daily = useRef<HTMLCanvasElement>(null);
  const calendar = useRef<HTMLCanvasElement>(null);
  const [chartError, setChartError] = useState<string | null>(null);

  const issues = payload.issues ?? [];
  const data = useMemo(
    () => computeInsights(applyInitiativeFilter(issues, initiativeFilter)),
    [issues, initiativeFilter],
  );

  useEffect(() => {
    let cancelled = false;
    void mountInsightCharts(
      { daily: daily.current, calendar: calendar.current },
      data,
    ).then((error: string | null) => {
      if (!cancelled) setChartError(error);
    });
    return () => {
      cancelled = true;
      destroyInsightCharts();
    };
  }, [data]);

  const { stats } = data;
  const busiest = stats.best.count
    ? `${stats.best.day} (${stats.best.count})`
    : "—";

  return (
    <>
      <div class="af-toolbar">
        <InitiativeSelect
          issues={issues}
          initiativeFilter={initiativeFilter}
          onInitiativeChange={onInitiativeChange}
          id="filter-initiative-insights"
        />
      </div>

      <div class="af-stat-row">
        <StatCard label="Total closed" value={stats.total} tone="accent" />
        <StatCard label="Closed (last 7d)" value={stats.last7} tone="accent" />
        <StatCard
          label="Avg / day"
          value={stats.avg ? stats.avg.toFixed(1) : "0"}
        />
        <StatCard label="Busiest day" value={busiest} tone="muted" />
      </div>

      <Card
        title="Beads closed over time"
        headingLevel={2}
        kicker="daily, by type"
      >
        <p class="af-prose af-muted">
          Daily count of closed beads, bucketed by <code>updatedAt</code> in UTC
          as a close-time proxy.
        </p>
        <div class="af-chart">
          <canvas ref={daily} />
        </div>
      </Card>

      <Card title="Activity calendar" headingLevel={2} kicker="last 12 weeks">
        <p class="af-prose af-muted">
          Brighter means more beads closed that day (UTC).
        </p>
        <div class="af-chart af-chart-short">
          <canvas ref={calendar} />
        </div>
      </Card>

      {chartError ? (
        <p class="af-chart-error" role="status">
          {chartError}. The numbers above still reflect the current data.
        </p>
      ) : null}
    </>
  );
}
