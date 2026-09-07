import type { CouncilServiceJob } from "../../../scripts/council/service";

export function CouncilHistory({
  history,
  selectedRunId,
  onOpen,
}: {
  history: CouncilServiceJob[];
  selectedRunId: string | undefined;
  onOpen: (runId: string) => Promise<void>;
}) {
  return (
    <aside className="panel history">
      <h2>Review history</h2>
      {history.length === 0 && (
        <p className="muted">
          Your completed and active runs will be saved here.
        </p>
      )}
      {history.map((item) => (
        <button
          type="button"
          key={item.runId}
          className={selectedRunId === item.runId ? "selected" : ""}
          onClick={() => void onOpen(item.runId)}
        >
          {item.run?.context.source.displayName ?? item.runId}
          <small>
            {item.status} · {new Date(item.startedAt).toLocaleString()}
          </small>
        </button>
      ))}
    </aside>
  );
}
