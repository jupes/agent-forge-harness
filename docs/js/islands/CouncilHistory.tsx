import type { JSX } from "preact";
import type { CouncilServiceJob } from "../../../scripts/council/service";
import { Card } from "../ds/Card";

export function CouncilHistory({
  history,
  selectedRunId,
  onOpen,
}: {
  history: CouncilServiceJob[];
  selectedRunId: string | undefined;
  onOpen: (runId: string) => Promise<void>;
}): JSX.Element {
  return (
    <Card title="Review history" headingLevel={2} class="af-history">
      {history.length === 0 ? (
        <p class="af-muted">
          Your completed and active runs will be saved here.
        </p>
      ) : null}
      {history.map((item) => (
        <button
          type="button"
          key={item.runId}
          class={`af-history-item${
            selectedRunId === item.runId ? " is-selected" : ""
          }`}
          aria-current={selectedRunId === item.runId ? "true" : undefined}
          onClick={() => void onOpen(item.runId)}
        >
          <span class="af-history-name">
            {item.run?.context.source.displayName ?? item.runId}
          </span>
          <span class="af-history-meta">
            {item.status} · {new Date(item.startedAt).toLocaleString()}
          </span>
        </button>
      ))}
    </Card>
  );
}
